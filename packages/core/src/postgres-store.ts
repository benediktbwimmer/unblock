import pg from "pg";
import { validation } from "./errors.js";
import { lowerPostgresMatcherTaskIds } from "./postgres-matcher.js";
import { postgresMigrations, DEFAULT_TENANT_ID } from "./postgres-migrations.js";
import type {
  ActivityRepository,
  AppStore,
  CommentRepository,
  DependencyRepository,
  HostedAuditRepository,
  HostedIdentityRepository,
  HostedSecretRepository,
  InboxEventRepository,
  MigrationRepository,
  MatcherQueryRepository,
  OutboxEventRepository,
  ProjectRepository,
  QueueFeedRepository,
  RepositorySet,
  InstructionRepository,
  SavedViewRepository,
  TagRepository,
  TaskRepository,
  TrackRepository
} from "./store.js";
import type { Activity, Comment, Dependency, HostedAuditEvent, HostedIdentity, HostedSecret, InboxEvent, Instruction, Migration, OutboxEvent, Project, QueueFeed, SavedView, Tag, Task, TaskTag, Track, TrackAssignment } from "./types.js";
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
    matcherQuery: "store",
    bulkOperations: true,
    outboxInbox: true
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
  readonly outbox: OutboxEventRepository;
  readonly inbox: InboxEventRepository;
  readonly matcher: MatcherQueryRepository;
  readonly hostedIdentity: HostedIdentityRepository;
  readonly hostedAudit: HostedAuditRepository;
  readonly hostedSecrets: HostedSecretRepository;

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
    this.outbox = new PostgresOutboxEventRepository(this.queryable, this.tenantId);
    this.inbox = new PostgresInboxEventRepository(this.queryable, this.tenantId);
    this.matcher = new PostgresMatcherRepository(this.queryable, this.tenantId);
    this.hostedIdentity = new PostgresHostedIdentityRepository(this.queryable, this.tenantId);
    this.hostedAudit = new PostgresHostedAuditRepository(this.queryable, this.tenantId);
    this.hostedSecrets = new PostgresHostedSecretRepository(this.queryable, this.tenantId);
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

class PostgresMatcherRepository implements MatcherQueryRepository {
  constructor(private readonly db: Queryable, private readonly tenantId: string) {}

  async matchTaskIds(projectId: string, query: string, filters = {}): Promise<string[]> {
    const lowered = lowerPostgresMatcherTaskIds(projectId, query, filters);
    const result = await this.db.query(lowered.taskIds.sql, [this.tenantId, ...lowered.taskIds.params]);
    return result.rows.map((row) => String(row.id));
  }
}

class PostgresHostedIdentityRepository implements HostedIdentityRepository {
  constructor(private readonly db: Queryable, private readonly tenantId: string) {}

  async sync(identity: HostedIdentity): Promise<void> {
    const now = nowIso();
    await this.db.query(`
      insert into tenants (id, slug, name, workos_organization_id, created_at, updated_at, archived_at)
      values ($1, $2, $3, $4, $5, $5, null)
      on conflict (id) do update set
        workos_organization_id = excluded.workos_organization_id,
        updated_at = excluded.updated_at
    `, [
      identity.tenantId,
      identity.tenantId.toLowerCase(),
      identity.organizationId,
      identity.organizationId,
      now
    ]);
    await this.db.query(`
      insert into tenant_members (
        tenant_id, principal_id, role, workos_user_id, roles_json, permissions_json, role_source,
        created_at, updated_at, disabled_at, last_seen_at
      ) values (
        $1, $2, $3, $2, $4::jsonb, $5::jsonb, $6, $7, $7, null, $7
      )
      on conflict (tenant_id, principal_id) do update set
        role = excluded.role,
        workos_user_id = excluded.workos_user_id,
        roles_json = excluded.roles_json,
        permissions_json = excluded.permissions_json,
        role_source = excluded.role_source,
        updated_at = excluded.updated_at,
        disabled_at = null,
        last_seen_at = excluded.last_seen_at
    `, [
      this.tenantId,
      identity.principalId,
      identity.roles[0] ?? "member",
      JSON.stringify(identity.roles),
      JSON.stringify(identity.permissions),
      identity.issuedBy,
      now
    ]);
  }

  async tenantRole(principalId: string): Promise<string | null> {
    const result = await this.db.query(`
      select role from tenant_members
      where tenant_id = $1 and principal_id = $2 and disabled_at is null
    `, [this.tenantId, principalId]);
    return result.rows[0]?.role ? String(result.rows[0].role) : null;
  }

  async projectRole(projectId: string, principalId: string): Promise<string | null> {
    const result = await this.db.query(`
      select role from project_members
      where tenant_id = $1 and project_id = $2 and principal_id = $3 and disabled_at is null
    `, [this.tenantId, projectId, principalId]);
    return result.rows[0]?.role ? String(result.rows[0].role) : null;
  }
}

class PostgresHostedAuditRepository implements HostedAuditRepository {
  constructor(private readonly db: Queryable, private readonly tenantId: string) {}

  async append(event: HostedAuditEvent): Promise<void> {
    await this.db.query(`
      insert into hosted_audit_events (
        tenant_id, project_id, id, event_type, principal_id, subject_type, subject_id,
        message, data_json, request_id, ip_address, user_agent, created_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)
    `, [
      this.tenantId,
      event.projectId,
      event.id,
      event.eventType,
      event.principalId,
      event.subjectType,
      event.subjectId,
      event.message,
      JSON.stringify(event.data),
      event.requestId,
      event.ipAddress,
      event.userAgent,
      event.createdAt
    ]);
  }

  async list(options: { tenantId?: string | undefined; projectId?: string | null | undefined; limit?: number | undefined } = {}): Promise<HostedAuditEvent[]> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const tenantId = options.tenantId ?? this.tenantId;
    const result = options.projectId === undefined
      ? await this.db.query("select * from hosted_audit_events where tenant_id = $1 order by created_at desc limit $2", [tenantId, limit])
      : await this.db.query("select * from hosted_audit_events where tenant_id = $1 and project_id is not distinct from $2 order by created_at desc limit $3", [tenantId, options.projectId, limit]);
    return result.rows.map(hostedAuditFromRow);
  }
}

class PostgresHostedSecretRepository implements HostedSecretRepository {
  constructor(private readonly db: Queryable, private readonly tenantId: string) {}

  async create(secret: HostedSecret): Promise<void> {
    await this.db.query(`
      insert into hosted_secrets (
        tenant_id, project_id, id, name, purpose, ciphertext, key_id, algorithm,
        created_at, updated_at, rotated_at, archived_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, hostedSecretParams(this.tenantId, secret));
  }

  async get(id: string): Promise<HostedSecret | null> {
    const result = await this.db.query("select * from hosted_secrets where tenant_id = $1 and id = $2", [this.tenantId, id]);
    return result.rows[0] ? hostedSecretFromRow(result.rows[0]) : null;
  }

  async findByName(projectId: string | null, name: string): Promise<HostedSecret | null> {
    const result = await this.db.query(`
      select * from hosted_secrets
      where tenant_id = $1 and project_id is not distinct from $2 and lower(name) = lower($3) and archived_at is null
    `, [this.tenantId, projectId, name]);
    return result.rows[0] ? hostedSecretFromRow(result.rows[0]) : null;
  }

  async update(secret: HostedSecret): Promise<void> {
    await this.db.query(`
      update hosted_secrets set
        name = $4, purpose = $5, ciphertext = $6, key_id = $7, algorithm = $8,
        updated_at = $10, rotated_at = $11, archived_at = $12
      where tenant_id = $1 and project_id is not distinct from $2 and id = $3
    `, hostedSecretParams(this.tenantId, secret));
  }

  async archive(id: string, archivedAt: string): Promise<void> {
    await this.db.query("update hosted_secrets set archived_at = $3, updated_at = $3 where tenant_id = $1 and id = $2", [this.tenantId, id, archivedAt]);
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

  async createMany(tasks: Task[]): Promise<void> {
    for (const chunk of chunks(tasks, 500)) {
      if (chunk.length === 0) continue;
      await this.db.query(`
        insert into tasks (
          tenant_id, project_id, id, parent_task_id, title, description, lifecycle, priority, size, source_doc, source_section,
          source_anchor, source_line, source_text, completion_bar, created_at, updated_at,
          started_at, finished_at, archived_at, version
        ) values ${valuesPlaceholders(chunk.length, 21)}
      `, chunk.flatMap((task) => taskParams(this.tenantId, task)));
    }
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
    if (isPoolClient(this.db)) {
      const task = await this.taskSummary(projectId, taskId);
      const dependsOnTask = await this.taskSummary(projectId, dependsOnTaskId);
      const exists = await this.hasDependency(projectId, taskId, dependsOnTaskId);
      const createsDependencyCycle = await this.hasDependencyPath(projectId, dependsOnTaskId, taskId);
      const taskContainsDependsOnTask = await this.hasHierarchyPath(projectId, taskId, dependsOnTaskId);
      const dependsOnTaskContainsTask = await this.hasHierarchyPath(projectId, dependsOnTaskId, taskId);
      return { task, dependsOnTask, exists, createsDependencyCycle, taskContainsDependsOnTask, dependsOnTaskContainsTask };
    }
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
    for (const chunk of chunks(dependencies, 1000)) {
      if (chunk.length === 0) continue;
      await this.db.query(`
        insert into task_dependencies (tenant_id, project_id, task_id, depends_on_task_id, created_at)
        values ${valuesPlaceholders(chunk.length, 5)}
        on conflict do nothing
      `, chunk.flatMap((dependency) => [this.tenantId, dependency.projectId, dependency.taskId, dependency.dependsOnTaskId, dependency.createdAt]));
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

  async createMany(comments: Comment[]): Promise<void> {
    for (const chunk of chunks(comments, 1000)) {
      if (chunk.length === 0) continue;
      await this.db.query(`
        insert into comments (tenant_id, project_id, id, task_id, machine, actor, body, created_at, updated_at, archived_at)
        values ${valuesPlaceholders(chunk.length, 10)}
      `, chunk.flatMap((comment) => [this.tenantId, comment.projectId, comment.id, comment.taskId, comment.machine, comment.actor, comment.body, comment.createdAt, comment.updatedAt, comment.archivedAt]));
    }
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

  async createMany(tags: Tag[]): Promise<void> {
    for (const chunk of chunks(tags, 1000)) {
      if (chunk.length === 0) continue;
      await this.db.query(`
        insert into tags (tenant_id, project_id, id, name, color, description, sort_order, created_at, updated_at, archived_at)
        values ${valuesPlaceholders(chunk.length, 10)}
      `, chunk.flatMap((tag) => [this.tenantId, tag.projectId, tag.id, tag.name, tag.color, tag.description, tag.sortOrder, tag.createdAt, tag.updatedAt, tag.archivedAt]));
    }
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
    for (const chunk of chunks(assignments, 1000)) {
      if (chunk.length === 0) continue;
      await this.db.query(`
        insert into task_tags (tenant_id, project_id, task_id, tag_id, created_at)
        values ${valuesPlaceholders(chunk.length, 5)}
        on conflict do nothing
      `, chunk.flatMap(({ taskTag }) => [this.tenantId, taskTag.projectId, taskTag.taskId, taskTag.tagId, taskTag.createdAt]));
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
      ? await this.db.query("select * from activity where tenant_id = $1 order by created_at desc, id desc limit $2", [this.tenantId, limit])
      : await this.db.query("select * from activity where tenant_id = $1 and project_id = $2 order by created_at desc, id desc limit $3", [this.tenantId, projectId, limit]);
    return result.rows.map(activityFromRow);
  }

  async version(projectId: string | null = null): Promise<string> {
    const result = projectId === null
      ? await this.db.query("select count(*)::int as count, max(created_at) as max_created_at from activity where tenant_id = $1", [this.tenantId])
      : await this.db.query("select count(*)::int as count, max(created_at) as max_created_at from activity where tenant_id = $1 and project_id = $2", [this.tenantId, projectId]);
    const row = result.rows[0] as { count: number; max_created_at: Date | string | null } | undefined;
    const maxCreatedAt = row?.max_created_at instanceof Date ? row.max_created_at.toISOString() : row?.max_created_at ?? "";
    return `${row?.count ?? 0}:${maxCreatedAt}`;
  }

  async append(activity: Activity): Promise<void> {
    await this.db.query(`
      insert into activity (tenant_id, project_id, id, type, subject_type, subject_id, message, data_json, machine, actor, created_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
    `, [this.tenantId, activity.projectId, activity.id, activity.type, activity.subjectType, activity.subjectId, activity.message, JSON.stringify(activity.data), activity.machine, activity.actor, activity.createdAt]);
  }

  async appendMany(activity: Activity[]): Promise<void> {
    for (const chunk of chunks(activity, 1000)) {
      if (chunk.length === 0) continue;
      await this.db.query(`
        insert into activity (tenant_id, project_id, id, type, subject_type, subject_id, message, data_json, machine, actor, created_at)
        values ${jsonValuesPlaceholders(chunk.length, 11, new Set([8]))}
      `, chunk.flatMap((item) => [this.tenantId, item.projectId, item.id, item.type, item.subjectType, item.subjectId, item.message, JSON.stringify(item.data), item.machine, item.actor, item.createdAt]));
    }
  }
}

class PostgresOutboxEventRepository implements OutboxEventRepository {
  constructor(private readonly db: Queryable, private readonly tenantId: string) {}

  async enqueue(event: OutboxEvent): Promise<OutboxEvent> {
    const result = await this.db.query(`
      with inserted as (
        insert into outbox_events (
          tenant_id, project_id, id, event_type, subject_type, subject_id, payload_json, idempotency_key,
          status, attempt_count, available_at, created_at, claimed_at, processed_at, error_json, evidence_json
        )
        values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb)
        on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing
        returning *, true as inserted
      )
      select * from inserted
      union all
      select outbox_events.*, false as inserted
      from outbox_events
      where tenant_id = $1 and idempotency_key = $8 and $8 is not null and not exists (select 1 from inserted)
      limit 1
    `, [
      this.tenantId,
      event.projectId,
      event.id,
      event.eventType,
      event.subjectType,
      event.subjectId,
      JSON.stringify(event.payload),
      event.idempotencyKey,
      event.status,
      event.attemptCount,
      event.availableAt,
      event.createdAt,
      event.claimedAt,
      event.processedAt,
      JSON.stringify(event.error),
      JSON.stringify(event.evidence)
    ]);
    return outboxEventFromRow(result.rows[0]);
  }

  async get(id: string): Promise<OutboxEvent | null> {
    const result = await this.db.query("select * from outbox_events where tenant_id = $1 and id = $2", [this.tenantId, id]);
    return result.rows[0] ? outboxEventFromRow(result.rows[0]) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<OutboxEvent | null> {
    const result = await this.db.query("select * from outbox_events where tenant_id = $1 and idempotency_key = $2", [this.tenantId, idempotencyKey]);
    return result.rows[0] ? outboxEventFromRow(result.rows[0]) : null;
  }

  async listReady(limit: number, now: string): Promise<OutboxEvent[]> {
    const result = await this.db.query(`
      select * from outbox_events
      where tenant_id = $1 and status in ('pending', 'failed') and available_at <= $2
      order by available_at asc, created_at asc
      limit $3
    `, [this.tenantId, now, limit]);
    return result.rows.map(outboxEventFromRow);
  }

  async claim(id: string, claimedAt: string): Promise<OutboxEvent | null> {
    const result = await this.db.query(`
      update outbox_events
      set status = 'claimed', claimed_at = $3, attempt_count = attempt_count + 1
      where tenant_id = $1 and id = $2 and status in ('pending', 'failed') and available_at <= $3
      returning *
    `, [this.tenantId, id, claimedAt]);
    return result.rows[0] ? outboxEventFromRow(result.rows[0]) : null;
  }

  async markProcessed(id: string, processedAt: string, evidence: Record<string, unknown> = {}): Promise<OutboxEvent | null> {
    const result = await this.db.query(`
      update outbox_events
      set status = 'processed', processed_at = $3, error_json = null, evidence_json = evidence_json || $4::jsonb
      where tenant_id = $1 and id = $2
      returning *
    `, [this.tenantId, id, processedAt, JSON.stringify(evidence)]);
    return result.rows[0] ? outboxEventFromRow(result.rows[0]) : null;
  }

  async markFailed(id: string, error: Record<string, unknown>, availableAt: string, evidence: Record<string, unknown> = {}): Promise<OutboxEvent | null> {
    const result = await this.db.query(`
      update outbox_events
      set status = 'failed', available_at = $3, error_json = $4::jsonb, evidence_json = evidence_json || $5::jsonb
      where tenant_id = $1 and id = $2
      returning *
    `, [this.tenantId, id, availableAt, JSON.stringify(error), JSON.stringify(evidence)]);
    return result.rows[0] ? outboxEventFromRow(result.rows[0]) : null;
  }

  async markDead(id: string, error: Record<string, unknown>, evidence: Record<string, unknown> = {}): Promise<OutboxEvent | null> {
    const result = await this.db.query(`
      update outbox_events
      set status = 'dead', error_json = $3::jsonb, evidence_json = evidence_json || $4::jsonb
      where tenant_id = $1 and id = $2
      returning *
    `, [this.tenantId, id, JSON.stringify(error), JSON.stringify(evidence)]);
    return result.rows[0] ? outboxEventFromRow(result.rows[0]) : null;
  }
}

class PostgresInboxEventRepository implements InboxEventRepository {
  constructor(private readonly db: Queryable, private readonly tenantId: string) {}

  async receive(event: InboxEvent): Promise<{ event: InboxEvent; created: boolean }> {
    const result = await this.db.query(`
      with inserted as (
        insert into inbox_events (
          tenant_id, project_id, id, source, external_event_id, event_type, payload_json,
          status, applied_at, created_at, error_json, evidence_json
        )
        values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb, $12::jsonb)
        on conflict (tenant_id, source, external_event_id) do nothing
        returning *, true as inserted
      )
      select * from inserted
      union all
      select inbox_events.*, false as inserted
      from inbox_events
      where tenant_id = $1 and source = $4 and external_event_id = $5 and not exists (select 1 from inserted)
      limit 1
    `, [
      this.tenantId,
      event.projectId,
      event.id,
      event.source,
      event.externalEventId,
      event.eventType,
      JSON.stringify(event.payload),
      event.status,
      event.appliedAt,
      event.createdAt,
      JSON.stringify(event.error),
      JSON.stringify(event.evidence)
    ]);
    return { event: inboxEventFromRow(result.rows[0]), created: result.rows[0].inserted === true };
  }

  async get(id: string): Promise<InboxEvent | null> {
    const result = await this.db.query("select * from inbox_events where tenant_id = $1 and id = $2", [this.tenantId, id]);
    return result.rows[0] ? inboxEventFromRow(result.rows[0]) : null;
  }

  async findBySource(source: string, externalEventId: string): Promise<InboxEvent | null> {
    const result = await this.db.query("select * from inbox_events where tenant_id = $1 and source = $2 and external_event_id = $3", [this.tenantId, source, externalEventId]);
    return result.rows[0] ? inboxEventFromRow(result.rows[0]) : null;
  }

  async markApplying(id: string): Promise<InboxEvent | null> {
    const result = await this.db.query(`
      update inbox_events
      set status = 'applying'
      where tenant_id = $1 and id = $2 and status in ('received', 'failed')
      returning *
    `, [this.tenantId, id]);
    return result.rows[0] ? inboxEventFromRow(result.rows[0]) : null;
  }

  async markApplied(id: string, appliedAt: string, evidence: Record<string, unknown> = {}): Promise<InboxEvent | null> {
    const result = await this.db.query(`
      update inbox_events
      set status = 'applied', applied_at = $3, error_json = null, evidence_json = evidence_json || $4::jsonb
      where tenant_id = $1 and id = $2
      returning *
    `, [this.tenantId, id, appliedAt, JSON.stringify(evidence)]);
    return result.rows[0] ? inboxEventFromRow(result.rows[0]) : null;
  }

  async markFailed(id: string, error: Record<string, unknown>, evidence: Record<string, unknown> = {}): Promise<InboxEvent | null> {
    const result = await this.db.query(`
      update inbox_events
      set status = 'failed', error_json = $3::jsonb, evidence_json = evidence_json || $4::jsonb
      where tenant_id = $1 and id = $2
      returning *
    `, [this.tenantId, id, JSON.stringify(error), JSON.stringify(evidence)]);
    return result.rows[0] ? inboxEventFromRow(result.rows[0]) : null;
  }

  async markDead(id: string, error: Record<string, unknown>, evidence: Record<string, unknown> = {}): Promise<InboxEvent | null> {
    const result = await this.db.query(`
      update inbox_events
      set status = 'dead', error_json = $3::jsonb, evidence_json = evidence_json || $4::jsonb
      where tenant_id = $1 and id = $2
      returning *
    `, [this.tenantId, id, JSON.stringify(error), JSON.stringify(evidence)]);
    return result.rows[0] ? inboxEventFromRow(result.rows[0]) : null;
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
    for (const chunk of chunks(instructions, 1000)) {
      if (chunk.length === 0) continue;
      await this.db.query(`
        insert into instructions (tenant_id, project_id, id, name, query, body, enabled, created_at, updated_at, archived_at)
        values ${valuesPlaceholders(chunk.length, 10)}
      `, chunk.flatMap((instruction) => [this.tenantId, instruction.projectId, instruction.id, instruction.name, instruction.query, instruction.body, instruction.enabled, instruction.createdAt, instruction.updatedAt, instruction.archivedAt]));
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

function hostedAuditFromRow(row: any): HostedAuditEvent {
  return {
    tenantId: row.tenant_id,
    projectId: row.project_id,
    id: row.id,
    eventType: row.event_type,
    principalId: row.principal_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    message: row.message,
    data: jsonRecord(row.data_json),
    requestId: row.request_id,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: iso(row.created_at)
  };
}

function hostedSecretParams(tenantId: string, secret: HostedSecret): unknown[] {
  return [
    tenantId,
    secret.projectId,
    secret.id,
    secret.name,
    secret.purpose,
    secret.ciphertext,
    secret.keyId,
    secret.algorithm,
    secret.createdAt,
    secret.updatedAt,
    secret.rotatedAt,
    secret.archivedAt
  ];
}

function hostedSecretFromRow(row: any): HostedSecret {
  return {
    tenantId: row.tenant_id,
    projectId: row.project_id,
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    ciphertext: row.ciphertext,
    keyId: row.key_id,
    algorithm: row.algorithm,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    rotatedAt: nullableIso(row.rotated_at),
    archivedAt: nullableIso(row.archived_at)
  };
}

function outboxEventFromRow(row: any): OutboxEvent {
  return {
    projectId: row.project_id,
    id: row.id,
    eventType: row.event_type,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    payload: jsonRecord(row.payload_json),
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attemptCount: row.attempt_count,
    availableAt: iso(row.available_at),
    createdAt: iso(row.created_at),
    claimedAt: nullableIso(row.claimed_at),
    processedAt: nullableIso(row.processed_at),
    error: row.error_json === null || row.error_json === undefined ? null : jsonRecord(row.error_json),
    evidence: jsonRecord(row.evidence_json)
  };
}

function inboxEventFromRow(row: any): InboxEvent {
  return {
    projectId: row.project_id,
    id: row.id,
    source: row.source,
    externalEventId: row.external_event_id,
    eventType: row.event_type,
    payload: jsonRecord(row.payload_json),
    status: row.status,
    appliedAt: nullableIso(row.applied_at),
    createdAt: iso(row.created_at),
    error: row.error_json === null || row.error_json === undefined ? null : jsonRecord(row.error_json),
    evidence: jsonRecord(row.evidence_json)
  };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return {};
  }
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return { value: parsed };
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function valuesPlaceholders(rowCount: number, columnCount: number): string {
  return jsonValuesPlaceholders(rowCount, columnCount, new Set());
}

function jsonValuesPlaceholders(rowCount: number, columnCount: number, jsonColumns: Set<number>): string {
  return Array.from({ length: rowCount }, (_row, rowIndex) => {
    const columns = Array.from({ length: columnCount }, (_column, columnIndex) => {
      const parameterIndex = rowIndex * columnCount + columnIndex + 1;
      const placeholder = `$${parameterIndex}`;
      return jsonColumns.has(columnIndex + 1) ? `${placeholder}::jsonb` : placeholder;
    });
    return `(${columns.join(", ")})`;
  }).join(", ");
}

function chunks<T>(items: T[], chunkSize: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    result.push(items.slice(index, index + chunkSize));
  }
  return result;
}

function isPoolClient(value: Queryable): value is pg.PoolClient {
  return "release" in value;
}
