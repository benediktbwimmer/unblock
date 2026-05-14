export type Lifecycle = "open" | "started" | "finished";
export type ComputedStatus = "ready" | "blocked" | "started" | "finished" | "archived";
export type RollupStatus = "leaf" | "complete" | "blocked-by-children";
export type Size = "XS" | "S" | "M" | "L" | "XL";
export type Priority = 0 | 1 | 2 | 3 | 4;

export interface TagRecord {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
  sortOrder: number;
  archivedAt: string | null;
}

export interface TrackRecord {
  id: string;
  machine: string;
  actor: string;
  name: string | null;
  archivedAt: string | null;
}

export interface ProjectRecord {
  id: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
}

export interface TaskView {
  id: string;
  parentTaskId: string | null;
  title: string;
  description: string;
  lifecycle: Lifecycle;
  computedStatus: ComputedStatus;
  priority: Priority;
  size: Size | null;
  sourceDoc: string | null;
  sourceSection: string | null;
  completionBar: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  archivedAt: string | null;
  ready: boolean;
  blocked: boolean;
  unfinishedDependenciesCount: number;
  finishedDependenciesCount: number;
  dependencyDepth: number;
  dependentsCount: number;
  transitiveDependentsCount: number;
  parent: { id: string; title: string; lifecycle: Lifecycle } | null;
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
  rollupStatus?: RollupStatus;
  unfinishedDescendantsCount?: number;
  criticalChildPath?: Array<{
    id: string;
    title: string;
    lifecycle: Lifecycle;
    computedStatus: ComputedStatus;
    unfinishedDependenciesCount: number;
  }>;
  assignedTrack: { trackId: string; machine: string; actor: string; name: string | null; position: string } | null;
  tags: TagRecord[];
  commentCount: number;
  recentCommentCount: number;
  lastCommentAt: string | null;
  commentAuthors: string[];
}

export interface Explanation {
  task: TaskView;
  dependencies: TaskView[];
  unfinishedDependencies: TaskView[];
  finishedDependencies: TaskView[];
  directDependents: TaskView[];
  transitiveDependentsCount: number;
  assignable: boolean;
  reason: string;
  instructions: InstructionMatchRecord[];
}

export interface InstructionRecord {
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

export interface InstructionMatchRecord {
  instruction: InstructionRecord;
  task: TaskView;
  reasons: string[];
}

export interface CommentRecord {
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

export interface MatcherPreviewRecord {
  ok: boolean;
  errors: string[];
  matches: InstructionMatchRecord[];
}

export interface MatcherGrammarRecord {
  fields: string[];
  fieldOperators: string[];
  comparisonOperators: string[];
  booleanOperators: string[];
  graphVerbs: string[];
  edgeKinds: string[];
  valueForms: Array<{ name: string; description: string }>;
  clauses: Array<{ name: string; forms: string[]; description: string }>;
  examples: string[];
  notes: string[];
}

export interface MatcherFieldValueSuggestionRecord {
  field: string;
  value: string;
  label: string;
  detail: string;
  count: number;
}

export interface SavedViewRecord {
  projectId: string;
  id: string;
  name: string;
  query: string;
  archivedAt: string | null;
}

export interface QueueFeedRecord {
  projectId: string;
  id: string;
  name: string;
  query: string;
  archivedAt: string | null;
}

export interface ActivityRecord {
  id: string;
  type: string;
  subjectType: string;
  subjectId: string | null;
  message: string;
  data: Record<string, unknown>;
  machine: string;
  actor: string;
  createdAt: string;
  task: TaskView | null;
}

export interface SourceCoverage {
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

export type ViewMode = "tasks" | "queues" | "tags" | "instructions" | "connectors" | "coverage" | "activity";
export type StatusFilter = ComputedStatus;
export type TaskAction = "start" | "finish" | "reopen" | "archive" | "restore";

export interface AppConfig {
  identity: {
    machine: string;
    actor: string;
  };
  ui: {
    refreshIntervalMs: number;
    persistState: boolean;
  };
  issues?: string[];
}

export interface UiState {
  mode: ViewMode;
  projectId: string;
  selectedId: string | null;
  statusFilters: StatusFilter[];
  search: string;
  matcher: string;
  selectedViewId: string;
  collapsedTaskIds: string[];
  scrollPositions: Record<string, number>;
  newProjectDraft: string;
  newTrackDraft: string;
  newTagDraft: string;
}

export interface RefreshOptions {
  silent?: boolean;
}

export interface AppliedTaskFilters {
  statusFilters: StatusFilter[];
  search: string;
  matcher: string;
}

export interface DependencyMode {
  targetIds: string[];
  draftByTaskId: Record<string, string[]>;
  dependencyMap: Record<string, string[]>;
  loading: boolean;
}

export interface CreateTaskDraft {
  parentTaskId: string | null;
  id: string;
  title: string;
  priority: string;
}

export interface GitHubConnectionRecord {
  projectId: string;
  id: string;
  provider: "github";
  displayName: string;
  status: "active" | "paused" | "error" | "archived";
  updatedAt: string;
  lastSyncAt: string | null;
  lastErrorAt: string | null;
  metadata: {
    authModel: "github_app_installation";
    appId: string;
    installationId: string;
    repositoryOwner: string;
    repositoryName: string;
    privateKeySecretId: string;
    webhookSecretId: string;
    syncDirection: "github_to_unblock" | "unblock_to_github" | "bidirectional";
    conflictPolicy: "github_wins" | "unblock_wins" | "last_writer_wins" | "operator_review";
    requiredPermissions: Record<string, string>;
    subscribeEvents: string[];
  };
}

export interface DependencyCandidateState {
  selected: boolean;
  disabled: boolean;
  reason: string | null;
}

export const UI_STATE_KEY = "unblock.ui-state.v1";
export const STATUS_FILTER_ORDER: StatusFilter[] = ["ready", "blocked", "started", "finished", "archived"];
export const DEFAULT_STATUS_FILTERS: StatusFilter[] = ["ready", "blocked", "started"];
export const DEFAULT_APP_CONFIG: AppConfig = {
  identity: {
    machine: "",
    actor: ""
  },
  ui: {
    refreshIntervalMs: 5000,
    persistState: true
  },
  issues: []
};
export const DEFAULT_UI_STATE: UiState = {
  mode: "tasks",
  projectId: "DEFAULT",
  selectedId: null,
  statusFilters: DEFAULT_STATUS_FILTERS,
  search: "",
  matcher: "",
  selectedViewId: "",
  collapsedTaskIds: [],
  scrollPositions: {},
  newProjectDraft: "",
  newTrackDraft: "",
  newTagDraft: ""
};
