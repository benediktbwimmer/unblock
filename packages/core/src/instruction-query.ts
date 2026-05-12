import { validation } from "./errors.js";
import type { Dependency, TaskView } from "./types.js";

type TokenKind = "word" | "number" | "string" | "op" | "lparen" | "rparen" | "comma" | "eof";

interface Token {
  kind: TokenKind;
  value: string;
  offset: number;
}

type QueryNode =
  | { type: "and"; nodes: QueryNode[] }
  | { type: "or"; nodes: QueryNode[] }
  | { type: "not"; node: QueryNode }
  | FieldPredicate
  | TimePredicate
  | CommentPredicate
  | GraphPredicate
  | HierarchyPredicate;

const COMPARE_OPERATORS = ["=", "!=", ">", ">=", "<", "<="] as const;
const FIELD_OPERATORS = [...COMPARE_OPERATORS, "in", "not in"] as const;
const BOOLEAN_OPERATORS = ["and", "or", "not"] as const;
const SIMPLE_FIELDS = ["id", "tag", "assigned", "machine", "actor", "status", "lifecycle", "parent", "priority", "comments"] as const;
const TIME_FIELDS = ["created", "updated", "started", "finished", "archived"] as const;
const PHRASE_FIELDS = ["id prefix", "source doc", "source section"] as const;
const FIELD_NAMES = [...SIMPLE_FIELDS, ...TIME_FIELDS, ...PHRASE_FIELDS] as const;
const GRAPH_VERBS = ["depends on", "unblocks"] as const;
const GRAPH_EDGE_KINDS = ["explicit dependencies", "implicit hierarchy edges"] as const;
const INSTRUCTION_QUERY_EXAMPLES = [
  "tag = frontend",
  "tag in (frontend, backend)",
  "assigned = local:codex-b",
  "descendant of PRISM-RUNTIME",
  "depends on PRISM-MIGRATIONS depth <= 2",
  "unblocks > 5 and priority >= 3",
  "comments > 0",
  "commented since now - 1d",
  "commented by local:codex-b",
  "started is empty",
  "updated >= now - 2d",
  "created = 2026-05-10"
] as const;

type FieldName = typeof FIELD_NAMES[number];
type CompareOp = typeof COMPARE_OPERATORS[number];
type FieldOperator = typeof FIELD_OPERATORS[number];
type GraphVerb = typeof GRAPH_VERBS[number];

export interface InstructionQueryGrammar {
  fields: FieldName[];
  fieldOperators: FieldOperator[];
  comparisonOperators: CompareOp[];
  booleanOperators: Array<typeof BOOLEAN_OPERATORS[number]>;
  graphVerbs: GraphVerb[];
  edgeKinds: Array<typeof GRAPH_EDGE_KINDS[number]>;
  valueForms: Array<{ name: string; description: string }>;
  clauses: Array<{ name: string; forms: string[]; description: string }>;
  examples: string[];
  notes: string[];
}

interface FieldPredicate {
  type: "field";
  field: FieldName;
  op: CompareOp | "in" | "not in";
  values: string[];
}

interface TimePredicate {
  type: "time";
  field: TimeFieldName;
  op: CompareOp | "is empty" | "is not empty";
  value?: TimeExpression;
}

interface CommentPredicate {
  type: "comment";
  relation: "by" | "since";
  value: string | TimeExpression;
}

type TimeFieldName = typeof TIME_FIELDS[number];
type TimeExpression =
  | { type: "absolute"; value: string; dateOnly: boolean }
  | { type: "now" }
  | { type: "today" }
  | { type: "relative"; anchor: "now"; amount: number; unit: TimeUnit };
type TimeUnit = "m" | "h" | "d" | "w";

interface GraphPredicate {
  type: "graph";
  verb: GraphVerb;
  targetId: string | null;
  count?: { op: CompareOp; value: number };
  depth?: { op: CompareOp; value: number };
}

interface HierarchyPredicate {
  type: "hierarchy";
  relation: "descendant of";
  taskId: string;
}

interface EvalContext {
  task: TaskView;
  taskById: Map<string, TaskView>;
  upstreamByTask: Map<string, Array<{ id: string; kind: "dependency" | "hierarchy" }>>;
  downstreamByTask: Map<string, Array<{ id: string; kind: "dependency" | "hierarchy" }>>;
  now: Date;
}

interface EvalResult {
  matched: boolean;
  reasons: string[];
}

export interface InstructionQueryMatch {
  task: TaskView;
  reasons: string[];
}

export function instructionQueryGrammar(): InstructionQueryGrammar {
  return {
    fields: [...FIELD_NAMES],
    fieldOperators: [...FIELD_OPERATORS],
    comparisonOperators: [...COMPARE_OPERATORS],
    booleanOperators: [...BOOLEAN_OPERATORS],
    graphVerbs: [...GRAPH_VERBS],
    edgeKinds: [...GRAPH_EDGE_KINDS],
    valueForms: [
      { name: "bare word", description: "A non-empty token without whitespace, parentheses, comma, or comparison characters." },
      { name: "quoted string", description: "Single-quoted or double-quoted text for values containing spaces or punctuation." },
      { name: "number", description: "An integer or numeric token where the field or count comparison expects a number." },
      { name: "date", description: "A local calendar date such as 2026-05-10. Equality means within that local day." },
      { name: "datetime", description: "An ISO-like datetime such as 2026-05-10T17:30." },
      { name: "relative time", description: "now, today, or now - NUMBERm/h/d/w. now is evaluated once per query." }
    ],
    clauses: [
      {
        name: "Boolean composition",
        forms: ["not CLAUSE", "CLAUSE and CLAUSE", "CLAUSE or CLAUSE", "(CLAUSE)"],
        description: "Combine any matcher clauses. Precedence is not, then and, then or."
      },
      {
        name: "Field comparison",
        forms: ["FIELD = VALUE", "FIELD != VALUE", "FIELD > VALUE", "FIELD >= VALUE", "FIELD < VALUE", "FIELD <= VALUE"],
        description: "Compare one task field against one value. Numeric ordering is meaningful for priority and comments; other fields use equality or inequality."
      },
      {
        name: "Field membership",
        forms: ["FIELD in (VALUE, VALUE, ...)", "FIELD not in (VALUE, VALUE, ...)"],
        description: "Match when any value for the field is, or is not, one of the listed values."
      },
      {
        name: "Time comparison",
        forms: ["created >= 2026-05-01", "updated < now - 2d", "finished = 2026-05-10", "started >= today"],
        description: "Compare timestamp fields against absolute dates, datetimes, now, today, or explicit relative durations."
      },
      {
        name: "Time presence",
        forms: ["started is empty", "finished is not empty", "archived is empty"],
        description: "Check nullable lifecycle timestamps without comparing against a time value."
      },
      {
        name: "Dependency relation",
        forms: ["depends on TASK", "depends on TASK depth = NUMBER", "depends on TASK depth <= NUMBER"],
        description: "Match tasks that depend on TASK. Traversal is transitive unless bounded with depth."
      },
      {
        name: "Unblocks relation",
        forms: ["unblocks TASK", "unblocks TASK depth = NUMBER", "unblocks TASK depth <= NUMBER"],
        description: "Match tasks that unblock TASK. Traversal is transitive unless bounded with depth."
      },
      {
        name: "Dependency count",
        forms: ["depends on > NUMBER", "depends on >= NUMBER", "unblocks > NUMBER", "unblocks >= NUMBER"],
        description: "Match by the number of reachable dependency or unblock tasks."
      },
      {
        name: "Comment count",
        forms: ["comments > NUMBER", "comments = NUMBER", "comments <= NUMBER"],
        description: "Match by active, non-archived task comment count."
      },
      {
        name: "Comment activity",
        forms: ["commented by MACHINE:ACTOR", "commented since today", "commented since now - 1d", "commented since 2026-05-10"],
        description: "Match tasks with active comments by an actor or at/after a time."
      },
      {
        name: "Hierarchy",
        forms: ["descendant of TASK"],
        description: "Match tasks below TASK in the parent-child hierarchy."
      }
    ],
    examples: [...INSTRUCTION_QUERY_EXAMPLES],
    notes: [
      "Boolean precedence is: not, then and, then or.",
      "Field comparisons are case-insensitive except numeric priority comparisons.",
      "Time fields are: created, updated, started, finished, archived.",
      "The comments field is a numeric active comment count.",
      "commented by uses machine:actor values.",
      "commented since accepts the same time values as time comparisons.",
      "Date-only equality matches the whole local day.",
      "Nullable time fields only match comparisons when present.",
      "Relative time units are m, h, d, and w.",
      "now is evaluated once per query.",
      "today means local midnight at the start of the current day.",
      "The assigned field accepts either actor or machine:actor.",
      "depends on and unblocks are transitive by default.",
      "Add depth = 1, depth <= 2, or another depth comparison to bound graph traversal.",
      "Count predicates omit a task reference, for example depends on > 3 or unblocks >= 5.",
      "The graph includes explicit task dependencies plus implicit hierarchy edges: parents depend on descendants, and children unblock ancestors.",
      "Archived tasks are ignored by instruction matching and graph traversal."
    ]
  };
}

export function formatInstructionQueryGrammar(): string {
  const grammar = instructionQueryGrammar();
  return [
    "Matcher reference:",
    "",
    "Clauses:",
    ...grammar.clauses.flatMap((clause) => [
      `  ${clause.name}:`,
      ...clause.forms.map((form) => `    ${form}`),
      `    ${clause.description}`
    ]),
    "",
    `Fields: ${grammar.fields.join(", ")}`,
    `Field operators: ${grammar.fieldOperators.join(" ")}`,
    `Comparison operators for counts and depth: ${grammar.comparisonOperators.join(" ")}`,
    `Boolean operators: ${grammar.booleanOperators.join(", ")}`,
    `Graph verbs: ${grammar.graphVerbs.join(", ")}`,
    "",
    "Values:",
    ...grammar.valueForms.map((value) => `  - ${value.name}: ${value.description}`),
    "",
    "Notes:",
    ...grammar.notes.map((note) => `  - ${note}`),
    "",
    "Examples:",
    ...grammar.examples.map((example) => `  ${example}`)
  ].join("\n");
}

export function validateInstructionQuery(query: string): string[] {
  try {
    parseInstructionQuery(query);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function matchInstructionQuery(query: string, tasks: TaskView[], dependencies: Dependency[]): InstructionQueryMatch[] {
  const ast = parseInstructionQuery(query);
  const graph = buildEffectiveGraph(tasks, dependencies);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const now = new Date();
  const matches: InstructionQueryMatch[] = [];
  for (const task of tasks) {
    if (task.archivedAt) {
      continue;
    }
    const result = evaluate(ast, { task, taskById, now, ...graph });
    if (result.matched) {
      matches.push({ task, reasons: result.reasons });
    }
  }
  return matches;
}

export function parseInstructionQuery(query: string): QueryNode {
  const parser = new Parser(tokenize(query));
  const ast = parser.parseExpression();
  parser.expect("eof");
  return ast;
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  parseExpression(): QueryNode {
    return this.parseOr();
  }

  private parseOr(): QueryNode {
    const nodes = [this.parseAnd()];
    while (this.matchWord("or")) {
      nodes.push(this.parseAnd());
    }
    return nodes.length === 1 ? nodes[0] as QueryNode : { type: "or", nodes };
  }

  private parseAnd(): QueryNode {
    const nodes = [this.parseFactor()];
    while (this.matchWord("and")) {
      nodes.push(this.parseFactor());
    }
    return nodes.length === 1 ? nodes[0] as QueryNode : { type: "and", nodes };
  }

  private parseFactor(): QueryNode {
    if (this.matchWord("not")) {
      return { type: "not", node: this.parseFactor() };
    }
    if (this.match("lparen")) {
      const node = this.parseExpression();
      this.expect("rparen");
      return node;
    }
    return this.parsePredicate();
  }

  private parsePredicate(): QueryNode {
    if (this.matchWords("descendant", "of")) {
      return { type: "hierarchy", relation: "descendant of", taskId: this.parseValue().toUpperCase() };
    }
    if (this.matchWords("depends", "on")) {
      return this.parseGraph("depends on");
    }
    if (this.matchWord("unblocks")) {
      return this.parseGraph("unblocks");
    }
    if (this.matchWord("commented")) {
      if (this.matchWord("by")) {
        return { type: "comment", relation: "by", value: this.parseValue() };
      }
      if (this.matchWord("since")) {
        return { type: "comment", relation: "since", value: this.parseTimeExpression() };
      }
      this.fail("Expected commented by or commented since.");
    }
    const field = this.parseField();
    if (field === "assigned") {
      this.matchWord("to");
    }
    if (isTimeField(field)) {
      return this.parseTimeField(field);
    }
    const op = this.parseOperator();
    if (op === "in" || op === "not in") {
      this.expect("lparen");
      const values = [this.parseValue()];
      while (this.match("comma")) {
        values.push(this.parseValue());
      }
      this.expect("rparen");
      return { type: "field", field, op, values };
    }
    return { type: "field", field, op, values: [this.parseValue()] };
  }

  private parseTimeField(field: TimeFieldName): TimePredicate {
    if (this.matchWord("is")) {
      if (this.matchWord("not")) {
        this.expectWord("empty");
        return { type: "time", field, op: "is not empty" };
      }
      this.expectWord("empty");
      return { type: "time", field, op: "is empty" };
    }
    const op = this.parseOperator();
    if (op === "in" || op === "not in") {
      this.fail("Time fields do not support in.");
    }
    return { type: "time", field, op, value: this.parseTimeExpression() };
  }

  private parseGraph(verb: GraphVerb): GraphPredicate {
    if (this.peek().kind === "op") {
      return { type: "graph", verb, targetId: null, count: { op: this.parseOperator() as CompareOp, value: this.parseNumber() } };
    }
    const targetId = this.parseValue().toUpperCase();
    let depth: GraphPredicate["depth"];
    if (this.matchWord("depth")) {
      depth = { op: this.parseOperator() as CompareOp, value: this.parseNumber() };
    }
    return depth ? { type: "graph", verb, targetId, depth } : { type: "graph", verb, targetId };
  }

  private parseField(): FieldName {
    if (this.matchWords("id", "prefix")) return "id prefix";
    if (this.matchWords("source", "doc")) return "source doc";
    if (this.matchWords("source", "section")) return "source section";
    const value = this.expect("word").value.toLowerCase();
    if (SIMPLE_FIELDS.includes(value as typeof SIMPLE_FIELDS[number])) {
      return value as FieldName;
    }
    if (TIME_FIELDS.includes(value as TimeFieldName)) {
      return value as FieldName;
    }
    this.fail(`Unknown field '${value}'.`);
  }

  private parseOperator(): CompareOp | "in" | "not in" {
    if (this.matchWords("not", "in")) return "not in";
    if (this.matchWord("in")) return "in";
    const token = this.expect("op").value;
    if (COMPARE_OPERATORS.includes(token as CompareOp)) {
      return token as CompareOp;
    }
    this.fail(`Unknown operator '${token}'.`);
  }

  private parseValue(): string {
    const token = this.peek();
    if (token.kind === "word" || token.kind === "string" || token.kind === "number") {
      this.index += 1;
      return token.value;
    }
    this.fail("Expected a value.");
  }

  private parseTimeExpression(): TimeExpression {
    if (this.matchWord("now")) {
      if (this.matchOp("-")) {
        const duration = this.parseRelativeDuration();
        return { type: "relative", anchor: "now", amount: duration.amount, unit: duration.unit };
      }
      return { type: "now" };
    }
    if (this.matchWord("today")) {
      return { type: "today" };
    }
    const value = this.parseValue();
    return { type: "absolute", value, dateOnly: /^\d{4}-\d{2}-\d{2}$/.test(value) };
  }

  private parseRelativeDuration(): { amount: number; unit: TimeUnit } {
    const token = this.peek();
    if (token.kind === "word") {
      const match = token.value.match(/^(\d+)([mhdw])$/i);
      if (match) {
        this.index += 1;
        return { amount: Number(match[1]), unit: match[2]!.toLowerCase() as TimeUnit };
      }
    }
    const amount = this.parseNumber();
    return { amount, unit: this.parseTimeUnit() };
  }

  private parseTimeUnit(): TimeUnit {
    const value = this.expect("word").value.toLowerCase();
    if (value === "m" || value === "h" || value === "d" || value === "w") {
      return value;
    }
    this.fail("Expected relative time unit m, h, d, or w.");
  }

  private parseNumber(): number {
    const token = this.expect("number");
    const value = Number(token.value);
    if (!Number.isFinite(value)) {
      this.fail(`Invalid number '${token.value}'.`);
    }
    return value;
  }

  private matchWords(...words: string[]): boolean {
    const start = this.index;
    for (const word of words) {
      if (!this.matchWord(word)) {
        this.index = start;
        return false;
      }
    }
    return true;
  }

  private matchWord(word: string): boolean {
    const token = this.peek();
    if (token.kind === "word" && token.value.toLowerCase() === word) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private match(kind: TokenKind): boolean {
    if (this.peek().kind === kind) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private matchOp(op: string): boolean {
    const token = this.peek();
    if (token.kind === "op" && token.value === op) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private expectWord(word: string): void {
    if (!this.matchWord(word)) {
      this.fail(`Expected '${word}'.`);
    }
  }

  expect(kind: TokenKind): Token {
    const token = this.peek();
    if (token.kind !== kind) {
      this.fail(`Expected ${kind}, got '${token.value || token.kind}'.`);
    }
    this.index += 1;
    return token;
  }

  private peek(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1] as Token;
  }

  private fail(message: string): never {
    validation(`Invalid instruction query: ${message}`, { offset: this.peek().offset });
  }
}

function evaluate(node: QueryNode, context: EvalContext): EvalResult {
  if (node.type === "and") {
    const reasons: string[] = [];
    for (const child of node.nodes) {
      const result = evaluate(child, context);
      if (!result.matched) return { matched: false, reasons: [] };
      reasons.push(...result.reasons);
    }
    return { matched: true, reasons };
  }
  if (node.type === "or") {
    for (const child of node.nodes) {
      const result = evaluate(child, context);
      if (result.matched) return result;
    }
    return { matched: false, reasons: [] };
  }
  if (node.type === "not") {
    const result = evaluate(node.node, context);
    return result.matched ? { matched: false, reasons: [] } : { matched: true, reasons: ["not matched"] };
  }
  if (node.type === "field") return evaluateField(node, context.task);
  if (node.type === "time") return evaluateTime(node, context);
  if (node.type === "comment") return evaluateComment(node, context);
  if (node.type === "graph") return evaluateGraph(node, context);
  return evaluateHierarchy(node, context);
}

function evaluateField(predicate: FieldPredicate, task: TaskView): EvalResult {
  const values = fieldValues(predicate.field, task);
  const inSet = values.some((value) => predicate.values.some((expected) => equalValue(value, expected, predicate.field)));
  const matched = predicate.op === "in"
    ? inSet
    : predicate.op === "not in"
      ? !inSet
      : compareAny(values, predicate.op, predicate.values[0] ?? "", predicate.field);
  return matched ? { matched: true, reasons: [`${predicate.field} ${predicate.op} ${predicate.values.join(", ")}`] } : { matched: false, reasons: [] };
}

function evaluateTime(predicate: TimePredicate, context: EvalContext): EvalResult {
  const value = timeFieldValue(predicate.field, context.task);
  if (predicate.op === "is empty") {
    return value ? { matched: false, reasons: [] } : { matched: true, reasons: [`${predicate.field} is empty`] };
  }
  if (predicate.op === "is not empty") {
    return value ? { matched: true, reasons: [`${predicate.field} is not empty`] } : { matched: false, reasons: [] };
  }
  if (!value || !predicate.value) {
    return { matched: false, reasons: [] };
  }
  const left = parseTaskTime(value, predicate.field);
  const right = resolveTimeExpression(predicate.value, context.now);
  const matched = compareTime(left, predicate.op, right);
  return matched ? { matched: true, reasons: [`${predicate.field} ${predicate.op} ${formatTimeExpression(predicate.value)}`] } : { matched: false, reasons: [] };
}

function evaluateComment(predicate: CommentPredicate, context: EvalContext): EvalResult {
  if (predicate.relation === "by") {
    const expected = String(predicate.value);
    const matched = context.task.commentAuthors.some((author) => author.toLowerCase() === expected.toLowerCase());
    return matched ? { matched: true, reasons: [`commented by ${expected}`] } : { matched: false, reasons: [] };
  }
  const lastCommentAt = context.task.lastCommentAt;
  if (!lastCommentAt) {
    return { matched: false, reasons: [] };
  }
  const right = resolveTimeExpression(predicate.value as TimeExpression, context.now);
  const matched = compareTime(parseTaskTime(lastCommentAt, "updated"), ">=", right);
  return matched ? { matched: true, reasons: [`commented since ${formatTimeExpression(predicate.value as TimeExpression)}`] } : { matched: false, reasons: [] };
}

function timeFieldValue(field: TimeFieldName, task: TaskView): string | null {
  if (field === "created") return task.createdAt;
  if (field === "updated") return task.updatedAt;
  if (field === "started") return task.startedAt;
  if (field === "finished") return task.finishedAt;
  return task.archivedAt;
}

function evaluateHierarchy(predicate: HierarchyPredicate, context: EvalContext): EvalResult {
  const matched = context.task.id !== predicate.taskId && isDescendantOf(context.task, predicate.taskId, context.taskById);
  return matched ? { matched: true, reasons: `descendant of ${predicate.taskId}`.split("\n") } : { matched: false, reasons: [] };
}

function evaluateGraph(predicate: GraphPredicate, context: EvalContext): EvalResult {
  const graph = predicate.verb === "depends on" ? context.upstreamByTask : context.downstreamByTask;
  const reachable = reachableWithDepth(context.task.id, graph);
  if (predicate.targetId) {
    const depth = reachable.get(predicate.targetId);
    if (depth === undefined) return { matched: false, reasons: [] };
    if (predicate.depth && !compareNumber(depth, predicate.depth.op, predicate.depth.value)) return { matched: false, reasons: [] };
    return { matched: true, reasons: [`${predicate.verb} ${predicate.targetId} depth ${depth}`] };
  }
  const count = reachable.size;
  const countRule = predicate.count ?? { op: ">" as CompareOp, value: 0 };
  return compareNumber(count, countRule.op, countRule.value)
    ? { matched: true, reasons: [`${predicate.verb} ${countRule.op} ${countRule.value} (${count})`] }
    : { matched: false, reasons: [] };
}

function fieldValues(field: FieldName, task: TaskView): string[] {
  if (field === "id") return [task.id];
  if (field === "id prefix") return [task.id];
  if (field === "tag") return task.tags.flatMap((tag) => [tag.id, tag.name]);
  if (field === "assigned") return task.assignedTrack ? [`${task.assignedTrack.machine}:${task.assignedTrack.actor}`, task.assignedTrack.actor] : [];
  if (field === "machine") return task.assignedTrack ? [task.assignedTrack.machine] : [];
  if (field === "actor") return task.assignedTrack ? [task.assignedTrack.actor] : [];
  if (field === "status") return [task.computedStatus];
  if (field === "lifecycle") return [task.lifecycle];
  if (field === "parent") return task.parentTaskId ? [task.parentTaskId] : ["root"];
  if (field === "source doc") return task.sourceDoc ? [task.sourceDoc] : [];
  if (field === "source section") return task.sourceSection ? [task.sourceSection] : [];
  if (field === "comments") return [String(task.commentCount)];
  return [String(task.priority), `P${task.priority}`];
}

function compareAny(values: string[], op: CompareOp, expected: string, field: FieldName): boolean {
  if (field === "id prefix") {
    return values.some((value) => op === "=" ? value.startsWith(expected) : op === "!=" ? !value.startsWith(expected) : false);
  }
  if (field === "priority" || field === "comments") {
    const expectedPriority = parsePriority(expected);
    return values.some((value) => compareNumber(parsePriority(value), op, expectedPriority));
  }
  return values.some((value) => op === "=" ? equalValue(value, expected, field) : op === "!=" ? !equalValue(value, expected, field) : false);
}

function equalValue(left: string, right: string, field: FieldName): boolean {
  if (field === "id" || field === "parent" || field === "tag") {
    return left.toUpperCase() === right.toUpperCase();
  }
  return left.toLowerCase() === right.toLowerCase();
}

function parsePriority(value: string): number {
  const normalized = value.toUpperCase().startsWith("P") ? value.slice(1) : value;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed)) {
    validation(`Invalid priority value: ${value}`);
  }
  return parsed;
}

function compareNumber(left: number, op: CompareOp, right: number): boolean {
  if (op === "=") return left === right;
  if (op === "!=") return left !== right;
  if (op === ">") return left > right;
  if (op === ">=") return left >= right;
  if (op === "<") return left < right;
  return left <= right;
}

interface ResolvedTime {
  start: Date;
  end?: Date;
}

function compareTime(left: Date, op: CompareOp, right: ResolvedTime): boolean {
  const leftMs = left.getTime();
  const startMs = right.start.getTime();
  const endMs = right.end?.getTime();
  if (op === "=") return endMs === undefined ? leftMs === startMs : leftMs >= startMs && leftMs < endMs;
  if (op === "!=") return endMs === undefined ? leftMs !== startMs : leftMs < startMs || leftMs >= endMs;
  if (op === ">") return leftMs > startMs;
  if (op === ">=") return leftMs >= startMs;
  if (op === "<") return leftMs < startMs;
  return leftMs <= startMs;
}

function resolveTimeExpression(expression: TimeExpression, now: Date): ResolvedTime {
  if (expression.type === "now") {
    return { start: now };
  }
  if (expression.type === "today") {
    const start = localDayStart(now);
    return { start, end: addDays(start, 1) };
  }
  if (expression.type === "relative") {
    return { start: new Date(now.getTime() - durationMs(expression.amount, expression.unit)) };
  }
  return parseAbsoluteTime(expression.value, expression.dateOnly);
}

function parseTaskTime(value: string, field: string): Date {
  const parsed = new Date(value.includes(" ") ? value.replace(" ", "T") : value);
  if (!Number.isFinite(parsed.getTime())) {
    validation(`Invalid ${field} timestamp: ${value}`);
  }
  return parsed;
}

function parseAbsoluteTime(value: string, dateOnly: boolean): ResolvedTime {
  if (dateOnly) {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      validation(`Invalid date value: ${value}`);
    }
    const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return { start, end: addDays(start, 1) };
  }
  const localDateTime = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  const parsed = localDateTime
    ? new Date(Number(localDateTime[1]), Number(localDateTime[2]) - 1, Number(localDateTime[3]), Number(localDateTime[4]), Number(localDateTime[5]), Number(localDateTime[6] ?? 0))
    : new Date(value.includes(" ") ? value.replace(" ", "T") : value);
  if (!Number.isFinite(parsed.getTime())) {
    validation(`Invalid time value: ${value}`);
  }
  return { start: parsed };
}

function localDayStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function durationMs(amount: number, unit: "m" | "h" | "d" | "w"): number {
  const minute = 60 * 1000;
  if (unit === "m") return amount * minute;
  if (unit === "h") return amount * 60 * minute;
  if (unit === "d") return amount * 24 * 60 * minute;
  return amount * 7 * 24 * 60 * minute;
}

function formatTimeExpression(expression: TimeExpression): string {
  if (expression.type === "absolute") return expression.value;
  if (expression.type === "now") return "now";
  if (expression.type === "today") return "today";
  return `now - ${expression.amount}${expression.unit}`;
}

function isTimeField(field: FieldName): field is TimeFieldName {
  return TIME_FIELDS.includes(field as TimeFieldName);
}

function isDescendantOf(task: TaskView, ancestorId: string, taskById: Map<string, TaskView>): boolean {
  let current: TaskView | null | undefined = task;
  while (current?.parentTaskId) {
    if (current.parentTaskId === ancestorId) return true;
    current = taskById.get(current.parentTaskId) ?? null;
  }
  return false;
}

function buildEffectiveGraph(tasks: TaskView[], dependencies: Dependency[]): Pick<EvalContext, "upstreamByTask" | "downstreamByTask"> {
  const taskIds = new Set(tasks.filter((task) => !task.archivedAt).map((task) => task.id));
  const upstreamByTask = new Map<string, Array<{ id: string; kind: "dependency" | "hierarchy" }>>();
  const downstreamByTask = new Map<string, Array<{ id: string; kind: "dependency" | "hierarchy" }>>();
  const addEdge = (from: string, to: string, kind: "dependency" | "hierarchy") => {
    if (!taskIds.has(from) || !taskIds.has(to)) return;
    upstreamByTask.set(from, [...(upstreamByTask.get(from) ?? []), { id: to, kind }]);
    downstreamByTask.set(to, [...(downstreamByTask.get(to) ?? []), { id: from, kind }]);
  };
  for (const dependency of dependencies) addEdge(dependency.taskId, dependency.dependsOnTaskId, "dependency");
  for (const task of tasks) {
    if (task.parentTaskId) addEdge(task.parentTaskId, task.id, "hierarchy");
  }
  return { upstreamByTask, downstreamByTask };
}

function reachableWithDepth(startId: string, graph: Map<string, Array<{ id: string; kind: "dependency" | "hierarchy" }>>): Map<string, number> {
  const result = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = (graph.get(startId) ?? []).map((edge) => ({ id: edge.id, depth: 1 }));
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const previousDepth = result.get(current.id);
    if (previousDepth !== undefined && previousDepth <= current.depth) continue;
    result.set(current.id, current.depth);
    for (const edge of graph.get(current.id) ?? []) {
      queue.push({ id: edge.id, depth: current.depth + 1 });
    }
  }
  result.delete(startId);
  return result;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index] as string;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "(") {
      tokens.push({ kind: "lparen", value: char, offset: index++ });
      continue;
    }
    if (char === ")") {
      tokens.push({ kind: "rparen", value: char, offset: index++ });
      continue;
    }
    if (char === ",") {
      tokens.push({ kind: "comma", value: char, offset: index++ });
      continue;
    }
    if (char === "\"" || char === "'") {
      const quote = char;
      const start = index;
      index += 1;
      let value = "";
      while (index < input.length && input[index] !== quote) {
        value += input[index] as string;
        index += 1;
      }
      if (input[index] !== quote) validation("Unterminated quoted string in instruction query.");
      index += 1;
      tokens.push({ kind: "string", value, offset: start });
      continue;
    }
    const two = input.slice(index, index + 2);
    if (two === ">=" || two === "<=" || two === "!=") {
      tokens.push({ kind: "op", value: two, offset: index });
      index += 2;
      continue;
    }
    if (char === "=" || char === ">" || char === "<") {
      tokens.push({ kind: "op", value: char, offset: index++ });
      continue;
    }
    if (char === "-") {
      const next = input[index + 1];
      if (!next || /\s/.test(next)) {
        tokens.push({ kind: "op", value: char, offset: index++ });
        continue;
      }
    }
    const start = index;
    while (index < input.length && !/[\s(),=<>!]/.test(input[index] as string)) {
      index += 1;
    }
    const value = input.slice(start, index);
    tokens.push({ kind: /^\d+$/.test(value) ? "number" : "word", value, offset: start });
  }
  tokens.push({ kind: "eof", value: "", offset: input.length });
  return tokens;
}
