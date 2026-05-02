import type {
  Activity,
  Dependency,
  Migration,
  Tag,
  Task,
  TaskTag,
  Track,
  TrackAssignment
} from "./types.js";

export interface TaskRepository {
  list(): Promise<Task[]>;
  get(id: string): Promise<Task | null>;
  create(task: Task): Promise<void>;
  update(task: Task): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface DependencyRepository {
  list(): Promise<Dependency[]>;
  listForTask(taskId: string): Promise<Dependency[]>;
  listDependents(dependsOnTaskId: string): Promise<Dependency[]>;
  add(dependency: Dependency): Promise<void>;
  remove(taskId: string, dependsOnTaskId: string): Promise<void>;
  replaceForTask(taskId: string, dependencies: Dependency[]): Promise<void>;
}

export interface TagRepository {
  list(): Promise<Tag[]>;
  get(id: string): Promise<Tag | null>;
  findByName(name: string): Promise<Tag | null>;
  create(tag: Tag): Promise<void>;
  update(tag: Tag): Promise<void>;
  listTaskTags(): Promise<TaskTag[]>;
  addTaskTag(taskTag: TaskTag): Promise<void>;
  removeTaskTag(taskId: string, tagId: string): Promise<void>;
}

export interface TrackRepository {
  list(): Promise<Track[]>;
  get(id: string): Promise<Track | null>;
  findByActor(actor: string): Promise<Track | null>;
  create(track: Track): Promise<void>;
  update(track: Track): Promise<void>;
  listAssignments(): Promise<TrackAssignment[]>;
  assign(assignment: TrackAssignment): Promise<void>;
  unassign(trackId: string, taskId: string): Promise<void>;
  updateAssignment(assignment: TrackAssignment): Promise<void>;
}

export interface ActivityRepository {
  list(limit?: number): Promise<Activity[]>;
  append(activity: Activity): Promise<void>;
}

export interface MigrationRepository {
  list(): Promise<Migration[]>;
  markApplied(migration: Migration): Promise<void>;
}

export interface RepositorySet {
  tasks: TaskRepository;
  dependencies: DependencyRepository;
  tags: TagRepository;
  tracks: TrackRepository;
  activity: ActivityRepository;
  migrations: MigrationRepository;
}

export interface AppStore extends RepositorySet {
  transaction<T>(fn: (repos: RepositorySet) => Promise<T>): Promise<T>;
  close?(): Promise<void> | void;
}

export interface StoreFactoryOptions {
  databasePath?: string;
}
