import type { QueryNode } from "./matcher-query.js";
import type { TaskListFilters, TaskSort } from "./types.js";

export type MatcherDialect = "sqlite" | "postgres";

export interface NormalizedMatcherQuery {
  source: string;
  ast: QueryNode;
  features: MatcherFeature[];
}

export type MatcherFeature =
  | "boolean"
  | "field"
  | "time"
  | "comment"
  | "graph"
  | "hierarchy";

export interface MatcherPlan {
  source: string;
  ast: QueryNode;
  features: MatcherFeature[];
  filters: MatcherPlanFilters;
}

export interface MatcherPlanFilters {
  includeArchived: boolean;
  includeFinished: boolean;
  sort: TaskSort | null;
}

export interface MatcherLoweringInput {
  dialect: MatcherDialect;
  projectId: string;
  plan: MatcherPlan;
}

export interface MatcherSqlQuery {
  sql: string;
  params: unknown[];
}

export interface MatcherLoweringResult {
  dialect: MatcherDialect;
  taskIds: MatcherSqlQuery;
}

export interface MatcherLowerer {
  readonly dialect: MatcherDialect;
  lower(input: MatcherLoweringInput): MatcherLoweringResult;
}

export function normalizeMatcherQuery(source: string, ast: QueryNode): NormalizedMatcherQuery {
  return {
    source,
    ast: normalizeNode(ast),
    features: collectFeatures(ast)
  };
}

export function planMatcherQuery(source: string, ast: QueryNode, filters: Omit<TaskListFilters, "where"> = {}): MatcherPlan {
  const normalized = normalizeMatcherQuery(source, ast);
  return {
    source: normalized.source,
    ast: normalized.ast,
    features: normalized.features,
    filters: {
      includeArchived: filters.includeArchived === true,
      includeFinished: filters.includeFinished === true,
      sort: filters.sort ?? null
    }
  };
}

function normalizeNode(node: QueryNode): QueryNode {
  if (node.type === "and" || node.type === "or") {
    const nodes = node.nodes.flatMap((child) => {
      const normalized = normalizeNode(child);
      return normalized.type === node.type ? normalized.nodes : [normalized];
    });
    return nodes.length === 1 ? nodes[0] as QueryNode : { type: node.type, nodes };
  }
  if (node.type === "not") {
    return { type: "not", node: normalizeNode(node.node) };
  }
  if (node.type === "field") {
    return {
      ...node,
      values: node.values.map((value) => normalizeFieldValue(node.field, value))
    };
  }
  if (node.type === "hierarchy") {
    return { ...node, taskId: node.taskId.toUpperCase() };
  }
  if (node.type === "graph") {
    return { ...node, targetId: node.targetId?.toUpperCase() ?? null };
  }
  return node;
}

function normalizeFieldValue(field: string, value: string): string {
  if (field === "id" || field === "id prefix" || field === "parent" || field === "tag") {
    return value.toUpperCase();
  }
  return value;
}

function collectFeatures(ast: QueryNode): MatcherFeature[] {
  const features = new Set<MatcherFeature>();
  visit(ast, features);
  return [...features].sort();
}

function visit(node: QueryNode, features: Set<MatcherFeature>): void {
  if (node.type === "and" || node.type === "or") {
    features.add("boolean");
    for (const child of node.nodes) visit(child, features);
    return;
  }
  if (node.type === "not") {
    features.add("boolean");
    visit(node.node, features);
    return;
  }
  features.add(node.type);
}
