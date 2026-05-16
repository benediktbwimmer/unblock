# Hosted Unblock Architecture

This document tracks the architecture pivot for hosted Unblock. The target is a
Postgres-native core for hosted and low-friction self-hosted deployments, while
preserving SQLite as the local single-machine option. Prism Flows is used for
durable connector orchestration only; it is not the primary Unblock data store.

## Runtime Mode Matrix

Unblock should support three runtime modes. The mode controls storage,
enterprise features, and connector availability. The domain semantics should
stay the same unless this document calls out a hosted-only feature.

| Mode | Storage | Target user | Connector support | Enterprise support |
| --- | --- | --- | --- | --- |
| Local SQLite | Local SQLite file, defaulting to the current `UNBLOCK_DB` or Unblock config path behavior. | A single developer or a single machine coordinating local agent work. | Disabled. No Prism Flows, no hosted connector worker, no external credential store. | Disabled. No WorkOS requirement, no hosted tenant model, no enterprise audit export. |
| Self-hosted Postgres | User-supplied Postgres URL managed by the team. | Small teams that want one shared Unblock instance without hosted enterprise services. | Disabled for the first hosted connector release. The schema should not block future opt-in connector workers. | Minimal. Project namespaces, local auth/provenance, and operational health checks only. |
| Hosted Postgres | Provider-managed Postgres with hosted API, web, migration, and worker deployment. | Paid hosted and licensed enterprise deployments. | Enabled. GitHub Issues is the first connector; Prism Flows orchestrates connector sync. | Enabled. WorkOS, tenant/project RBAC, secrets, connector administration, audit export, observability, and benchmark gates. |

### Local SQLite Mode

Local SQLite remains the zero-friction path. It must continue to work without a
network, without Postgres, without Prism, and without WorkOS.

Required behavior:

- Existing CLI defaults keep using SQLite.
- Existing `unblock serve` local development keeps using SQLite unless a
  Postgres mode is explicitly configured.
- Existing migrations continue to apply to the local database.
- All current task, dependency, tag, track, instruction, comment, view, feed,
  activity, import, export, matcher, and context commands keep working.
- Activity remains the local provenance trail.
- Connector configuration is hidden or reported as unavailable.

SQLite mode can keep implementation shortcuts that are acceptable for a local
single-machine database, including service-level matcher evaluation and local
file-backed configuration.

### Self-Hosted Postgres Mode

Self-hosted Postgres is the low-friction shared-team mode. The user supplies a
Postgres database and runs Unblock against it. This mode should be boring:
native SQL persistence, migrations, health checks, and the same core Unblock
API as SQLite.

Required behavior:

- Configuration accepts a Postgres URL and selects the Postgres store.
- Migrations are explicit and safe to run at startup or through a command.
- Core API and CLI behavior matches SQLite semantics.
- The API can support multiple users through configured provenance, but it does
  not require WorkOS for the initial version.
- Hosted-only connector routes are not enabled by default.
- The schema includes extension points for connector tables if they do not add
  runtime dependencies or user-visible complexity.

This mode is deliberately not the enterprise product. It is a credible shared
backend for teams that do not need hosted identity, credential management,
operator dashboards, or managed connector orchestration.

### Hosted Postgres Mode

Hosted Postgres is the production SaaS path. It uses the same core Postgres
domain schema as self-hosted mode, plus hosted-only tables and services.

Required behavior:

- WorkOS maps organizations and users into Unblock tenants, projects, roles,
  and administrative actions.
- Every request is tenant/project scoped before it reaches domain services.
- Hosted audit records extend local activity with immutable security,
  administration, connector, and operator events.
- Secret and connector credentials are managed by hosted infrastructure and
  never appear in local config files.
- Prism Flows handles durable connector orchestration: webhooks, polling,
  outbound sync, retries, rate limits, reconciliation, and operator review.
- Hosted benchmark gates cover CRUD, matcher reads, dashboard polling, and
  connector workloads before release.

### Feature Boundary

The implementation should avoid a fourth implicit mode. In particular:

- SQLite mode must not partially initialize hosted services.
- Self-hosted Postgres must not require Prism Flows or WorkOS.
- Hosted mode must not use Prism as an ORM or materialized read store.
- GitHub Issues sync is hosted-only until there is an explicit product decision
  to support self-hosted connector workers.
- The core service layer should remain storage-agnostic enough to run against
  SQLite and Postgres, but hosted auth and connector orchestration should stay
  outside that local compatibility path.

## Postgres-Native Core Schema

The Postgres schema should be a native application schema, not generated Prism
storage. It should make the hot paths cheap: scoped task CRUD, dependency
updates, matcher reads, queue reads, dashboard polling, and instruction
matching.

### Schema Principles

- Every tenant-owned row carries `tenant_id`; every project-owned row carries
  both `tenant_id` and `project_id`.
- Public task IDs remain project-scoped strings. Internal UUID primary keys may
  be added for joins, but the API contract continues to use project-local task
  IDs.
- Foreign keys enforce tenant/project boundaries.
- `created_at`, `updated_at`, and archive timestamps use `timestamptz`.
- Optimistic write protection uses the existing task `version` behavior.
- High-volume activity, audit, outbox, inbox, and connector events are append
  heavy and should be partitionable by time or tenant later.
- Hosted-only tables can exist in the same database, but local SQLite does not
  need equivalents unless the feature is enabled locally.

### Identity And Scope

`tenants`

- Hosted organization boundary.
- Key columns: `id`, `slug`, `name`, `created_at`, `updated_at`,
  `archived_at`.
- Hosted mode maps WorkOS organizations onto tenants.
- Self-hosted Postgres can create a single default tenant.

`tenant_members`

- Hosted user and role membership.
- Key columns: `tenant_id`, `principal_id`, `role`, `created_at`,
  `updated_at`, `disabled_at`.
- Role checks happen before project-scoped domain services run.

`projects`

- Same project namespace as SQLite, scoped under a tenant.
- Key columns: `tenant_id`, `id`, `name`, `description`, timestamps,
  `archived_at`.
- Unique key: `(tenant_id, id)`.

`project_members`

- Optional project-specific permissions for hosted mode.
- Key columns: `tenant_id`, `project_id`, `principal_id`, `role`,
  `created_at`, `updated_at`, `disabled_at`.

### Core Task Domain

`tasks`

- Postgres equivalent of the SQLite `tasks` table.
- Key columns: `tenant_id`, `project_id`, `id`, `parent_task_id`, `title`,
  `description`, `lifecycle`, `priority`, `size`, source fields,
  `completion_bar`, lifecycle timestamps, `archived_at`, `version`.
- Primary key: `(tenant_id, project_id, id)`.
- Foreign key: `(tenant_id, project_id, parent_task_id)` to `tasks`.
- Important indexes:
  - `(tenant_id, project_id, archived_at, lifecycle)`
  - `(tenant_id, project_id, parent_task_id)`
  - `(tenant_id, project_id, priority)`
  - `(tenant_id, project_id, updated_at desc)`
  - `(tenant_id, project_id, source_doc, source_section)`

`task_dependencies`

- Explicit hard dependency edges.
- Key columns: `tenant_id`, `project_id`, `task_id`, `depends_on_task_id`,
  `created_at`.
- Primary key: `(tenant_id, project_id, task_id, depends_on_task_id)`.
- Foreign keys point to project-local tasks.
- Check: `task_id != depends_on_task_id`.
- Important indexes:
  - `(tenant_id, project_id, task_id)`
  - `(tenant_id, project_id, depends_on_task_id)`

`task_dependency_closure`

- Optional Postgres read optimization for transitive dependency queries.
- Key columns: `tenant_id`, `project_id`, `task_id`, `depends_on_task_id`,
  `depth`, `edge_kinds`, `updated_at`.
- The implementation may start without this table if recursive CTEs meet
  benchmark gates. If introduced, it must be transactionally maintained or
  rebuilt with a correctness check.

`task_hierarchy_closure`

- Optional Postgres read optimization for ancestor/descendant queries and
  parent rollups.
- Key columns: `tenant_id`, `project_id`, `ancestor_task_id`,
  `descendant_task_id`, `depth`, `updated_at`.
- Like dependency closure, this is allowed only if benchmarks justify it and
  tests prove parity with the source edges.

### Tags, Queues, Instructions, Views

`tags`

- Project-scoped tag catalog.
- Key columns: `tenant_id`, `project_id`, `id`, `name`, `color`,
  `description`, `sort_order`, timestamps, `archived_at`.
- Unique keys: `(tenant_id, project_id, id)` and `(tenant_id, project_id,
  lower(name))`.

`task_tags`

- Many-to-many task/tag relation.
- Key columns: `tenant_id`, `project_id`, `task_id`, `tag_id`, `created_at`.
- Primary key: `(tenant_id, project_id, task_id, tag_id)`.
- Important index: `(tenant_id, project_id, tag_id, task_id)`.

`tracks`

- Actor queue identity.
- Key columns: `tenant_id`, `project_id`, `id`, `machine`, `actor`, `name`,
  timestamps, `archived_at`.
- Unique key: `(tenant_id, project_id, machine, actor)`.

`track_assignments`

- Exclusive assignment of a task to one actor queue.
- Key columns: `tenant_id`, `project_id`, `track_id`, `task_id`, `position`,
  `assigned_at`.
- Primary key: `(tenant_id, project_id, track_id, task_id)`.
- Unique key: `(tenant_id, project_id, task_id)`.
- Important index: `(tenant_id, project_id, track_id, position)`.

`instructions`

- Matcher-backed instruction records.
- Key columns: `tenant_id`, `project_id`, `id`, `name`, `query`, `body`,
  `enabled`, timestamps, `archived_at`.
- Unique keys: `(tenant_id, project_id, id)` and `(tenant_id, project_id,
  lower(name))`.
- Important index: `(tenant_id, project_id, enabled, archived_at)`.
- Runtime matching remains derived from `query`; no imperative attachment table
  is the source of truth.

`saved_views` and `queue_feeds`

- Named matcher queries.
- Key columns: `tenant_id`, `project_id`, `id`, `name`, `query`, timestamps,
  `archived_at`.
- Unique keys by project-local ID and case-insensitive name.

`comments`

- Flat chronological markdown comments.
- Key columns: `tenant_id`, `project_id`, `id`, `task_id`, `machine`, `actor`,
  `body`, timestamps, `archived_at`.
- Important indexes:
  - `(tenant_id, project_id, task_id, created_at)`
  - `(tenant_id, project_id, archived_at)`
  - `(tenant_id, project_id, machine, actor, created_at)`

### Matcher Support

Matcher queries should lower to SQL over the normalized tables and optional
closure tables. The matcher AST remains the semantic source of truth.

`matcher_query_cache`

- Optional hosted optimization for parsed/planned matcher queries.
- Key columns: `tenant_id`, `project_id`, `query_hash`, `query`, `ast_json`,
  `plan_json`, `created_at`, `last_used_at`.
- This is a compiler/planner cache only. It must not cache result sets as the
  primary correctness path.

`instruction_match_cache`

- Avoid this as a required table initially. Instruction matches should be a
  derived read from enabled instruction queries. Add a cache only if benchmarks
  prove repeated matching needs it, and invalidate by task/instruction version.

### Activity And Hosted Audit

`activity`

- Postgres equivalent of the current local activity stream.
- Key columns: `tenant_id`, `project_id`, `id`, `type`, `subject_type`,
  `subject_id`, `message`, `data_json`, `machine`, `actor`, `created_at`.
- Important indexes:
  - `(tenant_id, project_id, created_at desc)`
  - `(tenant_id, project_id, subject_type, subject_id, created_at desc)`

`audit_events`

- Hosted enterprise audit trail. This extends activity and is not required for
  local SQLite.
- Key columns: `tenant_id`, `id`, `project_id`, `event_type`, `principal_id`,
  `actor_machine`, `actor_name`, `subject_type`, `subject_id`, `ip_address`,
  `user_agent`, `request_id`, `data_json`, `created_at`.
- Records security, auth, admin, connector, secret, WorkOS, and operator events.
- Append-only at the application layer. Hosted retention/export policies apply
  here.

### Outbox, Inbox, And Connector Mapping

`outbox_events`

- Durable events emitted by Unblock domain transactions for external
  orchestration.
- Key columns: `tenant_id`, `project_id`, `id`, `event_type`, `subject_type`,
  `subject_id`, `payload_json`, `idempotency_key`, `status`, `attempt_count`,
  `available_at`, `created_at`, `claimed_at`, `processed_at`, `error_json`.
- Unique key: `(tenant_id, idempotency_key)` when an idempotency key is present.
- Important index: `(tenant_id, status, available_at, created_at)`.
- Written in the same transaction as the task/tag/dependency change that
  produced it.

`inbox_events`

- Idempotent application record for inbound connector events.
- Key columns: `tenant_id`, `project_id`, `id`, `source`, `external_event_id`,
  `event_type`, `payload_json`, `status`, `applied_at`, `created_at`,
  `error_json`.
- Unique key: `(tenant_id, source, external_event_id)`.
- Ensures webhook replay and Flow retry cannot apply the same external event
  twice.

`connector_connections`

- Hosted connector configuration at tenant/project scope.
- Key columns: `tenant_id`, `project_id`, `id`, `provider`, `display_name`,
  `status`, `settings_json`, `secret_ref`, timestamps, `archived_at`.
- GitHub Issues and Jira Issues are the first proving providers. GitHub keeps
  the low-friction path honest; Jira keeps the model honest for richer
  enterprise semantics.

`connector_sync_policies`

- Global and matcher-scoped policy records for one connector.
- Key columns: `tenant_id`, `project_id`, `id`, `connection_id`, `name`,
  `scope_query`, `priority`, `enabled`, `policy_json`, timestamps,
  `archived_at`.
- `scope_query` is null for the connector default policy. Non-null queries use
  the same matcher language as instructions and saved views. The highest
  priority enabled matching policy overrides or refines the connector default
  for the matched task/object.
- `policy_json` is field-grained. It records ownership, direction, conflict
  handling, manual-review requirements, outbound transition defaults, and
  provider-specific behavior.

`external_object_mappings`

- Stable mapping between Unblock objects and external objects.
- Key columns: `tenant_id`, `project_id`, `id`, `connection_id`,
  `external_system`, `external_kind`, `external_id`, `external_url`,
  `local_kind`, `local_id`, `sync_mode`, `external_version`,
  `local_version`, timestamps, `archived_at`.
- The mapping identifies object identity and the last known versions. It is not
  enough to decide sync behavior by itself; behavior comes from the resolved
  sync policy.
- Unique keys:
  - `(tenant_id, connection_id, external_system, external_kind, external_id)`
  - `(tenant_id, project_id, local_kind, local_id, connection_id,
    external_kind)`

`sync_queue_items`

- User-visible reconciliation queue for external/local divergence.
- Key columns: `tenant_id`, `project_id`, `id`, `connection_id`, `mapping_id`,
  `external_kind`, `external_id`, `local_kind`, `local_id`, `status`,
  `severity`, `detected_at`, `last_attempt_at`, `resolved_at`,
  `resolved_by_principal_id`, `decision_json`, `external_snapshot_json`,
  `local_snapshot_json`, `diff_json`, `policy_ref_json`, `error_json`.
- Status values should distinguish at least `pending`, `auto_applying`,
  `blocked`, `manual_review`, `ignored`, `resolved`, and `failed`.
- Queue items are not only errors. They represent every meaningful divergence
  where a human or policy may need to understand what will happen.

`sync_cursors`

- Durable polling/backfill cursor state.
- Key columns: `tenant_id`, `project_id`, `connection_id`, `cursor_name`,
  `cursor_value`, `watermark_at`, `updated_at`.
- Updated only after emitted evidence is durable.

`sync_runs`

- Operator-visible connector run records.
- Key columns: `tenant_id`, `project_id`, `id`, `connection_id`, `run_type`,
  `status`, `started_at`, `finished_at`, `stats_json`, `error_json`,
  `flow_run_ref`.

`dead_letters`

- Events requiring operator review.
- Key columns: `tenant_id`, `project_id`, `id`, `connection_id`, `source`,
  `event_ref`, `reason`, `payload_ref`, `status`, `created_at`,
  `resolved_at`, `resolved_by`.

`principals`

- Accountable identity inside a tenant. A principal may represent a human user,
  team, bot, or service account.
- Key columns: `tenant_id`, `id`, `kind`, `display_name`, `email`,
  `created_at`, `updated_at`, `disabled_at`.
- WorkOS users map to human principals in hosted mode. Self-hosted Postgres can
  create local principals without WorkOS.

`external_identities`

- Provider identity mapping for connector assignees and authors.
- Key columns: `tenant_id`, `connection_id`, `provider`, `external_kind`,
  `external_id`, `external_display_name`, `external_email`, `principal_id`,
  `confidence`, timestamps.
- Examples: GitHub login or node ID to principal; Jira `accountId` to
  principal. Unknown identities may exist without a `principal_id` until a user
  maps them.

`task_responsibilities`

- Accountable ownership of task outcome, separate from execution assignment.
- Key columns: `tenant_id`, `project_id`, `task_id`, `principal_id`,
  `role`, `source`, `created_at`, `updated_at`, `archived_at`.
- External assignees normally sync to responsibility assignments, not to actor
  queues.

`delegation_rules`

- Policy allowing a principal or team to delegate execution to an Unblock actor
  queue or agent pool.
- Key columns: `tenant_id`, `project_id`, `id`, `principal_id`, `target_kind`,
  `target_id`, `scope_query`, `priority`, `enabled`, timestamps,
  `archived_at`.
- Delegation is what lets a Jira assignee remain accountable while a machine
  actor such as `codex-b` executes the work.

### Schema Work Deferred To Later Tasks

Later implementation tasks should decide:

- Whether dependency and hierarchy closure tables are required at launch or
  whether recursive CTEs meet the benchmark gates.
- Exact enum representation for lifecycle, roles, connector status, and event
  status.
- Whether task IDs stay purely text keys in Postgres or receive internal UUIDs
  for join-heavy hosted paths.
- How audit retention and export are physically partitioned.
- Whether matcher planning caches are needed after the first benchmark pass.

## Prism Flows Orchestration Boundary

Prism Flows is the hosted connector orchestration layer. It should not own core
Unblock state, task read models, matcher evaluation, or ordinary API request
latency. The boundary is intentionally narrow: Unblock commits domain state to
Postgres, then durable Flow runs perform external sync and reconciliation.

### Unblock Postgres Owns

Unblock remains the system of record for:

- Tenants, projects, users, roles, and project membership.
- Tasks, hierarchy, dependencies, tags, comments, instructions, views, feeds,
  tracks, assignments, activity, and hosted audit.
- Matcher parsing semantics and Postgres matcher lowering.
- Connector configuration metadata, external object mappings, sync cursors,
  sync run summaries, dead letters, outbox, and inbox records.
- User-facing API responses and dashboard/frontend polling reads.
- Idempotent application of inbound connector mutations.
- The final decision about whether an external event changes local state.

This means a hosted API request that creates or edits a task should complete
after the Postgres transaction commits. It should not wait for a Flow run unless
the API explicitly exposes a synchronous connector operation later.

### Prism Flows Owns

Prism Flows owns durable external work:

- Receiving and validating connector webhooks where the connector endpoint is
  routed through the Flow layer.
- Polling external systems with durable cursors and dedupe windows.
- Reading Unblock outbox events and executing outbound connector operations.
- Calling GitHub APIs and later other issue/project-management APIs.
- Respecting external rate limits and retry policies.
- Running backfills and periodic reconciliation.
- Recovering ambiguous external mutations through retry-safe or manual-review
  policies.
- Emitting inbound events into the Unblock inbox.
- Producing Flow run references and summaries for hosted observability.

Flows can use Deno jobs or HTTP steps to call Unblock internal APIs, but those
calls must go through typed, idempotent contracts. Flow code should not reach
around the Unblock API and mutate arbitrary core tables directly.

### Event Flow

Outbound sync:

1. A user or API client changes Unblock state.
2. The domain transaction writes the task/tag/dependency change, activity/audit
   records, and an `outbox_events` record.
3. A hosted publisher starts or signals the relevant Prism Flow with the outbox
   event ID and idempotency key.
4. The Flow loads the event through an internal Unblock API, performs external
   work, and records connector evidence.
5. The Flow reports completion or failure back to Unblock, updating sync run
   state and any relevant mapping metadata.

Inbound sync:

1. GitHub sends a webhook, or a Flow poller/backfill discovers a changed issue.
2. The Flow validates/dedupes the external event and normalizes it.
3. The Flow posts the normalized event to an Unblock inbox endpoint with a
   stable external event ID.
4. Unblock inserts or finds the `inbox_events` record.
5. Unblock applies the local mutation in a transaction, updates mappings and
   audit/activity, then marks the inbox event applied.
6. If the event is ambiguous, Unblock records a dead letter or operator-review
   item instead of guessing.

Reconciliation:

1. A scheduled Flow chooses a connection/project scope.
2. The Flow fetches a bounded page or batch from the external system.
3. The Flow compares external identifiers and versions against Unblock mapping
   APIs.
4. Missing or divergent records become inbound inbox events, outbound repair
   events, or dead letters.
5. Cursor advancement happens only after event evidence is durably recorded.

### Idempotency And Ownership Rules

- Every outbox event has a stable idempotency key derived from the local object,
  operation, and local version.
- Every inbound external event has a stable source event key, such as GitHub
  delivery ID plus issue event identity.
- Unblock inbox application is exactly-once by unique source event key.
- Flow retries may repeat calls, but repeated calls must converge on the same
  Unblock inbox/outbox result.
- External object mappings are updated by Unblock transactions, not by Flow
  state alone.
- Flow run state is evidence and orchestration history. It is not the primary
  task state or connector mapping state.

### What Does Not Belong In Flows

The following must stay out of Prism Flows for the hosted Unblock architecture:

- Task CRUD as the primary data path.
- Matcher query execution for ordinary UI reads.
- Dependency graph materialization for the product UI.
- Project/tenant authorization decisions.
- Long-lived local caches that become required for correctness.
- Direct writes to core task/dependency/tag/instruction tables.
- User-visible source-of-truth state that cannot be reconstructed from Unblock
  Postgres.

## Connector Sync Product Model

Hosted Unblock should treat connectors as policy-controlled reconciliation
systems, not as one-way importers. The product promise is that external
planning systems remain useful sources of planning truth while Unblock becomes
the execution layer where dependencies, instructions, queues, agents, and
human review are first-class.

### Sync Modes And Field Ownership

Sync is configurable per connector, per object type, per field, and through
matcher-scoped overrides. The common high-level modes are:

| Mode | Meaning |
| --- | --- |
| `disabled` | Link and observe objects, but do not detect or apply divergence. |
| `manual` | Detect divergence and create sync queue items; a user chooses what to apply. |
| `inbound_only` | External system is authoritative for the selected field/object. |
| `outbound_only` | Unblock is authoritative for the selected field/object. |
| `bidirectional` | Both sides may change; conflict policy decides ambiguous divergence. |
| `append_only` | Both sides may append immutable records, such as comments, without rewriting history. |

Direction by itself is not sufficient. Each field also needs an ownership and
conflict policy. Good defaults should be simple enough to trust:

- `Mirror External Work`: inbound issue content, no outbound writes.
- `Execution Layer`: external issue content stays externally owned; Unblock
  owns dependencies, instructions, execution assignment, review gates, and task
  execution state. Optional outbound progress comments are allowed.
- `Bidirectional Project Sync`: selected status, labels, comments, and assignee
  fields sync both ways with explicit conflict handling.

The recommended hosted default is `Execution Layer`.

### Matcher-Scoped Sync Policies

Connector defaults can be overridden with matcher-backed sync policies. This
uses the same selector idea as instructions: a connector has a global default,
then more specific enabled policies apply to tasks or mappings that match their
selector.

Example policy shape:

```txt
connector github-main preset execution_layer

default fields:
  title: inbound_only
  description: inbound_only
  external_state: inbound_only
  comments: append_only
  external_labels: inbound_only
  dependencies: unblock_owned
  instructions: unblock_owned
  responsibility: inbound_to_principal
  execution_assignment: unblock_owned

override where `tag:agent-ready status:ready`:
  execution_assignment: route_to_track("codex-b")
  comments: outbound_progress_summaries

override where `tag:security`:
  responsibility: manual_review
  execution_assignment: manual_review
```

Policy resolution must be explainable. The sync queue and task detail views
should be able to show which policy matched and why a given field is inbound,
outbound, ignored, or awaiting review.

### Sync Queue

The sync queue is the trust surface for connectors. It should not be a hidden
error list. It should be an explicit reconciliation cockpit that shows where
external state and Unblock state diverge and what Unblock plans to do.

Each queue item should show:

- connector, external object, local object, and mapping
- field-level diff between external snapshot and local snapshot
- resolved policy and matching policy source
- proposed decision: apply inbound, apply outbound, ignore, block, or manual
  review
- reason and confidence
- last webhook/reconciliation/run evidence
- retry, apply, ignore, reopen, and escalate actions where permitted

Examples:

- GitHub title changed externally. Policy says title is inbound, so Unblock
  updates the task title automatically and records the queue item as resolved.
- Unblock task finished while Jira issue is `In Progress`. Policy allows
  outbound status sync, but Jira requires a resolution field. The queue item is
  blocked and offers the configured resolution choices.
- Jira assignee changes from Alice to Bob. Policy says assignees map to
  responsible principals, so Unblock updates responsibility to Bob and keeps the
  execution queue assigned to the delegated agent.
- Unblock dependency is added. GitHub Issues has no native dependency field in
  the configured preset, so the divergence is ignored or represented only as an
  optional outbound comment, depending on policy.

### Assignees, Principals, Actors, And Delegation

External assignees must not map directly to Unblock actor queues. External
assignees are usually accountable users in Jira, Linear, GitHub, or Asana.
Unblock actors are execution identities: humans, agents, machine-local agents,
CI workers, or delegated queues.

Unblock therefore separates:

- `Principal`: accountable tenant identity, usually a human user or team.
- `ExternalIdentity`: provider account mapped to a principal.
- `TaskResponsibility`: who is responsible for the outcome.
- `Track`: execution queue identity, currently `(machine, actor)`.
- `DelegationRule`: when a responsible principal allows a track or actor pool
  to execute matching work.
- `TrackAssignment`: who or what should execute the next step.

Example:

```txt
Jira assignee: Alice
External identity: jira:accountId:abc -> principal:alice
Task responsibility: Alice
Delegation rule: Alice delegates `tag:backend status:ready` to CODEX-E
Execution assignment: CODEX-E
```

Outbound sync should normally write the accountable principal back to external
assignee fields, not the delegated machine actor. Agent execution evidence can
be posted as comments or metadata only when policy allows it.

### Provider Proving Grounds

GitHub Issues is the first connector target.

The first production slice should support:

- GitHub installation/connection configuration in hosted Unblock.
- Issue webhook ingestion.
- Backfill/poll reconciliation for missed webhooks.
- Mapping between GitHub repositories/issues and Unblock tasks.
- Inbound issue create/update/close/reopen to Unblock task mutations.
- Outbound selected Unblock task changes to GitHub issue mutations.
- Rate-limit handling, retry, dead-letter, and operator visibility.

It should not try to support every GitHub Project, pull request, label, or
milestone behavior in the first connector milestone. Those should become later
connector tasks after the issue sync path is proven.

Jira Issues should be implemented alongside the connector policy foundation
before the connector model is considered stable. Jira forces the abstractions
to handle richer semantics:

- issue types and custom fields
- statuses and workflow transitions
- required transition fields
- priorities, components, fix versions, and sprints
- parent/epic links and issue links
- rich assignee/account IDs
- permission and visibility failures
- provider-managed field schemas

The Jira connector does not need to reach feature parity with GitHub in the
first implementation pass. It does need to exercise the same policy engine,
external identity mapping, responsibility model, sync queue, and connector run
observability.

## Benchmark And Production Readiness Gates

Hosted Unblock should not be accepted as production-ready until it passes
repeatable benchmark gates. The gates should be run against release builds, a
real Postgres database, and seeded data sets that resemble actual agent-heavy
project usage.

The exact machine profile can be adjusted in the benchmark task, but every
reported number must include:

- commit SHA and build mode
- CPU, memory, and database location
- Postgres version and connection pool settings
- data set size and project/tenant distribution
- concurrency level
- p50, p95, p99, max latency, throughput, and error rate
- database CPU, connection saturation, slow queries, and lock waits where
  available

### Data Sets

Benchmarks should run at these scales:

| Name | Tenants | Projects per tenant | Tasks per project | Dependency edges per project | Tags per project | Instructions per project |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Small | 1 | 1 | 1,000 | 2,000 | 50 | 25 |
| Medium | 8 | 8 | 10,000 | 30,000 | 200 | 100 |
| Large | 32 | 16 | 50,000 | 200,000 | 500 | 250 |

The medium data set is the default CI performance gate. The large data set is
the release gate and can run outside ordinary pull request CI if needed.

### CRUD Gates

CRUD benchmarks measure the native Unblock API and repository layer, not direct
SQL helper scripts.

Release gates for hosted Postgres:

- Task create with activity and optional outbox: at least 1,000 writes/second
  sustained on the medium data set, p95 below 75 ms, error rate below 0.1%.
- Task update/lifecycle transition with activity and version check: at least
  1,500 writes/second sustained, p95 below 60 ms.
- Dependency add/remove with cycle and hierarchy checks: at least 500
  mutations/second sustained on the medium data set, p95 below 100 ms.
- Tag assignment: at least 2,000 assignments/second sustained, p95 below 50 ms.
- Comment add/edit/archive: at least 1,000 mutations/second sustained, p95
  below 75 ms.
- Import-tree style bulk creation: at least 10,000 tasks/minute with tags,
  dependencies, and assignments on one project.

SQLite local mode should have a separate non-hosted baseline. It does not need
to hit hosted throughput, but regressions against the current local path should
fail tests.

### Matcher And Heavy Read Gates

Matcher and read benchmarks must include warm and cold-ish runs. They should not
depend on Prism materialization or connector workers.

Required hosted gates on the medium data set:

- Basic task list by lifecycle/tag/assignee: p95 below 50 ms.
- Ready queue for one actor: p95 below 50 ms.
- Saved queue feed: p95 below 75 ms.
- Task detail with dependencies, dependents, comments, tags, and instructions:
  p95 below 75 ms.
- Matcher with nested boolean field predicates: p95 below 75 ms.
- Matcher with `depends on` or `unblocks` depth-bounded graph predicates: p95
  below 125 ms.
- Matcher with transitive graph count predicates: p95 below 200 ms.
- Instruction matching for one task: p95 below 100 ms.
- Project activity feed: p95 below 50 ms.

The large data set release gate may allow higher graph-query latency, but p95
for ordinary dashboard and queue reads should stay below 150 ms.

### Frontend Polling Gates

The hosted product must tolerate many open frontends polling at once because the
current UI model refreshes views periodically.

Required scenarios:

- 100 concurrent frontends polling dashboard, ready queue, selected task detail,
  activity, and instructions every 5 seconds for 10 minutes.
- 500 concurrent frontends polling the same mix every 5 seconds for 10 minutes.
- Mixed active workload where 10% of clients also perform task updates,
  comments, and dependency edits while polling continues.

Release gates:

- 100-client scenario: p95 read latency below 75 ms and no sustained database
  pool saturation.
- 500-client scenario: p95 read latency below 150 ms, p99 below 400 ms, error
  rate below 0.1%.
- Mixed workload: write p95 below 150 ms and read p95 below 200 ms.
- Polling must not starve connector inbox/outbox processing.

If these gates require push-based UI updates later, that should be a product
decision made from benchmark evidence, not an assumption baked into the first
Postgres port.

### Connector Sync Gates

Connector benchmarks apply to hosted mode only. They measure both Prism Flows
orchestration and Unblock inbox/outbox application, but the final user-visible
state is verified in Unblock Postgres.

GitHub Issues release gates:

- Webhook burst: ingest and dedupe 10,000 issue events with no duplicate local
  application and p95 inbox application below 150 ms.
- Outbound sync: process 10,000 task-change outbox events with no lost events,
  respecting simulated GitHub rate limits.
- Reconciliation: scan 100,000 external issues across multiple repositories
  and converge mappings without duplicate tasks.
- Retry safety: repeated Flow deliveries must not create duplicate task changes,
  comments, mappings, or audit records.
- Dead-letter path: ambiguous or invalid events become operator-visible dead
  letters within 30 seconds.

Connector throughput is allowed to be rate-limited by external APIs. The gate is
therefore convergence, correctness, observability, and backpressure behavior,
not only raw events per second.

### Multi-Tenant Gates

Hosted Unblock must preserve tenant isolation while scaling across tenants and
projects.

Required scenarios:

- One hot project with many tasks and many pollers.
- Many warm projects across one tenant.
- Many tenants with independent projects and connector configurations.
- One tenant with a connector backlog while other tenants continue normal CRUD
  and reads.

Release gates:

- No cross-tenant reads or writes in correctness tests.
- A hot tenant should not push unrelated tenants above 2x their baseline p95
  latency.
- Per-tenant rate limiting should protect global database and Flow capacity.
- Benchmark reports must break down latency by tenant/project, not only global
  averages.

### Readiness Checklist

The hosted path is not production-ready until all of the following are true:

- SQLite compatibility tests still pass.
- Postgres parity tests pass for every core service path.
- Benchmark gates above pass on release builds.
- Query plans for critical matcher/read paths are captured and reviewed.
- Migration, backup, and restore runbooks are tested.
- WorkOS tenant/project authorization has negative tests.
- Audit and activity records exist for every hosted security-relevant mutation.
- GitHub connector replay, retry, and reconciliation tests pass.
- Failure injection covers database downtime, Flow downtime, GitHub errors,
  webhook replay, and retry exhaustion.

## Current SQLite Contract

The existing SQLite path is the compatibility contract for local Unblock. Any
Postgres or hosted implementation must preserve the behavior below unless a
later review task explicitly changes it.

### Store Boundary

The core storage contract is `AppStore` in `packages/core/src/store.ts`.
`SqliteStore` implements it in `packages/core/src/sqlite-store.ts` with
embedded migrations from `packages/core/src/migrations.ts`.

The repository set is:

- `projects`: project namespaces, archive/restore, global project activity.
- `tasks`: task CRUD, parent hierarchy, lifecycle timestamps, archival, hard
  delete, optimistic `version`.
- `dependencies`: hard task dependencies plus cycle and hierarchy checks.
- `comments`: chronological markdown comments with archive/restore.
- `tags`: project-scoped tag catalog and many-to-many task tags.
- `tracks`: actor queues and exclusive task assignment.
- `instructions`: matcher-backed instruction records.
- `views`: saved matcher views.
- `feeds`: ready-work queue feeds backed by matcher queries.
- `activity`: append-only project activity stream.
- `migrations`: applied store migrations.
- Optional `matcher`: store-accelerated matcher hooks. SQLite currently uses
  the service-level in-memory matcher path.

`transaction(fn)` is part of the contract. Mutations rely on it for consistency
between domain writes and activity records.

### Tables And State

SQLite currently stores these tables:

- `projects`
  - `id`, `name`, `description`, timestamps, `archived_at`.
  - Every task-side table is scoped by `project_id`.
- `tasks`
  - `id`, parent, title, description, lifecycle, priority, size, source fields,
    completion bar, lifecycle timestamps, archive timestamp, `version`.
  - Parent references are project-local.
  - Lifecycle values are `open`, `started`, and `finished`.
- `task_dependencies`
  - Directed edge `task_id` -> `depends_on_task_id`.
  - Self-dependencies are rejected.
  - Edges cannot cross project scope.
- `tags`
  - Project-scoped tag identity, display name, color, description, sort order,
    archive timestamp.
- `task_tags`
  - Many-to-many relation between tasks and tags.
- `tracks`
  - Actor queue identity as `(project_id, machine, actor)`.
  - Display name and archive timestamp.
- `track_assignments`
  - Exclusive task assignment to a single track.
  - `position` preserves queue ordering.
- `instructions`
  - Project-scoped matcher query plus markdown body.
  - `enabled` and archive timestamp determine active use.
- `saved_views`
  - Named matcher queries.
- `queue_feeds`
  - Named matcher queries used as ready-work feeds.
- `comments`
  - Project/task scoped markdown body, author machine/actor, archive timestamp.
- `activity`
  - Append-only user-visible activity records with subject, JSON payload,
    machine, actor, and timestamp.
- `migrations`
  - Applied embedded migration records.

### Service Paths

`packages/core/src/services.ts` defines the behavior above the store. This is
the primary semantic layer that Postgres must match.

Task behavior:

- `add`, `addMany`, and import upsert create tasks with normalized IDs.
- Parent changes check parent existence, archived parents, parent cycles, and
  finished-parent constraints.
- `start`, `finish`, and `reopen` are lifecycle edits that set timestamps.
- `archive` and `restore` preserve history and enforce parent constraints.
- `delete` is a hard delete and is rejected while other tasks depend on the
  task.
- `list`, `get`, `explain`, and task context rendering are query-layer reads.

Dependency behavior:

- `add`, `addMany`, `remove`, and `set` maintain explicit hard dependencies.
- Dependency writes reject missing tasks, archived dependency targets, cycles,
  task-to-descendant edges, and task-to-ancestor edges.
- The effective graph includes explicit dependencies and implicit hierarchy:
  parents are blocked by unfinished descendants, and children unblock ancestors.

Tag behavior:

- Tags are project scoped and unique by ID and name.
- Task tag assignment accepts tag IDs or names.
- Archived tags cannot be assigned.
- Bulk assignment is used by import paths.

Track and queue behavior:

- Tracks represent actor queues, identified by machine and actor.
- A task can have at most one active track assignment.
- Assignment positions are stable strings ordered inside the track.
- Queue feeds are saved matcher queries filtered to ready tasks.
- Actor references accept actor or `machine:actor` forms.

Instruction behavior:

- Instructions are project-scoped records with a matcher query and markdown
  body.
- The matcher query is validated on create/update.
- Matching instructions are derived at read time for task context and explain
  output.
- Disabled or archived instructions are not active.

Comment behavior:

- Comments are flat chronological markdown records.
- Comments carry machine/actor provenance.
- Comments can be edited, archived, and restored.
- Matcher queries can filter by comment count, author, and recent activity.

Activity and audit-like behavior:

- Mutating service methods append activity records inside the same transaction
  as the domain write.
- Activity is project scoped except global project lifecycle records, which use
  `project_id = null`.
- Activity stores a typed event string, subject type/id, message, JSON data,
  actor, machine, and timestamp.
- This activity stream is user-visible provenance. Hosted enterprise audit can
  extend it, but local SQLite behavior must keep activity intact.

Import/export behavior:

- Markdown import creates or updates tasks, dependency edges, tags, track
  assignments, and instructions.
- JSON import/export covers project data and can include activity.
- Task tree import is an upsert path used for larger planning sessions.

### Matcher Contract

The matcher DSL is implemented in `packages/core/src/matcher-query.ts`.

Supported selectors include:

- Boolean composition: `and`, `or`, `not`, parentheses.
- Field predicates: `id`, `id prefix`, `tag`, `assigned`, `machine`, `actor`,
  `status`, `lifecycle`, `parent`, `priority`, `source doc`,
  `source section`.
- Time predicates: `created`, `updated`, `started`, `finished`, `archived`;
  `now`, `today`, relative times, and date equality.
- Graph predicates: `depends on`, `unblocks`, depth bounds, and reachable count
  comparisons.
- Hierarchy predicate: `descendant of`.
- Comment predicates: count, `commented by`, and `commented since`.

Matcher reads currently operate over `TaskView` objects plus dependency edges.
The semantic contract is the matcher result, not the implementation strategy.
Postgres may lower the matcher to SQL, but the result ordering, filtering, and
explain/context behavior must remain compatible.

### API And CLI Surfaces

The CLI in `packages/cli/src/index.ts` exposes the local contract:

- `project`: add/list/archive/restore.
- `task`: add/upsert/edit/list/show/explain/dependencies/import-tree/comments
  lifecycle/archive/restore/bulk operations/delete.
- `tag`: add/edit/archive/list/assign/remove through task commands.
- `track`: add/rename/archive/list/show/assign/unassign.
- `instruction`: add/edit/archive/restore/list/preview/task matches.
- `query`, `query-suggest`, and `context`.
- `view` and `feed`.
- `import` and `export`.
- `activity`.
- `db` and `config`.

The server in `packages/server/src/index.ts` exposes the same semantics over
HTTP for the web UI:

- health, config, migration status/migrate.
- project, task, dependency, comment, tag, track, instruction, view, feed,
  activity, import, export, matcher grammar, and matcher suggestion endpoints.
- project scope is explicit through request context.
- mutating endpoints require machine/actor provenance from configuration.

### Compatibility Requirements For New Backends

New storage modes must preserve:

- Project-scoped IDs and uniqueness.
- Task lifecycle timestamps and version increments.
- Parent hierarchy rollups and finished-parent constraints.
- Dependency cycle prevention and hierarchy/dependency deadlock prevention.
- Exclusive track assignment per task and stable queue positions.
- Matcher semantics across tasks, dependencies, hierarchy, tags, assignment,
  lifecycle, source fields, comments, and time.
- Instruction matching as a derived read from enabled instruction selectors.
- Activity append behavior for all existing mutating service paths.
- Import/export behavior, including bulk creation and assignment paths.
- CLI and server behavior for SQLite local users.

Hosted-only features may add tables and APIs, but they must not make the local
SQLite mode require Postgres, Prism, WorkOS, or external connector services.
