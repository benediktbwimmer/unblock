# Hosted Unblock Architecture

This document tracks the architecture pivot for hosted Unblock. The target is a
Postgres-native core for hosted and low-friction self-hosted deployments, while
preserving SQLite as the local single-machine option. Prism Flows is used for
durable connector orchestration only; it is not the primary Unblock data store.

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
