import type { AppStore, RepositorySet } from "./store.js";
import type { Migration } from "./types.js";
import { nowIso } from "./types.js";

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
    const pending = sqliteMigrations.filter((migration) => !appliedIds.has(migration.id));
    return { applied, pending };
  }

  async migrate(): Promise<{ applied: Migration[]; pending: StoreMigration[] }> {
    if (!this.store.exec) {
      return this.status();
    }

    for (const migration of sqliteMigrations) {
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
}
