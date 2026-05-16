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

      create table if not exists outbox_events (
        tenant_id text not null references tenants(id) on delete restrict,
        project_id text null,
        id text primary key,
        event_type text not null,
        subject_type text not null,
        subject_id text null,
        payload_json jsonb not null,
        idempotency_key text null,
        status text not null check (status in ('pending', 'claimed', 'processed', 'failed', 'dead')),
        attempt_count integer not null default 0 check (attempt_count >= 0),
        available_at timestamptz not null,
        created_at timestamptz not null,
        claimed_at timestamptz null,
        processed_at timestamptz null,
        error_json jsonb null,
        evidence_json jsonb not null default '{}'::jsonb,
        foreign key (tenant_id, project_id) references projects(tenant_id, id) on delete restrict
      );

      create unique index if not exists outbox_events_tenant_idempotency_idx
        on outbox_events (tenant_id, idempotency_key)
        where idempotency_key is not null;

      create table if not exists inbox_events (
        tenant_id text not null references tenants(id) on delete restrict,
        project_id text null,
        id text primary key,
        source text not null,
        external_event_id text not null,
        event_type text not null,
        payload_json jsonb not null,
        status text not null check (status in ('received', 'applying', 'applied', 'failed', 'dead')),
        applied_at timestamptz null,
        created_at timestamptz not null,
        error_json jsonb null,
        evidence_json jsonb not null default '{}'::jsonb,
        foreign key (tenant_id, project_id) references projects(tenant_id, id) on delete restrict,
        unique (tenant_id, source, external_event_id)
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
      create index if not exists outbox_events_ready_idx on outbox_events(tenant_id, status, available_at, created_at);
      create index if not exists outbox_events_subject_idx on outbox_events(tenant_id, project_id, subject_type, subject_id, created_at desc);
      create index if not exists inbox_events_status_idx on inbox_events(tenant_id, project_id, status, created_at);
      create index if not exists inbox_events_type_idx on inbox_events(tenant_id, project_id, event_type, created_at desc);
    `
  },
  {
    id: "pg0002",
    name: "postgres matcher hot path indexes",
    sql: `
      create index if not exists tasks_active_created_idx
        on tasks(tenant_id, project_id, created_at asc, id asc)
        where archived_at is null;
      create index if not exists tasks_active_priority_idx
        on tasks(tenant_id, project_id, priority desc, created_at asc, id asc)
        where archived_at is null;
      create index if not exists tasks_active_source_lower_idx
        on tasks(tenant_id, project_id, lower(source_doc), lower(source_section))
        where archived_at is null;
      create index if not exists tags_lower_name_idx
        on tags(tenant_id, project_id, lower(name))
        where archived_at is null;
      create index if not exists tracks_lower_actor_idx
        on tracks(tenant_id, project_id, lower(actor))
        where archived_at is null;
      create index if not exists tracks_lower_actor_ref_idx
        on tracks(tenant_id, project_id, lower(machine), lower(actor))
        where archived_at is null;
      create index if not exists comments_active_task_created_idx
        on comments(tenant_id, project_id, task_id, created_at)
        where archived_at is null;
      create index if not exists comments_active_actor_task_idx
        on comments(tenant_id, project_id, lower(machine), lower(actor), task_id, created_at)
        where archived_at is null;
    `
  },
  {
    id: "pg0003",
    name: "hosted identity audit and secrets foundation",
    sql: `
      alter table tenants add column if not exists workos_organization_id text null;
      alter table tenants add column if not exists metadata_json jsonb not null default '{}'::jsonb;

      create unique index if not exists tenants_workos_organization_idx
        on tenants(workos_organization_id)
        where workos_organization_id is not null;

      alter table tenant_members add column if not exists workos_user_id text null;
      alter table tenant_members add column if not exists workos_membership_id text null;
      alter table tenant_members add column if not exists roles_json jsonb not null default '[]'::jsonb;
      alter table tenant_members add column if not exists permissions_json jsonb not null default '[]'::jsonb;
      alter table tenant_members add column if not exists role_source text not null default 'workos';
      alter table tenant_members add column if not exists last_seen_at timestamptz null;

      create index if not exists tenant_members_workos_user_idx
        on tenant_members(tenant_id, workos_user_id)
        where disabled_at is null;

      alter table project_members add column if not exists roles_json jsonb not null default '[]'::jsonb;
      alter table project_members add column if not exists permissions_json jsonb not null default '[]'::jsonb;
      alter table project_members add column if not exists last_seen_at timestamptz null;

      create table if not exists hosted_audit_events (
        tenant_id text not null references tenants(id) on delete restrict,
        project_id text null,
        id text primary key,
        event_type text not null,
        principal_id text null,
        subject_type text not null,
        subject_id text null,
        message text not null,
        data_json jsonb not null default '{}'::jsonb,
        request_id text null,
        ip_address text null,
        user_agent text null,
        created_at timestamptz not null,
        foreign key (tenant_id, project_id) references projects(tenant_id, id) on delete restrict
      );

      create index if not exists hosted_audit_events_tenant_created_idx
        on hosted_audit_events(tenant_id, created_at desc);
      create index if not exists hosted_audit_events_project_created_idx
        on hosted_audit_events(tenant_id, project_id, created_at desc)
        where project_id is not null;
      create index if not exists hosted_audit_events_principal_created_idx
        on hosted_audit_events(tenant_id, principal_id, created_at desc)
        where principal_id is not null;
      create index if not exists hosted_audit_events_subject_created_idx
        on hosted_audit_events(tenant_id, subject_type, subject_id, created_at desc);

      create table if not exists hosted_secrets (
        tenant_id text not null references tenants(id) on delete restrict,
        project_id text null,
        id text primary key,
        name text not null,
        purpose text not null,
        ciphertext text not null,
        key_id text not null,
        algorithm text not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        rotated_at timestamptz null,
        archived_at timestamptz null,
        foreign key (tenant_id, project_id) references projects(tenant_id, id) on delete restrict
      );

      create unique index if not exists hosted_secrets_active_name_idx
        on hosted_secrets(tenant_id, coalesce(project_id, ''), lower(name))
        where archived_at is null;
      create index if not exists hosted_secrets_project_idx
        on hosted_secrets(tenant_id, project_id, archived_at, updated_at desc);
    `
  },
  {
    id: "pg0004",
    name: "hosted connector orchestration state",
    sql: `
      create table if not exists connector_connections (
        tenant_id text not null references tenants(id) on delete restrict,
        project_id text not null,
        id text not null,
        provider text not null,
        display_name text not null,
        status text not null check (status in ('active', 'paused', 'error', 'archived')),
        created_at timestamptz not null,
        updated_at timestamptz not null,
        archived_at timestamptz null,
        last_sync_at timestamptz null,
        last_error_at timestamptz null,
        metadata_json jsonb not null default '{}'::jsonb,
        primary key (tenant_id, project_id, id),
        foreign key (tenant_id, project_id) references projects(tenant_id, id) on delete cascade
      );

      create index if not exists connector_connections_status_idx
        on connector_connections(tenant_id, project_id, status, updated_at desc);

      create table if not exists connector_cursors (
        tenant_id text not null,
        project_id text not null,
        connection_id text not null,
        name text not null,
        value text not null,
        observed_at timestamptz not null,
        updated_at timestamptz not null,
        primary key (tenant_id, project_id, connection_id, name),
        foreign key (tenant_id, project_id, connection_id)
          references connector_connections(tenant_id, project_id, id) on delete cascade
      );

      create table if not exists connector_sync_runs (
        tenant_id text not null,
        project_id text not null,
        id text primary key,
        connection_id text not null,
        run_type text not null check (run_type in ('outbound', 'inbound', 'reconciliation', 'cursor_recovery')),
        status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'dead_letter', 'operator_review')),
        started_at timestamptz not null,
        finished_at timestamptz null,
        error_json jsonb null,
        evidence_json jsonb not null default '{}'::jsonb,
        foreign key (tenant_id, project_id, connection_id)
          references connector_connections(tenant_id, project_id, id) on delete cascade
      );

      create index if not exists connector_sync_runs_connection_idx
        on connector_sync_runs(tenant_id, project_id, connection_id, started_at desc);
      create index if not exists connector_sync_runs_status_idx
        on connector_sync_runs(tenant_id, project_id, status, started_at desc);
    `
  },
  {
    id: "pg0005",
    name: "hosted connector external mappings",
    sql: `
      create table if not exists connector_external_mappings (
        tenant_id text not null,
        project_id text not null,
        connection_id text not null,
        provider text not null,
        external_kind text not null,
        external_id text not null,
        external_url text null,
        external_version text null,
        local_kind text not null,
        local_id text not null,
        local_version text null,
        sync_direction text not null check (sync_direction in ('github_to_unblock', 'unblock_to_github', 'bidirectional')),
        conflict_policy text not null check (conflict_policy in ('github_wins', 'unblock_wins', 'last_writer_wins', 'operator_review')),
        status text not null check (status in ('active', 'conflict', 'operator_review', 'archived')),
        created_at timestamptz not null,
        updated_at timestamptz not null,
        archived_at timestamptz null,
        metadata_json jsonb not null default '{}'::jsonb,
        primary key (tenant_id, project_id, connection_id, external_kind, external_id),
        foreign key (tenant_id, project_id, connection_id)
          references connector_connections(tenant_id, project_id, id) on delete cascade
      );

      create index if not exists connector_external_mappings_local_idx
        on connector_external_mappings(tenant_id, project_id, connection_id, local_kind, local_id)
        where archived_at is null;
      create index if not exists connector_external_mappings_status_idx
        on connector_external_mappings(tenant_id, project_id, provider, status, updated_at desc);
    `
  },
  {
    id: "pg0006",
    name: "hosted connector sync policies and queue",
    sql: `
      create table if not exists connector_sync_policies (
        tenant_id text not null,
        project_id text not null,
        id text not null,
        connection_id text not null,
        name text not null,
        scope_query text null,
        priority integer not null default 0,
        enabled boolean not null default true,
        policy_json jsonb not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        archived_at timestamptz null,
        primary key (tenant_id, project_id, id),
        foreign key (tenant_id, project_id, connection_id)
          references connector_connections(tenant_id, project_id, id) on delete cascade
      );

      create index if not exists connector_sync_policies_connection_idx
        on connector_sync_policies(tenant_id, project_id, connection_id, enabled, priority desc, updated_at desc)
        where archived_at is null;
      create index if not exists connector_sync_policies_scope_idx
        on connector_sync_policies(tenant_id, project_id, connection_id, scope_query)
        where archived_at is null and scope_query is not null;

      create table if not exists sync_queue_items (
        tenant_id text not null,
        project_id text not null,
        id text not null,
        connection_id text not null,
        mapping_id text null,
        external_kind text not null,
        external_id text not null,
        local_kind text not null,
        local_id text not null,
        status text not null check (status in ('pending', 'auto_applying', 'blocked', 'manual_review', 'ignored', 'resolved', 'failed')),
        severity text not null check (severity in ('info', 'warning', 'error')),
        detected_at timestamptz not null,
        resolved_at timestamptz null,
        decision_json jsonb not null,
        external_snapshot_json jsonb not null default '{}'::jsonb,
        local_snapshot_json jsonb not null default '{}'::jsonb,
        diff_json jsonb not null,
        policy_ref_json jsonb not null,
        error_json jsonb null,
        primary key (tenant_id, project_id, id),
        foreign key (tenant_id, project_id, connection_id)
          references connector_connections(tenant_id, project_id, id) on delete cascade
      );

      create index if not exists sync_queue_items_connection_status_idx
        on sync_queue_items(tenant_id, project_id, connection_id, status, detected_at desc);
      create index if not exists sync_queue_items_status_idx
        on sync_queue_items(tenant_id, project_id, status, severity, detected_at desc);
      create index if not exists sync_queue_items_external_idx
        on sync_queue_items(tenant_id, project_id, connection_id, external_kind, external_id, detected_at desc);
      create index if not exists sync_queue_items_local_idx
        on sync_queue_items(tenant_id, project_id, local_kind, local_id, detected_at desc);
    `
  }
];
