import type { AppStore, RepositorySet } from "./store.js";
import type { Migration } from "./types.js";
import { DEFAULT_PROJECT_ID, nowIso } from "./types.js";
import { postgresMigrations } from "./postgres-migrations.js";

export interface StoreMigration {
  id: string;
  name: string;
  sql: string;
}

export const sqliteMigrations: StoreMigration[] = [
  {
    id: "0001",
    name: "initial schema",
    sql: `
      create table if not exists tasks (
        id text primary key,
        parent_task_id text null references tasks(id) on delete set null,
        title text not null,
        description text not null default '',
        lifecycle text not null check (lifecycle in ('open', 'started', 'finished')),
        priority integer not null default 2,
        size text null check (size in ('XS', 'S', 'M', 'L', 'XL') or size is null),
        source_doc text null,
        source_section text null,
        source_anchor text null,
        source_line integer null,
        source_text text null,
        completion_bar text null,
        created_at text not null,
        updated_at text not null,
        started_at text null,
        finished_at text null,
        archived_at text null,
        version integer not null default 1
      );

      create table if not exists task_dependencies (
        task_id text not null references tasks(id) on delete cascade,
        depends_on_task_id text not null references tasks(id) on delete restrict,
        created_at text not null,
        primary key (task_id, depends_on_task_id),
        check (task_id != depends_on_task_id)
      );

      create table if not exists tags (
        id text primary key,
        name text not null unique,
        color text null,
        description text null,
        sort_order integer not null default 0,
        created_at text not null,
        updated_at text not null,
        archived_at text null
      );

      create table if not exists task_tags (
        task_id text not null references tasks(id) on delete cascade,
        tag_id text not null references tags(id) on delete cascade,
        created_at text not null,
        primary key (task_id, tag_id)
      );

      create table if not exists tracks (
        id text primary key,
        actor text not null unique,
        name text null,
        created_at text not null,
        updated_at text not null,
        archived_at text null
      );

      create table if not exists track_assignments (
        track_id text not null references tracks(id) on delete cascade,
        task_id text not null references tasks(id) on delete cascade,
        position text not null,
        assigned_at text not null,
        primary key (track_id, task_id),
        unique (task_id)
      );

      create table if not exists activity (
        id text primary key,
        type text not null,
        subject_type text not null,
        subject_id text null,
        message text not null,
        data_json text not null,
        actor text null,
        created_at text not null
      );

      create table if not exists migrations (
        id text primary key,
        name text not null,
        applied_at text not null
      );

      create index if not exists idx_tasks_lifecycle on tasks(lifecycle);
      create index if not exists idx_tasks_parent on tasks(parent_task_id);
      create index if not exists idx_tasks_priority on tasks(priority);
      create index if not exists idx_tasks_source on tasks(source_doc, source_section);
      create index if not exists idx_tasks_archived on tasks(archived_at);
      create index if not exists idx_task_dependencies_task on task_dependencies(task_id);
      create index if not exists idx_task_dependencies_depends on task_dependencies(depends_on_task_id);
      create index if not exists idx_task_tags_tag on task_tags(tag_id);
      create index if not exists idx_track_assignments_track on track_assignments(track_id, position);
      create index if not exists idx_activity_subject on activity(subject_type, subject_id);
      create index if not exists idx_activity_created on activity(created_at);
    `
  },
  {
    id: "0002",
    name: "add project namespaces",
    sql: `
      create table if not exists projects (
        id text primary key,
        name text not null,
        description text null,
        created_at text not null,
        updated_at text not null,
        archived_at text null
      );

      insert or ignore into projects (id, name, description, created_at, updated_at, archived_at)
      values ('${DEFAULT_PROJECT_ID}', 'Default', 'Migrated tasks from the pre-project unblock database.', datetime('now'), datetime('now'), null);

      alter table tasks rename to tasks_old;
      alter table task_dependencies rename to task_dependencies_old;
      alter table tags rename to tags_old;
      alter table task_tags rename to task_tags_old;
      alter table tracks rename to tracks_old;
      alter table track_assignments rename to track_assignments_old;
      alter table activity rename to activity_old;

      create table tasks (
        project_id text not null references projects(id) on delete restrict,
        id text not null,
        parent_task_id text null,
        title text not null,
        description text not null default '',
        lifecycle text not null check (lifecycle in ('open', 'started', 'finished')),
        priority integer not null default 2,
        size text null check (size in ('XS', 'S', 'M', 'L', 'XL') or size is null),
        source_doc text null,
        source_section text null,
        source_anchor text null,
        source_line integer null,
        source_text text null,
        completion_bar text null,
        created_at text not null,
        updated_at text not null,
        started_at text null,
        finished_at text null,
        archived_at text null,
        version integer not null default 1,
        primary key (project_id, id),
        foreign key (project_id, parent_task_id) references tasks(project_id, id) on delete set null
      );

      create table task_dependencies (
        project_id text not null references projects(id) on delete restrict,
        task_id text not null,
        depends_on_task_id text not null,
        created_at text not null,
        primary key (project_id, task_id, depends_on_task_id),
        foreign key (project_id, task_id) references tasks(project_id, id) on delete cascade,
        foreign key (project_id, depends_on_task_id) references tasks(project_id, id) on delete restrict,
        check (task_id != depends_on_task_id)
      );

      create table tags (
        project_id text not null references projects(id) on delete restrict,
        id text not null,
        name text not null,
        color text null,
        description text null,
        sort_order integer not null default 0,
        created_at text not null,
        updated_at text not null,
        archived_at text null,
        primary key (project_id, id),
        unique (project_id, name)
      );

      create table task_tags (
        project_id text not null references projects(id) on delete restrict,
        task_id text not null,
        tag_id text not null,
        created_at text not null,
        primary key (project_id, task_id, tag_id),
        foreign key (project_id, task_id) references tasks(project_id, id) on delete cascade,
        foreign key (project_id, tag_id) references tags(project_id, id) on delete cascade
      );

      create table tracks (
        project_id text not null references projects(id) on delete restrict,
        id text not null,
        actor text not null,
        name text null,
        created_at text not null,
        updated_at text not null,
        archived_at text null,
        primary key (project_id, id),
        unique (project_id, actor)
      );

      create table track_assignments (
        project_id text not null references projects(id) on delete restrict,
        track_id text not null,
        task_id text not null,
        position text not null,
        assigned_at text not null,
        primary key (project_id, track_id, task_id),
        unique (project_id, task_id),
        foreign key (project_id, track_id) references tracks(project_id, id) on delete cascade,
        foreign key (project_id, task_id) references tasks(project_id, id) on delete cascade
      );

      create table activity (
        project_id text null references projects(id) on delete set null,
        id text primary key,
        type text not null,
        subject_type text not null,
        subject_id text null,
        message text not null,
        data_json text not null,
        actor text null,
        created_at text not null
      );

      insert into tasks (
        project_id, id, parent_task_id, title, description, lifecycle, priority, size, source_doc, source_section,
        source_anchor, source_line, source_text, completion_bar, created_at, updated_at, started_at, finished_at, archived_at, version
      )
      select '${DEFAULT_PROJECT_ID}', id, parent_task_id, title, description, lifecycle, priority, size, source_doc, source_section,
        source_anchor, source_line, source_text, completion_bar, created_at, updated_at, started_at, finished_at, archived_at, version
      from tasks_old;

      insert into task_dependencies (project_id, task_id, depends_on_task_id, created_at)
      select '${DEFAULT_PROJECT_ID}', task_id, depends_on_task_id, created_at from task_dependencies_old;

      insert into tags (project_id, id, name, color, description, sort_order, created_at, updated_at, archived_at)
      select '${DEFAULT_PROJECT_ID}', id, name, color, description, sort_order, created_at, updated_at, archived_at from tags_old;

      insert into task_tags (project_id, task_id, tag_id, created_at)
      select '${DEFAULT_PROJECT_ID}', task_id, tag_id, created_at from task_tags_old;

      insert into tracks (project_id, id, actor, name, created_at, updated_at, archived_at)
      select '${DEFAULT_PROJECT_ID}', id, actor, name, created_at, updated_at, archived_at from tracks_old;

      insert into track_assignments (project_id, track_id, task_id, position, assigned_at)
      select '${DEFAULT_PROJECT_ID}', track_id, task_id, position, assigned_at from track_assignments_old;

      insert into activity (project_id, id, type, subject_type, subject_id, message, data_json, actor, created_at)
      select '${DEFAULT_PROJECT_ID}', id, type, subject_type, subject_id, message, data_json, actor, created_at from activity_old;

      drop table track_assignments_old;
      drop table tracks_old;
      drop table task_tags_old;
      drop table tags_old;
      drop table task_dependencies_old;
      drop table tasks_old;
      drop table activity_old;

      create index if not exists idx_tasks_project_lifecycle on tasks(project_id, lifecycle);
      create index if not exists idx_tasks_project_parent on tasks(project_id, parent_task_id);
      create index if not exists idx_tasks_project_priority on tasks(project_id, priority);
      create index if not exists idx_tasks_project_source on tasks(project_id, source_doc, source_section);
      create index if not exists idx_tasks_project_archived on tasks(project_id, archived_at);
      create index if not exists idx_task_dependencies_project_task on task_dependencies(project_id, task_id);
      create index if not exists idx_task_dependencies_project_depends on task_dependencies(project_id, depends_on_task_id);
      create index if not exists idx_task_tags_project_tag on task_tags(project_id, tag_id);
      create index if not exists idx_track_assignments_project_track on track_assignments(project_id, track_id, position);
      create index if not exists idx_activity_project_created on activity(project_id, created_at);
      create index if not exists idx_activity_subject on activity(project_id, subject_type, subject_id);
    `
  },
  {
    id: "0003",
    name: "add required provenance",
    sql: `
      pragma defer_foreign_keys = on;

      alter table track_assignments rename to track_assignments_old_provenance;
      alter table tracks rename to tracks_old_provenance;
      alter table activity rename to activity_old_provenance;

      create table tracks (
        project_id text not null references projects(id) on delete restrict,
        id text not null,
        machine text not null,
        actor text not null,
        name text null,
        created_at text not null,
        updated_at text not null,
        archived_at text null,
        primary key (project_id, id),
        unique (project_id, machine, actor)
      );

      insert into tracks (project_id, id, machine, actor, name, created_at, updated_at, archived_at)
      select project_id, id, 'unknown-machine', actor, name, created_at, updated_at, archived_at
      from tracks_old_provenance;

      create table track_assignments (
        project_id text not null references projects(id) on delete restrict,
        track_id text not null,
        task_id text not null,
        position text not null,
        assigned_at text not null,
        primary key (project_id, track_id, task_id),
        unique (project_id, task_id),
        foreign key (project_id, track_id) references tracks(project_id, id) on delete cascade,
        foreign key (project_id, task_id) references tasks(project_id, id) on delete cascade
      );

      insert into track_assignments (project_id, track_id, task_id, position, assigned_at)
      select project_id, track_id, task_id, position, assigned_at
      from track_assignments_old_provenance;

      create table activity (
        project_id text null references projects(id) on delete set null,
        id text primary key,
        type text not null,
        subject_type text not null,
        subject_id text null,
        message text not null,
        data_json text not null,
        machine text not null,
        actor text not null,
        created_at text not null
      );

      insert into activity (project_id, id, type, subject_type, subject_id, message, data_json, machine, actor, created_at)
      select project_id, id, type, subject_type, subject_id, message, data_json, 'unknown-machine', coalesce(actor, 'unknown'), created_at
      from activity_old_provenance;

      drop table activity_old_provenance;
      drop table track_assignments_old_provenance;
      drop table tracks_old_provenance;

      create index if not exists idx_track_assignments_project_track on track_assignments(project_id, track_id, position);
      create index if not exists idx_activity_project_created on activity(project_id, created_at);
      create index if not exists idx_activity_subject on activity(project_id, subject_type, subject_id);
    `
  },
  {
    id: "0004",
    name: "add instructions",
    sql: `
      create table if not exists instructions (
        project_id text not null references projects(id) on delete restrict,
        id text not null,
        name text not null,
        query text not null,
        body text not null,
        enabled integer not null default 1 check (enabled in (0, 1)),
        created_at text not null,
        updated_at text not null,
        archived_at text null,
        primary key (project_id, id),
        unique (project_id, name)
      );

      create index if not exists idx_instructions_project_enabled on instructions(project_id, enabled, archived_at);
    `
  },
  {
    id: "0005",
    name: "add saved views and queue feeds",
    sql: `
      create table if not exists saved_views (
        project_id text not null references projects(id) on delete restrict,
        id text not null,
        name text not null,
        query text not null,
        created_at text not null,
        updated_at text not null,
        archived_at text null,
        primary key (project_id, id),
        unique (project_id, name)
      );

      create table if not exists queue_feeds (
        project_id text not null references projects(id) on delete restrict,
        id text not null,
        name text not null,
        query text not null,
        created_at text not null,
        updated_at text not null,
        archived_at text null,
        primary key (project_id, id),
        unique (project_id, name)
      );

      create index if not exists idx_saved_views_project_archived on saved_views(project_id, archived_at);
      create index if not exists idx_queue_feeds_project_archived on queue_feeds(project_id, archived_at);
    `
  },
  {
    id: "0006",
    name: "add comments",
    sql: `
      create table if not exists comments (
        project_id text not null references projects(id) on delete restrict,
        id text not null,
        task_id text not null,
        machine text not null,
        actor text not null,
        body text not null,
        created_at text not null,
        updated_at text not null,
        archived_at text null,
        primary key (project_id, id),
        foreign key (project_id, task_id) references tasks(project_id, id) on delete cascade
      );

      create index if not exists idx_comments_project_task_created on comments(project_id, task_id, created_at);
      create index if not exists idx_comments_project_archived on comments(project_id, archived_at);
    `
  }
];

export interface MigratingStore extends AppStore {
  exec?(sql: string): Promise<void> | void;
}

export class MigrationService {
  constructor(private readonly store: MigratingStore) {}

  async status(): Promise<{ applied: Migration[]; pending: StoreMigration[] }> {
    const applied = await this.store.migrations.list();
    const appliedIds = new Set(applied.map((migration) => migration.id));
    const pending = this.migrations().filter((migration) => !appliedIds.has(migration.id));
    return { applied, pending };
  }

  async migrate(): Promise<{ applied: Migration[]; pending: StoreMigration[] }> {
    if (!this.store.exec) {
      return this.status();
    }

    for (const migration of this.migrations()) {
      const existing = await this.store.migrations.list();
      if (existing.some((item) => item.id === migration.id)) {
        continue;
      }
      await this.store.transaction(async (repos: RepositorySet) => {
        await this.store.exec?.(migration.sql);
        await repos.migrations.markApplied({
          id: migration.id,
          name: migration.name,
          appliedAt: nowIso()
        });
      });
    }

    return this.status();
  }

  private migrations(): StoreMigration[] {
    return this.store.capabilities?.dialect === "postgres" || this.store.capabilities?.dialect === "hosted"
      ? postgresMigrations
      : sqliteMigrations;
  }
}
