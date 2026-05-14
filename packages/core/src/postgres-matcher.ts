import { validation } from "./errors.js";
import { parseMatcherPlan, type QueryNode, type FieldPredicate, type TimePredicate, type TimeExpression, type GraphPredicate, type HierarchyPredicate } from "./matcher-query.js";
import type { MatcherLoweringResult, MatcherPlan } from "./matcher-plan.js";
import type { TaskListFilters } from "./types.js";

type Direction = "upstream" | "downstream";

interface LowerContext {
  projectPlaceholder: string;
}

export function lowerPostgresMatcherTaskIds(projectId: string, query: string, filters: Omit<TaskListFilters, "where"> = {}): MatcherLoweringResult {
  const plan = parseMatcherPlan(query, filters);
  const builder = new SqlBuilder(1);
  const projectPlaceholder = builder.placeholder(projectId);
  const context = { projectPlaceholder };
  const conditions = ["t.tenant_id = $1", `t.project_id = ${projectPlaceholder}`];
  conditions.push("t.archived_at is null");
  if (!plan.filters.includeFinished) {
    conditions.push("t.lifecycle != 'finished'");
  }
  conditions.push(lowerNode(plan.ast, builder, context));

  return {
    dialect: "postgres",
    taskIds: {
      sql: `
        select t.id
        from tasks t
        where ${conditions.map((condition) => `(${condition})`).join(" and ")}
        order by ${orderBy(plan)}
      `,
      params: builder.params
    }
  };
}

function lowerNode(node: QueryNode, builder: SqlBuilder, context: LowerContext): string {
  if (node.type === "and") {
    return node.nodes.map((child) => `(${lowerNode(child, builder, context)})`).join(" and ");
  }
  if (node.type === "or") {
    return node.nodes.map((child) => `(${lowerNode(child, builder, context)})`).join(" or ");
  }
  if (node.type === "not") {
    return `not (${lowerNode(node.node, builder, context)})`;
  }
  if (node.type === "field") return lowerField(node, builder, context);
  if (node.type === "time") return lowerTime(node, builder);
  if (node.type === "comment") return lowerComment(node, builder);
  if (node.type === "graph") return lowerGraph(node, builder, context);
  return lowerHierarchy(node, builder, context);
}

function lowerField(predicate: FieldPredicate, builder: SqlBuilder, context: LowerContext): string {
  if (predicate.field === "priority") {
    return compareNumeric("t.priority", predicate.op, numericValue(predicate.values[0] ?? ""));
  }
  if (predicate.field === "comments") {
    const countSql = `(select count(*) from comments c where c.tenant_id = t.tenant_id and c.project_id = t.project_id and c.task_id = t.id and c.archived_at is null)`;
    return compareNumeric(countSql, predicate.op, numericValue(predicate.values[0] ?? ""));
  }
  if (predicate.op === "in" || predicate.op === "not in") {
    const parts = predicate.values.map((value) => lowerField({ ...predicate, op: "=", values: [value] }, builder, context));
    const joined = parts.length > 0 ? parts.map((part) => `(${part})`).join(" or ") : "false";
    return predicate.op === "in" ? joined : `not (${joined})`;
  }
  const value = predicate.values[0] ?? "";
  const equality = lowerFieldEquality(predicate.field, value, builder, context);
  if (predicate.op === "=") return equality;
  if (predicate.op === "!=") return `not (${equality})`;
  validation(`Matcher field ${predicate.field} only supports equality operators in SQL lowering.`);
}

function lowerFieldEquality(field: FieldPredicate["field"], value: string, builder: SqlBuilder, context: LowerContext): string {
  if (field === "id") return builder.param(value.toUpperCase(), "t.id = $");
  if (field === "id prefix") return builder.param(`${value.toUpperCase()}%`, "t.id like $");
  if (field === "tag") {
    const tagId = builder.add(value.toUpperCase());
    const tagName = builder.add(value.toLowerCase());
    return `
      t.id in (
        select tt.task_id from task_tags tt
        join tags tg on tg.tenant_id = tt.tenant_id and tg.project_id = tt.project_id and tg.id = tt.tag_id
        where tt.tenant_id = $1 and tt.project_id = ${context.projectPlaceholder}
          and tg.archived_at is null
          and (tg.id = $${tagId} or lower(tg.name) = $${tagName})
      )
    `;
  }
  if (field === "assigned") {
    const actorRef = parseActorRef(value);
    const actor = builder.add(actorRef.actor);
    const machineClause = actorRef.machine ? `and lower(tr.machine) = $${builder.add(actorRef.machine)}` : "";
    return `
      t.id in (
        select ta.task_id from track_assignments ta
        join tracks tr on tr.tenant_id = ta.tenant_id and tr.project_id = ta.project_id and tr.id = ta.track_id
        where ta.tenant_id = $1 and ta.project_id = ${context.projectPlaceholder}
          and tr.archived_at is null
          and lower(tr.actor) = $${actor}
          ${machineClause}
      )
    `;
  }
  if (field === "machine" || field === "actor") {
    const expected = builder.add(value.toLowerCase());
    return `
      t.id in (
        select ta.task_id from track_assignments ta
        join tracks tr on tr.tenant_id = ta.tenant_id and tr.project_id = ta.project_id and tr.id = ta.track_id
        where ta.tenant_id = $1 and ta.project_id = ${context.projectPlaceholder}
          and tr.archived_at is null
          and lower(tr.${field}) = $${expected}
      )
    `;
  }
  if (field === "status") return `${computedStatusSql()} = ${builder.placeholder(value.toLowerCase())}`;
  if (field === "lifecycle") return builder.param(value.toLowerCase(), "t.lifecycle = $");
  if (field === "parent") {
    return value.toLowerCase() === "root"
      ? "t.parent_task_id is null"
      : builder.param(value.toUpperCase(), "t.parent_task_id = $");
  }
  if (field === "source doc") return builder.param(value.toLowerCase(), "lower(t.source_doc) = $");
  if (field === "source section") return builder.param(value.toLowerCase(), "lower(t.source_section) = $");
  validation(`Unsupported matcher field for Postgres lowering: ${field}`);
}

function lowerTime(predicate: TimePredicate, builder: SqlBuilder): string {
  const column = timeColumn(predicate.field);
  if (predicate.op === "is empty") return `${column} is null`;
  if (predicate.op === "is not empty") return `${column} is not null`;
  if (!predicate.value) return "false";
  const resolved = resolveTimeExpression(predicate.value);
  if (predicate.op === "=" && resolved.end) {
    return `${column} >= ${builder.placeholder(resolved.start)} and ${column} < ${builder.placeholder(resolved.end)}`;
  }
  if (predicate.op === "!=" && resolved.end) {
    return `(${column} < ${builder.placeholder(resolved.start)} or ${column} >= ${builder.placeholder(resolved.end)})`;
  }
  return `${column} ${predicate.op} ${builder.placeholder(resolved.start)}`;
}

function lowerComment(predicate: Extract<QueryNode, { type: "comment" }>, builder: SqlBuilder): string {
  if (predicate.relation === "by") {
    const actorRef = parseActorRef(String(predicate.value));
    const actor = builder.add(actorRef.actor);
    const machineClause = actorRef.machine
      ? `and lower(c.machine) = $${builder.add(actorRef.machine)}`
      : `and lower(c.machine || ':' || c.actor) = $${builder.add(String(predicate.value).toLowerCase())}`;
    return `
      exists (
        select 1 from comments c
        where c.tenant_id = t.tenant_id and c.project_id = t.project_id and c.task_id = t.id
          and c.archived_at is null
          and lower(c.actor) = $${actor}
          ${machineClause}
      )
    `;
  }
  const resolved = resolveTimeExpression(predicate.value as TimeExpression);
  return `
    exists (
      select 1 from comments c
      where c.tenant_id = t.tenant_id and c.project_id = t.project_id and c.task_id = t.id
        and c.archived_at is null
        and c.created_at >= ${builder.placeholder(resolved.start)}
    )
  `;
}

function lowerHierarchy(predicate: HierarchyPredicate, builder: SqlBuilder, context: LowerContext): string {
  const target = builder.add(predicate.taskId.toUpperCase());
  return `
    t.id in (
      with recursive walk(id) as (
        select child.id
        from tasks child
        where child.tenant_id = $1 and child.project_id = ${context.projectPlaceholder}
          and child.archived_at is null and child.parent_task_id = $${target}
        union
        select child.id
        from tasks child
        join walk w on child.parent_task_id = w.id
        where child.tenant_id = $1 and child.project_id = ${context.projectPlaceholder} and child.archived_at is null
      )
      select id from walk
    )
  `;
}

function lowerGraph(predicate: GraphPredicate, builder: SqlBuilder, context: LowerContext): string {
  const direction: Direction = predicate.verb === "depends on" ? "upstream" : "downstream";
  if (predicate.targetId) {
    const target = builder.add(predicate.targetId.toUpperCase());
    const depth = predicate.depth ? `and ${compareNumeric("depth", predicate.depth.op, predicate.depth.value)}` : "";
    return `
      t.id in (
        ${graphCandidatesForTargetSql(predicate.verb, context)}
        select id from walk where true ${depth}
      )
    `.replaceAll("__TARGET__", `$${target}`);
  }
  const graph = graphReachableSql(direction, context);
  const countRule = predicate.count ?? { op: ">" as const, value: 0 };
  return `(select count(*) from (${graph} select distinct id from walk) reachable) ${countRule.op} ${builder.placeholder(countRule.value)}`;
}

function graphReachableSql(direction: Direction, context: LowerContext): string {
  const dependencyFrom = direction === "upstream" ? "d.task_id" : "d.depends_on_task_id";
  const dependencyTo = direction === "upstream" ? "d.depends_on_task_id" : "d.task_id";
  const hierarchyFrom = direction === "upstream" ? "parent.id" : "child.id";
  const hierarchyTo = direction === "upstream" ? "child.id" : "parent.id";
  return `
    with recursive edges(from_id, to_id) as (
      select ${dependencyFrom}, ${dependencyTo}
      from task_dependencies d
      join tasks source_task on source_task.tenant_id = d.tenant_id and source_task.project_id = d.project_id and source_task.id = d.task_id
      join tasks dependency_task on dependency_task.tenant_id = d.tenant_id and dependency_task.project_id = d.project_id and dependency_task.id = d.depends_on_task_id
      where d.tenant_id = $1 and d.project_id = ${context.projectPlaceholder}
        and source_task.archived_at is null and dependency_task.archived_at is null
      union all
      select ${hierarchyFrom}, ${hierarchyTo}
      from tasks parent
      join tasks child on child.tenant_id = parent.tenant_id and child.project_id = parent.project_id and child.parent_task_id = parent.id
      where parent.tenant_id = $1 and parent.project_id = ${context.projectPlaceholder}
        and parent.archived_at is null and child.archived_at is null
    ),
    walk(id, depth, path) as (
      select e.to_id, 1, array[t.id, e.to_id]
      from edges e
      where e.from_id = t.id
      union all
      select e.to_id, w.depth + 1, w.path || e.to_id
      from walk w
      join edges e on e.from_id = w.id
      where not e.to_id = any(w.path)
    )
  `;
}

function graphCandidatesForTargetSql(verb: GraphPredicate["verb"], context: LowerContext): string {
  const seedId = verb === "depends on" ? "e.from_id" : "e.to_id";
  const seedWhere = verb === "depends on" ? "e.to_id = __TARGET__" : "e.from_id = __TARGET__";
  const recursiveId = verb === "depends on" ? "e.from_id" : "e.to_id";
  const recursiveJoin = verb === "depends on" ? "e.to_id = w.id" : "e.from_id = w.id";
  return `
    with recursive edges(from_id, to_id) as (
      select d.task_id, d.depends_on_task_id
      from task_dependencies d
      join tasks source_task on source_task.tenant_id = d.tenant_id and source_task.project_id = d.project_id and source_task.id = d.task_id
      join tasks dependency_task on dependency_task.tenant_id = d.tenant_id and dependency_task.project_id = d.project_id and dependency_task.id = d.depends_on_task_id
      where d.tenant_id = $1 and d.project_id = ${context.projectPlaceholder}
        and source_task.archived_at is null and dependency_task.archived_at is null
      union all
      select parent.id, child.id
      from tasks parent
      join tasks child on child.tenant_id = parent.tenant_id and child.project_id = parent.project_id and child.parent_task_id = parent.id
      where parent.tenant_id = $1 and parent.project_id = ${context.projectPlaceholder}
        and parent.archived_at is null and child.archived_at is null
    ),
    walk(id, depth, path) as (
      select ${seedId}, 1, array[__TARGET__, ${seedId}]
      from edges e
      where ${seedWhere}
      union all
      select ${recursiveId}, w.depth + 1, w.path || ${recursiveId}
      from walk w
      join edges e on ${recursiveJoin}
      where not ${recursiveId} = any(w.path)
    )
  `;
}

function computedStatusSql(): string {
  return `
    case
      when t.archived_at is not null then 'archived'
      when t.lifecycle = 'finished' then 'finished'
      when t.lifecycle = 'started' then 'started'
      when exists (
        select 1
        from task_dependencies d
        join tasks dep on dep.tenant_id = d.tenant_id and dep.project_id = d.project_id and dep.id = d.depends_on_task_id
        where d.tenant_id = t.tenant_id and d.project_id = t.project_id and d.task_id = t.id
          and dep.archived_at is null and dep.lifecycle != 'finished'
      ) then 'blocked'
      else 'ready'
    end
  `;
}

function compareNumeric(left: string, op: string, right: number): string {
  if (op === "=" || op === "!=" || op === ">" || op === ">=" || op === "<" || op === "<=") {
    return `${left} ${op} ${right}`;
  }
  validation(`Invalid numeric matcher operator: ${op}`);
}

function numericValue(value: string): number {
  const normalized = value.toUpperCase().startsWith("P") ? value.slice(1) : value;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    validation(`Invalid numeric matcher value: ${value}`);
  }
  return parsed;
}

function timeColumn(field: TimePredicate["field"]): string {
  if (field === "created") return "t.created_at";
  if (field === "updated") return "t.updated_at";
  if (field === "started") return "t.started_at";
  if (field === "finished") return "t.finished_at";
  return "t.archived_at";
}

interface ResolvedTime {
  start: string;
  end?: string;
}

function resolveTimeExpression(expression: TimeExpression): ResolvedTime {
  const now = new Date();
  if (expression.type === "now") return { start: now.toISOString() };
  if (expression.type === "today") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (expression.type === "relative") {
    return { start: new Date(now.getTime() - durationMs(expression.amount, expression.unit)).toISOString() };
  }
  if (expression.dateOnly) {
    const match = expression.value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) validation(`Invalid date value: ${expression.value}`);
    const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const end = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  const parsed = new Date(expression.value.includes(" ") ? expression.value.replace(" ", "T") : expression.value);
  if (!Number.isFinite(parsed.getTime())) validation(`Invalid time value: ${expression.value}`);
  return { start: parsed.toISOString() };
}

function durationMs(amount: number, unit: "m" | "h" | "d" | "w"): number {
  const minute = 60 * 1000;
  if (unit === "m") return amount * minute;
  if (unit === "h") return amount * 60 * minute;
  if (unit === "d") return amount * 24 * 60 * minute;
  return amount * 7 * 24 * 60 * minute;
}

function parseActorRef(value: string): { machine: string | null; actor: string } {
  const normalized = value.toLowerCase();
  const separator = normalized.indexOf(":");
  if (separator < 0) return { machine: null, actor: normalized };
  return { machine: normalized.slice(0, separator), actor: normalized.slice(separator + 1) };
}

function orderBy(plan: MatcherPlan): string {
  if (plan.filters.sort === "priority") return "t.priority desc, t.created_at asc, t.id asc";
  if (plan.filters.sort === "created") return "t.created_at asc, t.id asc";
  if (plan.filters.sort === "updated") return "t.updated_at desc, t.id asc";
  if (plan.filters.sort === "id") return "t.id asc";
  if (plan.filters.sort === "title") return "t.title asc, t.id asc";
  return "t.created_at asc, t.id asc";
}

class SqlBuilder {
  readonly params: unknown[] = [];
  constructor(private readonly offset = 0) {}

  add(value: unknown): number {
    this.params.push(value);
    return this.params.length + this.offset;
  }

  placeholder(value: unknown): string {
    return `$${this.add(value)}`;
  }

  param(value: unknown, prefix: string): string {
    return `${prefix}${this.add(value)}`;
  }
}
