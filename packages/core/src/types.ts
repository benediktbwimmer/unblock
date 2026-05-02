import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";

export const lifecycleSchema = z.enum(["open", "started", "finished"]);
export const sizeSchema = z.enum(["XS", "S", "M", "L", "XL"]);
export const prioritySchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4)
]);

export type Lifecycle = z.infer<typeof lifecycleSchema>;
export type TaskSize = z.infer<typeof sizeSchema>;
export type Priority = z.infer<typeof prioritySchema>;

export type ComputedStatus = "ready" | "blocked" | "started" | "finished" | "archived";
export type SubjectType = "task" | "tag" | "track" | "import" | "export" | "system";
export type OutputFormat = "table" | "json" | "markdown";
export type TaskSort = "dependency" | "priority" | "depth" | "created" | "updated" | "id" | "title";

export interface Task {
  id: string;
  parentTaskId: string | null;
  title: string;
  description: string;
  lifecycle: Lifecycle;
  priority: Priority;
  size: TaskSize | null;
  sourceDoc: string | null;
  sourceSection: string | null;
  sourceAnchor: string | null;
  sourceLine: number | null;
  sourceText: string | null;
  completionBar: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  archivedAt: string | null;
  version: number;
}

export interface Dependency {
  taskId: string;
  dependsOnTaskId: string;
  createdAt: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface TaskTag {
  taskId: string;
  tagId: string;
  createdAt: string;
}

export interface Track {
  id: string;
  actor: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface TrackAssignment {
  trackId: string;
  taskId: string;
  position: string;
  assignedAt: string;
}

export interface Activity {
  id: string;
  type: string;
  subjectType: SubjectType;
  subjectId: string | null;
  message: string;
  data: Record<string, unknown>;
  actor: string | null;
  createdAt: string;
}

export interface Migration {
  id: string;
  name: string;
  appliedAt: string;
}

export interface AssignedTrackView {
  trackId: string;
  actor: string;
  name: string | null;
  position: string;
}

export interface ParentTaskSummary {
  id: string;
  title: string;
  lifecycle: Lifecycle;
}

export interface TaskView extends Task {
  computedStatus: ComputedStatus;
  ready: boolean;
  blocked: boolean;
  unfinishedDependenciesCount: number;
  finishedDependenciesCount: number;
  dependencyDepth: number;
  dependentsCount: number;
  transitiveDependentsCount: number;
  parent: ParentTaskSummary | null;
  childrenCount: number;
  descendantsCount: number;
  leafDescendantsCount: number;
  finishedLeafDescendantsCount: number;
  subtreeProgress: number;
  subtreeOpenCount: number;
  subtreeReadyCount: number;
  subtreeBlockedCount: number;
  subtreeStartedCount: number;
  subtreeFinishedCount: number;
  hierarchyDepth: number;
  assignedTrack: AssignedTrackView | null;
  tags: Tag[];
}

export interface DependencyExplanation {
  task: TaskView;
  dependencies: TaskView[];
  unfinishedDependencies: TaskView[];
  finishedDependencies: TaskView[];
  directDependents: TaskView[];
  transitiveDependentsCount: number;
  assignable: boolean;
  reason: string;
}

export interface TaskListFilters {
  search?: string;
  status?: ComputedStatus | "open";
  lifecycle?: Lifecycle;
  priorityMin?: Priority;
  priorityMax?: Priority;
  size?: TaskSize;
  parentTaskId?: string | null;
  sourceDoc?: string;
  sourceSection?: string;
  tag?: string;
  assignedActor?: string;
  includeFinished?: boolean;
  includeArchived?: boolean;
  sort?: TaskSort;
}

export interface SourceSectionCoverage {
  sourceDoc: string | null;
  sourceSection: string | null;
  total: number;
  open: number;
  ready: number;
  blocked: number;
  started: number;
  finished: number;
  archived: number;
}

export interface TagCoverage {
  tag: Tag | null;
  total: number;
  open: number;
  ready: number;
  blocked: number;
  started: number;
  finished: number;
}

export interface AddTaskInput {
  id: string;
  parentTaskId?: string | null;
  title: string;
  description?: string;
  lifecycle?: Lifecycle;
  priority?: Priority;
  size?: TaskSize | null;
  sourceDoc?: string | null;
  sourceSection?: string | null;
  sourceAnchor?: string | null;
  sourceLine?: number | null;
  sourceText?: string | null;
  completionBar?: string | null;
}

export interface EditTaskInput {
  parentTaskId?: string | null;
  title?: string;
  description?: string;
  lifecycle?: Lifecycle;
  priority?: Priority;
  size?: TaskSize | null;
  sourceDoc?: string | null;
  sourceSection?: string | null;
  sourceAnchor?: string | null;
  sourceLine?: number | null;
  sourceText?: string | null;
  completionBar?: string | null;
}

export interface AddTagInput {
  id?: string;
  name: string;
  color?: string | null;
  description?: string | null;
  sortOrder?: number;
}

export interface AddTrackInput {
  id?: string;
  actor: string;
  name?: string | null;
}

export interface ImportIssue {
  line: number;
  message: string;
  source: string;
}

export interface ImportedMarkdownTask {
  id: string;
  parentTaskId: string | null;
  title: string;
  lifecycle: Lifecycle;
  sourceDoc: string | null;
  sourceSection: string | null;
  sourceLine: number;
  sourceText: string;
  completionBar: string | null;
  assignee: string | null;
}

export interface MarkdownImportPlan {
  filePath: string;
  tasks: ImportedMarkdownTask[];
  issues: ImportIssue[];
}

export interface ImportResult {
  created: number;
  updated: number;
  assigned: number;
  skipped: number;
  issues: ImportIssue[];
}

export interface JsonImportResult {
  tasksCreated: number;
  tasksUpdated: number;
  tagsCreated: number;
  tagsUpdated: number;
  tracksCreated: number;
  tracksUpdated: number;
  dependenciesAdded: number;
  taskTagsAdded: number;
  assignmentsAdded: number;
  skipped: number;
  issues: ImportIssue[];
}

export interface JsonExport {
  tasks: Task[];
  dependencies: Dependency[];
  tags: Tag[];
  taskTags: TaskTag[];
  tracks: Track[];
  assignments: TrackAssignment[];
  activity?: Activity[];
}

export const taskIdSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const taskTitleSchema = z.string().trim().min(1).max(500);
export const nullableTextSchema = z.string().trim().max(2000).nullable();

export const addTaskSchema = z.object({
  id: taskIdSchema,
  parentTaskId: taskIdSchema.nullable().default(null),
  title: taskTitleSchema,
  description: z.string().default(""),
  lifecycle: lifecycleSchema.default("open"),
  priority: prioritySchema.default(2),
  size: sizeSchema.nullable().default(null),
  sourceDoc: nullableTextSchema.default(null),
  sourceSection: nullableTextSchema.default(null),
  sourceAnchor: nullableTextSchema.default(null),
  sourceLine: z.number().int().positive().nullable().default(null),
  sourceText: z.string().nullable().default(null),
  completionBar: z.string().nullable().default(null)
});

export const editTaskSchema = z.object({
  parentTaskId: taskIdSchema.nullable().optional(),
  title: taskTitleSchema.optional(),
  description: z.string().optional(),
  lifecycle: lifecycleSchema.optional(),
  priority: prioritySchema.optional(),
  size: sizeSchema.nullable().optional(),
  sourceDoc: nullableTextSchema.optional(),
  sourceSection: nullableTextSchema.optional(),
  sourceAnchor: nullableTextSchema.optional(),
  sourceLine: z.number().int().positive().nullable().optional(),
  sourceText: z.string().nullable().optional(),
  completionBar: z.string().nullable().optional()
});

export function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeId(value: string): string {
  return value.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._:-]/g, "").toUpperCase();
}

export function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/`/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug.length > 0 ? slug : "item";
}

export function priorityLabel(priority: Priority): string {
  switch (priority) {
    case 0:
      return "someday";
    case 1:
      return "low";
    case 2:
      return "normal";
    case 3:
      return "high";
    case 4:
      return "urgent";
  }
}

export function defaultNotJiraDir(): string {
  return join(homedir(), ".not-jira");
}

export function defaultNotJiraDbPath(): string {
  return join(defaultNotJiraDir(), "not-jira.sqlite");
}
