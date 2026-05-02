import type {
  ActivityRepository,
  AppStore,
  DependencyRepository,
  MigrationRepository,
  RepositorySet,
  TagRepository,
  TaskRepository,
  TrackRepository
} from "./store.js";
import type { Activity, Dependency, Migration, Tag, Task, TaskTag, Track, TrackAssignment } from "./types.js";

interface MemoryState {
  tasks: Map<string, Task>;
  dependencies: Map<string, Dependency>;
  tags: Map<string, Tag>;
  taskTags: Map<string, TaskTag>;
  tracks: Map<string, Track>;
  assignments: Map<string, TrackAssignment>;
  activity: Activity[];
  migrations: Map<string, Migration>;
}

export class MemoryStore implements AppStore {
  private readonly state: MemoryState;
  readonly tasks: TaskRepository;
  readonly dependencies: DependencyRepository;
  readonly tags: TagRepository;
  readonly tracks: TrackRepository;
  readonly activity: ActivityRepository;
  readonly migrations: MigrationRepository;

  constructor(seed?: Partial<{
    tasks: Task[];
    dependencies: Dependency[];
    tags: Tag[];
    taskTags: TaskTag[];
    tracks: Track[];
    assignments: TrackAssignment[];
    activity: Activity[];
    migrations: Migration[];
  }>) {
    this.state = {
      tasks: new Map((seed?.tasks ?? []).map((task) => [task.id, task])),
      dependencies: new Map((seed?.dependencies ?? []).map((dependency) => [dependencyKey(dependency.taskId, dependency.dependsOnTaskId), dependency])),
      tags: new Map((seed?.tags ?? []).map((tag) => [tag.id, tag])),
      taskTags: new Map((seed?.taskTags ?? []).map((taskTag) => [taskTagKey(taskTag.taskId, taskTag.tagId), taskTag])),
      tracks: new Map((seed?.tracks ?? []).map((track) => [track.id, track])),
      assignments: new Map((seed?.assignments ?? []).map((assignment) => [assignmentKey(assignment.trackId, assignment.taskId), assignment])),
      activity: [...(seed?.activity ?? [])],
      migrations: new Map((seed?.migrations ?? []).map((migration) => [migration.id, migration]))
    };
    this.tasks = new MemoryTaskRepository(this.state);
    this.dependencies = new MemoryDependencyRepository(this.state);
    this.tags = new MemoryTagRepository(this.state);
    this.tracks = new MemoryTrackRepository(this.state);
    this.activity = new MemoryActivityRepository(this.state);
    this.migrations = new MemoryMigrationRepository(this.state);
  }

  async transaction<T>(fn: (repos: RepositorySet) => Promise<T>): Promise<T> {
    const snapshot = cloneState(this.state);
    try {
      return await fn(this);
    } catch (error) {
      restoreState(this.state, snapshot);
      throw error;
    }
  }
}

export function createMemoryStore(seed?: ConstructorParameters<typeof MemoryStore>[0]): MemoryStore {
  return new MemoryStore(seed);
}

class MemoryTaskRepository implements TaskRepository {
  constructor(private readonly state: MemoryState) {}

  async list(): Promise<Task[]> {
    return [...this.state.tasks.values()].map(cloneTask).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<Task | null> {
    const task = this.state.tasks.get(id);
    return task ? cloneTask(task) : null;
  }

  async create(task: Task): Promise<void> {
    this.state.tasks.set(task.id, cloneTask(task));
  }

  async update(task: Task): Promise<void> {
    this.state.tasks.set(task.id, cloneTask(task));
  }

  async delete(id: string): Promise<void> {
    this.state.tasks.delete(id);
    for (const key of [...this.state.dependencies.keys()]) {
      if (key.startsWith(`${id}\u0000`)) {
        this.state.dependencies.delete(key);
      }
    }
    for (const key of [...this.state.taskTags.keys()]) {
      if (key.startsWith(`${id}\u0000`)) {
        this.state.taskTags.delete(key);
      }
    }
    for (const [key, assignment] of this.state.assignments) {
      if (assignment.taskId === id) {
        this.state.assignments.delete(key);
      }
    }
  }
}

class MemoryDependencyRepository implements DependencyRepository {
  constructor(private readonly state: MemoryState) {}

  async list(): Promise<Dependency[]> {
    return [...this.state.dependencies.values()].map(cloneDependency);
  }

  async listForTask(taskId: string): Promise<Dependency[]> {
    return [...this.state.dependencies.values()].filter((dependency) => dependency.taskId === taskId).map(cloneDependency);
  }

  async listDependents(dependsOnTaskId: string): Promise<Dependency[]> {
    return [...this.state.dependencies.values()].filter((dependency) => dependency.dependsOnTaskId === dependsOnTaskId).map(cloneDependency);
  }

  async add(dependency: Dependency): Promise<void> {
    this.state.dependencies.set(dependencyKey(dependency.taskId, dependency.dependsOnTaskId), cloneDependency(dependency));
  }

  async remove(taskId: string, dependsOnTaskId: string): Promise<void> {
    this.state.dependencies.delete(dependencyKey(taskId, dependsOnTaskId));
  }

  async replaceForTask(taskId: string, dependencies: Dependency[]): Promise<void> {
    for (const key of [...this.state.dependencies.keys()]) {
      if (key.startsWith(`${taskId}\u0000`)) {
        this.state.dependencies.delete(key);
      }
    }
    for (const dependency of dependencies) {
      await this.add(dependency);
    }
  }
}

class MemoryTagRepository implements TagRepository {
  constructor(private readonly state: MemoryState) {}

  async list(): Promise<Tag[]> {
    return [...this.state.tags.values()].map(cloneTag).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<Tag | null> {
    const tag = this.state.tags.get(id);
    return tag ? cloneTag(tag) : null;
  }

  async findByName(name: string): Promise<Tag | null> {
    const tag = [...this.state.tags.values()].find((item) => item.name === name);
    return tag ? cloneTag(tag) : null;
  }

  async create(tag: Tag): Promise<void> {
    this.state.tags.set(tag.id, cloneTag(tag));
  }

  async update(tag: Tag): Promise<void> {
    this.state.tags.set(tag.id, cloneTag(tag));
  }

  async listTaskTags(): Promise<TaskTag[]> {
    return [...this.state.taskTags.values()].map(cloneTaskTag);
  }

  async addTaskTag(taskTag: TaskTag): Promise<void> {
    this.state.taskTags.set(taskTagKey(taskTag.taskId, taskTag.tagId), cloneTaskTag(taskTag));
  }

  async removeTaskTag(taskId: string, tagId: string): Promise<void> {
    this.state.taskTags.delete(taskTagKey(taskId, tagId));
  }
}

class MemoryTrackRepository implements TrackRepository {
  constructor(private readonly state: MemoryState) {}

  async list(): Promise<Track[]> {
    return [...this.state.tracks.values()].map(cloneTrack).sort((a, b) => a.actor.localeCompare(b.actor));
  }

  async get(id: string): Promise<Track | null> {
    const track = this.state.tracks.get(id);
    return track ? cloneTrack(track) : null;
  }

  async findByActor(actor: string): Promise<Track | null> {
    const track = [...this.state.tracks.values()].find((item) => item.actor === actor);
    return track ? cloneTrack(track) : null;
  }

  async create(track: Track): Promise<void> {
    this.state.tracks.set(track.id, cloneTrack(track));
  }

  async update(track: Track): Promise<void> {
    this.state.tracks.set(track.id, cloneTrack(track));
  }

  async listAssignments(): Promise<TrackAssignment[]> {
    return [...this.state.assignments.values()].map(cloneAssignment).sort((a, b) => a.trackId.localeCompare(b.trackId) || a.position.localeCompare(b.position));
  }

  async assign(assignment: TrackAssignment): Promise<void> {
    this.state.assignments.set(assignmentKey(assignment.trackId, assignment.taskId), cloneAssignment(assignment));
  }

  async unassign(trackId: string, taskId: string): Promise<void> {
    this.state.assignments.delete(assignmentKey(trackId, taskId));
  }

  async updateAssignment(assignment: TrackAssignment): Promise<void> {
    this.state.assignments.set(assignmentKey(assignment.trackId, assignment.taskId), cloneAssignment(assignment));
  }
}

class MemoryActivityRepository implements ActivityRepository {
  constructor(private readonly state: MemoryState) {}

  async list(limit = 100): Promise<Activity[]> {
    return [...this.state.activity].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(cloneActivity);
  }

  async append(activity: Activity): Promise<void> {
    this.state.activity.push(cloneActivity(activity));
  }
}

class MemoryMigrationRepository implements MigrationRepository {
  constructor(private readonly state: MemoryState) {}

  async list(): Promise<Migration[]> {
    return [...this.state.migrations.values()].map(cloneMigration).sort((a, b) => a.id.localeCompare(b.id));
  }

  async markApplied(migration: Migration): Promise<void> {
    this.state.migrations.set(migration.id, cloneMigration(migration));
  }
}

function dependencyKey(taskId: string, dependsOnTaskId: string): string {
  return `${taskId}\u0000${dependsOnTaskId}`;
}

function taskTagKey(taskId: string, tagId: string): string {
  return `${taskId}\u0000${tagId}`;
}

function assignmentKey(trackId: string, taskId: string): string {
  return `${trackId}\u0000${taskId}`;
}

function cloneTask(task: Task): Task {
  return { ...task };
}

function cloneDependency(dependency: Dependency): Dependency {
  return { ...dependency };
}

function cloneTag(tag: Tag): Tag {
  return { ...tag };
}

function cloneTaskTag(taskTag: TaskTag): TaskTag {
  return { ...taskTag };
}

function cloneTrack(track: Track): Track {
  return { ...track };
}

function cloneAssignment(assignment: TrackAssignment): TrackAssignment {
  return { ...assignment };
}

function cloneActivity(activity: Activity): Activity {
  return { ...activity, data: { ...activity.data } };
}

function cloneMigration(migration: Migration): Migration {
  return { ...migration };
}

function cloneState(state: MemoryState): MemoryState {
  return {
    tasks: new Map([...state.tasks].map(([key, value]) => [key, cloneTask(value)])),
    dependencies: new Map([...state.dependencies].map(([key, value]) => [key, cloneDependency(value)])),
    tags: new Map([...state.tags].map(([key, value]) => [key, cloneTag(value)])),
    taskTags: new Map([...state.taskTags].map(([key, value]) => [key, cloneTaskTag(value)])),
    tracks: new Map([...state.tracks].map(([key, value]) => [key, cloneTrack(value)])),
    assignments: new Map([...state.assignments].map(([key, value]) => [key, cloneAssignment(value)])),
    activity: state.activity.map(cloneActivity),
    migrations: new Map([...state.migrations].map(([key, value]) => [key, cloneMigration(value)]))
  };
}

function restoreState(target: MemoryState, source: MemoryState): void {
  target.tasks = source.tasks;
  target.dependencies = source.dependencies;
  target.tags = source.tags;
  target.taskTags = source.taskTags;
  target.tracks = source.tracks;
  target.assignments = source.assignments;
  target.activity = source.activity;
  target.migrations = source.migrations;
}
