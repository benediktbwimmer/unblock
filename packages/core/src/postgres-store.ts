import pg from "pg";
import { validation } from "./errors.js";
import { postgresMigrations, DEFAULT_TENANT_ID } from "./postgres-migrations.js";
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
import { nowIso } from "./types.js";

type Queryable = pg.Pool | pg.PoolClient;

export interface PostgresStoreOptions {
  connectionString?: string | undefined;
  tenantId?: string | undefined;
  autoMigrate?: boolean | undefined;
  pool?: pg.Pool | undefined;
}

export class PostgresStore implements AppStore {
  readonly capabilities = {
    dialect: "postgres",
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

  constructor(
    private readonly pool: pg.Pool,
    private readonly tenantId: string,
    private readonly queryable: Queryable = pool,
    private readonly ownsPool = true
  ) {
    this.projects = new PostgresProjectRepository(this.queryable, this.tenantId);
    this.tasks = new PostgresTaskRepository(this.queryable, this.tenantId);
    this.dependencies = new PostgresDependencyRepository(this.queryable, this.tenantId);
    this.comments = new PostgresCommentRepository(this.queryable, this.tenantId);
    this.tags = new PostgresTagRepository(this.queryable, this.tenantId);
    this.tracks = new PostgresTrackRepository(this.queryable, this.tenantId);
    this.instructions = new PostgresInstructionRepository(this.queryable, this.tenantId);
    this.views = new PostgresSavedViewRepository(this.queryable, this.tenantId);
    this.feeds = new PostgresQueueFeedRepository(this.queryable, this.tenantId);
    this.activity = new PostgresActivityRepository(this.queryable, this.tenantId);
    this.migrations = new PostgresMigrationRepository(this.queryable);
  }

  async transaction<T>(fn: (repos: RepositorySet) => Promise<T>): Promise<T> {
    if (isPoolClient(this.queryable)) {
      return fn(this);
    }
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const scoped = new PostgresStore(this.pool, this.tenantId, client, false);
      const result = await fn(scoped);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async exec(sql: string): Promise<void> {
    await this.queryable.query(sql);
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}

export async function createPostgresStore(options: PostgresStoreOptions = {}): Promise<PostgresStore> {
  const connectionString = options.connectionString ?? process.env.UNBLOCK_POSTGRES_URL;
  if (!options.pool && !connectionString) {
    validation("Postgres storage requires UNBLOCK_POSTGRES_URL or PostgresStoreOptions.connectionString.");
  }
  const pool = options.pool ?? new pg.Pool({ connectionString });
  const store = new PostgresStore(pool, options.tenantId ?? DEFAULT_TENANT_ID, pool, !options.pool);
  if (options.autoMigrate ?? true) {
    await runPostgresMigrations(store);
  }
  return store;
}

export async function runPostgresMigrations(store: PostgresStore): Promise<void> {
  await store.exec(`
    create table if not exists migrations (
      id text primary key,
      name text not null,
      applied_at timestamptz not null
    )
  `);
  for (const migration of postgresMigrations) {
    const existing = await store.migrations.list();
    if (existing.some((item) => item.id === migration.id)) continue;
    await store.transaction(async (repos) => {
      await (repos as PostgresStore).exec(migration.sql);
      await repos.migrations.markApplied({ id: migration.id, name: migration.name, appliedAt: nowIso() });
    });
  }
}

class PostgresProjectRepository implements ProjectRepository {
  constructor(private readonly db: Queryable, private readonly tenantId: string) {}

  async list(): Promise<Project[]> {
    const result = await this.db.query("select * from projects where tenant_id = $1 order by name asc, id asc", [this.tenantId]);
    return result.rows.map(projectFromRow);
  }

  async get(id: string): Promise<Project | null> {
    const result = await this.db.query("select * from projects where tenant_id = $1 and id = $2", [this.tenantId, id]);
    return result.rows[0] ? projectFromRow(result.rows[0]) : null;
  }

  async create(project: Project): Promise<void> {
    await this.db.query(`
      insert into projects (tenant_id, id, name, description, created_at, updated_at, archived_at)
      values ($1, $2, $3, $4, $5, $6, $7)
    `, [this.tenantId, project.id, project.name, project.description, project.createdAt, project.updatedAt, project.archivedAt]);
  }

  async update(project: Project): Promise<void> {
    await this.db.query(`
      update projects set name = $3, description = $4, updated_at = $5, archived_at = $6
      where tenant_id = $1 and id = $2
    `, [this.tenantId, project.id, project.name, project.description, project.updatedAt, project.archivedAt]);
  }
}

class PostgresTaskRepository implements TaskRepository {
  constructor(private readonly db: Queryable, private readonly tenantId: string) {}

  async list(projectId?: string): Promise<Task[]> {
    const result = projectId
      ? await this.db.query("select * from tasks where tenant_id = $1 and project_id = $2 order by created_at asc, id asc", [this.tenantId, projectId])
      : await this.db.query("select * from tasks where tenant_id = $1 order by project_id asc, created_at asc, id asc", [this.tenantId]);
    return result.rows.map(taskFromRow);
  }

  async get(projectId: string, id: string): Promise<Task | null> {
    const result = await this.db.query("select * from tasks where tenant_id = $1 and project_id = $2 and id = $3", [this.tenantId, projectId, id]);
    return result.rows[0] ? taskFromRow(result.rows[0]) : null;
  }

  async create(task: Task): Promise<void> {
    await this.db.query(`
      insert into tasks (
        tenant_id, project_id, id, parent_task_id, title, description, lifecycle, priority, size, source_doc, source_section,
        source_anchor, source_line, source_text, completion_bar, created_at, updated_at,
        started_at, finished_at, archived_at, version
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
      )
    `, taskParams(this.tenantId, task));
  }

  async update(task: Task): Promise<void> {
    await this.db.query(`
      update tasks set
        parent_task_id = $4, title = $5, description = $6, lifecycle = $7, priority = $8, size = $9,
        source_doc = $10, source_section = $11, source_anchor = $12, source_line = $13, source_text = $14,
        completion_bar = $15, created_at = $16, updated_at = $17, started_at = $18, finished_at = $19,
        archived_at = $20, version = $21
      where tenant_id = $1 and project_id = $2 and id = $3
    `, taskParams(this.tenantId, task));
  }

  async updateWithPrevious(previous: Task, task: Task): Promise<void> {
    const result = await this.db.query(`
      update tasks set
        parent_task_id = $4, title = $5, description = $6, lifecycle = $7, priority = $8, size = $9,
        source_doc = $10, source_section = $11, source_anchor = $12, source_line = $13, source_text = $14,
        completion_bar = $15, created_at = $16, updated_at = $17, started_at = $18, finished_at = $19,
        archived_at = $20, version = $21
      where tenant_id = $1 and project_id = $2 and id = $3 and version = $22
    `, [...taskParams(this.tenantId, task), previous.version]);
    if (result.rowCount !== 1) {
      validation("Task version conflict.", { taskId: task.id, expectedVersion: previous.version });
    }
  }

  async delete(projectId: string, id: string): Promise<void> {
    await this.db.query("update tasks set parent_task_id = null where tenant_id = $1 and project_id = $2 and parent_task_id = $3", [this.tenantId, projectId, id]);
    await this.db.query("delete from tasks where tenant_id = $1 and project_id = $2 and id = $3", [this.tenantId, projectId, id]);
  }
}

class PostgresDependencyRepository implements DependencyRepository {
  constructor(private readonly db: Queryable, private readonly tenantId: string) {}

  async list(projectId?: string): Promise<Dependency[]> {
    const result = projectId
      ? await this.db.query("select * from task_dependencies where tenant_id = $1 and project_id = $2 order by task_id, depends_on_task_id", [this.tenantId, projectId])
      : await this.db.query("select * from task_dependencies where tenant_id = $1 order by project_id, task_id, depends_on_task_id", [this.tenantId]);
    return result.rows.map(dependencyFromRow);
  }

  async listForTask(projectId: string, taskId: string): Promise<Dependency[]> {
    const result = await this.db.query("select * from task_dependencies where tenant_id = $1 and project_id = $2 and task_id = $3 order by depends_on_task_id", [this.tenantId, projectId, taskId]);
    return result.rows.map(dependencyFromRow);
  }

  async listDependents(projectId: string, dependsOnTaskId: string): Promise<Dependency[]> {
    const result = await this.db.query("select * from task_dependencies where tenant_id = $1 and project_id = $2 and depends_on_task_id = $3 order by task_id", [this.tenantId, projectId, dependsOnTaskId]);
    return result.rows.map(dependencyFromRow);
  }

  async inspectAdd(projectId: string, taskId: string, dependsOnTaskId: string) {
    const [task, dependsOnTask, exists, createsDependencyCycle, taskContainsDependsOnTask, dependsOnTaskContainsTask] = await Promise.all([
      this.taskSummary(projectId, taskId),
      this.taskSummary(projectId, dependsOnTaskId),
      this.hasDependency(projectId, taskId, dependsOnTaskId),
      this.hasDependencyPath(projectId, dependsOnTaskId, taskId),
      this.hasHierarchyPath(projectId, taskId, dependsOnTaskId),
      this.hasHierarchyPath(projectId, dependsOnTaskId, taskId)
    ]);
    return { task, dependsOnTask, exists, createsDependencyCycle, taskContainsDependsOnTask, dependsOnTaskContainsTask };
  }

  async hasDependency(projectId: string, taskId: string, dependsOnTaskId: string): Promise<boolean> {
    const result = await this.db.query("select 1 from task_dependencies where tenant_id = $1 and project_id = $2 and task_id = $3 and depends_on_task_id = $4 limit 1", [this.tenantId, projectId, taskId, dependsOnTaskId]);
    return (result.rowCount ?? 0) > 0;
  }

  async hasDependencyPath(projectId: string, fromTaskId: string, toTaskId: string): Promise<boolean> {
    const result = await this.db.query(`
      with recursive walk(id) as (
        select depends_on_task_id from task_dependencies where tenant_id = $1 and project_id = $2 and task_id = $3
        union
        select d.depends_on_task_id from task_dependencies d join walk w on d.task_id = w.id
        where d.tenant_id = $1 and d.project_id = $2
      )
      select 1 from walk where id = $4 limit 1
    `, [this.tenantId, projectId, fromTaskId, toTaskId]);
    return (result.rowCount ?? 0) > 0;
  }

  async hasHierarchyPath(projectId: string, ancestorTaskId: string, descendantTaskId: string): Promise<boolean> {
    const result = await this.db.query(`
      with recursive walk(id) as (
        select id from tasks where tenant_id = $1 and project_id = $2 and parent_task_id = $3
        union
        select t.id from tasks t join walk w on t.parent_task_id = w.id
        where t.tenant_id = $1 and t.project_id = $2
      )
      select 1 from walk where id = $4 limit 1
    `, [this.tenantId, projectId, ancestorTaskId, descendantTaskId]);
    return (result.rowCount ?? 0) > 0;
  }

  async add(dependency: Dependency): Promise<void> {
    await this.db.query(`
      insert into task_dependencies (tenant_id, project_id, task_id, depends_on_task_id, created_at)
      values ($1, $2, $3, $4, $5)
      on conflict do nothing
    `, [this.tenantId, dependency.projectId, dependency.taskId, dependency.dependsOnTaskId, dependency.createdAt]);
  }

  async addMany(dependencies: Dependency[]): Promise<void> {
    for (const dependency of dependencies) {
      await this.add(dependency);
    }
  }

  async remove(projectId: string, taskId: string, dependsOnTaskId: string): Promise<void> {
    await this.db.query("delete from task_dependencies where tenant_id = $1 and project_id = $2 and task_id = $3 and depends_on_task_id = $4", [this.tenantId, projectId, taskId, dependsOnTaskId]);
  }

  async replaceForTask(projectId: string, taskId: string, dependencies: Dependency[]): Promise<void> {
    await this.db.query("delete from task_dependencies where tenant_id = $1 and project_id = $2 and task_id = $3", [this.tenantId, projectId, taskId]);
    await this.addMany(dependencies);
  }

  private async taskSummary(projectId: string, taskId: string): Promise<{ id: string; archivedAt: string | null } | null> {
    const result = await this.db.query("select id, archived_at from tasks where tenant_id = $1 and project_id = $2 and id = $3", [this.tenantId, projectId, taskId]);
    return result.rows[0] ? { id: result.rows[0].id, archivedAt: nullableIso(result.rows[0].archived_at) } : null;
  }
}

class PostgresCommentRepository implements CommentRepository {
  constructor(private readonly db: Queryable, private readonly tenantId: string) {}

  async list(projectId?: string): Promise<Comment[]> {
    const result = projectId
      ? await this.db.query("select * from comments where tenant_id = $1 and project_id = $2 order by created_at asc, id asc", [this.tenantId, projectId])
      : await this.db.query("select * from comments where tenant_id = $1 order by project_id, created_at asc, id asc", [this.tenantId]);
    return result.rows.map(commentFromRow);
  }

  async listForTask(projectId: string, taskId: string): Promise<Comment[]> {
    const result = await this.db.query("select * from comments where tenant_id = $1 and project_id = $2 and task_id = $3 order by created_at asc, id asc", [this.tenantId, projectId, taskId]);
    return result.rows.map(commentFromRow);
  }

  async get(projectId: string, id: string): Promise<Comment | null> {
    const result = await this.db.query("select * from comments where tenant_id = $1 and project_id = $2 and id = $3", [this.tenantId, projectId, id]);
    return result.rows[0] ? commentFromRow(result.rows[0]) : null;
  }

  async create(comment: Comment): Promise<void> {
    await this.db.query(`
      insert into comments (tenant_id, project_id, id, task_id, machine, actor, body, created_at, updated_at, archived_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [this.tenantId, comment.projectId, comment.id, comment.taskId, comment.machine, comment.actor, comment.body, comment.createdAt, comment.updatedAt, comment.archivedAt]);
  }

  async update(comment: Comment): Promise<void> {
    await this.db.query(`
      update comments set task_id = $4, machine = $5, actor = $6, body = $7, updated_at = $8, archived_at = $9
      where tenant_id = $1 and project_id = $2 and id = $3
    `, [this.tenantId, comment.projectId, comment.id, comment.taskId, comment.machine, comment.actor, comment.body, comment.updatedAt, comment.archivedAt]);
  }
}

class PostgresTagRepository implements TagRepository {
  constructor(private readonly db: Queryable, private readonly tenantId: string) {}

  async list(projectId?: string): Promise<Tag[]> {
    const result = projectId
      ? await this.db.query("select * from tags where tenant_id = $1 and project_id = $2 order by sort_order asc, name asc", [this.tenantId, projectId])
      : await this.db.query("select * from tags where tenant_id = $1 order by project_id, sort_order asc, name asc", [this.tenantId]);
    return result.rows.map(tagFromRow);
  }

  async get(projectId: string, id: string): Promise<Tag | null> {
    const result = await this.db.query("select * from tags where tenant_id = $1 and project_id = $2 and id = $3", [this.tenantId, projectId, id]);
    return result.rows[0] ? tagFromRow(result.rows[0]) : null;
  }

  async findByName(projectId: string, name: string): Promise<Tag | null> {
    const result = await this.db.query("select * from tags where tenant_id = $1 and project_id = $2 and name = $3", [this.tenantId, projectId, name]);
    return result.rows[0] ? tagFromRow(result.rows[0]) : null;
  }

  async create(tag: Tag): Promise<void> {
    await this.db.query(`
      insert into tags (tenant_id, project_id, id, name, color, description, sort_order, created_at, updated_at, archived_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [this.tenantId, tag.projectId, tag.id, tag.name, tag.color, tag.description, tag.sortOrder, tag.createdAt, tag.updatedAt, tag.archivedAt]);
  }

  async update(tag: Tag): Promise<void> {
    await this.db.query(`
      update tags set name = $4, color = $5, description = $6, sort_order = $7, updated_at = $8, archived_at = $9
      where tenant_id = $1 and project_id = $2 and id = $3
    `, [this.tenantId, tag.projectId, tag.id, tag.name, tag.color, tag.description, tag.sortOrder, tag.updatedAt, tag.archivedAt]);
  }

  async listTaskTags(projectId?: string): Promise<TaskTag[]> {
    const result = projectId
      ? await this.db.query("select * from task_tags where tenant_id = $1 and project_id = $2 order by task_id, tag_id", [this.tenantId, projectId])
      : await this.db.query("select * from task_tags where tenant_id = $1 order by project_id, task_id, tag_id", [this.tenantId]);
    return result.rows.map(taskTagFromRow);
  }

  async hasTaskTag(projectId: string, taskId: string, tagId: string): Promise<boolean> {
    const result = await this.db.query("select 1 from task_tags where tenant_id = $1 and project_id = $2 and task_id = $3 and tag_id = $4 limit 1", [this.tenantId, projectId, taskId, tagId]);
    return (result.rowCount ?? 0) > 0;
  }

  async addTaskTag(taskTag: TaskTag): Promise<void> {
    await this.db.query(`
      insert into task_tags (tenant_id, project_id, task_id, tag_id, created_at)
      values ($1, $2, $3, $4, $5)
      on conflict do nothing
    `, [this.tenantId, taskTag.projectId, taskTag.taskId, taskTag.tagId, taskTag.createdAt]);
  }

  async addTaskTags(assignments: Array<{ taskTag: TaskTag }>): Promise<void> {
    for (const { taskTag } of assignments) {
      await this.addTaskTag(taskTag);
    }
  }

  async removeTaskTag(projectId: string, taskId: string, tagId: string): Promise<void> {
    await this.db.query("delete from task_tags where tenant_id = $1 and project_id = $2 and task_id = $3 and tag_id = $4", [this.tenantId, projectId, taskId, tagId]);
  }
}

class PostgresTrackRepository implements TrackRepository {
  constructor(private readonly db: Queryable, private readonly tenantId: string) {}

  async list(projectId?: string): Promise<Track[]> {
    const result = projectId
      ? await this.db.query("select * from tracks where tenant_id = $1 and project_id = $2 order by machine asc, actor asc", [this.tenantId, projectId])
      : await this.db.query("select * from tracks where tenant_id = $1 order by project_id, machine asc, actor asc", [this.tenantId]);
    return result.rows.map(trackFromRow);
  }

  async get(projectId: string, id: string): Promise<Track | null> {
    const result = await this.db.query("select * from tracks where tenant_id = $1 and project_id = $2 and id = $3", [this.tenantId, projectId, id]);
    return result.rows[0] ? trackFromRow(result.rows[0]) : null;
  }

  async findByActor(projectId: string, machine: string, actor: string): Promise<Track | null> {
    const result = await this.db.query("select * from tracks where tenant_id = $1 and project_id = $2 and machine = $3 and actor = $4", [this.tenantId, projectId, machine, actor]);
    return result.rows[0] ? trackFromRow(result.rows[0]) : null;
  }

  async create(track: Track): Promise<void> {
    await this.db.query(`
      insert into tracks (tenant_id, project_id, id, machine, actor, name, created_at, updated_at, archived_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [this.tenantId, track.projectId, track.id, track.machine, track.actor, track.name, track.createdAt, track.updatedAt, track.archivedAt]);
  }

  async update(track: Track): Promise<void> {
    await this.db.query(`
      update tracks set machine = $4, actor = $5, name = $6, updated_at = $7, archived_at = $8
      where tenant_id = $1 and project_id = $2 and id = $3
    `, [this.tenantId, track.projectId, track.id, track.machine, track.actor, track.name, track.updatedAt, track.archivedAt]);
  }

  async listAssignments(projectId?: string): Promise<TrackAssignment[]> {
    const result = projectId
      ? await this.db.query("select * from track_assignments where tenant_id = $1 and project_id = $2 order by track_id, position", [this.tenantId, projectId])
      : await this.db.query("select * from track_assignments where tenant_id = $1 order by project_id, track_id, position", [this.tenantId]);
    return result.rows.map(assignmentFromRow);
  }

  async assign(assignment: TrackAssignment): Promise<void> {
    await this.db.query(`
      insert into track_assignments (tenant_id, project_id, track_id, task_id, position, assigned_at)
      values ($1, $2, $3, $4, $5, $6)
    `, [this.tenantId, assignment.projectId, assignment.trackId, assignment.taskId, assignment.position, assignment.assignedAt]);
  }

  async unassign(projectId: string, trackId: string, taskId: string): Promise<void> {
    await this.db.query("delete from track_assignments where tenant_id = $1 and project_id = $2 and track_id = $3 and task_id = $4", [this.tenantId, projectId, trackId, taskId]);
  }

  async updateAssignment(assignment: TrackAssignment): Promise<void> {
    await this.db.query(`
      update track_assignments set position = $5, assigned_at = $6
      where tenant_id = $1 and project_id = $2 and track_id = $3 and task_id = $4
    `, [this.tenantId, assignment.projectId, assignment.trackId, assignment.taskId, assignment.position, assignment.assignedAt]);
  }
}

class PostgresActivityRepository implements ActivityRepository {
  constructor(private readonly db: Queryable, private readonly tenantId: string) {}

  async list(projectId: string | null = null, limit = 100): Promise<Activity[]> {
    const result = projectId === null
      ? await this.db.query("select * from activity where tenant_id = $1 order by created_at desc limit $2", [this.tenantId, limit])
      : await this.db.query("select * from activity where tenant_id = $1 and project_id = $2 order by created_at desc limit $3", [this.tenantId, projectId, limit]);
    return result.rows.map(activityFromRow);
  }

  async append(activity: Activity): Promise<void> {
    await this.db.query(`
      insert into activity (tenant_id, project_id, id, type, subject_type, subject_id, message, data_json, machine, actor, created_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
    `, [this.tenantId, activity.projectId, activity.id, activity.type, activity.subjectType, activity.subjectId, activity.message, JSON.stringify(activity.data), activity.machine, activity.actor, activity.createdAt]);
  }
}

class PostgresInstructionRepository implements InstructionRepository {
  constructor(private readonly db: Queryable, private readonly tenantId: string) {}

  async list(projectId?: string): Promise<Instruction[]> {
    const result = projectId
      ? await this.db.query("select * from instructions where tenant_id = $1 and project_id = $2 order by name asc, id asc", [this.tenantId, projectId])
      : await this.db.query("select * from instructions where tenant_id = $1 order by project_id, name asc, id asc", [this.tenantId]);
    return result.rows.map(instructionFromRow);
  }

  async get(projectId: string, id: string): Promise<Instruction | null> {
    const result = await this.db.query("select * from instructions where tenant_id = $1 and project_id = $2 and id = $3", [this.tenantId, projectId, id]);
    return result.rows[0] ? instructionFromRow(result.rows[0]) : null;
  }

  async create(instruction: Instruction): Promise<void> {
    await this.db.query(`
      insert into instructions (tenant_id, project_id, id, name, query, body, enabled, created_at, updated_at, archived_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [this.tenantId, instruction.projectId, instruction.id, instruction.name, instruction.query, instruction.body, instruction.enabled, instruction.createdAt, instruction.updatedAt, instruction.archivedAt]);
  }

  async createMany(instructions: Instruction[]): Promise<void> {
    for (const instruction of instructions) {
      await this.create(instruction);
    }
  }

  async update(instruction: Instruction): Promise<void> {
    await this.db.query(`
      update instructions set name = $4, query = $5, body = $6, enabled = $7, updated_at = $8, archived_at = $9
      where tenant_id = $1 and project_id = $2 and id = $3
    `, [this.tenantId, instruction.projectId, instruction.id, instruction.name, instruction.query, instruction.body, instruction.enabled, instruction.updatedAt, instruction.archivedAt]);
  }
}

class PostgresSavedViewRepository implements SavedViewRepository {
  constructor(private readonly db: Queryable, private readonly tenantId: string) {}

  async list(projectId?: string): Promise<SavedView[]> {
    const result = projectId
      ? await this.db.query("select * from saved_views where tenant_id = $1 and project_id = $2 order by name asc, id asc", [this.tenantId, projectId])
      : await this.db.query("select * from saved_views where tenant_id = $1 order by project_id, name asc, id asc", [this.tenantId]);
    return result.rows.map(savedViewFromRow);
  }

  async get(projectId: string, id: string): Promise<SavedView | null> {
    const result = await this.db.query("select * from saved_views where tenant_id = $1 and project_id = $2 and id = $3", [this.tenantId, projectId, id]);
    return result.rows[0] ? savedViewFromRow(result.rows[0]) : null;
  }

  async create(view: SavedView): Promise<void> {
    await this.db.query(`
      insert into saved_views (tenant_id, project_id, id, name, query, created_at, updated_at, archived_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [this.tenantId, view.projectId, view.id, view.name, view.query, view.createdAt, view.updatedAt, view.archivedAt]);
  }

  async update(view: SavedView): Promise<void> {
    await this.db.query(`
      update saved_views set name = $4, query = $5, updated_at = $6, archived_at = $7
      where tenant_id = $1 and project_id = $2 and id = $3
    `, [this.tenantId, view.projectId, view.id, view.name, view.query, view.updatedAt, view.archivedAt]);
  }
}

class PostgresQueueFeedRepository implements QueueFeedRepository {
  constructor(private readonly db: Queryable, private readonly tenantId: string) {}

  async list(projectId?: string): Promise<QueueFeed[]> {
    const result = projectId
      ? await this.db.query("select * from queue_feeds where tenant_id = $1 and project_id = $2 order by name asc, id asc", [this.tenantId, projectId])
      : await this.db.query("select * from queue_feeds where tenant_id = $1 order by project_id, name asc, id asc", [this.tenantId]);
    return result.rows.map(queueFeedFromRow);
  }

  async get(projectId: string, id: string): Promise<QueueFeed | null> {
    const result = await this.db.query("select * from queue_feeds where tenant_id = $1 and project_id = $2 and id = $3", [this.tenantId, projectId, id]);
    return result.rows[0] ? queueFeedFromRow(result.rows[0]) : null;
  }

  async create(feed: QueueFeed): Promise<void> {
    await this.db.query(`
      insert into queue_feeds (tenant_id, project_id, id, name, query, created_at, updated_at, archived_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [this.tenantId, feed.projectId, feed.id, feed.name, feed.query, feed.createdAt, feed.updatedAt, feed.archivedAt]);
  }

  async update(feed: QueueFeed): Promise<void> {
    await this.db.query(`
      update queue_feeds set name = $4, query = $5, updated_at = $6, archived_at = $7
      where tenant_id = $1 and project_id = $2 and id = $3
    `, [this.tenantId, feed.projectId, feed.id, feed.name, feed.query, feed.updatedAt, feed.archivedAt]);
  }
}

class PostgresMigrationRepository implements MigrationRepository {
  constructor(private readonly db: Queryable) {}

  async list(): Promise<Migration[]> {
    await this.db.query(`
      create table if not exists migrations (
        id text primary key,
        name text not null,
        applied_at timestamptz not null
      )
    `);
    const result = await this.db.query("select * from migrations order by id asc");
    return result.rows.map(migrationFromRow);
  }

  async markApplied(migration: Migration): Promise<void> {
    await this.db.query(`
      insert into migrations (id, name, applied_at)
      values ($1, $2, $3)
      on conflict (id) do update set name = excluded.name, applied_at = excluded.applied_at
    `, [migration.id, migration.name, migration.appliedAt]);
  }
}

function taskParams(tenantId: string, task: Task): unknown[] {
  return [
    tenantId,
    task.projectId,
    task.id,
    task.parentTaskId,
    task.title,
    task.description,
    task.lifecycle,
    task.priority,
    task.size,
    task.sourceDoc,
    task.sourceSection,
    task.sourceAnchor,
    task.sourceLine,
    task.sourceText,
    task.completionBar,
    task.createdAt,
    task.updatedAt,
    task.startedAt,
    task.finishedAt,
    task.archivedAt,
    task.version
  ];
}

function taskFromRow(row: any): Task {
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
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    startedAt: nullableIso(row.started_at),
    finishedAt: nullableIso(row.finished_at),
    archivedAt: nullableIso(row.archived_at),
    version: row.version
  };
}

function dependencyFromRow(row: any): Dependency {
  return { projectId: row.project_id, taskId: row.task_id, dependsOnTaskId: row.depends_on_task_id, createdAt: iso(row.created_at) };
}

function commentFromRow(row: any): Comment {
  return { projectId: row.project_id, id: row.id, taskId: row.task_id, machine: row.machine, actor: row.actor, body: row.body, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), archivedAt: nullableIso(row.archived_at) };
}

function tagFromRow(row: any): Tag {
  return { projectId: row.project_id, id: row.id, name: row.name, color: row.color, description: row.description, sortOrder: row.sort_order, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), archivedAt: nullableIso(row.archived_at) };
}

function taskTagFromRow(row: any): TaskTag {
  return { projectId: row.project_id, taskId: row.task_id, tagId: row.tag_id, createdAt: iso(row.created_at) };
}

function trackFromRow(row: any): Track {
  return { projectId: row.project_id, id: row.id, machine: row.machine, actor: row.actor, name: row.name, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), archivedAt: nullableIso(row.archived_at) };
}

function assignmentFromRow(row: any): TrackAssignment {
  return { projectId: row.project_id, trackId: row.track_id, taskId: row.task_id, position: row.position, assignedAt: iso(row.assigned_at) };
}

function activityFromRow(row: any): Activity {
  return { projectId: row.project_id, id: row.id, type: row.type, subjectType: row.subject_type, subjectId: row.subject_id, message: row.message, data: typeof row.data_json === "string" ? JSON.parse(row.data_json) : row.data_json, machine: row.machine, actor: row.actor, createdAt: iso(row.created_at) };
}

function instructionFromRow(row: any): Instruction {
  return { projectId: row.project_id, id: row.id, name: row.name, query: row.query, body: row.body, enabled: row.enabled === true, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), archivedAt: nullableIso(row.archived_at) };
}

function savedViewFromRow(row: any): SavedView {
  return { projectId: row.project_id, id: row.id, name: row.name, query: row.query, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), archivedAt: nullableIso(row.archived_at) };
}

function queueFeedFromRow(row: any): QueueFeed {
  return { projectId: row.project_id, id: row.id, name: row.name, query: row.query, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), archivedAt: nullableIso(row.archived_at) };
}

function projectFromRow(row: any): Project {
  return { id: row.id, name: row.name, description: row.description, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), archivedAt: nullableIso(row.archived_at) };
}

function migrationFromRow(row: any): Migration {
  return { id: row.id, name: row.name, appliedAt: iso(row.applied_at) };
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function isPoolClient(value: Queryable): value is pg.PoolClient {
  return "release" in value;
}
