import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { validation } from "./errors.js";
import { sqliteMigrations } from "./migrations.js";
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
import type { Activity, Comment, Dependency, Instruction, Lifecycle, Migration, Priority, Project, QueueFeed, SavedView, Tag, Task, TaskSize, TaskTag, Track, TrackAssignment } from "./types.js";
import { defaultUnblockDbPath, nowIso } from "./types.js";

type SqliteDatabase = Database.Database;

export interface SqliteStoreOptions {
  databasePath?: string | undefined;
  autoMigrate?: boolean;
}

interface TaskRow {
  project_id: string;
  id: string;
  parent_task_id: string | null;
  title: string;
  description: string;
  lifecycle: Lifecycle;
  priority: Priority;
  size: TaskSize | null;
  source_doc: string | null;
  source_section: string | null;
  source_anchor: string | null;
  source_line: number | null;
  source_text: string | null;
  completion_bar: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  archived_at: string | null;
  version: number;
}

interface DependencyRow {
  project_id: string;
  task_id: string;
  depends_on_task_id: string;
  created_at: string;
}

interface CommentRow {
  project_id: string;
  id: string;
  task_id: string;
  machine: string;
  actor: string;
  body: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface TagRow {
  project_id: string;
  id: string;
  name: string;
  color: string | null;
  description: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface TaskTagRow {
  project_id: string;
  task_id: string;
  tag_id: string;
  created_at: string;
}

interface TrackRow {
  project_id: string;
  id: string;
  machine: string;
  actor: string;
  name: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface AssignmentRow {
  project_id: string;
  track_id: string;
  task_id: string;
  position: string;
  assigned_at: string;
}

interface ActivityRow {
  project_id: string | null;
  id: string;
  type: string;
  subject_type: Activity["subjectType"];
  subject_id: string | null;
  message: string;
  data_json: string;
  machine: string;
  actor: string;
  created_at: string;
}

interface MigrationRow {
  id: string;
  name: string;
  applied_at: string;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface InstructionRow {
  project_id: string;
  id: string;
  name: string;
  query: string;
  body: string;
  enabled: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface SavedViewRow {
  project_id: string;
  id: string;
  name: string;
  query: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface QueueFeedRow {
  project_id: string;
  id: string;
  name: string;
  query: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export class SqliteStore implements AppStore {
  readonly capabilities = {
    dialect: "sqlite",
    transactionalWrites: true,
    coreDomain: true,
    comments: true,
    matcherQuery: "service",
    bulkOperations: true,
    outboxInbox: false
  } as const;
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  readonly dependencies: DependencyRepository;
  readonly comments: CommentRepository;
  readonly tags: TagRepository;
  readonly tracks: TrackRepository;
  readonly instructions: InstructionRepository;
  readonly views: SavedViewRepository;
  readonly feeds: QueueFeedRepository;
  readonly activity: ActivityRepository;
  readonly migrations: MigrationRepository;

  constructor(private readonly db: SqliteDatabase, options: SqliteStoreOptions = {}) {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    ensureMigrationTable(this.db);
    if (options.autoMigrate ?? true) {
      runEmbeddedMigrations(this.db);
    }
    this.projects = new SqliteProjectRepository(this.db);
    this.tasks = new SqliteTaskRepository(this.db);
    this.dependencies = new SqliteDependencyRepository(this.db);
    this.comments = new SqliteCommentRepository(this.db);
    this.tags = new SqliteTagRepository(this.db);
    this.tracks = new SqliteTrackRepository(this.db);
    this.instructions = new SqliteInstructionRepository(this.db);
    this.views = new SqliteSavedViewRepository(this.db);
    this.feeds = new SqliteQueueFeedRepository(this.db);
    this.activity = new SqliteActivityRepository(this.db);
    this.migrations = new SqliteMigrationRepository(this.db);
  }

  async transaction<T>(fn: (repos: RepositorySet) => Promise<T>): Promise<T> {
    this.db.exec("begin immediate");
    try {
      const result = await fn(this);
      this.db.exec("commit");
      return result;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

export function createSqliteStore(options: SqliteStoreOptions = {}): SqliteStore {
  const databasePath = options.databasePath ?? process.env.UNBLOCK_DB ?? defaultUnblockDbPath();
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  return new SqliteStore(db, options);
}

class SqliteProjectRepository implements ProjectRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async list(): Promise<Project[]> {
    return this.db.prepare("select * from projects order by name asc, id asc").all().map((row) => projectFromRow(row as ProjectRow));
  }

  async get(id: string): Promise<Project | null> {
    const row = this.db.prepare("select * from projects where id = ?").get(id) as ProjectRow | undefined;
    return row ? projectFromRow(row) : null;
  }

  async create(project: Project): Promise<void> {
    this.db.prepare(`
      insert into projects (id, name, description, created_at, updated_at, archived_at)
      values (@id, @name, @description, @createdAt, @updatedAt, @archivedAt)
    `).run(project);
  }

  async update(project: Project): Promise<void> {
    this.db.prepare(`
      update projects set name = @name, description = @description, updated_at = @updatedAt, archived_at = @archivedAt
      where id = @id
    `).run(project);
  }
}

class SqliteTaskRepository implements TaskRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async list(projectId?: string): Promise<Task[]> {
    const rows = projectId
      ? this.db.prepare("select * from tasks where project_id = ? order by created_at asc, id asc").all(projectId)
      : this.db.prepare("select * from tasks order by project_id asc, created_at asc, id asc").all();
    return rows.map((row) => taskFromRow(row as TaskRow));
  }

  async get(projectId: string, id: string): Promise<Task | null> {
    const row = this.db.prepare("select * from tasks where project_id = ? and id = ?").get(projectId, id) as TaskRow | undefined;
    return row ? taskFromRow(row) : null;
  }

  async create(task: Task): Promise<void> {
    this.db.prepare(`
      insert into tasks (
        project_id, id, parent_task_id, title, description, lifecycle, priority, size, source_doc, source_section,
        source_anchor, source_line, source_text, completion_bar, created_at, updated_at,
        started_at, finished_at, archived_at, version
      ) values (
        @projectId, @id, @parentTaskId, @title, @description, @lifecycle, @priority, @size, @sourceDoc, @sourceSection,
        @sourceAnchor, @sourceLine, @sourceText, @completionBar, @createdAt, @updatedAt,
        @startedAt, @finishedAt, @archivedAt, @version
      )
    `).run(task);
  }

  async update(task: Task): Promise<void> {
    this.db.prepare(`
      update tasks set
        parent_task_id = @parentTaskId,
        title = @title,
        description = @description,
        lifecycle = @lifecycle,
        priority = @priority,
        size = @size,
        source_doc = @sourceDoc,
        source_section = @sourceSection,
        source_anchor = @sourceAnchor,
        source_line = @sourceLine,
        source_text = @sourceText,
        completion_bar = @completionBar,
        updated_at = @updatedAt,
        started_at = @startedAt,
        finished_at = @finishedAt,
        archived_at = @archivedAt,
        version = @version
      where project_id = @projectId and id = @id
    `).run(task);
  }

  async updateWithPrevious(previous: Task, task: Task): Promise<void> {
    const result = this.db.prepare(`
      update tasks set
        parent_task_id = @parentTaskId,
        title = @title,
        description = @description,
        lifecycle = @lifecycle,
        priority = @priority,
        size = @size,
        source_doc = @sourceDoc,
        source_section = @sourceSection,
        source_anchor = @sourceAnchor,
        source_line = @sourceLine,
        source_text = @sourceText,
        completion_bar = @completionBar,
        updated_at = @updatedAt,
        started_at = @startedAt,
        finished_at = @finishedAt,
        archived_at = @archivedAt,
        version = @version
      where project_id = @projectId and id = @id and version = @previousVersion
    `).run({ ...task, previousVersion: previous.version });
    if (result.changes !== 1) {
      validation("Task version conflict.", { taskId: task.id, expectedVersion: previous.version });
    }
  }

  async delete(projectId: string, id: string): Promise<void> {
    this.db.prepare("delete from tasks where project_id = ? and id = ?").run(projectId, id);
  }
}

class SqliteDependencyRepository implements DependencyRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async list(projectId?: string): Promise<Dependency[]> {
    const rows = projectId
      ? this.db.prepare("select * from task_dependencies where project_id = ? order by task_id, depends_on_task_id").all(projectId)
      : this.db.prepare("select * from task_dependencies order by project_id, task_id, depends_on_task_id").all();
    return rows.map((row) => dependencyFromRow(row as DependencyRow));
  }

  async listForTask(projectId: string, taskId: string): Promise<Dependency[]> {
    return this.db.prepare("select * from task_dependencies where project_id = ? and task_id = ? order by depends_on_task_id").all(projectId, taskId).map((row) => dependencyFromRow(row as DependencyRow));
  }

  async listDependents(projectId: string, dependsOnTaskId: string): Promise<Dependency[]> {
    return this.db.prepare("select * from task_dependencies where project_id = ? and depends_on_task_id = ? order by task_id").all(projectId, dependsOnTaskId).map((row) => dependencyFromRow(row as DependencyRow));
  }

  async add(dependency: Dependency): Promise<void> {
    this.db.prepare("insert or ignore into task_dependencies (project_id, task_id, depends_on_task_id, created_at) values (@projectId, @taskId, @dependsOnTaskId, @createdAt)").run(dependency);
  }

  async remove(projectId: string, taskId: string, dependsOnTaskId: string): Promise<void> {
    this.db.prepare("delete from task_dependencies where project_id = ? and task_id = ? and depends_on_task_id = ?").run(projectId, taskId, dependsOnTaskId);
  }

  async replaceForTask(projectId: string, taskId: string, dependencies: Dependency[]): Promise<void> {
    this.db.prepare("delete from task_dependencies where project_id = ? and task_id = ?").run(projectId, taskId);
    const insert = this.db.prepare("insert or ignore into task_dependencies (project_id, task_id, depends_on_task_id, created_at) values (@projectId, @taskId, @dependsOnTaskId, @createdAt)");
    for (const dependency of dependencies) {
      insert.run(dependency);
    }
  }
}

class SqliteCommentRepository implements CommentRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async list(projectId?: string): Promise<Comment[]> {
    const rows = projectId
      ? this.db.prepare("select * from comments where project_id = ? order by created_at asc, id asc").all(projectId)
      : this.db.prepare("select * from comments order by project_id, created_at asc, id asc").all();
    return rows.map((row) => commentFromRow(row as CommentRow));
  }

  async listForTask(projectId: string, taskId: string): Promise<Comment[]> {
    return this.db.prepare("select * from comments where project_id = ? and task_id = ? order by created_at asc, id asc").all(projectId, taskId).map((row) => commentFromRow(row as CommentRow));
  }

  async get(projectId: string, id: string): Promise<Comment | null> {
    const row = this.db.prepare("select * from comments where project_id = ? and id = ?").get(projectId, id) as CommentRow | undefined;
    return row ? commentFromRow(row) : null;
  }

  async create(comment: Comment): Promise<void> {
    this.db.prepare(`
      insert into comments (project_id, id, task_id, machine, actor, body, created_at, updated_at, archived_at)
      values (@projectId, @id, @taskId, @machine, @actor, @body, @createdAt, @updatedAt, @archivedAt)
    `).run(comment);
  }

  async update(comment: Comment): Promise<void> {
    this.db.prepare(`
      update comments
      set task_id = @taskId, machine = @machine, actor = @actor, body = @body, updated_at = @updatedAt, archived_at = @archivedAt
      where project_id = @projectId and id = @id
    `).run(comment);
  }
}

class SqliteTagRepository implements TagRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async list(projectId?: string): Promise<Tag[]> {
    const rows = projectId
      ? this.db.prepare("select * from tags where project_id = ? order by sort_order asc, name asc").all(projectId)
      : this.db.prepare("select * from tags order by project_id, sort_order asc, name asc").all();
    return rows.map((row) => tagFromRow(row as TagRow));
  }

  async get(projectId: string, id: string): Promise<Tag | null> {
    const row = this.db.prepare("select * from tags where project_id = ? and id = ?").get(projectId, id) as TagRow | undefined;
    return row ? tagFromRow(row) : null;
  }

  async findByName(projectId: string, name: string): Promise<Tag | null> {
    const row = this.db.prepare("select * from tags where project_id = ? and name = ?").get(projectId, name) as TagRow | undefined;
    return row ? tagFromRow(row) : null;
  }

  async create(tag: Tag): Promise<void> {
    this.db.prepare(`
      insert into tags (project_id, id, name, color, description, sort_order, created_at, updated_at, archived_at)
      values (@projectId, @id, @name, @color, @description, @sortOrder, @createdAt, @updatedAt, @archivedAt)
    `).run(tag);
  }

  async update(tag: Tag): Promise<void> {
    this.db.prepare(`
      update tags set
        name = @name,
        color = @color,
        description = @description,
        sort_order = @sortOrder,
        updated_at = @updatedAt,
        archived_at = @archivedAt
      where project_id = @projectId and id = @id
    `).run(tag);
  }

  async listTaskTags(projectId?: string): Promise<TaskTag[]> {
    const rows = projectId
      ? this.db.prepare("select * from task_tags where project_id = ? order by task_id, tag_id").all(projectId)
      : this.db.prepare("select * from task_tags order by project_id, task_id, tag_id").all();
    return rows.map((row) => taskTagFromRow(row as TaskTagRow));
  }

  async addTaskTag(taskTag: TaskTag): Promise<void> {
    this.db.prepare("insert or ignore into task_tags (project_id, task_id, tag_id, created_at) values (@projectId, @taskId, @tagId, @createdAt)").run(taskTag);
  }

  async removeTaskTag(projectId: string, taskId: string, tagId: string): Promise<void> {
    this.db.prepare("delete from task_tags where project_id = ? and task_id = ? and tag_id = ?").run(projectId, taskId, tagId);
  }
}

class SqliteTrackRepository implements TrackRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async list(projectId?: string): Promise<Track[]> {
    const rows = projectId
      ? this.db.prepare("select * from tracks where project_id = ? order by machine asc, actor asc").all(projectId)
      : this.db.prepare("select * from tracks order by project_id, machine asc, actor asc").all();
    return rows.map((row) => trackFromRow(row as TrackRow));
  }

  async get(projectId: string, id: string): Promise<Track | null> {
    const row = this.db.prepare("select * from tracks where project_id = ? and id = ?").get(projectId, id) as TrackRow | undefined;
    return row ? trackFromRow(row) : null;
  }

  async findByActor(projectId: string, machine: string, actor: string): Promise<Track | null> {
    const row = this.db.prepare("select * from tracks where project_id = ? and machine = ? and actor = ?").get(projectId, machine, actor) as TrackRow | undefined;
    return row ? trackFromRow(row) : null;
  }

  async create(track: Track): Promise<void> {
    this.db.prepare(`
      insert into tracks (project_id, id, machine, actor, name, created_at, updated_at, archived_at)
      values (@projectId, @id, @machine, @actor, @name, @createdAt, @updatedAt, @archivedAt)
    `).run(track);
  }

  async update(track: Track): Promise<void> {
    this.db.prepare("update tracks set machine = @machine, actor = @actor, name = @name, updated_at = @updatedAt, archived_at = @archivedAt where project_id = @projectId and id = @id").run(track);
  }

  async listAssignments(projectId?: string): Promise<TrackAssignment[]> {
    const rows = projectId
      ? this.db.prepare("select * from track_assignments where project_id = ? order by track_id, position").all(projectId)
      : this.db.prepare("select * from track_assignments order by project_id, track_id, position").all();
    return rows.map((row) => assignmentFromRow(row as AssignmentRow));
  }

  async assign(assignment: TrackAssignment): Promise<void> {
    this.db.prepare("insert into track_assignments (project_id, track_id, task_id, position, assigned_at) values (@projectId, @trackId, @taskId, @position, @assignedAt)").run(assignment);
  }

  async unassign(projectId: string, trackId: string, taskId: string): Promise<void> {
    this.db.prepare("delete from track_assignments where project_id = ? and track_id = ? and task_id = ?").run(projectId, trackId, taskId);
  }

  async updateAssignment(assignment: TrackAssignment): Promise<void> {
    this.db.prepare("update track_assignments set position = @position, assigned_at = @assignedAt where project_id = @projectId and track_id = @trackId and task_id = @taskId").run(assignment);
  }
}

class SqliteActivityRepository implements ActivityRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async list(projectId: string | null = null, limit = 100): Promise<Activity[]> {
    const rows = projectId === null
      ? this.db.prepare("select * from activity order by created_at desc, id desc limit ?").all(limit)
      : this.db.prepare("select * from activity where project_id = ? order by created_at desc, id desc limit ?").all(projectId, limit);
    return rows.map((row) => activityFromRow(row as ActivityRow));
  }

  async version(projectId: string | null = null): Promise<string> {
    const row = projectId === null
      ? this.db.prepare("select count(*) as count, max(created_at) as max_created_at from activity").get()
      : this.db.prepare("select count(*) as count, max(created_at) as max_created_at from activity where project_id = ?").get(projectId);
    const version = row as { count: number; max_created_at: string | null };
    return `${version.count}:${version.max_created_at ?? ""}`;
  }

  async append(activity: Activity): Promise<void> {
    this.db.prepare(`
      insert into activity (project_id, id, type, subject_type, subject_id, message, data_json, machine, actor, created_at)
      values (@projectId, @id, @type, @subjectType, @subjectId, @message, @dataJson, @machine, @actor, @createdAt)
    `).run({ ...activity, dataJson: JSON.stringify(activity.data) });
  }
}

class SqliteInstructionRepository implements InstructionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async list(projectId?: string): Promise<Instruction[]> {
    const rows = projectId
      ? this.db.prepare("select * from instructions where project_id = ? order by name asc, id asc").all(projectId)
      : this.db.prepare("select * from instructions order by project_id, name asc, id asc").all();
    return rows.map((row) => instructionFromRow(row as InstructionRow));
  }

  async get(projectId: string, id: string): Promise<Instruction | null> {
    const row = this.db.prepare("select * from instructions where project_id = ? and id = ?").get(projectId, id) as InstructionRow | undefined;
    return row ? instructionFromRow(row) : null;
  }

  async create(instruction: Instruction): Promise<void> {
    this.db.prepare(`
      insert into instructions (project_id, id, name, query, body, enabled, created_at, updated_at, archived_at)
      values (@projectId, @id, @name, @query, @body, @enabled, @createdAt, @updatedAt, @archivedAt)
    `).run({ ...instruction, enabled: instruction.enabled ? 1 : 0 });
  }

  async update(instruction: Instruction): Promise<void> {
    this.db.prepare(`
      update instructions
      set name = @name, query = @query, body = @body, enabled = @enabled, updated_at = @updatedAt, archived_at = @archivedAt
      where project_id = @projectId and id = @id
    `).run({ ...instruction, enabled: instruction.enabled ? 1 : 0 });
  }
}

class SqliteSavedViewRepository implements SavedViewRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async list(projectId?: string): Promise<SavedView[]> {
    const rows = projectId
      ? this.db.prepare("select * from saved_views where project_id = ? order by name asc, id asc").all(projectId)
      : this.db.prepare("select * from saved_views order by project_id, name asc, id asc").all();
    return rows.map((row) => savedViewFromRow(row as SavedViewRow));
  }

  async get(projectId: string, id: string): Promise<SavedView | null> {
    const row = this.db.prepare("select * from saved_views where project_id = ? and id = ?").get(projectId, id) as SavedViewRow | undefined;
    return row ? savedViewFromRow(row) : null;
  }

  async create(view: SavedView): Promise<void> {
    this.db.prepare(`
      insert into saved_views (project_id, id, name, query, created_at, updated_at, archived_at)
      values (@projectId, @id, @name, @query, @createdAt, @updatedAt, @archivedAt)
    `).run(view);
  }

  async update(view: SavedView): Promise<void> {
    this.db.prepare(`
      update saved_views
      set name = @name, query = @query, updated_at = @updatedAt, archived_at = @archivedAt
      where project_id = @projectId and id = @id
    `).run(view);
  }
}

class SqliteQueueFeedRepository implements QueueFeedRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async list(projectId?: string): Promise<QueueFeed[]> {
    const rows = projectId
      ? this.db.prepare("select * from queue_feeds where project_id = ? order by name asc, id asc").all(projectId)
      : this.db.prepare("select * from queue_feeds order by project_id, name asc, id asc").all();
    return rows.map((row) => queueFeedFromRow(row as QueueFeedRow));
  }

  async get(projectId: string, id: string): Promise<QueueFeed | null> {
    const row = this.db.prepare("select * from queue_feeds where project_id = ? and id = ?").get(projectId, id) as QueueFeedRow | undefined;
    return row ? queueFeedFromRow(row) : null;
  }

  async create(feed: QueueFeed): Promise<void> {
    this.db.prepare(`
      insert into queue_feeds (project_id, id, name, query, created_at, updated_at, archived_at)
      values (@projectId, @id, @name, @query, @createdAt, @updatedAt, @archivedAt)
    `).run(feed);
  }

  async update(feed: QueueFeed): Promise<void> {
    this.db.prepare(`
      update queue_feeds
      set name = @name, query = @query, updated_at = @updatedAt, archived_at = @archivedAt
      where project_id = @projectId and id = @id
    `).run(feed);
  }
}

class SqliteMigrationRepository implements MigrationRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async list(): Promise<Migration[]> {
    ensureMigrationTable(this.db);
    return this.db.prepare("select * from migrations order by id asc").all().map((row) => migrationFromRow(row as MigrationRow));
  }

  async markApplied(migration: Migration): Promise<void> {
    ensureMigrationTable(this.db);
    this.db.prepare("insert or replace into migrations (id, name, applied_at) values (@id, @name, @appliedAt)").run(migration);
  }
}

function ensureMigrationTable(db: SqliteDatabase): void {
  db.exec(`
    create table if not exists migrations (
      id text primary key,
      name text not null,
      applied_at text not null
    )
  `);
}

function runEmbeddedMigrations(db: SqliteDatabase): void {
  ensureMigrationTable(db);
  for (const migration of sqliteMigrations) {
    const existing = db.prepare("select id from migrations where id = ?").get(migration.id);
    if (existing) {
      continue;
    }
    const run = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("insert or replace into migrations (id, name, applied_at) values (?, ?, ?)").run(migration.id, migration.name, nowIso());
    });
    run();
  }
}

function taskFromRow(row: TaskRow): Task {
  return {
    projectId: row.project_id,
    id: row.id,
    parentTaskId: row.parent_task_id,
    title: row.title,
    description: row.description,
    lifecycle: row.lifecycle,
    priority: row.priority,
    size: row.size,
    sourceDoc: row.source_doc,
    sourceSection: row.source_section,
    sourceAnchor: row.source_anchor,
    sourceLine: row.source_line,
    sourceText: row.source_text,
    completionBar: row.completion_bar,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    archivedAt: row.archived_at,
    version: row.version
  };
}

function dependencyFromRow(row: DependencyRow): Dependency {
  return {
    projectId: row.project_id,
    taskId: row.task_id,
    dependsOnTaskId: row.depends_on_task_id,
    createdAt: row.created_at
  };
}

function commentFromRow(row: CommentRow): Comment {
  return {
    projectId: row.project_id,
    id: row.id,
    taskId: row.task_id,
    machine: row.machine,
    actor: row.actor,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  };
}

function tagFromRow(row: TagRow): Tag {
  return {
    projectId: row.project_id,
    id: row.id,
    name: row.name,
    color: row.color,
    description: row.description,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  };
}

function taskTagFromRow(row: TaskTagRow): TaskTag {
  return {
    projectId: row.project_id,
    taskId: row.task_id,
    tagId: row.tag_id,
    createdAt: row.created_at
  };
}

function trackFromRow(row: TrackRow): Track {
  return {
    projectId: row.project_id,
    id: row.id,
    machine: row.machine,
    actor: row.actor,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  };
}

function assignmentFromRow(row: AssignmentRow): TrackAssignment {
  return {
    projectId: row.project_id,
    trackId: row.track_id,
    taskId: row.task_id,
    position: row.position,
    assignedAt: row.assigned_at
  };
}

function activityFromRow(row: ActivityRow): Activity {
  return {
    projectId: row.project_id,
    id: row.id,
    type: row.type,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    message: row.message,
    data: JSON.parse(row.data_json) as Record<string, unknown>,
    machine: row.machine,
    actor: row.actor,
    createdAt: row.created_at
  };
}

function instructionFromRow(row: InstructionRow): Instruction {
  return {
    projectId: row.project_id,
    id: row.id,
    name: row.name,
    query: row.query,
    body: row.body,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  };
}

function savedViewFromRow(row: SavedViewRow): SavedView {
  return {
    projectId: row.project_id,
    id: row.id,
    name: row.name,
    query: row.query,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  };
}

function queueFeedFromRow(row: QueueFeedRow): QueueFeed {
  return {
    projectId: row.project_id,
    id: row.id,
    name: row.name,
    query: row.query,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  };
}

function projectFromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  };
}

function migrationFromRow(row: MigrationRow): Migration {
  return {
    id: row.id,
    name: row.name,
    appliedAt: row.applied_at
  };
}
