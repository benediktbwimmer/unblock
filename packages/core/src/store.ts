import type {
  Activity,
  Comment,
  Dependency,
  HostedAuditEvent,
  HostedIdentity,
  HostedSecret,
  Migration,
  Project,
  QueueFeed,
  SavedView,
  Tag,
  Task,
  TaskTag,
  TaskListFilters,
  Track,
  TrackAssignment,
  Instruction,
  OutboxEvent,
  InboxEvent
} from "./types.js";

export type StoreDialect = "memory" | "sqlite" | "postgres" | "hosted" | "prism";

export interface StoreCapabilities {
  dialect: StoreDialect;
  transactionalWrites: boolean;
  coreDomain: boolean;
  comments: boolean;
  matcherQuery: "service" | "store";
  bulkOperations: boolean;
  outboxInbox: boolean;
}

export interface ProjectRepository {
  list(): Promise<Project[]>;
  get(id: string): Promise<Project | null>;
  create(project: Project): Promise<void>;
  update(project: Project): Promise<void>;
}

export interface TaskRepository {
  list(projectId?: string): Promise<Task[]>;
  get(projectId: string, id: string): Promise<Task | null>;
  create(task: Task): Promise<void>;
  createMany?(tasks: Task[]): Promise<void>;
  update(task: Task): Promise<void>;
  updateWithPrevious?(previous: Task, task: Task): Promise<void>;
  delete(projectId: string, id: string): Promise<void>;
}

export interface DependencyRepository {
  list(projectId?: string): Promise<Dependency[]>;
  listForTask(projectId: string, taskId: string): Promise<Dependency[]>;
  listDependents(projectId: string, dependsOnTaskId: string): Promise<Dependency[]>;
  inspectAdd?(projectId: string, taskId: string, dependsOnTaskId: string): Promise<{
    task: { id: string; archivedAt: string | null } | null;
    dependsOnTask: { id: string; archivedAt: string | null } | null;
    exists: boolean;
    createsDependencyCycle: boolean;
    taskContainsDependsOnTask: boolean;
    dependsOnTaskContainsTask: boolean;
  }>;
  hasDependency?(projectId: string, taskId: string, dependsOnTaskId: string): Promise<boolean>;
  hasDependencyPath?(projectId: string, fromTaskId: string, toTaskId: string): Promise<boolean>;
  hasHierarchyPath?(projectId: string, ancestorTaskId: string, descendantTaskId: string): Promise<boolean>;
  add(dependency: Dependency): Promise<void>;
  addMany?(dependencies: Dependency[]): Promise<void>;
  remove(projectId: string, taskId: string, dependsOnTaskId: string): Promise<void>;
  replaceForTask(projectId: string, taskId: string, dependencies: Dependency[]): Promise<void>;
}

export interface CommentRepository {
  list(projectId?: string): Promise<Comment[]>;
  listForTask(projectId: string, taskId: string): Promise<Comment[]>;
  get(projectId: string, id: string): Promise<Comment | null>;
  create(comment: Comment): Promise<void>;
  createMany?(comments: Comment[]): Promise<void>;
  update(comment: Comment): Promise<void>;
}

export interface TagRepository {
  list(projectId?: string): Promise<Tag[]>;
  get(projectId: string, id: string): Promise<Tag | null>;
  findByName(projectId: string, name: string): Promise<Tag | null>;
  create(tag: Tag): Promise<void>;
  createMany?(tags: Tag[]): Promise<void>;
  update(tag: Tag): Promise<void>;
  listTaskTags(projectId?: string): Promise<TaskTag[]>;
  hasTaskTag?(projectId: string, taskId: string, tagId: string): Promise<boolean>;
  addTaskTag(taskTag: TaskTag): Promise<void>;
  addTaskTags?(assignments: Array<{ taskTag: TaskTag; tag?: Tag | null }>): Promise<void>;
  removeTaskTag(projectId: string, taskId: string, tagId: string): Promise<void>;
}

export interface TrackRepository {
  list(projectId?: string): Promise<Track[]>;
  get(projectId: string, id: string): Promise<Track | null>;
  findByActor(projectId: string, machine: string, actor: string): Promise<Track | null>;
  create(track: Track): Promise<void>;
  update(track: Track): Promise<void>;
  listAssignments(projectId?: string): Promise<TrackAssignment[]>;
  assign(assignment: TrackAssignment): Promise<void>;
  unassign(projectId: string, trackId: string, taskId: string): Promise<void>;
  updateAssignment(assignment: TrackAssignment): Promise<void>;
}

export interface ActivityRepository {
  list(projectId?: string | null, limit?: number): Promise<Activity[]>;
  version?(projectId?: string | null): Promise<string>;
  append(activity: Activity): Promise<void>;
  appendMany?(activity: Activity[]): Promise<void>;
}

export interface InstructionRepository {
  list(projectId?: string): Promise<Instruction[]>;
  get(projectId: string, id: string): Promise<Instruction | null>;
  create(instruction: Instruction): Promise<void>;
  createMany?(instructions: Instruction[]): Promise<void>;
  update(instruction: Instruction): Promise<void>;
}

export interface SavedViewRepository {
  list(projectId?: string): Promise<SavedView[]>;
  get(projectId: string, id: string): Promise<SavedView | null>;
  create(view: SavedView): Promise<void>;
  update(view: SavedView): Promise<void>;
}

export interface QueueFeedRepository {
  list(projectId?: string): Promise<QueueFeed[]>;
  get(projectId: string, id: string): Promise<QueueFeed | null>;
  create(feed: QueueFeed): Promise<void>;
  update(feed: QueueFeed): Promise<void>;
}

export interface MigrationRepository {
  list(): Promise<Migration[]>;
  markApplied(migration: Migration): Promise<void>;
}

export interface OutboxEventRepository {
  enqueue(event: OutboxEvent): Promise<OutboxEvent>;
  get(id: string): Promise<OutboxEvent | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<OutboxEvent | null>;
  listReady(limit: number, now: string): Promise<OutboxEvent[]>;
  claim(id: string, claimedAt: string): Promise<OutboxEvent | null>;
  markProcessed(id: string, processedAt: string, evidence?: Record<string, unknown>): Promise<OutboxEvent | null>;
  markFailed(id: string, error: Record<string, unknown>, availableAt: string, evidence?: Record<string, unknown>): Promise<OutboxEvent | null>;
  markDead(id: string, error: Record<string, unknown>, evidence?: Record<string, unknown>): Promise<OutboxEvent | null>;
}

export interface InboxEventRepository {
  receive(event: InboxEvent): Promise<{ event: InboxEvent; created: boolean }>;
  get(id: string): Promise<InboxEvent | null>;
  findBySource(source: string, externalEventId: string): Promise<InboxEvent | null>;
  markApplying(id: string): Promise<InboxEvent | null>;
  markApplied(id: string, appliedAt: string, evidence?: Record<string, unknown>): Promise<InboxEvent | null>;
  markFailed(id: string, error: Record<string, unknown>, evidence?: Record<string, unknown>): Promise<InboxEvent | null>;
  markDead(id: string, error: Record<string, unknown>, evidence?: Record<string, unknown>): Promise<InboxEvent | null>;
}

export interface HostedIdentityRepository {
  sync(identity: HostedIdentity): Promise<void>;
  tenantRole(principalId: string): Promise<string | null>;
  projectRole(projectId: string, principalId: string): Promise<string | null>;
}

export interface HostedAuditRepository {
  append(event: HostedAuditEvent): Promise<void>;
  list(options?: {
    tenantId?: string | undefined;
    projectId?: string | null | undefined;
    limit?: number | undefined;
  }): Promise<HostedAuditEvent[]>;
}

export interface HostedSecretRepository {
  create(secret: HostedSecret): Promise<void>;
  get(id: string): Promise<HostedSecret | null>;
  list(projectId?: string | null | undefined): Promise<HostedSecret[]>;
  findByName(projectId: string | null, name: string): Promise<HostedSecret | null>;
  update(secret: HostedSecret): Promise<void>;
  archive(id: string, archivedAt: string): Promise<void>;
}

export interface MatcherQueryRepository {
  matchTaskIds(projectId: string, query: string, filters?: Omit<TaskListFilters, "where">): Promise<string[]>;
  matchingInstructionIds?(
    projectId: string,
    filters?: Omit<TaskListFilters, "where">
  ): Promise<Array<{ instructionId: string; taskId: string }>>;
  matchTaskIdsByInstructionQuery?(
    projectId: string,
    instructions: Instruction[],
    filters?: Omit<TaskListFilters, "where">
  ): Promise<Map<string, string[]>>;
}

export interface RepositorySet {
  projects: ProjectRepository;
  tasks: TaskRepository;
  dependencies: DependencyRepository;
  comments: CommentRepository;
  tags: TagRepository;
  tracks: TrackRepository;
  instructions: InstructionRepository;
  views: SavedViewRepository;
  feeds: QueueFeedRepository;
  activity: ActivityRepository;
  migrations: MigrationRepository;
  outbox?: OutboxEventRepository;
  inbox?: InboxEventRepository;
}

/**
 * AppStore is the core Unblock storage contract. Implementations must preserve
 * the service semantics in services.ts: project-scoped task IDs, transactional
 * domain writes plus activity records, dependency and hierarchy validation,
 * exclusive track assignment, matcher-compatible reads, and import/export
 * parity. Hosted-only stores may add repositories outside this interface, but
 * local SQLite and Postgres must both satisfy this core contract.
 */
export interface AppStore extends RepositorySet {
  readonly capabilities?: StoreCapabilities;
  matcher?: MatcherQueryRepository;
  hostedIdentity?: HostedIdentityRepository;
  hostedAudit?: HostedAuditRepository;
  hostedSecrets?: HostedSecretRepository;
  transaction<T>(fn: (repos: RepositorySet) => Promise<T>): Promise<T>;
  close?(): Promise<void> | void;
}

export interface StoreFactoryOptions {
  databasePath?: string;
}
