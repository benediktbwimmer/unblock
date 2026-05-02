import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sqliteMigrations } from "./migrations.js";
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
import type { Activity, Dependency, Lifecycle, Migration, Priority, Tag, Task, TaskSize, TaskTag, Track, TrackAssignment } from "./types.js";
import { defaultNotJiraDbPath, nowIso } from "./types.js";

type SqliteDatabase = Database.Database;

export interface SqliteStoreOptions {
  databasePath?: string | undefined;
  autoMigrate?: boolean;
}

interface TaskRow {
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
  task_id: string;
  depends_on_task_id: string;
  created_at: string;
}

interface TagRow {
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
  task_id: string;
  tag_id: string;
  created_at: string;
}

interface TrackRow {
  id: string;
  actor: string;
  name: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface AssignmentRow {
  track_id: string;
  task_id: string;
  position: string;
  assigned_at: string;
}

interface ActivityRow {
  id: string;
  type: string;
  subject_type: Activity["subjectType"];
  subject_id: string | null;
  message: string;
  data_json: string;
  actor: string | null;
  created_at: string;
}

interface MigrationRow {
  id: string;
  name: string;
  applied_at: string;
}

export class SqliteStore implements AppStore {
  readonly tasks: TaskRepository;
  readonly dependencies: DependencyRepository;
  readonly tags: TagRepository;
  readonly tracks: TrackRepository;
  readonly activity: ActivityRepository;
  readonly migrations: MigrationRepository;

  constructor(private readonly db: SqliteDatabase, options: SqliteStoreOptions = {}) {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    ensureMigrationTable(this.db);
    if (options.autoMigrate ?? true) {
      runEmbeddedMigrations(this.db);
    }
    this.tasks = new SqliteTaskRepository(this.db);
    this.dependencies = new SqliteDependencyRepository(this.db);
    this.tags = new SqliteTagRepository(this.db);
    this.tracks = new SqliteTrackRepository(this.db);
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
  const databasePath = options.databasePath ?? process.env.NOT_JIRA_DB ?? defaultNotJiraDbPath();
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  return new SqliteStore(db, options);
}

class SqliteTaskRepository implements TaskRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async list(): Promise<Task[]> {
    return this.db.prepare("select * from tasks order by created_at asc, id asc").all().map((row) => taskFromRow(row as TaskRow));
  }

  async get(id: string): Promise<Task | null> {
    const row = this.db.prepare("select * from tasks where id = ?").get(id) as TaskRow | undefined;
    return row ? taskFromRow(row) : null;
  }

  async create(task: Task): Promise<void> {
    this.db.prepare(`
      insert into tasks (
        id, parent_task_id, title, description, lifecycle, priority, size, source_doc, source_section,
        source_anchor, source_line, source_text, completion_bar, created_at, updated_at,
        started_at, finished_at, archived_at, version
      ) values (
        @id, @parentTaskId, @title, @description, @lifecycle, @priority, @size, @sourceDoc, @sourceSection,
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
      where id = @id
    `).run(task);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("delete from tasks where id = ?").run(id);
  }
}

class SqliteDependencyRepository implements DependencyRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async list(): Promise<Dependency[]> {
    return this.db.prepare("select * from task_dependencies order by task_id, depends_on_task_id").all().map((row) => dependencyFromRow(row as DependencyRow));
  }

  async listForTask(taskId: string): Promise<Dependency[]> {
    return this.db.prepare("select * from task_dependencies where task_id = ? order by depends_on_task_id").all(taskId).map((row) => dependencyFromRow(row as DependencyRow));
  }

  async listDependents(dependsOnTaskId: string): Promise<Dependency[]> {
    return this.db.prepare("select * from task_dependencies where depends_on_task_id = ? order by task_id").all(dependsOnTaskId).map((row) => dependencyFromRow(row as DependencyRow));
  }

  async add(dependency: Dependency): Promise<void> {
    this.db.prepare("insert or ignore into task_dependencies (task_id, depends_on_task_id, created_at) values (@taskId, @dependsOnTaskId, @createdAt)").run(dependency);
  }

  async remove(taskId: string, dependsOnTaskId: string): Promise<void> {
    this.db.prepare("delete from task_dependencies where task_id = ? and depends_on_task_id = ?").run(taskId, dependsOnTaskId);
  }

  async replaceForTask(taskId: string, dependencies: Dependency[]): Promise<void> {
    this.db.prepare("delete from task_dependencies where task_id = ?").run(taskId);
    const insert = this.db.prepare("insert or ignore into task_dependencies (task_id, depends_on_task_id, created_at) values (@taskId, @dependsOnTaskId, @createdAt)");
    for (const dependency of dependencies) {
      insert.run(dependency);
    }
  }
}

class SqliteTagRepository implements TagRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async list(): Promise<Tag[]> {
    return this.db.prepare("select * from tags order by sort_order asc, name asc").all().map((row) => tagFromRow(row as TagRow));
  }

  async get(id: string): Promise<Tag | null> {
    const row = this.db.prepare("select * from tags where id = ?").get(id) as TagRow | undefined;
    return row ? tagFromRow(row) : null;
  }

  async findByName(name: string): Promise<Tag | null> {
    const row = this.db.prepare("select * from tags where name = ?").get(name) as TagRow | undefined;
    return row ? tagFromRow(row) : null;
  }

  async create(tag: Tag): Promise<void> {
    this.db.prepare(`
      insert into tags (id, name, color, description, sort_order, created_at, updated_at, archived_at)
      values (@id, @name, @color, @description, @sortOrder, @createdAt, @updatedAt, @archivedAt)
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
      where id = @id
    `).run(tag);
  }

  async listTaskTags(): Promise<TaskTag[]> {
    return this.db.prepare("select * from task_tags order by task_id, tag_id").all().map((row) => taskTagFromRow(row as TaskTagRow));
  }

  async addTaskTag(taskTag: TaskTag): Promise<void> {
    this.db.prepare("insert or ignore into task_tags (task_id, tag_id, created_at) values (@taskId, @tagId, @createdAt)").run(taskTag);
  }

  async removeTaskTag(taskId: string, tagId: string): Promise<void> {
    this.db.prepare("delete from task_tags where task_id = ? and tag_id = ?").run(taskId, tagId);
  }
}

class SqliteTrackRepository implements TrackRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async list(): Promise<Track[]> {
    return this.db.prepare("select * from tracks order by actor asc").all().map((row) => trackFromRow(row as TrackRow));
  }

  async get(id: string): Promise<Track | null> {
    const row = this.db.prepare("select * from tracks where id = ?").get(id) as TrackRow | undefined;
    return row ? trackFromRow(row) : null;
  }

  async findByActor(actor: string): Promise<Track | null> {
    const row = this.db.prepare("select * from tracks where actor = ?").get(actor) as TrackRow | undefined;
    return row ? trackFromRow(row) : null;
  }

  async create(track: Track): Promise<void> {
    this.db.prepare(`
      insert into tracks (id, actor, name, created_at, updated_at, archived_at)
      values (@id, @actor, @name, @createdAt, @updatedAt, @archivedAt)
    `).run(track);
  }

  async update(track: Track): Promise<void> {
    this.db.prepare("update tracks set actor = @actor, name = @name, updated_at = @updatedAt, archived_at = @archivedAt where id = @id").run(track);
  }

  async listAssignments(): Promise<TrackAssignment[]> {
    return this.db.prepare("select * from track_assignments order by track_id, position").all().map((row) => assignmentFromRow(row as AssignmentRow));
  }

  async assign(assignment: TrackAssignment): Promise<void> {
    this.db.prepare("insert into track_assignments (track_id, task_id, position, assigned_at) values (@trackId, @taskId, @position, @assignedAt)").run(assignment);
  }

  async unassign(trackId: string, taskId: string): Promise<void> {
    this.db.prepare("delete from track_assignments where track_id = ? and task_id = ?").run(trackId, taskId);
  }

  async updateAssignment(assignment: TrackAssignment): Promise<void> {
    this.db.prepare("update track_assignments set position = @position, assigned_at = @assignedAt where track_id = @trackId and task_id = @taskId").run(assignment);
  }
}

class SqliteActivityRepository implements ActivityRepository {
  constructor(private readonly db: SqliteDatabase) {}

  async list(limit = 100): Promise<Activity[]> {
    return this.db.prepare("select * from activity order by created_at desc limit ?").all(limit).map((row) => activityFromRow(row as ActivityRow));
  }

  async append(activity: Activity): Promise<void> {
    this.db.prepare(`
      insert into activity (id, type, subject_type, subject_id, message, data_json, actor, created_at)
      values (@id, @type, @subjectType, @subjectId, @message, @dataJson, @actor, @createdAt)
    `).run({ ...activity, dataJson: JSON.stringify(activity.data) });
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
    taskId: row.task_id,
    dependsOnTaskId: row.depends_on_task_id,
    createdAt: row.created_at
  };
}

function tagFromRow(row: TagRow): Tag {
  return {
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
    taskId: row.task_id,
    tagId: row.tag_id,
    createdAt: row.created_at
  };
}

function trackFromRow(row: TrackRow): Track {
  return {
    id: row.id,
    actor: row.actor,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  };
}

function assignmentFromRow(row: AssignmentRow): TrackAssignment {
  return {
    trackId: row.track_id,
    taskId: row.task_id,
    position: row.position,
    assignedAt: row.assigned_at
  };
}

function activityFromRow(row: ActivityRow): Activity {
  return {
    id: row.id,
    type: row.type,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    message: row.message,
    data: JSON.parse(row.data_json) as Record<string, unknown>,
    actor: row.actor,
    createdAt: row.created_at
  };
}

function migrationFromRow(row: MigrationRow): Migration {
  return {
    id: row.id,
    name: row.name,
    appliedAt: row.applied_at
  };
}
