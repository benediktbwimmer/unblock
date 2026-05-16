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
export type RollupStatus = "leaf" | "complete" | "blocked-by-children";
export type SubjectType = "project" | "task" | "comment" | "tag" | "track" | "instruction" | "view" | "feed" | "import" | "export" | "system" | "tenant" | "auth" | "connector" | "secret" | "audit";
export type OutputFormat = "table" | "json" | "markdown";
export type TaskSort = "dependency" | "priority" | "depth" | "created" | "updated" | "id" | "title";

export const DEFAULT_PROJECT_ID = "DEFAULT";

export interface Project {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface Task {
  projectId: string;
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
  projectId: string;
  taskId: string;
  dependsOnTaskId: string;
  createdAt: string;
}

export interface Comment {
  projectId: string;
  id: string;
  taskId: string;
  machine: string;
  actor: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface Tag {
  projectId: string;
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
  projectId: string;
  taskId: string;
  tagId: string;
  createdAt: string;
}

export interface Track {
  projectId: string;
  id: string;
  machine: string;
  actor: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface TrackAssignment {
  projectId: string;
  trackId: string;
  taskId: string;
  position: string;
  assignedAt: string;
}

export interface Activity {
  projectId: string | null;
  id: string;
  type: string;
  subjectType: SubjectType;
  subjectId: string | null;
  message: string;
  data: Record<string, unknown>;
  machine: string;
  actor: string;
  createdAt: string;
}

export interface ActivityView extends Activity {
  task: TaskView | null;
}

export type HostedRole = "owner" | "admin" | "security_admin" | "connector_admin" | "member" | "viewer";

export type HostedPermission =
  | "tenant:admin"
  | "tenant:audit:read"
  | "tenant:secrets:manage"
  | "project:admin"
  | "project:write"
  | "project:read"
  | "connector:admin"
  | "connector:sync"
  | "operator:read";

export interface HostedIdentity {
  tenantId: string;
  principalId: string;
  organizationId: string;
  sessionId: string | null;
  roles: HostedRole[];
  permissions: HostedPermission[];
  issuedBy: "workos" | "trusted_headers" | "test";
  rawClaims?: Record<string, unknown> | undefined;
}

export interface HostedAuditEvent {
  tenantId: string;
  projectId: string | null;
  id: string;
  eventType: string;
  principalId: string | null;
  subjectType: SubjectType;
  subjectId: string | null;
  message: string;
  data: Record<string, unknown>;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface HostedSecret {
  tenantId: string;
  projectId: string | null;
  id: string;
  name: string;
  purpose: string;
  ciphertext: string;
  keyId: string;
  algorithm: string;
  createdAt: string;
  updatedAt: string;
  rotatedAt: string | null;
  archivedAt: string | null;
}

export type ConnectorConnectionStatus = "active" | "paused" | "error" | "archived";
export type ConnectorSyncRunStatus = "queued" | "running" | "succeeded" | "failed" | "dead_letter" | "operator_review";
export type ConnectorSyncRunType = "outbound" | "inbound" | "reconciliation" | "cursor_recovery";
export type ConnectorMappingStatus = "active" | "conflict" | "operator_review" | "archived";
export type ConnectorSyncDirection = "github_to_unblock" | "unblock_to_github" | "bidirectional";
export type ConnectorConflictPolicy = "github_wins" | "unblock_wins" | "last_writer_wins" | "operator_review";
export type PrincipalKind = "user" | "team" | "service_account" | "bot";
export type ExternalIdentityConfidence = "verified" | "inferred" | "unmapped";
export type TaskResponsibilityRole = "owner" | "reviewer" | "watcher";
export type DelegationTargetKind = "track" | "actor_pool" | "principal";
export type ConnectorSyncPreset = "mirror_external_work" | "execution_layer" | "bidirectional_project_sync";
export type ConnectorFieldSyncMode = "disabled" | "manual" | "inbound_only" | "outbound_only" | "bidirectional" | "append_only" | "unblock_owned" | "external_owned";
export type ConnectorFieldConflictPolicy = "external_wins" | "unblock_wins" | "last_writer_wins" | "manual_review" | "blocked";
export type ConnectorSyncDecisionKind = "noop" | "apply_inbound" | "apply_outbound" | "manual_review" | "ignore" | "blocked";
export type ConnectorSyncQueueItemStatus = "pending" | "auto_applying" | "blocked" | "manual_review" | "ignored" | "resolved" | "failed";
export type ConnectorSyncQueueSeverity = "info" | "warning" | "error";

export interface Principal {
  tenantId: string;
  id: string;
  kind: PrincipalKind;
  displayName: string;
  email: string | null;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
}

export interface ExternalIdentity {
  tenantId: string;
  connectionId: string;
  provider: string;
  externalKind: "user" | "team" | "bot" | "service_account";
  externalId: string;
  externalDisplayName: string | null;
  externalEmail: string | null;
  principalId: string | null;
  confidence: ExternalIdentityConfidence;
  createdAt: string;
  updatedAt: string;
}

export interface TaskResponsibility {
  tenantId: string;
  projectId: string;
  taskId: string;
  principalId: string;
  role: TaskResponsibilityRole;
  source: "manual" | "connector" | "delegation";
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface DelegationRule {
  tenantId: string;
  projectId: string;
  id: string;
  principalId: string;
  targetKind: DelegationTargetKind;
  targetId: string;
  scopeQuery: string | null;
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ConnectorFieldPolicy {
  field: string;
  mode: ConnectorFieldSyncMode;
  conflictPolicy?: ConnectorFieldConflictPolicy | undefined;
  outboundAction?: string | null | undefined;
  requiredExternalDefaults?: Record<string, unknown> | undefined;
  notes?: string | undefined;
}

export interface ConnectorSyncPolicy {
  preset: ConnectorSyncPreset;
  provider: string;
  objectKind: string;
  fields: Record<string, ConnectorFieldPolicy>;
}

export interface ConnectorSyncPolicyRecord {
  projectId: string;
  id: string;
  connectionId: string;
  name: string;
  scopeQuery: string | null;
  priority: number;
  enabled: boolean;
  policy: ConnectorSyncPolicy;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ConnectorFieldDiff {
  field: string;
  externalValue: unknown;
  localValue: unknown;
  externalVersion?: string | null | undefined;
  localVersion?: string | null | undefined;
  externalUpdatedAt?: string | null | undefined;
  localUpdatedAt?: string | null | undefined;
  reason?: string | undefined;
}

export interface ConnectorSyncDecision {
  kind: ConnectorSyncDecisionKind;
  field: string;
  policy: ConnectorFieldPolicy;
  reason: string;
  confidence: "high" | "medium" | "low";
  diff?: ConnectorFieldDiff | undefined;
  proposedValue?: unknown;
  blockedBy?: string | undefined;
}

export interface ConnectorSyncQueueItem {
  projectId: string;
  id: string;
  connectionId: string;
  mappingId: string | null;
  externalKind: string;
  externalId: string;
  localKind: string;
  localId: string;
  status: ConnectorSyncQueueItemStatus;
  severity: ConnectorSyncQueueSeverity;
  detectedAt: string;
  resolvedAt: string | null;
  decision: ConnectorSyncDecision;
  externalSnapshot: Record<string, unknown>;
  localSnapshot: Record<string, unknown>;
  diff: ConnectorFieldDiff;
  policyRef: {
    preset: ConnectorSyncPreset;
    policyId: string | null;
    scopeQuery: string | null;
  };
  error: Record<string, unknown> | null;
}

export interface ConnectorConnection {
  projectId: string;
  id: string;
  provider: string;
  displayName: string;
  status: ConnectorConnectionStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  lastSyncAt: string | null;
  lastErrorAt: string | null;
  metadata: Record<string, unknown>;
}

export interface ConnectorCursorRecord {
  projectId: string;
  connectionId: string;
  name: string;
  value: string;
  observedAt: string;
  updatedAt: string;
}

export interface ConnectorSyncRun {
  projectId: string;
  id: string;
  connectionId: string;
  runType: ConnectorSyncRunType;
  status: ConnectorSyncRunStatus;
  startedAt: string;
  finishedAt: string | null;
  error: Record<string, unknown> | null;
  evidence: Record<string, unknown>;
}

export interface ConnectorExternalMapping {
  projectId: string;
  connectionId: string;
  provider: string;
  externalKind: string;
  externalId: string;
  externalUrl: string | null;
  externalVersion: string | null;
  localKind: string;
  localId: string;
  localVersion: string | null;
  syncDirection: ConnectorSyncDirection;
  conflictPolicy: ConnectorConflictPolicy;
  status: ConnectorMappingStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  metadata: Record<string, unknown>;
}

export interface ConnectorObservabilitySnapshot {
  projectId: string | null;
  generatedAt: string;
  connections: Array<ConnectorConnection & {
    cursors: ConnectorCursorRecord[];
    recentRuns: ConnectorSyncRun[];
    retryCount: number;
    deadLetterCount: number;
    lastSuccessAt: string | null;
    lagMs: number | null;
  }>;
}

export interface Instruction {
  projectId: string;
  id: string;
  name: string;
  query: string;
  body: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface SavedView {
  projectId: string;
  id: string;
  name: string;
  query: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface QueueFeed {
  projectId: string;
  id: string;
  name: string;
  query: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface Migration {
  id: string;
  name: string;
  appliedAt: string;
}

export type OutboxEventStatus = "pending" | "claimed" | "processed" | "failed" | "dead";
export type InboxEventStatus = "received" | "applying" | "applied" | "failed" | "dead";

export interface OutboxEvent {
  projectId: string | null;
  id: string;
  eventType: string;
  subjectType: string;
  subjectId: string | null;
  payload: Record<string, unknown>;
  idempotencyKey: string | null;
  status: OutboxEventStatus;
  attemptCount: number;
  availableAt: string;
  createdAt: string;
  claimedAt: string | null;
  processedAt: string | null;
  error: Record<string, unknown> | null;
  evidence: Record<string, unknown>;
}

export interface InboxEvent {
  projectId: string | null;
  id: string;
  source: string;
  externalEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: InboxEventStatus;
  appliedAt: string | null;
  createdAt: string;
  error: Record<string, unknown> | null;
  evidence: Record<string, unknown>;
}

export interface AssignedTrackView {
  trackId: string;
  machine: string;
  actor: string;
  name: string | null;
  position: string;
}

export interface ParentTaskSummary {
  id: string;
  title: string;
  lifecycle: Lifecycle;
}

export interface TaskPathSummary {
  id: string;
  title: string;
  lifecycle: Lifecycle;
  computedStatus: ComputedStatus;
  unfinishedDependenciesCount: number;
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
  rollupStatus: RollupStatus;
  unfinishedDescendantsCount: number;
  criticalChildPath: TaskPathSummary[];
  assignedTrack: AssignedTrackView | null;
  tags: Tag[];
  commentCount: number;
  recentCommentCount: number;
  lastCommentAt: string | null;
  commentAuthors: string[];
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
  instructions: InstructionMatch[];
}

export interface InstructionMatch {
  instruction: Instruction;
  task: TaskView;
  reasons: string[];
}

export interface AddInstructionInput {
  id?: string;
  name: string;
  query: string;
  body: string;
  enabled?: boolean;
}

export interface EditInstructionInput {
  name?: string;
  query?: string;
  body?: string;
  enabled?: boolean;
}

export interface AddSavedViewInput {
  id?: string;
  name: string;
  query: string;
}

export interface EditSavedViewInput {
  name?: string;
  query?: string;
}

export interface AddQueueFeedInput {
  id?: string;
  name: string;
  query: string;
}

export interface EditQueueFeedInput {
  name?: string;
  query?: string;
}

export interface AddCommentInput {
  body: string;
}

export interface EditCommentInput {
  body?: string;
}

export interface ReleaseTaskInput {
  reason: string;
}

export interface MatcherPreview {
  ok: boolean;
  query: string;
  errors: string[];
  matches: InstructionMatch[];
}

export interface MatcherFieldValueSuggestion {
  field: string;
  value: string;
  label: string;
  detail: string;
  count: number;
}

export interface TaskListFilters {
  search?: string;
  where?: string;
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

export interface ActivityListOptions {
  limit?: number;
  where?: string;
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

export interface AddProjectInput {
  id: string;
  name?: string;
  description?: string | null;
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
  machine?: string;
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
  instructionsCreated: number;
  instructionsUpdated: number;
  commentsCreated: number;
  commentsUpdated: number;
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
  instructions?: Instruction[];
  views?: SavedView[];
  feeds?: QueueFeed[];
  comments?: Comment[];
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

export function defaultUnblockDir(): string {
  return join(homedir(), ".unblock");
}

export function defaultUnblockDbPath(): string {
  return join(defaultUnblockDir(), "unblock.sqlite");
}

export function defaultUnblockConfigPath(): string {
  return join(defaultUnblockDir(), "config.json");
}
