import type {
  ActivityRepository,
  AppStore,
  CommentRepository,
  DependencyRepository,
  MigrationRepository,
  ProjectRepository,
  QueueFeedRepository,
  RepositorySet,
  InstructionRepository,
  SavedViewRepository,
  TagRepository,
  TaskRepository,
  TrackRepository
} from "./store.js";
import type { Activity, Comment, Dependency, Instruction, Migration, Project, QueueFeed, SavedView, Tag, Task, TaskTag, Track, TrackAssignment } from "./types.js";
import { DEFAULT_PROJECT_ID, nowIso } from "./types.js";

interface MemoryState {
  projects: Map<string, Project>;
  tasks: Map<string, Task>;
  dependencies: Map<string, Dependency>;
  comments: Map<string, Comment>;
  tags: Map<string, Tag>;
  taskTags: Map<string, TaskTag>;
  tracks: Map<string, Track>;
  instructions: Map<string, Instruction>;
  views: Map<string, SavedView>;
  feeds: Map<string, QueueFeed>;
  assignments: Map<string, TrackAssignment>;
  activity: Activity[];
  migrations: Map<string, Migration>;
}

export class MemoryStore implements AppStore {
  readonly capabilities = {
    dialect: "memory",
    transactionalWrites: true,
    coreDomain: true,
    comments: true,
    matcherQuery: "service",
    bulkOperations: false,
    outboxInbox: false
  } as const;
  private readonly state: MemoryState;
  readonly tasks: TaskRepository;
  readonly projects: ProjectRepository;
  readonly dependencies: DependencyRepository;
  readonly comments: CommentRepository;
  readonly tags: TagRepository;
  readonly tracks: TrackRepository;
  readonly instructions: InstructionRepository;
  readonly views: SavedViewRepository;
  readonly feeds: QueueFeedRepository;
  readonly activity: ActivityRepository;
  readonly migrations: MigrationRepository;

  constructor(seed?: Partial<{
    tasks: Task[];
    dependencies: Dependency[];
    comments: Comment[];
    tags: Tag[];
    taskTags: TaskTag[];
    tracks: Track[];
    instructions: Instruction[];
    views: SavedView[];
    feeds: QueueFeed[];
    projects: Project[];
    assignments: TrackAssignment[];
    activity: Activity[];
    migrations: Migration[];
  }>) {
    const projects = new Map((seed?.projects ?? []).map((project) => [project.id, project]));
    if (!projects.has(DEFAULT_PROJECT_ID)) {
      const now = nowIso();
      projects.set(DEFAULT_PROJECT_ID, {
        id: DEFAULT_PROJECT_ID,
        name: "Default",
        description: "Migrated default project",
        createdAt: now,
        updatedAt: now,
        archivedAt: null
      });
    }
    this.state = {
      projects,
      tasks: new Map((seed?.tasks ?? []).map((task) => [taskKey(task.projectId, task.id), task])),
      dependencies: new Map((seed?.dependencies ?? []).map((dependency) => [dependencyKey(dependency.projectId, dependency.taskId, dependency.dependsOnTaskId), dependency])),
      comments: new Map((seed?.comments ?? []).map((comment) => [scopedKey(comment.projectId, comment.id), comment])),
      tags: new Map((seed?.tags ?? []).map((tag) => [scopedKey(tag.projectId, tag.id), tag])),
      taskTags: new Map((seed?.taskTags ?? []).map((taskTag) => [taskTagKey(taskTag.projectId, taskTag.taskId, taskTag.tagId), taskTag])),
      tracks: new Map((seed?.tracks ?? []).map((track) => [scopedKey(track.projectId, track.id), track])),
      instructions: new Map((seed?.instructions ?? []).map((instruction) => [scopedKey(instruction.projectId, instruction.id), instruction])),
      views: new Map((seed?.views ?? []).map((view) => [scopedKey(view.projectId, view.id), view])),
      feeds: new Map((seed?.feeds ?? []).map((feed) => [scopedKey(feed.projectId, feed.id), feed])),
      assignments: new Map((seed?.assignments ?? []).map((assignment) => [assignmentKey(assignment.projectId, assignment.trackId, assignment.taskId), assignment])),
      activity: [...(seed?.activity ?? [])],
      migrations: new Map((seed?.migrations ?? []).map((migration) => [migration.id, migration]))
    };
    this.projects = new MemoryProjectRepository(this.state);
    this.tasks = new MemoryTaskRepository(this.state);
    this.dependencies = new MemoryDependencyRepository(this.state);
    this.comments = new MemoryCommentRepository(this.state);
    this.tags = new MemoryTagRepository(this.state);
    this.tracks = new MemoryTrackRepository(this.state);
    this.instructions = new MemoryInstructionRepository(this.state);
    this.views = new MemorySavedViewRepository(this.state);
    this.feeds = new MemoryQueueFeedRepository(this.state);
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

class MemoryProjectRepository implements ProjectRepository {
  constructor(private readonly state: MemoryState) {}

  async list(): Promise<Project[]> {
    return [...this.state.projects.values()].map(cloneProject).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<Project | null> {
    const project = this.state.projects.get(id);
    return project ? cloneProject(project) : null;
  }

  async create(project: Project): Promise<void> {
    this.state.projects.set(project.id, cloneProject(project));
  }

  async update(project: Project): Promise<void> {
    this.state.projects.set(project.id, cloneProject(project));
  }
}

class MemoryTaskRepository implements TaskRepository {
  constructor(private readonly state: MemoryState) {}

  async list(projectId?: string): Promise<Task[]> {
    return [...this.state.tasks.values()].filter((task) => !projectId || task.projectId === projectId).map(cloneTask).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async get(projectId: string, id: string): Promise<Task | null> {
    const task = this.state.tasks.get(taskKey(projectId, id));
    return task ? cloneTask(task) : null;
  }

  async create(task: Task): Promise<void> {
    this.state.tasks.set(taskKey(task.projectId, task.id), cloneTask(task));
  }

  async update(task: Task): Promise<void> {
    this.state.tasks.set(taskKey(task.projectId, task.id), cloneTask(task));
  }

  async delete(projectId: string, id: string): Promise<void> {
    this.state.tasks.delete(taskKey(projectId, id));
    for (const key of [...this.state.dependencies.keys()]) {
      if (key.startsWith(`${projectId}\u0000${id}\u0000`)) {
        this.state.dependencies.delete(key);
      }
    }
    for (const key of [...this.state.taskTags.keys()]) {
      if (key.startsWith(`${projectId}\u0000${id}\u0000`)) {
        this.state.taskTags.delete(key);
      }
    }
    for (const [key, assignment] of this.state.assignments) {
      if (assignment.projectId === projectId && assignment.taskId === id) {
        this.state.assignments.delete(key);
      }
    }
    for (const [key, comment] of this.state.comments) {
      if (comment.projectId === projectId && comment.taskId === id) {
        this.state.comments.delete(key);
      }
    }
  }
}

class MemoryDependencyRepository implements DependencyRepository {
  constructor(private readonly state: MemoryState) {}

  async list(projectId?: string): Promise<Dependency[]> {
    return [...this.state.dependencies.values()].filter((dependency) => !projectId || dependency.projectId === projectId).map(cloneDependency);
  }

  async listForTask(projectId: string, taskId: string): Promise<Dependency[]> {
    return [...this.state.dependencies.values()].filter((dependency) => dependency.projectId === projectId && dependency.taskId === taskId).map(cloneDependency);
  }

  async listDependents(projectId: string, dependsOnTaskId: string): Promise<Dependency[]> {
    return [...this.state.dependencies.values()].filter((dependency) => dependency.projectId === projectId && dependency.dependsOnTaskId === dependsOnTaskId).map(cloneDependency);
  }

  async add(dependency: Dependency): Promise<void> {
    this.state.dependencies.set(dependencyKey(dependency.projectId, dependency.taskId, dependency.dependsOnTaskId), cloneDependency(dependency));
  }

  async remove(projectId: string, taskId: string, dependsOnTaskId: string): Promise<void> {
    this.state.dependencies.delete(dependencyKey(projectId, taskId, dependsOnTaskId));
  }

  async replaceForTask(projectId: string, taskId: string, dependencies: Dependency[]): Promise<void> {
    for (const key of [...this.state.dependencies.keys()]) {
      if (key.startsWith(`${projectId}\u0000${taskId}\u0000`)) {
        this.state.dependencies.delete(key);
      }
    }
    for (const dependency of dependencies) {
      await this.add(dependency);
    }
  }
}

class MemoryCommentRepository implements CommentRepository {
  constructor(private readonly state: MemoryState) {}

  async list(projectId?: string): Promise<Comment[]> {
    return [...this.state.comments.values()]
      .filter((comment) => !projectId || comment.projectId === projectId)
      .map(cloneComment)
      .sort(compareComments);
  }

  async listForTask(projectId: string, taskId: string): Promise<Comment[]> {
    return [...this.state.comments.values()]
      .filter((comment) => comment.projectId === projectId && comment.taskId === taskId)
      .map(cloneComment)
      .sort(compareComments);
  }

  async get(projectId: string, id: string): Promise<Comment | null> {
    const comment = this.state.comments.get(scopedKey(projectId, id));
    return comment ? cloneComment(comment) : null;
  }

  async create(comment: Comment): Promise<void> {
    this.state.comments.set(scopedKey(comment.projectId, comment.id), cloneComment(comment));
  }

  async update(comment: Comment): Promise<void> {
    this.state.comments.set(scopedKey(comment.projectId, comment.id), cloneComment(comment));
  }
}

class MemoryTagRepository implements TagRepository {
  constructor(private readonly state: MemoryState) {}

  async list(projectId?: string): Promise<Tag[]> {
    return [...this.state.tags.values()].filter((tag) => !projectId || tag.projectId === projectId).map(cloneTag).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  async get(projectId: string, id: string): Promise<Tag | null> {
    const tag = this.state.tags.get(scopedKey(projectId, id));
    return tag ? cloneTag(tag) : null;
  }

  async findByName(projectId: string, name: string): Promise<Tag | null> {
    const tag = [...this.state.tags.values()].find((item) => item.projectId === projectId && item.name === name);
    return tag ? cloneTag(tag) : null;
  }

  async create(tag: Tag): Promise<void> {
    this.state.tags.set(scopedKey(tag.projectId, tag.id), cloneTag(tag));
  }

  async update(tag: Tag): Promise<void> {
    this.state.tags.set(scopedKey(tag.projectId, tag.id), cloneTag(tag));
  }

  async listTaskTags(projectId?: string): Promise<TaskTag[]> {
    return [...this.state.taskTags.values()].filter((taskTag) => !projectId || taskTag.projectId === projectId).map(cloneTaskTag);
  }

  async addTaskTag(taskTag: TaskTag): Promise<void> {
    this.state.taskTags.set(taskTagKey(taskTag.projectId, taskTag.taskId, taskTag.tagId), cloneTaskTag(taskTag));
  }

  async removeTaskTag(projectId: string, taskId: string, tagId: string): Promise<void> {
    this.state.taskTags.delete(taskTagKey(projectId, taskId, tagId));
  }
}

class MemoryTrackRepository implements TrackRepository {
  constructor(private readonly state: MemoryState) {}

  async list(projectId?: string): Promise<Track[]> {
    return [...this.state.tracks.values()].filter((track) => !projectId || track.projectId === projectId).map(cloneTrack).sort((a, b) => a.machine.localeCompare(b.machine) || a.actor.localeCompare(b.actor));
  }

  async get(projectId: string, id: string): Promise<Track | null> {
    const track = this.state.tracks.get(scopedKey(projectId, id));
    return track ? cloneTrack(track) : null;
  }

  async findByActor(projectId: string, machine: string, actor: string): Promise<Track | null> {
    const track = [...this.state.tracks.values()].find((item) => item.projectId === projectId && item.machine === machine && item.actor === actor);
    return track ? cloneTrack(track) : null;
  }

  async create(track: Track): Promise<void> {
    this.state.tracks.set(scopedKey(track.projectId, track.id), cloneTrack(track));
  }

  async update(track: Track): Promise<void> {
    this.state.tracks.set(scopedKey(track.projectId, track.id), cloneTrack(track));
  }

  async listAssignments(projectId?: string): Promise<TrackAssignment[]> {
    return [...this.state.assignments.values()].filter((assignment) => !projectId || assignment.projectId === projectId).map(cloneAssignment).sort((a, b) => a.trackId.localeCompare(b.trackId) || a.position.localeCompare(b.position));
  }

  async assign(assignment: TrackAssignment): Promise<void> {
    this.state.assignments.set(assignmentKey(assignment.projectId, assignment.trackId, assignment.taskId), cloneAssignment(assignment));
  }

  async unassign(projectId: string, trackId: string, taskId: string): Promise<void> {
    this.state.assignments.delete(assignmentKey(projectId, trackId, taskId));
  }

  async updateAssignment(assignment: TrackAssignment): Promise<void> {
    this.state.assignments.set(assignmentKey(assignment.projectId, assignment.trackId, assignment.taskId), cloneAssignment(assignment));
  }
}

class MemoryActivityRepository implements ActivityRepository {
  constructor(private readonly state: MemoryState) {}

  async list(projectId: string | null = null, limit = 100): Promise<Activity[]> {
    return [...this.state.activity]
      .filter((activity) => projectId === null || activity.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, limit)
      .map(cloneActivity);
  }

  async version(projectId: string | null = null): Promise<string> {
    const activities = this.state.activity.filter((activity) => projectId === null || activity.projectId === projectId);
    const maxCreatedAt = activities.reduce((max, activity) => activity.createdAt > max ? activity.createdAt : max, "");
    return `${activities.length}:${maxCreatedAt}`;
  }

  async append(activity: Activity): Promise<void> {
    this.state.activity.push(cloneActivity(activity));
  }
}

class MemoryInstructionRepository implements InstructionRepository {
  constructor(private readonly state: MemoryState) {}

  async list(projectId?: string): Promise<Instruction[]> {
    return [...this.state.instructions.values()].filter((instruction) => !projectId || instruction.projectId === projectId).map(cloneInstruction).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async get(projectId: string, id: string): Promise<Instruction | null> {
    const instruction = this.state.instructions.get(scopedKey(projectId, id));
    return instruction ? cloneInstruction(instruction) : null;
  }

  async create(instruction: Instruction): Promise<void> {
    this.state.instructions.set(scopedKey(instruction.projectId, instruction.id), cloneInstruction(instruction));
  }

  async update(instruction: Instruction): Promise<void> {
    this.state.instructions.set(scopedKey(instruction.projectId, instruction.id), cloneInstruction(instruction));
  }
}

class MemorySavedViewRepository implements SavedViewRepository {
  constructor(private readonly state: MemoryState) {}

  async list(projectId?: string): Promise<SavedView[]> {
    return [...this.state.views.values()].filter((view) => !projectId || view.projectId === projectId).map(cloneSavedView).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async get(projectId: string, id: string): Promise<SavedView | null> {
    const view = this.state.views.get(scopedKey(projectId, id));
    return view ? cloneSavedView(view) : null;
  }

  async create(view: SavedView): Promise<void> {
    this.state.views.set(scopedKey(view.projectId, view.id), cloneSavedView(view));
  }

  async update(view: SavedView): Promise<void> {
    this.state.views.set(scopedKey(view.projectId, view.id), cloneSavedView(view));
  }
}

class MemoryQueueFeedRepository implements QueueFeedRepository {
  constructor(private readonly state: MemoryState) {}

  async list(projectId?: string): Promise<QueueFeed[]> {
    return [...this.state.feeds.values()].filter((feed) => !projectId || feed.projectId === projectId).map(cloneQueueFeed).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async get(projectId: string, id: string): Promise<QueueFeed | null> {
    const feed = this.state.feeds.get(scopedKey(projectId, id));
    return feed ? cloneQueueFeed(feed) : null;
  }

  async create(feed: QueueFeed): Promise<void> {
    this.state.feeds.set(scopedKey(feed.projectId, feed.id), cloneQueueFeed(feed));
  }

  async update(feed: QueueFeed): Promise<void> {
    this.state.feeds.set(scopedKey(feed.projectId, feed.id), cloneQueueFeed(feed));
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

function scopedKey(projectId: string, id: string): string {
  return `${projectId}\u0000${id}`;
}

function taskKey(projectId: string, taskId: string): string {
  return scopedKey(projectId, taskId);
}

function dependencyKey(projectId: string, taskId: string, dependsOnTaskId: string): string {
  return `${projectId}\u0000${taskId}\u0000${dependsOnTaskId}`;
}

function taskTagKey(projectId: string, taskId: string, tagId: string): string {
  return `${projectId}\u0000${taskId}\u0000${tagId}`;
}

function assignmentKey(projectId: string, trackId: string, taskId: string): string {
  return `${projectId}\u0000${trackId}\u0000${taskId}`;
}

function cloneProject(project: Project): Project {
  return { ...project };
}

function cloneTask(task: Task): Task {
  return { ...task };
}

function cloneDependency(dependency: Dependency): Dependency {
  return { ...dependency };
}

function cloneComment(comment: Comment): Comment {
  return { ...comment };
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

function cloneInstruction(instruction: Instruction): Instruction {
  return { ...instruction };
}

function cloneSavedView(view: SavedView): SavedView {
  return { ...view };
}

function cloneQueueFeed(feed: QueueFeed): QueueFeed {
  return { ...feed };
}

function cloneMigration(migration: Migration): Migration {
  return { ...migration };
}

function cloneState(state: MemoryState): MemoryState {
  return {
    tasks: new Map([...state.tasks].map(([key, value]) => [key, cloneTask(value)])),
    projects: new Map([...state.projects].map(([key, value]) => [key, cloneProject(value)])),
    dependencies: new Map([...state.dependencies].map(([key, value]) => [key, cloneDependency(value)])),
    comments: new Map([...state.comments].map(([key, value]) => [key, cloneComment(value)])),
    tags: new Map([...state.tags].map(([key, value]) => [key, cloneTag(value)])),
    taskTags: new Map([...state.taskTags].map(([key, value]) => [key, cloneTaskTag(value)])),
    tracks: new Map([...state.tracks].map(([key, value]) => [key, cloneTrack(value)])),
    instructions: new Map([...state.instructions].map(([key, value]) => [key, cloneInstruction(value)])),
    views: new Map([...state.views].map(([key, value]) => [key, cloneSavedView(value)])),
    feeds: new Map([...state.feeds].map(([key, value]) => [key, cloneQueueFeed(value)])),
    assignments: new Map([...state.assignments].map(([key, value]) => [key, cloneAssignment(value)])),
    activity: state.activity.map(cloneActivity),
    migrations: new Map([...state.migrations].map(([key, value]) => [key, cloneMigration(value)]))
  };
}

function restoreState(target: MemoryState, source: MemoryState): void {
  target.tasks = source.tasks;
  target.projects = source.projects;
  target.dependencies = source.dependencies;
  target.comments = source.comments;
  target.tags = source.tags;
  target.taskTags = source.taskTags;
  target.tracks = source.tracks;
  target.instructions = source.instructions;
  target.views = source.views;
  target.feeds = source.feeds;
  target.assignments = source.assignments;
  target.activity = source.activity;
  target.migrations = source.migrations;
}

function compareComments(a: Comment, b: Comment): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}
