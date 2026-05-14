import type { StoreMigration } from "./migrations.js";
import { DEFAULT_PROJECT_ID } from "./types.js";

export const DEFAULT_TENANT_ID = "DEFAULT";

export const postgresMigrations: StoreMigration[] = [
  {
    id: "pg0001",
    name: "postgres core domain schema",
    sql: `
      create table if not exists migrations (
        id text primary key,
        name text not null,
        applied_at timestamptz not null
      );

      create table if not exists tenants (
        id text primary key,
        slug text not null unique,
        name text not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        archived_at timestamptz null
      );

      insert into tenants (id, slug, name, created_at, updated_at, archived_at)
      values ('${DEFAULT_TENANT_ID}', 'default', 'Default', now(), now(), null)
      on conflict (id) do nothing;

      create table if not exists projects (
        tenant_id text not null references tenants(id) on delete restrict,
        id text not null,
        name text not null,
        description text null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        archived_at timestamptz null,
        primary key (tenant_id, id)
      );

      insert into projects (tenant_id, id, name, description, created_at, updated_at, archived_at)
      values ('${DEFAULT_TENANT_ID}', '${DEFAULT_PROJECT_ID}', 'Default', 'Default self-hosted project.', now(), now(), null)
      on conflict (tenant_id, id) do nothing;

      create table if not exists tenant_members (
        tenant_id text not null references tenants(id) on delete cascade,
        principal_id text not null,
        role text not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        disabled_at timestamptz null,
        primary key (tenant_id, principal_id)
      );

      create table if not exists project_members (
        tenant_id text not null,
        project_id text not null,
        principal_id text not null,
        role text not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        disabled_at timestamptz null,
        primary key (tenant_id, project_id, principal_id),
        foreign key (tenant_id, project_id) references projects(tenant_id, id) on delete cascade
      );

      create table if not exists tasks (
        tenant_id text not null,
        project_id text not null,
        id text not null,
        parent_task_id text null,
        title text not null,
        description text not null default '',
        lifecycle text not null check (lifecycle in ('open', 'started', 'finished')),
        priority integer not null default 2 check (priority >= 0 and priority <= 4),
        size text null check (size in ('XS', 'S', 'M', 'L', 'XL') or size is null),
        source_doc text null,
        source_section text null,
        source_anchor text null,
        source_line integer null,
        source_text text null,
        completion_bar text null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        started_at timestamptz null,
        finished_at timestamptz null,
        archived_at timestamptz null,
        version integer not null default 1 check (version >= 1),
        primary key (tenant_id, project_id, id),
        foreign key (tenant_id, project_id) references projects(tenant_id, id) on delete restrict
      );

      create table if not exists task_dependencies (
        tenant_id text not null,
        project_id text not null,
        task_id text not null,
        depends_on_task_id text not null,
        created_at timestamptz not null,
        primary key (tenant_id, project_id, task_id, depends_on_task_id),
        foreign key (tenant_id, project_id, task_id) references tasks(tenant_id, project_id, id) on delete cascade,
        foreign key (tenant_id, project_id, depends_on_task_id) references tasks(tenant_id, project_id, id) on delete restrict,
        check (task_id != depends_on_task_id)
      );

      create table if not exists tags (
        tenant_id text not null,
        project_id text not null,
        id text not null,
        name text not null,
        color text null,
        description text null,
        sort_order integer not null default 0,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        archived_at timestamptz null,
        primary key (tenant_id, project_id, id),
        foreign key (tenant_id, project_id) references projects(tenant_id, id) on delete restrict
      );

      create unique index if not exists tags_tenant_project_name_idx
        on tags (tenant_id, project_id, name);

      create table if not exists task_tags (
        tenant_id text not null,
        project_id text not null,
        task_id text not null,
        tag_id text not null,
        created_at timestamptz not null,
        primary key (tenant_id, project_id, task_id, tag_id),
        foreign key (tenant_id, project_id, task_id) references tasks(tenant_id, project_id, id) on delete cascade,
        foreign key (tenant_id, project_id, tag_id) references tags(tenant_id, project_id, id) on delete cascade
      );

      create table if not exists tracks (
        tenant_id text not null,
        project_id text not null,
        id text not null,
        machine text not null,
        actor text not null,
        name text null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        archived_at timestamptz null,
        primary key (tenant_id, project_id, id),
        unique (tenant_id, project_id, machine, actor),
        foreign key (tenant_id, project_id) references projects(tenant_id, id) on delete restrict
      );

      create table if not exists track_assignments (
        tenant_id text not null,
        project_id text not null,
        track_id text not null,
        task_id text not null,
        position text not null,
        assigned_at timestamptz not null,
        primary key (tenant_id, project_id, track_id, task_id),
        unique (tenant_id, project_id, task_id),
        foreign key (tenant_id, project_id, track_id) references tracks(tenant_id, project_id, id) on delete cascade,
        foreign key (tenant_id, project_id, task_id) references tasks(tenant_id, project_id, id) on delete cascade
      );

      create table if not exists instructions (
        tenant_id text not null,
        project_id text not null,
        id text not null,
        name text not null,
        query text not null,
        body text not null,
        enabled boolean not null default true,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        archived_at timestamptz null,
        primary key (tenant_id, project_id, id),
        foreign key (tenant_id, project_id) references projects(tenant_id, id) on delete restrict
      );

      create unique index if not exists instructions_tenant_project_name_idx
        on instructions (tenant_id, project_id, name);

      create table if not exists saved_views (
        tenant_id text not null,
        project_id text not null,
        id text not null,
        name text not null,
        query text not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        archived_at timestamptz null,
        primary key (tenant_id, project_id, id),
        foreign key (tenant_id, project_id) references projects(tenant_id, id) on delete restrict
      );

      create unique index if not exists saved_views_tenant_project_name_idx
        on saved_views (tenant_id, project_id, name);

      create table if not exists queue_feeds (
        tenant_id text not null,
        project_id text not null,
        id text not null,
        name text not null,
        query text not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        archived_at timestamptz null,
        primary key (tenant_id, project_id, id),
        foreign key (tenant_id, project_id) references projects(tenant_id, id) on delete restrict
      );

      create unique index if not exists queue_feeds_tenant_project_name_idx
        on queue_feeds (tenant_id, project_id, name);

      create table if not exists comments (
        tenant_id text not null,
        project_id text not null,
        id text not null,
        task_id text not null,
        machine text not null,
        actor text not null,
        body text not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        archived_at timestamptz null,
        primary key (tenant_id, project_id, id),
        foreign key (tenant_id, project_id, task_id) references tasks(tenant_id, project_id, id) on delete cascade
      );

      create table if not exists activity (
        tenant_id text not null references tenants(id) on delete restrict,
        project_id text null,
        id text primary key,
        type text not null,
        subject_type text not null,
        subject_id text null,
        message text not null,
        data_json jsonb not null,
        machine text not null,
        actor text not null,
        created_at timestamptz not null,
        foreign key (tenant_id, project_id) references projects(tenant_id, id) on delete restrict
      );

      create index if not exists tasks_tenant_project_lifecycle_idx on tasks(tenant_id, project_id, archived_at, lifecycle);
      create index if not exists tasks_tenant_project_parent_idx on tasks(tenant_id, project_id, parent_task_id);
      create index if not exists tasks_tenant_project_priority_idx on tasks(tenant_id, project_id, priority);
      create index if not exists tasks_tenant_project_updated_idx on tasks(tenant_id, project_id, updated_at desc);
      create index if not exists tasks_tenant_project_source_idx on tasks(tenant_id, project_id, source_doc, source_section);
      create index if not exists task_dependencies_task_idx on task_dependencies(tenant_id, project_id, task_id);
      create index if not exists task_dependencies_depends_idx on task_dependencies(tenant_id, project_id, depends_on_task_id);
      create index if not exists task_tags_tag_idx on task_tags(tenant_id, project_id, tag_id, task_id);
      create index if not exists track_assignments_track_idx on track_assignments(tenant_id, project_id, track_id, position);
      create index if not exists instructions_enabled_idx on instructions(tenant_id, project_id, enabled, archived_at);
      create index if not exists saved_views_archived_idx on saved_views(tenant_id, project_id, archived_at);
      create index if not exists queue_feeds_archived_idx on queue_feeds(tenant_id, project_id, archived_at);
      create index if not exists comments_task_created_idx on comments(tenant_id, project_id, task_id, created_at);
      create index if not exists comments_archived_idx on comments(tenant_id, project_id, archived_at);
      create index if not exists comments_actor_created_idx on comments(tenant_id, project_id, machine, actor, created_at);
      create index if not exists activity_project_created_idx on activity(tenant_id, project_id, created_at desc);
      create index if not exists activity_subject_idx on activity(tenant_id, project_id, subject_type, subject_id, created_at desc);
    `
  }
];
