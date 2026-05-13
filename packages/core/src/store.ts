import type {
  Activity,
  Comment,
  Dependency,
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
  Instruction
} from "./types.js";

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
  update(task: Task): Promise<void>;
  delete(projectId: string, id: string): Promise<void>;
}

export interface DependencyRepository {
  list(projectId?: string): Promise<Dependency[]>;
  listForTask(projectId: string, taskId: string): Promise<Dependency[]>;
  listDependents(projectId: string, dependsOnTaskId: string): Promise<Dependency[]>;
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
  update(comment: Comment): Promise<void>;
}

export interface TagRepository {
  list(projectId?: string): Promise<Tag[]>;
  get(projectId: string, id: string): Promise<Tag | null>;
  findByName(projectId: string, name: string): Promise<Tag | null>;
  create(tag: Tag): Promise<void>;
  update(tag: Tag): Promise<void>;
  listTaskTags(projectId?: string): Promise<TaskTag[]>;
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
  append(activity: Activity): Promise<void>;
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

export interface MatcherQueryRepository {
  matchTaskIds(projectId: string, query: string, filters?: Omit<TaskListFilters, "where">): Promise<string[]>;
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
}

export interface AppStore extends RepositorySet {
  matcher?: MatcherQueryRepository;
  transaction<T>(fn: (repos: RepositorySet) => Promise<T>): Promise<T>;
  close?(): Promise<void> | void;
}

export interface StoreFactoryOptions {
  databasePath?: string;
}
