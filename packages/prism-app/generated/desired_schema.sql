create table if not exists prism.commit_log (
  project_id text not null,
  shard_id text not null,
  sequence bigint not null,
  commit_id text not null,
  manifest_hash text not null,
  committed_at timestamptz not null,
  receipt jsonb not null,
  primary key (project_id, shard_id, sequence)
);

create table if not exists prism.materialization_queue (
  project_id text not null,
  shard_id text not null,
  scope_key text not null,
  reason text not null,
  available_at timestamptz not null,
  primary key (project_id, shard_id, scope_key)
);

create table if not exists prism.temporal_wakeups (
  project_id text not null,
  shard_id text not null,
  wakeup_id text not null,
  scheduled_at timestamptz not null,
  target_kind text not null,
  target_id text not null,
  candidate_id text not null,
  status text not null,
  revision text not null,
  primary key (project_id, shard_id, wakeup_id)
);
create index if not exists temporal_wakeups_due_idx on prism.temporal_wakeups using btree (project_id, shard_id, scheduled_at);

create table if not exists prism.watch_cursors (
  project_id text not null,
  shard_id text not null,
  subscription_id text not null,
  surface_id text not null,
  cursor jsonb not null,
  result_hash text,
  primary key (project_id, shard_id, subscription_id)
);

create table if not exists prism.semantic_outbox (
  project_id text not null,
  shard_id text not null,
  outbox_id text not null,
  event_kind text not null,
  producer_kind text not null,
  producer_id text not null,
  subject_kind text,
  subject_id text,
  idempotency_key text not null,
  payload jsonb not null,
  headers jsonb not null,
  state text not null,
  acked_at timestamptz,
  primary key (project_id, shard_id, outbox_id)
);

create table if not exists prism.window_buckets (
  project_id text not null,
  shard_id text not null,
  spec_id text not null,
  bucket_key text not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  state text not null,
  group_key jsonb not null,
  aggregate_state jsonb,
  primary key (project_id, shard_id, spec_id, bucket_key)
);

create table if not exists prism.window_summaries (
  project_id text not null,
  shard_id text not null,
  spec_id text not null,
  summary_key text not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  closed boolean not null,
  payload jsonb not null,
  primary key (project_id, shard_id, spec_id, summary_key)
);

create schema if not exists app_unblock;

do $$ begin create type app_unblock.activitysubject as enum ('project', 'task', 'comment', 'tag', 'track', 'instruction', 'view', 'feed', 'external_issue', 'import', 'export', 'system'); exception when duplicate_object then null; end $$;

do $$ begin create type app_unblock.computedstatus as enum ('ready', 'blocked', 'started', 'finished', 'archived'); exception when duplicate_object then null; end $$;

do $$ begin create type app_unblock.externalprovider as enum ('github', 'jira', 'linear', 'asana', 'trello', 'manual'); exception when duplicate_object then null; end $$;

do $$ begin create type app_unblock.lifecycle as enum ('open', 'started', 'finished'); exception when duplicate_object then null; end $$;

do $$ begin create type app_unblock.rollupstatus as enum ('leaf', 'complete', 'blocked_by_children'); exception when duplicate_object then null; end $$;

do $$ begin create type app_unblock.selectorkind as enum ('instruction', 'view', 'feed'); exception when duplicate_object then null; end $$;

do $$ begin create type app_unblock.tasksize as enum ('XS', 'S', 'M', 'L', 'XL'); exception when duplicate_object then null; end $$;

create table if not exists app_unblock.projects (
  project_id text not null,
  shard_id text not null,
  id text not null,
  name text not null,
  description text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  archived_at timestamptz,
  provenance jsonb not null default '{}'::jsonb,
  primary key (project_id, shard_id, id)
);
create index if not exists projects_by_archive on app_unblock.projects using btree (archived_at, id);

create table if not exists app_unblock.tasks (
  project_id text not null,
  shard_id text not null,
  id text not null,
  title text not null,
  description text not null,
  lifecycle app_unblock.lifecycle not null,
  priority integer not null,
  size app_unblock.tasksize,
  source_doc text,
  source_section text,
  source_anchor text,
  source_line integer,
  source_text text,
  completion_bar text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  archived_at timestamptz,
  version bigint not null,
  provenance jsonb not null default '{}'::jsonb,
  primary key (project_id, shard_id, id)
);
create unique index if not exists tasks_by_project on app_unblock.tasks using btree (project_id, id);
create index if not exists tasks_by_project_lifecycle on app_unblock.tasks using btree (project_id, lifecycle, archived_at);
create index if not exists tasks_by_project_source on app_unblock.tasks using btree (project_id, source_doc, source_section);

create table if not exists app_unblock.tracks (
  project_id text not null,
  shard_id text not null,
  id text not null,
  machine text not null,
  actor text not null,
  name text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  archived_at timestamptz,
  provenance jsonb not null default '{}'::jsonb,
  primary key (project_id, shard_id, id)
);
create unique index if not exists tracks_by_actor on app_unblock.tracks using btree (project_id, machine, actor);

create table if not exists app_unblock.comments (
  project_id text not null,
  shard_id text not null,
  id text not null,
  task_id text not null,
  machine text not null,
  actor text not null,
  body text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  archived_at timestamptz,
  provenance jsonb not null default '{}'::jsonb,
  primary key (project_id, shard_id, id)
);
create index if not exists comments_by_task on app_unblock.comments using btree (project_id, task_id, created_at);
create index if not exists comments_by_actor on app_unblock.comments using btree (project_id, machine, actor, created_at);

create table if not exists app_unblock.instructions (
  project_id text not null,
  shard_id text not null,
  id text not null,
  name text not null,
  selector_text text not null,
  selector_hash text not null,
  selector_fragment_id text,
  selector_fragment_hash text,
  body text not null,
  enabled boolean not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  archived_at timestamptz,
  provenance jsonb not null default '{}'::jsonb,
  primary key (project_id, shard_id, id)
);
create unique index if not exists instructions_by_name on app_unblock.instructions using btree (project_id, name);
create index if not exists instructions_by_selector on app_unblock.instructions using btree (project_id, selector_hash);

create table if not exists app_unblock.savedselectors (
  project_id text not null,
  shard_id text not null,
  id text not null,
  kind app_unblock.selectorkind not null,
  name text not null,
  selector_text text not null,
  selector_hash text not null,
  selector_fragment_id text,
  selector_fragment_hash text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  archived_at timestamptz,
  provenance jsonb not null default '{}'::jsonb,
  primary key (project_id, shard_id, id)
);
create unique index if not exists saved_selectors_by_kind_name on app_unblock.savedselectors using btree (project_id, kind, name);
create index if not exists saved_selectors_by_fragment on app_unblock.savedselectors using btree (project_id, selector_fragment_hash);

create table if not exists app_unblock.externalissues (
  project_id text not null,
  shard_id text not null,
  id text not null,
  provider app_unblock.externalprovider not null,
  external_id text not null,
  external_key text,
  url text,
  title text not null,
  state text not null,
  payload jsonb not null,
  synced_at timestamptz not null,
  archived_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  provenance jsonb not null default '{}'::jsonb,
  primary key (project_id, shard_id, id)
);
create unique index if not exists external_issues_by_provider on app_unblock.externalissues using btree (project_id, provider, external_id);

create table if not exists app_unblock.activityevents (
  project_id text not null,
  shard_id text not null,
  id text not null,
  type text not null,
  subject app_unblock.activitysubject not null,
  subject_id text,
  message text not null,
  data jsonb not null,
  machine text not null,
  actor text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  provenance jsonb not null default '{}'::jsonb,
  primary key (project_id, shard_id, id)
);
create index if not exists activity_by_project_time on app_unblock.activityevents using btree (project_id, created_at);
create index if not exists activity_by_subject on app_unblock.activityevents using btree (project_id, subject, subject_id, created_at);

create table if not exists app_unblock.taskdependsontask (
  project_id text not null,
  shard_id text not null,
  from_task_id text not null,
  to_task_id text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  provenance jsonb not null default '{}'::jsonb,
  primary key (project_id, shard_id, from_task_id, to_task_id)
);
create index if not exists taskdependsontask_from_idx on app_unblock.taskdependsontask using btree (from_task_id);
create index if not exists taskdependsontask_to_idx on app_unblock.taskdependsontask using btree (to_task_id);

create table if not exists app_unblock.taskcontainstask (
  project_id text not null,
  shard_id text not null,
  from_task_id text not null,
  to_task_id text not null,
  sort_key text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  provenance jsonb not null default '{}'::jsonb,
  primary key (project_id, shard_id, from_task_id, to_task_id)
);
create index if not exists taskcontainstask_from_idx on app_unblock.taskcontainstask using btree (from_task_id);
create index if not exists taskcontainstask_to_idx on app_unblock.taskcontainstask using btree (to_task_id);

create table if not exists app_unblock.taskassignedtotrack (
  project_id text not null,
  shard_id text not null,
  from_task_id text not null,
  to_track_id text not null,
  position text not null,
  assigned_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  provenance jsonb not null default '{}'::jsonb,
  primary key (project_id, shard_id, from_task_id, to_track_id)
);
create index if not exists taskassignedtotrack_from_idx on app_unblock.taskassignedtotrack using btree (from_task_id);
create index if not exists taskassignedtotrack_to_idx on app_unblock.taskassignedtotrack using btree (to_track_id);

create table if not exists app_unblock.taskmirrorsexternalissue (
  project_id text not null,
  shard_id text not null,
  from_task_id text not null,
  to_externalissue_id text not null,
  sync_policy text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  provenance jsonb not null default '{}'::jsonb,
  primary key (project_id, shard_id, from_task_id, to_externalissue_id)
);
create index if not exists taskmirrorsexternalissue_from_idx on app_unblock.taskmirrorsexternalissue using btree (from_task_id);
create index if not exists taskmirrorsexternalissue_to_idx on app_unblock.taskmirrorsexternalissue using btree (to_externalissue_id);

create table if not exists app_unblock.surface_projectrows (
  project_id text not null,
  shard_id text not null,
  id text not null,
  name text not null,
  description text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  archived_at timestamptz,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_taskrows (
  project_id text not null,
  shard_id text not null,
  id text not null,
  title text not null,
  description text not null,
  lifecycle app_unblock.lifecycle not null,
  priority integer not null,
  size app_unblock.tasksize,
  source_doc text,
  source_section text,
  source_anchor text,
  source_line integer,
  source_text text,
  completion_bar text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  archived_at timestamptz,
  version bigint not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_tasklabelrows (
  project_id text not null,
  shard_id text not null,
  task_id text not null,
  label_id text not null,
  name text not null,
  color text,
  description text,
  sort_order integer not null,
  assigned_at timestamptz not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_commentrows (
  project_id text not null,
  shard_id text not null,
  id text not null,
  task_id text not null,
  machine text not null,
  actor text not null,
  body text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  archived_at timestamptz,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_trackrows (
  project_id text not null,
  shard_id text not null,
  id text not null,
  machine text not null,
  actor text not null,
  name text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  archived_at timestamptz,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_instructionrows (
  project_id text not null,
  shard_id text not null,
  id text not null,
  name text not null,
  selector_text text not null,
  body text not null,
  enabled boolean not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  archived_at timestamptz,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_savedselectorrows (
  project_id text not null,
  shard_id text not null,
  id text not null,
  kind app_unblock.selectorkind not null,
  name text not null,
  selector_text text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  archived_at timestamptz,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_activityrows (
  project_id text not null,
  shard_id text not null,
  id text not null,
  type text not null,
  subject app_unblock.activitysubject not null,
  subject_id text,
  message text not null,
  data jsonb not null,
  machine text not null,
  actor text not null,
  created_at timestamptz not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_taskdependencyrows (
  project_id text not null,
  shard_id text not null,
  task_id text not null,
  depends_on_task_id text not null,
  created_at timestamptz not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_taskhierarchyrows (
  project_id text not null,
  shard_id text not null,
  parent_task_id text not null,
  task_id text not null,
  sort_key text,
  created_at timestamptz not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_taskassignmentrows (
  project_id text not null,
  shard_id text not null,
  task_id text not null,
  track_id text not null,
  position text not null,
  assigned_at timestamptz not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_taskdependencyclosure (
  project_id text not null,
  shard_id text not null,
  scope_key text not null,
  from_kind text not null,
  from_id text not null,
  to_kind text not null,
  to_id text not null,
  min_depth integer not null,
  path_count bigint not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_hierarchyclosure (
  project_id text not null,
  shard_id text not null,
  scope_key text not null,
  from_kind text not null,
  from_id text not null,
  to_kind text not null,
  to_id text not null,
  min_depth integer not null,
  path_count bigint not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_directdependencysummary (
  project_id text not null,
  shard_id text not null,
  task_id text not null,
  direct_dependency_count bigint not null,
  direct_dependency_ids text[] not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_directdependentsummary (
  project_id text not null,
  shard_id text not null,
  task_id text not null,
  direct_dependent_count bigint not null,
  direct_dependent_ids text[] not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_unfinisheddirectdependencysummary (
  project_id text not null,
  shard_id text not null,
  task_id text not null,
  unfinished_dependency_count bigint not null,
  unfinished_dependency_ids text[] not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_taskdependencysummary (
  project_id text not null,
  shard_id text not null,
  task_id text not null,
  dependency_count bigint not null,
  dependency_ids text[] not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_taskunblocksummary (
  project_id text not null,
  shard_id text not null,
  task_id text not null,
  unblocks_count bigint not null,
  unblocks_task_ids text[] not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_childsummary (
  project_id text not null,
  shard_id text not null,
  task_id text not null,
  children_count bigint not null,
  child_ids text[] not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_descendantsummary (
  project_id text not null,
  shard_id text not null,
  task_id text not null,
  descendants_count bigint not null,
  descendant_ids text[] not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_unfinisheddescendantsummary (
  project_id text not null,
  shard_id text not null,
  task_id text not null,
  unfinished_descendants_count bigint not null,
  unfinished_descendant_ids text[] not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_parentsummary (
  project_id text not null,
  shard_id text not null,
  task_id text not null,
  parent_task_id text not null,
  sort_key text,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_commentsummary (
  project_id text not null,
  shard_id text not null,
  task_id text not null,
  comment_count bigint not null,
  comment_authors text[] not null,
  last_comment_at timestamptz,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_assignmentsummary (
  project_id text not null,
  shard_id text not null,
  task_id text not null,
  track_id text not null,
  machine text not null,
  actor text not null,
  name text,
  position text not null,
  assigned_at timestamptz not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_taskstatus (
  project_id text not null,
  shard_id text not null,
  task_id text not null,
  computed_status app_unblock.computedstatus not null,
  ready boolean not null,
  blocked boolean not null,
  unfinished_dependency_count bigint not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_hierarchystatus (
  project_id text not null,
  shard_id text not null,
  task_id text not null,
  descendants_count bigint not null,
  unfinished_descendants_count bigint not null,
  rollup_status app_unblock.rollupstatus not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_taskreadmodel (
  project_id text not null,
  shard_id text not null,
  id text not null,
  title text not null,
  description text not null,
  lifecycle app_unblock.lifecycle not null,
  priority integer not null,
  size app_unblock.tasksize,
  source_doc text,
  source_section text,
  source_anchor text,
  source_line integer,
  source_text text,
  completion_bar text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  archived_at timestamptz,
  version bigint not null,
  computed_status app_unblock.computedstatus not null,
  ready boolean not null,
  blocked boolean not null,
  unfinished_dependency_count bigint not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_taskcommentmatchermodel (
  project_id text not null,
  shard_id text not null,
  id text not null,
  title text not null,
  description text not null,
  lifecycle app_unblock.lifecycle not null,
  priority integer not null,
  size app_unblock.tasksize,
  source_doc text,
  source_section text,
  source_anchor text,
  source_line integer,
  source_text text,
  completion_bar text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  archived_at timestamptz,
  version bigint not null,
  computed_status app_unblock.computedstatus not null,
  ready boolean not null,
  blocked boolean not null,
  unfinished_dependency_count bigint not null,
  comment_count bigint not null,
  comment_authors text[] not null,
  last_comment_at timestamptz,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_taskassignmentmatchermodel (
  project_id text not null,
  shard_id text not null,
  id text not null,
  title text not null,
  description text not null,
  lifecycle app_unblock.lifecycle not null,
  priority integer not null,
  size app_unblock.tasksize,
  source_doc text,
  source_section text,
  source_anchor text,
  source_line integer,
  source_text text,
  completion_bar text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  archived_at timestamptz,
  version bigint not null,
  computed_status app_unblock.computedstatus not null,
  ready boolean not null,
  blocked boolean not null,
  unfinished_dependency_count bigint not null,
  comment_count bigint not null,
  comment_authors text[] not null,
  last_comment_at timestamptz,
  assigned_track_id text,
  assigned_machine text,
  assigned_actor text,
  assigned_name text,
  assigned_position text,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_taskmatcherreadmodel (
  project_id text not null,
  shard_id text not null,
  id text not null,
  title text not null,
  description text not null,
  lifecycle app_unblock.lifecycle not null,
  priority integer not null,
  size app_unblock.tasksize,
  source_doc text,
  source_section text,
  source_anchor text,
  source_line integer,
  source_text text,
  completion_bar text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  archived_at timestamptz,
  version bigint not null,
  computed_status app_unblock.computedstatus not null,
  ready boolean not null,
  blocked boolean not null,
  unfinished_dependency_count bigint not null,
  comment_count bigint not null,
  comment_authors text[] not null,
  last_comment_at timestamptz,
  assigned_track_id text,
  assigned_machine text,
  assigned_actor text,
  assigned_name text,
  assigned_position text,
  dependency_count bigint not null,
  dependency_ids text[] not null,
  unblocks_count bigint not null,
  unblocks_task_ids text[] not null,
  parent_task_id text,
  descendants_count bigint not null,
  unfinished_descendants_count bigint not null,
  rollup_status app_unblock.rollupstatus not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_readytasks (
  project_id text not null,
  shard_id text not null,
  task_id text not null,
  priority integer not null,
  updated_at timestamptz not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_instructionselectorcatalog (
  project_id text not null,
  shard_id text not null,
  instruction_id text not null,
  selector_text text not null,
  selector_hash text not null,
  selector_fragment_id text,
  selector_fragment_hash text,
  body text not null,
  primary key (project_id, shard_id)
);

create table if not exists app_unblock.surface_savedselectorcatalog (
  project_id text not null,
  shard_id text not null,
  selector_id text not null,
  kind app_unblock.selectorkind not null,
  name text not null,
  selector_text text not null,
  selector_hash text not null,
  selector_fragment_id text,
  selector_fragment_hash text,
  primary key (project_id, shard_id)
);

