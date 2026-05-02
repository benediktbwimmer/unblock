# Not Jira Design

Not Jira is a dependency-first project management app for implementation work.

It is intentionally smaller than Jira, Linear, or GitHub Projects. The core
idea is that meaningful implementation work is a graph: tasks depend on other
tasks, tasks trace back to source documents, ready work should be obvious, and
actor queues should only receive work that can actually start.

The first product target is a local-first single-user app with a web UI, CLI,
SQLite storage, and import/export. The second target is a teams-ready app with
Postgres, collaboration, auth, and shared deployment.

## 1. Product Thesis

Most project management tools are optimized around boards, tickets, status, and
meetings. Not Jira is optimized around dependency-aware execution:

```txt
source document
  -> implementation tasks
  -> dependency graph
  -> ready queue
  -> actor queues
  -> completion evidence
```

The app should answer these questions quickly:

- What can be started right now?
- Why is this task blocked?
- Which document and section does this task implement?
- Which implementation areas still have open work?
- What is assigned to each actor?
- Which high-priority tasks are blocked, and by what?
- What changed recently?

## 2. Design Principles

- Local-first V1. The app must be useful as a private tool on one machine.
- Dependency-first. Blocked status is computed from dependencies, not manually
  assigned.
- Source-attributed. Every implementation task can point back to a document,
  section, line, and original source text.
- Hierarchical without hiding readiness. Parent tasks organize work and compute
  subtree progress, but only dependencies control whether a task is ready or
  blocked.
- UI and CLI parity. Anything possible in the web UI must be possible from the
  CLI.
- Storage isolation. App services use repository interfaces. SQLite is the only
  V1 store, but SQLite details must not leak into UI, CLI, or domain logic.
  The store boundary must be strong enough that Postgres can be added later by
  implementing the same repository and transaction contracts.
- Human-readable export. Data must be exportable to JSON and Markdown.
- Explicit history. Important state changes produce activity records.
- Small workflow. The lifecycle is deliberately simple: `open`, `started`,
  `finished`. `blocked` and `ready` are computed views.

## 3. V1 Scope: Local-First

V1 is a single-user local app.

V1 includes:

- web UI
- CLI
- SQLite storage
- migrations
- task CRUD
- dependency graph with cycle prevention
- computed `blocked` and `ready` state
- actor queues
- tags
- priority
- size
- source document attribution
- search, filtering, grouping, and sorting
- activity log
- import/export

V1 does not include:

- auth
- remote sync
- multi-user conflict resolution
- notifications
- comments with threaded discussions
- sprint planning
- permissions
- external issue tracker integrations

## 4. V2 Scope: Teams-Ready

V2 turns the same product model into a shared team app.

V2 adds:

- Postgres storage implementation
- hosted server mode
- users and teams
- auth
- optimistic concurrency across clients
- realtime updates
- shared saved views
- audit-grade activity history
- API tokens
- optional GitHub/GitLab import/export
- optional deployment artifacts

V2 must not rewrite the app model. The V1 storage abstraction, domain services,
and migrations should make Postgres and team collaboration additive.

## 5. Core Concepts

### 5.1 Task

A task is one unit of implementation work.

Fields:

```txt
id: string
parentTaskId: string | null
title: string
description: string
lifecycle: open | started | finished
priority: 0 | 1 | 2 | 3 | 4
size: XS | S | M | L | XL | null
sourceDoc: string | null
sourceSection: string | null
sourceAnchor: string | null
sourceLine: number | null
sourceText: string | null
completionBar: string | null
createdAt: timestamp
updatedAt: timestamp
startedAt: timestamp | null
finishedAt: timestamp | null
archivedAt: timestamp | null
version: integer
```

Lifecycle meanings:

```txt
open
  task exists and has not started

started
  work has started

finished
  implementation is complete
```

Computed status:

```txt
blocked
  lifecycle != finished
  and at least one dependency is not finished

ready
  lifecycle == open
  and no dependency is unfinished
```

Priority:

```txt
0 = someday
1 = low
2 = normal
3 = high
4 = urgent
```

Default priority is `2`.

Size is separate from priority. A task can be urgent and large.

### 5.1.1 Task Nesting

Tasks may be nested under a parent task.

```txt
parentTaskId
  null for root tasks
  task id for child tasks
```

Nesting is a containment tree, not a dependency graph:

```txt
parent task
  child task
    grandchild task
```

Rules:

- A task cannot be its own parent.
- Parent links cannot create cycles.
- A parent task and its children may each have their own lifecycle.
- Parent-child containment does not make a child ready or blocked.
- Parent-child containment does not make a parent ready or blocked.
- Readiness is still computed only from unfinished dependencies.
- Parent tasks expose computed subtree rollups for progress and navigation.

Subtree progress is computed from leaf descendants:

```txt
leaf descendant
  a descendant with no children

subtreeProgress
  100 if every descendant leaf is finished
  0 if no descendant leaf is finished
  finished descendant leaves / total descendant leaves otherwise
```

If a task has no descendants, its own progress is:

```txt
finished = 100
started/open/blocked = 0
```

V1 should not automatically finish a parent just because all children are
finished. Instead, it should show the parent as finishable with
`subtreeProgress = 100`. A stricter policy can be added later without changing
the data model.

### 5.2 Dependency

A dependency says one task cannot start until another task is finished.

```txt
taskId depends on dependsOnTaskId
```

Rules:

- A task cannot depend on itself.
- Dependencies cannot create cycles.
- Finished tasks may still be dependencies.
- Deleting or archiving a task with dependents requires explicit confirmation.
- Blocked status is always computed from unfinished dependencies.

### 5.3 Tag

Tags are curated implementation groupings.

Fields:

```txt
id: string
name: string
color: string | null
description: string | null
sortOrder: integer
createdAt: timestamp
updatedAt: timestamp
archivedAt: timestamp | null
```

Examples:

```txt
authoring-language
compiler
runtime
materializer
sqlite
postgres
ui
cli
docs
security
```

Tags are not actor queues. Tags group work by area, source, or concern.

### 5.4 Actor Queue

An actor queue is a queue of tasks for one implementation actor.

Fields:

```txt
id: string
actor: string
name: string | null
createdAt: timestamp
updatedAt: timestamp
archivedAt: timestamp | null
```

Assignments:

```txt
trackId: string
taskId: string
position: string
assignedAt: timestamp
```

Rules:

- A task can be assigned only if it is not blocked.
- Assigning a task does not automatically mark it `started` unless the user
  explicitly enables that option.
- A task may be assigned to at most one actor queue in V1.
- Queue ordering is manual and stable.

### 5.5 Activity

Important changes produce activity records.

Examples:

```txt
task.created
task.updated
task.started
task.finished
task.reopened
task.archived
dependency.added
dependency.removed
tag.created
tag.assigned
tag.removed
track.created
track.assigned
track.unassigned
priority.changed
source.changed
import.completed
export.completed
```

Fields:

```txt
id: string
type: string
subjectType: task | tag | track | import | export | system
subjectId: string | null
message: string
data: JSON
createdAt: timestamp
actor: string | null
```

In V1, `actor` is a local string. In V2, it maps to a user.

## 6. Storage Architecture

The app must keep storage behind interfaces.

```txt
UI / CLI
  -> application services
  -> store-backed unit of work
  -> repository interfaces
  -> SQLite implementation in V1
  -> Postgres implementation in V2
```

V1 repository interfaces:

```txt
TaskRepository
DependencyRepository
TagRepository
TrackRepository
ActivityRepository
MigrationRepository
ImportExportRepository
```

The application layer receives an `AppStore` abstraction with a transaction
method and typed repositories. It must not import concrete SQLite modules, SQL
strings, connection handles, or dialect-specific row shapes.

```txt
AppStore
  taskRepository
  dependencyRepository
  tagRepository
  trackRepository
  activityRepository
  migrationRepository
  transaction(fn)
```

Application services own domain rules:

```txt
TaskService
DependencyService
TagService
TrackService
QueryService
ImportService
ExportService
```

Repositories perform persistence only. They do not decide whether a task is
assignable, whether a dependency creates a cycle, or whether a lifecycle change
is valid.

SQLite is the only V1 implementation. Postgres is a V2 repository
implementation behind the same service contracts.

## 7. SQLite Schema

Initial tables:

```sql
tasks (
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
)

task_dependencies (
  task_id text not null references tasks(id) on delete cascade,
  depends_on_task_id text not null references tasks(id) on delete restrict,
  created_at text not null,
  primary key (task_id, depends_on_task_id),
  check (task_id != depends_on_task_id)
)

tags (
  id text primary key,
  name text not null unique,
  color text null,
  description text null,
  sort_order integer not null default 0,
  created_at text not null,
  updated_at text not null,
  archived_at text null
)

task_tags (
  task_id text not null references tasks(id) on delete cascade,
  tag_id text not null references tags(id) on delete cascade,
  created_at text not null,
  primary key (task_id, tag_id)
)

tracks (
  id text primary key,
  actor text not null unique,
  name text null,
  created_at text not null,
  updated_at text not null,
  archived_at text null
)

track_assignments (
  track_id text not null references tracks(id) on delete cascade,
  task_id text not null references tasks(id) on delete cascade,
  position text not null,
  assigned_at text not null,
  primary key (track_id, task_id),
  unique (task_id)
)

activity (
  id text primary key,
  type text not null,
  subject_type text not null,
  subject_id text null,
  message text not null,
  data_json text not null,
  actor text null,
  created_at text not null
)

migrations (
  id text primary key,
  name text not null,
  applied_at text not null
)
```

Indexes:

```sql
create index idx_tasks_lifecycle on tasks(lifecycle);
create index idx_tasks_parent on tasks(parent_task_id);
create index idx_tasks_priority on tasks(priority);
create index idx_tasks_source on tasks(source_doc, source_section);
create index idx_tasks_archived on tasks(archived_at);
create index idx_task_dependencies_task on task_dependencies(task_id);
create index idx_task_dependencies_depends on task_dependencies(depends_on_task_id);
create index idx_task_tags_tag on task_tags(tag_id);
create index idx_track_assignments_track on track_assignments(track_id, position);
create index idx_activity_subject on activity(subject_type, subject_id);
create index idx_activity_created on activity(created_at);
```

Search in V1 can use simple `LIKE` queries across `id`, `title`,
`description`, `source_doc`, `source_section`, and `source_text`. SQLite FTS can
be added later without changing the service API.

## 8. Derived Query Model

The app computes view fields from base tables:

```txt
blocked
ready
unfinishedDependenciesCount
finishedDependenciesCount
dependencyDepth
dependentsCount
transitiveDependentsCount
parent
childrenCount
descendantsCount
leafDescendantsCount
finishedLeafDescendantsCount
subtreeProgress
subtreeOpenCount
subtreeReadyCount
subtreeBlockedCount
subtreeStartedCount
subtreeFinishedCount
assignedTrack
tags
```

Dependency depth:

```txt
depth(task) = 0 if task has no dependencies
depth(task) = 1 + max(depth(dep) for each dependency)
```

Transitive dependents count:

```txt
unblocks(task) = count of unfinished downstream tasks that directly or
transitively depend on this task
```

Cycles are impossible if dependency writes go through `DependencyService`, but
depth computation should still have cycle guards to protect against corrupted
imports or manual DB edits.

Default task list ordering is dependency-first. The ready queue should surface
the ready task whose completion unlocks the most downstream work, then break
ties by priority and stable graph position:

```txt
archived hidden
finished hidden unless requested
ready before blocked
transitiveDependentsCount desc
priority desc
dependencyDepth asc
createdAt asc
id asc
```

The UI and CLI should show the downstream unblock count wherever ready tasks
are ranked, for example `unblocks: 15 tasks`. A ready task with no dependents
is still valid work, but it should not outrank a ready task on the critical
path unless explicit sorting overrides the dependency-first default.

Hierarchy ordering:

```txt
root tasks retain dependency-first ordering
children are displayed under parents
siblings retain dependency-first ordering
collapsed parents still show subtree progress and subtree status counts
```

## 9. Web UI

The UI has three primary views:

```txt
Tasks
Actor Queues
Tags
```

The main screen uses two panels:

```txt
left: task list
right: actor queues
```

### 9.1 Task List

Task list requirements:

- search box
- show/hide finished toggle
- show/hide archived toggle
- filters for lifecycle, computed status, priority, size, source doc, source
  section, tag, assigned actor
- sort dropdown
- clear visual distinction for ready, blocked, started, and finished tasks
- high-priority ready tasks visually prominent
- blocked tasks show unfinished dependency count
- selected task shows details and dependency explanation

Each task row should show:

```txt
id
title
parent/indentation
lifecycle/computed status
priority
size
tags
source doc/section
dependency count
subtree progress when descendants exist
assigned actor if any
```

### 9.2 Task Editing

Task edit form:

- title
- parent task
- description
- lifecycle
- priority
- size
- tags
- source doc
- source section
- source anchor
- source line
- source text
- completion bar

Delete should be archive by default. Hard delete should require confirmation.

### 9.3 Dependency Editing

Dependency editing is an interactive mode.

Flow:

1. User clicks `Edit dependencies` on a task.
2. The edited task is pinned and highlighted.
3. Current dependency tasks are highlighted.
4. Tasks that cannot be selected are disabled with a reason:
   - self-dependency
   - would create cycle
   - archived task
5. Clicking a task toggles it as a dependency.
6. The side panel shows:
   - selected dependencies
   - dependencies that block the task
   - resulting computed status
7. Save applies changes and writes activity records.

This mode should be optimized for fast graph editing without opening a modal
for every dependency.

### 9.4 Actor Queues

Actor queues panel:

- add actor queue
- rename actor queue
- archive actor queue
- show queued tasks in manual order
- assign ready task to queue
- unassign task
- reorder tasks inside queue
- mark assigned task started
- mark assigned task finished

Assignment rules:

- blocked tasks cannot be assigned
- finished tasks cannot be assigned
- archived tasks cannot be assigned
- already assigned tasks cannot be assigned to another V1 queue

Smooth assignment interactions:

- `Assign` button on each ready task
- drag ready task from task list to actor queue
- command palette action: `Assign task to actor`
- bulk assign selected ready tasks to one actor queue

Invalid drag/drop should show a clear reason.

### 9.5 Tag View

Tag view groups tasks by tag.

Requirements:

- list tags with task counts
- show open/ready/blocked/started/finished counts per tag
- create/edit/archive tags
- assign tags by task edit and bulk edit
- click a tag to show task list filtered by that tag
- optionally show untagged tasks

This gives the third view:

```txt
source implementation graph
actor execution queues
tag-based work areas
```

### 9.6 Source Coverage View

Source coverage groups tasks by `sourceDoc` and `sourceSection`.

Requirements:

- show counts by source doc
- show counts by source section
- show open/ready/blocked/started/finished counts
- filter to tasks from one doc/section
- show tasks missing source attribution

This makes source documents the implementation driver.

### 9.7 Activity View

Activity view shows recent changes.

Filters:

- task
- tag
- track
- activity type
- actor
- date range

V1 can keep this simple, but activity should exist from the beginning because
it becomes audit history in V2.

## 10. CLI

The CLI must expose everything the UI can do.

Binary name:

```sh
not-jira
```

Configuration:

```sh
not-jira --db ./not-jira.sqlite ...
NOT_JIRA_DB=./not-jira.sqlite
```

Task commands:

```sh
not-jira task add --id AUTH-001 --title "Add AST capture"
not-jira task edit AUTH-001 --title "Add TypeScript AST capture"
not-jira task delete AUTH-001
not-jira task archive AUTH-001
not-jira task start AUTH-001
not-jira task finish AUTH-001
not-jira task reopen AUTH-001
not-jira task show AUTH-001
not-jira task explain AUTH-001
not-jira task list
not-jira task list --status ready --sort depth
not-jira task list --tag compiler --priority-min 3
not-jira task list --source docs/prism-authoring-language.md
```

Dependency commands:

```sh
not-jira deps set AUTH-003 AUTH-001 AUTH-002
not-jira deps add AUTH-003 AUTH-001
not-jira deps remove AUTH-003 AUTH-001
not-jira deps list AUTH-003
not-jira deps graph AUTH-003
```

Tag commands:

```sh
not-jira tag add compiler --color '#3b82f6'
not-jira tag edit compiler --description "Compiler work"
not-jira tag archive compiler
not-jira tag assign AUTH-001 compiler runtime
not-jira tag remove AUTH-001 runtime
not-jira tag list
not-jira tag tasks compiler
```

Track commands:

```sh
not-jira track add codex-a
not-jira track rename codex-a "Codex A"
not-jira track archive codex-a
not-jira track assign codex-a AUTH-001
not-jira track unassign codex-a AUTH-001
not-jira track move codex-a AUTH-001 --before AUTH-003
not-jira track list
not-jira track show codex-a
```

Import/export commands:

```sh
not-jira import markdown ~/code/prism-coordination.md
not-jira import json ./tasks.json
not-jira export json ./tasks.json
not-jira export markdown ./tasks.md
```

Maintenance commands:

```sh
not-jira db init
not-jira db migrate
not-jira db status
not-jira doctor
```

Output formats:

```sh
--format table
--format json
--format markdown
```

Every command that mutates state should write activity records.

## 11. Import And Export

### 11.1 Markdown Import

V1 should import the current Markdown tracker shape:

```markdown
## `docs/prism-v1.md` - Prism Engine v1

| Done | Feature | Assignee | Completion bar |
| --- | --- | --- | --- |
| [ ] | Finish TypeScript predicate AST capture... | none | Captured values... |
```

Import behavior:

- section heading becomes `sourceSection`
- doc path inside backticks becomes `sourceDoc`
- feature becomes task title/source text
- completion bar becomes `completionBar`
- checked rows become `finished`
- unchecked rows become `open`
- assignee becomes actor queue assignment when not `none`
- generated task ids use section prefix and sequence
- repeated imports should be idempotent where possible

Generated IDs:

```txt
V1-001
RUNTIME-001
PROGRAMMING-001
COORDINATION-001
ORCH-001
DATA-001
EXEC-001
SEC-001
WINDOW-001
FUTURE-001
```

The importer should allow dry-run:

```sh
not-jira import markdown ~/code/prism-coordination.md --dry-run
```

### 11.2 JSON Export

JSON export must preserve all fields needed to recreate the database:

```txt
tasks
dependencies
tags
taskTags
tracks
assignments
activity optional
```

### 11.3 Markdown Export

Markdown export should produce a human-readable tracker, not necessarily the
exact imported format.

## 12. API Shape

Even in V1, the frontend and CLI should call the same app service layer.

HTTP API endpoints:

```txt
GET    /api/tasks
POST   /api/tasks
GET    /api/tasks/:id
PATCH  /api/tasks/:id
DELETE /api/tasks/:id
POST   /api/tasks/:id/archive
POST   /api/tasks/:id/start
POST   /api/tasks/:id/finish
POST   /api/tasks/:id/reopen
GET    /api/tasks/:id/explain

PUT    /api/tasks/:id/dependencies
POST   /api/tasks/:id/dependencies/:dependencyId
DELETE /api/tasks/:id/dependencies/:dependencyId

GET    /api/tags
POST   /api/tags
PATCH  /api/tags/:id
POST   /api/tags/:id/archive
POST   /api/tasks/:id/tags/:tagId
DELETE /api/tasks/:id/tags/:tagId

GET    /api/tracks
POST   /api/tracks
PATCH  /api/tracks/:id
POST   /api/tracks/:id/archive
POST   /api/tracks/:id/assignments
DELETE /api/tracks/:id/assignments/:taskId
PATCH  /api/tracks/:id/assignments/:taskId

GET    /api/activity
POST   /api/import/markdown
POST   /api/export/json
POST   /api/export/markdown
GET    /api/source-coverage
GET    /api/ready
```

The CLI can either call services directly in-process or call the HTTP API when
the server is running. V1 should support direct local DB access for speed and
simplicity.

## 13. Validation Rules

Task validation:

- `id` is required and stable.
- `title` is required.
- `lifecycle` must be `open`, `started`, or `finished`.
- `priority` must be 0 through 4.
- `size` must be null or one of `XS`, `S`, `M`, `L`, `XL`.
- `finishedAt` is set when lifecycle becomes `finished`.
- `startedAt` is set when lifecycle first becomes `started`.
- reopening clears `finishedAt` but does not clear historical activity.

Dependency validation:

- no self dependency
- no cycles
- dependency task must exist
- archived dependencies require explicit override or are rejected in V1
- warn when a task depends on its descendant; reject by default unless an
  explicit override is added later

Assignment validation:

- task must exist
- track must exist
- task must not be archived
- task must not be finished
- task must not be blocked
- task must not already be assigned to another track in V1

Tag validation:

- tag names are unique
- archived tags cannot be assigned

Import validation:

- malformed rows are reported with line numbers
- duplicate generated IDs are resolved deterministically or rejected
- cycles in imported dependencies are rejected
- parent cycles in imported hierarchy are rejected

## 14. Explain Output

Task explain should return:

```txt
task id/title
lifecycle
computed status
priority
size
source doc/section
assigned actor
tags
dependency depth
parent task
subtree progress
unfinished dependencies
finished dependencies
dependents
why assignable or not
recent activity
```

Example:

```txt
AUTH-003 Add behavior callback AST capture

Status: blocked
Lifecycle: open
Priority: high
Depth: 2
Source: docs/prism-authoring-language.md#31-implementation-order

Blocked by:
- AUTH-001 Add fluent declaration registry [open]
- AUTH-002 Generate object type surfaces [started]

Assignable: no
Reason: 2 dependencies are unfinished.
```

## 15. V1 Implementation Plan

1. Create TypeScript monorepo structure.
2. Add shared domain types and Zod schemas.
3. Add repository interfaces.
4. Add SQLite repository implementation.
5. Add migration runner.
6. Add task CRUD service.
7. Add dependency service with cycle detection.
8. Add computed task query service.
9. Add tags.
10. Add actor queues and assignments.
11. Add activity records.
12. Add CLI for task/dependency/tag/track CRUD.
13. Add web API.
14. Add React UI shell.
15. Build task list with filters/sorting/search.
16. Build task editor.
17. Build dependency editing mode.
18. Build actor queue panel.
19. Build tag view.
20. Build source coverage view.
21. Add Markdown import.
22. Add JSON/Markdown export.
23. Add tests for services and repositories.
24. Add Playwright or equivalent UI smoke tests.
25. Add README and setup instructions.

## 16. V2 Team-Ready Design

V2 keeps the V1 domain model and adds team deployment.

### 16.1 Postgres Store

Postgres implementation requirements:

- repository interface parity with SQLite
- migrations
- transactional writes
- row-level optimistic concurrency through `version`
- indexes for task search/filtering
- efficient recursive dependency queries
- activity append in same transaction as mutations

The app service layer should not care which store is active.

### 16.2 Users And Auth

V2 user model:

```txt
User
  id
  email
  name
  createdAt
  disabledAt

Team
  id
  name

TeamMember
  teamId
  userId
  role: owner | admin | member | viewer
```

Actor queues may map to users, bots, or custom actor labels.

### 16.3 Realtime

Realtime is an update channel, not correctness.

Requirements:

- clients subscribe to task/tag/track/activity changes
- reconnect reloads authoritative state from HTTP API
- missed realtime events do not corrupt client state

### 16.4 Collaboration

V2 conflict rules:

- writes include expected `version`
- conflicting edits return current server state and conflict metadata
- activity records preserve who changed what
- bulk operations are transactional where practical

### 16.5 Shared Views

Saved views:

```txt
id
name
ownerUserId
scope: private | team
filtersJson
sortJson
groupBy
createdAt
updatedAt
```

Examples:

- high-priority ready work
- blocked by compiler tasks
- all open tasks for docs/prism-authoring-language.md
- actor queue overview

### 16.6 API Tokens

API tokens allow agents and CI systems to query and mutate tasks.

Tokens should be scoped:

```txt
read
write
assign
admin
```

V2 should preserve CLI parity through either local config or remote API mode.

## 17. Non-Goals

V1 non-goals:

- replace GitHub Issues
- replace Slack
- implement full Scrum/Jira workflows
- implement permissions
- implement hosted SaaS

V2 non-goals:

- arbitrary workflow engines
- enterprise permission matrix
- built-in chat
- time tracking
- billing

## 18. Product Name

Working name: `not-jira`.

The name should remain a working name until the product shape settles. If shared
with the community, consider a name that emphasizes dependency-aware execution
rather than being framed only as an anti-Jira.
