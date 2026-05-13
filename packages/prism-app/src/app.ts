import {
  prism,
  z,
} from "../../../../prism-new2/packages/prism-authoring/mod.ts";

export const Unblock = prism.app("unblock", {
  version: "0.3.0",
});

const Timestamp = z.string().datetime();
const Lifecycle = z.enum(["open", "started", "finished"], "Lifecycle");
const ComputedStatus = z.enum([
  "ready",
  "blocked",
  "started",
  "finished",
  "archived",
], "ComputedStatus");
const RollupStatus = z.enum([
  "leaf",
  "complete",
  "blocked_by_children",
], "RollupStatus");
const TaskSize = z.enum(["XS", "S", "M", "L", "XL"], "TaskSize");
const Priority = z.number().int32();
const SelectorKind = z.enum(["instruction", "view", "feed"], "SelectorKind");
const ExternalProvider = z.enum([
  "github",
  "jira",
  "linear",
  "asana",
  "trello",
  "manual",
], "ExternalProvider");
const ActivitySubject = z.enum([
  "project",
  "task",
  "comment",
  "tag",
  "track",
  "instruction",
  "view",
  "feed",
  "external_issue",
  "import",
  "export",
  "system",
], "ActivitySubject");

export const Project = Unblock.object("Project")
  .key("id")
  .routeBy("id")
  .schema(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
    archived_at: Timestamp.nullable(),
  }))
  .index("projects_by_archive", ["archived_at", "id"]);

export const Task = Unblock.object("Task")
  .key("id")
  .routeBy("project_id")
  .schema(z.object({
    id: z.string(),
    project_id: z.string(),
    title: z.string(),
    description: z.string(),
    lifecycle: Lifecycle,
    priority: Priority,
    size: TaskSize.nullable(),
    source_doc: z.string().nullable(),
    source_section: z.string().nullable(),
    source_anchor: z.string().nullable(),
    source_line: z.number().int32().nullable(),
    source_text: z.string().nullable(),
    completion_bar: z.string().nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
    started_at: Timestamp.nullable(),
    finished_at: Timestamp.nullable(),
    archived_at: Timestamp.nullable(),
    version: z.number().int64(),
  }))
  .index("tasks_by_project", ["project_id", "id"], { unique: true })
  .index("tasks_by_project_lifecycle", ["project_id", "lifecycle", "archived_at"])
  .index("tasks_by_project_source", ["project_id", "source_doc", "source_section"]);

export const Track = Unblock.object("Track")
  .key("id")
  .routeBy("project_id")
  .schema(z.object({
    id: z.string(),
    project_id: z.string(),
    machine: z.string(),
    actor: z.string(),
    name: z.string().nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
    archived_at: Timestamp.nullable(),
  }))
  .index("tracks_by_actor", ["project_id", "machine", "actor"], { unique: true });

export const Comment = Unblock.object("Comment")
  .key("id")
  .routeBy("project_id")
  .schema(z.object({
    id: z.string(),
    project_id: z.string(),
    task_id: z.string(),
    machine: z.string(),
    actor: z.string(),
    body: z.string(),
    created_at: Timestamp,
    updated_at: Timestamp,
    archived_at: Timestamp.nullable(),
  }))
  .index("comments_by_task", ["project_id", "task_id", "created_at"])
  .index("comments_by_actor", ["project_id", "machine", "actor", "created_at"]);

export const Instruction = Unblock.object("Instruction")
  .key("id")
  .routeBy("project_id")
  .schema(z.object({
    id: z.string(),
    project_id: z.string(),
    name: z.string(),
    selector_text: z.string(),
    selector_hash: z.string(),
    selector_fragment_id: z.string().nullable(),
    selector_fragment_hash: z.string().nullable(),
    body: z.string(),
    enabled: z.boolean(),
    created_at: Timestamp,
    updated_at: Timestamp,
    archived_at: Timestamp.nullable(),
  }))
  .index("instructions_by_name", ["project_id", "name"], { unique: true })
  .index("instructions_by_selector", ["project_id", "selector_hash"]);

export const SavedSelector = Unblock.object("SavedSelector")
  .key("id")
  .routeBy("project_id")
  .schema(z.object({
    id: z.string(),
    project_id: z.string(),
    kind: SelectorKind,
    name: z.string(),
    selector_text: z.string(),
    selector_hash: z.string(),
    selector_fragment_id: z.string().nullable(),
    selector_fragment_hash: z.string().nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
    archived_at: Timestamp.nullable(),
  }))
  .index("saved_selectors_by_kind_name", ["project_id", "kind", "name"], {
    unique: true,
  })
  .index("saved_selectors_by_fragment", ["project_id", "selector_fragment_hash"]);

export const ExternalIssue = Unblock.object("ExternalIssue")
  .key("id")
  .routeBy("project_id")
  .schema(z.object({
    id: z.string(),
    project_id: z.string(),
    provider: ExternalProvider,
    external_id: z.string(),
    external_key: z.string().nullable(),
    url: z.string().nullable(),
    title: z.string(),
    state: z.string(),
    payload: z.json(),
    synced_at: Timestamp,
    archived_at: Timestamp.nullable(),
  }))
  .index("external_issues_by_provider", [
    "project_id",
    "provider",
    "external_id",
  ], { unique: true });

export const ActivityEvent = Unblock.object("ActivityEvent")
  .key("id")
  .routeBy((event: any) => event.project_id ?? "global")
  .schema(z.object({
    id: z.string(),
    project_id: z.string().nullable(),
    type: z.string(),
    subject: ActivitySubject,
    subject_id: z.string().nullable(),
    message: z.string(),
    data: z.json(),
    machine: z.string(),
    actor: z.string(),
    created_at: Timestamp,
  }))
  .index("activity_by_project_time", ["project_id", "created_at"])
  .index("activity_by_subject", ["project_id", "subject", "subject_id", "created_at"]);

export const TaskDependsOnTask = Unblock.relation("TaskDependsOnTask")
  .from(Task)
  .to(Task)
  .cardinality("many-to-many")
  .storedOnFrom()
  .schema(z.object({
    project_id: z.string(),
    created_at: Timestamp,
  }));

export const TaskContainsTask = Unblock.relation("TaskContainsTask")
  .from(Task)
  .to(Task)
  .cardinality("one-to-many")
  .storedOnFrom()
  .schema(z.object({
    project_id: z.string(),
    sort_key: z.string().nullable(),
    created_at: Timestamp,
  }));

export const TaskAssignedToTrack = Unblock.relation("TaskAssignedToTrack")
  .from(Task)
  .to(Track)
  .cardinality("many-to-one")
  .storedOnFrom()
  .schema(z.object({
    project_id: z.string(),
    position: z.string(),
    assigned_at: Timestamp,
  }));

export const TaskMirrorsExternalIssue = Unblock.relation("TaskMirrorsExternalIssue")
  .from(Task)
  .to(ExternalIssue)
  .cardinality("many-to-one")
  .storedOnFrom()
  .schema(z.object({
    project_id: z.string(),
    sync_policy: z.string(),
    created_at: Timestamp,
  }));

export const ProjectLabelDefinition = Project.tag("project.label_definition", z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  description: z.string().nullable(),
  sort_order: z.number().int32(),
  created_at: Timestamp,
  updated_at: Timestamp,
  archived_at: Timestamp.nullable(),
})).cardinality({ multi: { value_key: ["id"] } });

export const TaskLabel = Task.tag("task.label", z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  description: z.string().nullable(),
  sort_order: z.number().int32(),
  assigned_at: Timestamp,
})).cardinality({ multi: { value_key: ["id"] } });

export const TaskReady = Task.tag("task.ready").derived();
export const TaskBlocked = Task.tag("task.blocked").derived();
export const TaskStarted = Task.tag("task.started").derived();
export const TaskFinished = Task.tag("task.finished").derived();
export const TaskArchived = Task.tag("task.archived").derived();
export const TaskBlockedByChildren = Task.tag("task.blocked_by_children").derived();

export const projectRows = Unblock.surface.view("projectRows")
  .from(Project)
  .returns(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
    archived_at: Timestamp.nullable(),
  }))
  .select((project: any) => ({
    id: project.id,
    name: project.name,
    description: project.description,
    created_at: project.created_at,
    updated_at: project.updated_at,
    archived_at: project.archived_at,
  }))
  .materialized("daemon");

export const taskRows = Unblock.surface.view("taskRows")
  .from(Task)
  .returns(z.object({
    id: z.string(),
    project_id: z.string(),
    title: z.string(),
    description: z.string(),
    lifecycle: Lifecycle,
    priority: Priority,
    size: TaskSize.nullable(),
    source_doc: z.string().nullable(),
    source_section: z.string().nullable(),
    source_anchor: z.string().nullable(),
    source_line: z.number().int32().nullable(),
    source_text: z.string().nullable(),
    completion_bar: z.string().nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
    started_at: Timestamp.nullable(),
    finished_at: Timestamp.nullable(),
    archived_at: Timestamp.nullable(),
    version: z.number().int64(),
  }))
  .select((task: any) => ({
    id: task.id,
    project_id: task.project_id,
    title: task.title,
    description: task.description,
    lifecycle: task.lifecycle,
    priority: task.priority,
    size: task.size,
    source_doc: task.source_doc,
    source_section: task.source_section,
    source_anchor: task.source_anchor,
    source_line: task.source_line,
    source_text: task.source_text,
    completion_bar: task.completion_bar,
    created_at: task.created_at,
    updated_at: task.updated_at,
    started_at: task.started_at,
    finished_at: task.finished_at,
    archived_at: task.archived_at,
    version: task.version,
  }))
  .materialized("daemon");

export const taskLabelRows = Unblock.surface.view("taskLabelRows")
  .from(TaskLabel)
  .where((label: any) => label.object_kind === "Task")
  .returns(z.object({
    project_id: z.string(),
    task_id: z.string(),
    label_id: z.string(),
    name: z.string(),
    color: z.string().nullable(),
    description: z.string().nullable(),
    sort_order: z.number().int32(),
    assigned_at: Timestamp,
  }))
  .select((label: any) => ({
    project_id: label.value.project_id,
    task_id: label.subject_id,
    label_id: label.value.id,
    name: label.value.name,
    color: label.value.color,
    description: label.value.description,
    sort_order: label.value.sort_order,
    assigned_at: label.value.assigned_at,
  }))
  .materialized("daemon");

export const commentRows = Unblock.surface.view("commentRows")
  .from(Comment)
  .returns(z.object({
    id: z.string(),
    project_id: z.string(),
    task_id: z.string(),
    machine: z.string(),
    actor: z.string(),
    body: z.string(),
    created_at: Timestamp,
    updated_at: Timestamp,
    archived_at: Timestamp.nullable(),
  }))
  .select((comment: any) => ({
    id: comment.id,
    project_id: comment.project_id,
    task_id: comment.task_id,
    machine: comment.machine,
    actor: comment.actor,
    body: comment.body,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    archived_at: comment.archived_at,
  }))
  .materialized("daemon");

export const trackRows = Unblock.surface.view("trackRows")
  .from(Track)
  .returns(z.object({
    id: z.string(),
    project_id: z.string(),
    machine: z.string(),
    actor: z.string(),
    name: z.string().nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
    archived_at: Timestamp.nullable(),
  }))
  .select((track: any) => ({
    id: track.id,
    project_id: track.project_id,
    machine: track.machine,
    actor: track.actor,
    name: track.name,
    created_at: track.created_at,
    updated_at: track.updated_at,
    archived_at: track.archived_at,
  }))
  .materialized("daemon");

export const instructionRows = Unblock.surface.view("instructionRows")
  .from(Instruction)
  .returns(z.object({
    id: z.string(),
    project_id: z.string(),
    name: z.string(),
    selector_text: z.string(),
    body: z.string(),
    enabled: z.boolean(),
    created_at: Timestamp,
    updated_at: Timestamp,
    archived_at: Timestamp.nullable(),
  }))
  .select((instruction: any) => ({
    id: instruction.id,
    project_id: instruction.project_id,
    name: instruction.name,
    selector_text: instruction.selector_text,
    body: instruction.body,
    enabled: instruction.enabled,
    created_at: instruction.created_at,
    updated_at: instruction.updated_at,
    archived_at: instruction.archived_at,
  }))
  .materialized("daemon");

export const savedSelectorRows = Unblock.surface.view("savedSelectorRows")
  .from(SavedSelector)
  .returns(z.object({
    id: z.string(),
    project_id: z.string(),
    kind: SelectorKind,
    name: z.string(),
    selector_text: z.string(),
    created_at: Timestamp,
    updated_at: Timestamp,
    archived_at: Timestamp.nullable(),
  }))
  .select((selector: any) => ({
    id: selector.id,
    project_id: selector.project_id,
    kind: selector.kind,
    name: selector.name,
    selector_text: selector.selector_text,
    created_at: selector.created_at,
    updated_at: selector.updated_at,
    archived_at: selector.archived_at,
  }))
  .materialized("daemon");

export const activityRows = Unblock.surface.view("activityRows")
  .from(ActivityEvent)
  .returns(z.object({
    id: z.string(),
    project_id: z.string().nullable(),
    type: z.string(),
    subject: ActivitySubject,
    subject_id: z.string().nullable(),
    message: z.string(),
    data: z.json(),
    machine: z.string(),
    actor: z.string(),
    created_at: Timestamp,
  }))
  .select((event: any) => ({
    id: event.id,
    project_id: event.project_id,
    type: event.type,
    subject: event.subject,
    subject_id: event.subject_id,
    message: event.message,
    data: event.data,
    machine: event.machine,
    actor: event.actor,
    created_at: event.created_at,
  }))
  .materialized("daemon");

export const taskDependencyRows = Unblock.surface.view("taskDependencyRows")
  .from(TaskDependsOnTask)
  .returns(z.object({
    project_id: z.string(),
    task_id: z.string(),
    depends_on_task_id: z.string(),
    created_at: Timestamp,
  }))
  .select((edge: any) => ({
    project_id: edge.project_id,
    task_id: edge.from_id,
    depends_on_task_id: edge.to_id,
    created_at: edge.created_at,
  }))
  .materialized("daemon");

export const taskHierarchyRows = Unblock.surface.view("taskHierarchyRows")
  .from(TaskContainsTask)
  .returns(z.object({
    project_id: z.string(),
    parent_task_id: z.string(),
    task_id: z.string(),
    sort_key: z.string().nullable(),
    created_at: Timestamp,
  }))
  .select((edge: any) => ({
    project_id: edge.project_id,
    parent_task_id: edge.from_id,
    task_id: edge.to_id,
    sort_key: edge.sort_key,
    created_at: edge.created_at,
  }))
  .materialized("daemon");

export const taskAssignmentRows = Unblock.surface.view("taskAssignmentRows")
  .from(TaskAssignedToTrack)
  .returns(z.object({
    project_id: z.string(),
    task_id: z.string(),
    track_id: z.string(),
    position: z.string(),
    assigned_at: Timestamp,
  }))
  .select((assignment: any) => ({
    project_id: assignment.project_id,
    task_id: assignment.from_id,
    track_id: assignment.to_id,
    position: assignment.position,
    assigned_at: assignment.assigned_at,
  }))
  .materialized("daemon");

export const taskDependencyClosure = TaskDependsOnTask.transitive(
  "taskDependencyClosure",
  {
    sources: [
      { relation: TaskDependsOnTask, scopeField: "project_id" },
      { relation: TaskContainsTask, scopeField: "project_id" },
    ],
    maxDepth: 64,
    countPaths: false,
  },
);

export const hierarchyClosure = TaskContainsTask.transitive("hierarchyClosure", {
  scopeField: "project_id",
  maxDepth: 64,
  countPaths: false,
});

export const directDependencySummary = Unblock.surface.view("directDependencySummary")
  .from(TaskDependsOnTask)
  .groupRowsBy((edge: any) => edge.from_id)
  .countRows("direct_dependency_count")
  .collectRows("direct_dependency_ids", (edge: any) => edge.to_id, {
    distinct: true,
  })
  .firstRow("project_id", (edge: any) => edge.project_id)
  .returns(z.object({
    task_id: z.string(),
    project_id: z.string(),
    direct_dependency_count: z.number().int64(),
    direct_dependency_ids: z.array(z.string()),
  }))
  .select((row: any) => ({
    task_id: row.group_0,
    project_id: row.project_id,
    direct_dependency_count: row.direct_dependency_count,
    direct_dependency_ids: row.direct_dependency_ids,
  }))
  .materialized("daemon");

export const directDependentSummary = Unblock.surface.view("directDependentSummary")
  .from(TaskDependsOnTask)
  .groupRowsBy((edge: any) => edge.to_id)
  .countRows("direct_dependent_count")
  .collectRows("direct_dependent_ids", (edge: any) => edge.from_id, {
    distinct: true,
  })
  .firstRow("project_id", (edge: any) => edge.project_id)
  .returns(z.object({
    task_id: z.string(),
    project_id: z.string(),
    direct_dependent_count: z.number().int64(),
    direct_dependent_ids: z.array(z.string()),
  }))
  .select((row: any) => ({
    task_id: row.group_0,
    project_id: row.project_id,
    direct_dependent_count: row.direct_dependent_count,
    direct_dependent_ids: row.direct_dependent_ids,
  }))
  .materialized("daemon");

export const unfinishedDirectDependencySummary = Unblock.surface.view(
  "unfinishedDirectDependencySummary",
)
  .from(TaskDependsOnTask)
  .join(
    Task,
    (edge: any, dependency: any) =>
      edge.to_id === dependency.id && edge.project_id === dependency.project_id,
  )
  .where((row: any) =>
    row.right.archived_at === null && row.right.lifecycle !== "finished"
  )
  .groupRowsBy((row: any) => row.left.from_id)
  .countRows("unfinished_dependency_count")
  .collectRows("unfinished_dependency_ids", (row: any) => row.left.to_id, {
    distinct: true,
  })
  .firstRow("project_id", (row: any) => row.left.project_id)
  .returns(z.object({
    task_id: z.string(),
    project_id: z.string(),
    unfinished_dependency_count: z.number().int64(),
    unfinished_dependency_ids: z.array(z.string()),
  }))
  .select((row: any) => ({
    task_id: row.group_0,
    project_id: row.project_id,
    unfinished_dependency_count: row.unfinished_dependency_count,
    unfinished_dependency_ids: row.unfinished_dependency_ids,
  }))
  .materialized("daemon");

export const taskDependencySummary = Unblock.surface.view("taskDependencySummary")
  .from(taskDependencyClosure)
  .groupRowsBy((edge: any) => edge.from_id)
  .aggregateRows("dependency_count", "count", (edge: any) => edge.to_id, {
    distinct: true,
  })
  .collectRows("dependency_ids", (edge: any) => edge.to_id, { distinct: true })
  .firstRow("project_id", (edge: any) => edge.scope_key)
  .returns(z.object({
    task_id: z.string(),
    project_id: z.string(),
    dependency_count: z.number().int64(),
    dependency_ids: z.array(z.string()),
  }))
  .select((row: any) => ({
    task_id: row.group_0,
    project_id: row.project_id,
    dependency_count: row.dependency_count,
    dependency_ids: row.dependency_ids,
  }))
  .materialized("daemon");

export const taskUnblockSummary = Unblock.surface.view("taskUnblockSummary")
  .from(taskDependencyClosure)
  .groupRowsBy((edge: any) => edge.to_id)
  .aggregateRows("unblocks_count", "count", (edge: any) => edge.from_id, {
    distinct: true,
  })
  .collectRows("unblocks_task_ids", (edge: any) => edge.from_id, { distinct: true })
  .firstRow("project_id", (edge: any) => edge.scope_key)
  .returns(z.object({
    task_id: z.string(),
    project_id: z.string(),
    unblocks_count: z.number().int64(),
    unblocks_task_ids: z.array(z.string()),
  }))
  .select((row: any) => ({
    task_id: row.group_0,
    project_id: row.project_id,
    unblocks_count: row.unblocks_count,
    unblocks_task_ids: row.unblocks_task_ids,
  }))
  .materialized("daemon");

export const childSummary = Unblock.surface.view("childSummary")
  .from(TaskContainsTask)
  .groupRowsBy((edge: any) => edge.from_id)
  .countRows("children_count")
  .collectRows("child_ids", (edge: any) => edge.to_id, { distinct: true })
  .firstRow("project_id", (edge: any) => edge.project_id)
  .returns(z.object({
    task_id: z.string(),
    project_id: z.string(),
    children_count: z.number().int64(),
    child_ids: z.array(z.string()),
  }))
  .select((row: any) => ({
    task_id: row.group_0,
    project_id: row.project_id,
    children_count: row.children_count,
    child_ids: row.child_ids,
  }))
  .materialized("daemon");

export const descendantSummary = Unblock.surface.view("descendantSummary")
  .from(hierarchyClosure)
  .groupRowsBy((edge: any) => edge.from_id)
  .aggregateRows("descendants_count", "count", (edge: any) => edge.to_id, {
    distinct: true,
  })
  .collectRows("descendant_ids", (edge: any) => edge.to_id, { distinct: true })
  .firstRow("project_id", (edge: any) => edge.scope_key)
  .returns(z.object({
    task_id: z.string(),
    project_id: z.string(),
    descendants_count: z.number().int64(),
    descendant_ids: z.array(z.string()),
  }))
  .select((row: any) => ({
    task_id: row.group_0,
    project_id: row.project_id,
    descendants_count: row.descendants_count,
    descendant_ids: row.descendant_ids,
  }))
  .materialized("daemon");

export const unfinishedDescendantSummary = Unblock.surface.view(
  "unfinishedDescendantSummary",
)
  .from(hierarchyClosure)
  .join(
    Task,
    (edge: any, descendant: any) =>
      edge.to_id === descendant.id && edge.scope_key === descendant.project_id,
  )
  .where((row: any) =>
    row.right.archived_at === null && row.right.lifecycle !== "finished"
  )
  .groupRowsBy((row: any) => row.left.from_id)
  .aggregateRows("unfinished_descendants_count", "count", (row: any) =>
    row.left.to_id
  , { distinct: true })
  .collectRows("unfinished_descendant_ids", (row: any) => row.left.to_id, {
    distinct: true,
  })
  .firstRow("project_id", (row: any) => row.left.scope_key)
  .returns(z.object({
    task_id: z.string(),
    project_id: z.string(),
    unfinished_descendants_count: z.number().int64(),
    unfinished_descendant_ids: z.array(z.string()),
  }))
  .select((row: any) => ({
    task_id: row.group_0,
    project_id: row.project_id,
    unfinished_descendants_count: row.unfinished_descendants_count,
    unfinished_descendant_ids: row.unfinished_descendant_ids,
  }))
  .materialized("daemon");

export const parentSummary = Unblock.surface.view("parentSummary")
  .from(TaskContainsTask)
  .returns(z.object({
    task_id: z.string(),
    project_id: z.string(),
    parent_task_id: z.string(),
    sort_key: z.string().nullable(),
  }))
  .select((edge: any) => ({
    task_id: edge.to_id,
    project_id: edge.project_id,
    parent_task_id: edge.from_id,
    sort_key: edge.sort_key,
  }))
  .materialized("daemon");

export const commentSummary = Unblock.surface.view("commentSummary")
  .from(Comment)
  .where((comment: any) => comment.archived_at === null)
  .groupRowsBy((comment: any) => comment.task_id)
  .countRows("comment_count")
  .collectRows("comment_authors", (comment: any) =>
    comment.machine + ":" + comment.actor
  , { distinct: true })
  .lastRow("last_comment_at", (comment: any) => comment.created_at)
  .firstRow("project_id", (comment: any) => comment.project_id)
  .returns(z.object({
    task_id: z.string(),
    project_id: z.string(),
    comment_count: z.number().int64(),
    comment_authors: z.array(z.string()),
    last_comment_at: Timestamp.nullable(),
  }))
  .select((row: any) => ({
    task_id: row.group_0,
    project_id: row.project_id,
    comment_count: row.comment_count,
    comment_authors: row.comment_authors,
    last_comment_at: row.last_comment_at,
  }))
  .materialized("daemon");

export const assignmentSummary = Unblock.surface.view("assignmentSummary")
  .from(TaskAssignedToTrack)
  .join(Track, (assignment: any, track: any) => assignment.to_id === track.id)
  .returns(z.object({
    task_id: z.string(),
    project_id: z.string(),
    track_id: z.string(),
    machine: z.string(),
    actor: z.string(),
    name: z.string().nullable(),
    position: z.string(),
    assigned_at: Timestamp,
  }))
  .select((row: any) => ({
    task_id: row.left.from_id,
    project_id: row.left.project_id,
    track_id: row.left.to_id,
    machine: row.right.machine,
    actor: row.right.actor,
    name: row.right.name,
    position: row.left.position,
    assigned_at: row.left.assigned_at,
  }))
  .materialized("daemon");

export const taskStatus = Unblock.surface.view("taskStatus")
  .from(Task)
  .leftJoin(
    unfinishedDirectDependencySummary,
    (task: any, dependency: any) =>
      task.id === dependency.task_id && task.project_id === dependency.project_id,
  )
  .returns(z.object({
    task_id: z.string(),
    project_id: z.string(),
    computed_status: ComputedStatus,
    ready: z.boolean(),
    blocked: z.boolean(),
    unfinished_dependency_count: z.number().int64(),
  }))
  .select((row: any) => ({
    task_id: row.left.id,
    project_id: row.left.project_id,
    computed_status: row.left.archived_at !== null
      ? "archived"
      : row.left.lifecycle === "finished"
      ? "finished"
      : row.left.lifecycle === "started"
      ? "started"
      : (row.right.unfinished_dependency_count ?? 0) > 0
      ? "blocked"
      : "ready",
    ready: row.left.archived_at === null &&
      row.left.lifecycle === "open" &&
      (row.right.unfinished_dependency_count ?? 0) === 0,
    blocked: row.left.archived_at === null &&
      row.left.lifecycle !== "finished" &&
      (row.right.unfinished_dependency_count ?? 0) > 0,
    unfinished_dependency_count: row.right.unfinished_dependency_count ?? 0,
  }))
  .materialized("daemon");

export const hierarchyStatus = Unblock.surface.view("hierarchyStatus")
  .from(Task)
  .leftJoin(
    descendantSummary,
    (task: any, descendants: any) =>
      task.id === descendants.task_id && task.project_id === descendants.project_id,
  )
  .leftJoin(
    unfinishedDescendantSummary,
    (row: any, unfinished: any) =>
      row.left.id === unfinished.task_id &&
      row.left.project_id === unfinished.project_id,
  )
  .returns(z.object({
    task_id: z.string(),
    project_id: z.string(),
    descendants_count: z.number().int64(),
    unfinished_descendants_count: z.number().int64(),
    rollup_status: RollupStatus,
  }))
  .select((row: any) => ({
    task_id: row.left.left.id,
    project_id: row.left.left.project_id,
    descendants_count: row.left.right.descendants_count ?? 0,
    unfinished_descendants_count: row.right.unfinished_descendants_count ?? 0,
    rollup_status: (row.left.right.descendants_count ?? 0) === 0
      ? "leaf"
      : (row.right.unfinished_descendants_count ?? 0) === 0
      ? "complete"
      : "blocked_by_children",
  }))
  .materialized("daemon");

export const taskReadModel = Unblock.surface.view("taskReadModel")
  .from(Task)
  .leftJoin(
    taskStatus,
    (task: any, status: any) =>
      task.id === status.task_id && task.project_id === status.project_id,
  )
  .returns(z.object({
    id: z.string(),
    project_id: z.string(),
    title: z.string(),
    description: z.string(),
    lifecycle: Lifecycle,
    priority: Priority,
    size: TaskSize.nullable(),
    source_doc: z.string().nullable(),
    source_section: z.string().nullable(),
    source_anchor: z.string().nullable(),
    source_line: z.number().int32().nullable(),
    source_text: z.string().nullable(),
    completion_bar: z.string().nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
    started_at: Timestamp.nullable(),
    finished_at: Timestamp.nullable(),
    archived_at: Timestamp.nullable(),
    version: z.number().int64(),
    computed_status: ComputedStatus,
    ready: z.boolean(),
    blocked: z.boolean(),
    unfinished_dependency_count: z.number().int64(),
  }))
  .select((row: any) => ({
    id: row.left.id,
    project_id: row.left.project_id,
    title: row.left.title,
    description: row.left.description,
    lifecycle: row.left.lifecycle,
    priority: row.left.priority,
    size: row.left.size,
    source_doc: row.left.source_doc,
    source_section: row.left.source_section,
    source_anchor: row.left.source_anchor,
    source_line: row.left.source_line,
    source_text: row.left.source_text,
    completion_bar: row.left.completion_bar,
    created_at: row.left.created_at,
    updated_at: row.left.updated_at,
    started_at: row.left.started_at,
    finished_at: row.left.finished_at,
    archived_at: row.left.archived_at,
    version: row.left.version,
    computed_status: row.right.computed_status ?? "ready",
    ready: row.right.ready ?? true,
    blocked: row.right.blocked ?? false,
    unfinished_dependency_count: row.right.unfinished_dependency_count ?? 0,
  }))
  .materialized("daemon");

export const taskCommentMatcherModel = Unblock.surface.view("taskCommentMatcherModel")
  .from(taskReadModel)
  .leftJoin(
    commentSummary,
    (task: any, comments: any) =>
      task.id === comments.task_id && task.project_id === comments.project_id,
  )
  .returns(z.object({
    id: z.string(),
    project_id: z.string(),
    title: z.string(),
    description: z.string(),
    lifecycle: Lifecycle,
    priority: Priority,
    size: TaskSize.nullable(),
    source_doc: z.string().nullable(),
    source_section: z.string().nullable(),
    source_anchor: z.string().nullable(),
    source_line: z.number().int32().nullable(),
    source_text: z.string().nullable(),
    completion_bar: z.string().nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
    started_at: Timestamp.nullable(),
    finished_at: Timestamp.nullable(),
    archived_at: Timestamp.nullable(),
    version: z.number().int64(),
    computed_status: ComputedStatus,
    ready: z.boolean(),
    blocked: z.boolean(),
    unfinished_dependency_count: z.number().int64(),
    comment_count: z.number().int64(),
    comment_authors: z.array(z.string()),
    last_comment_at: Timestamp.nullable(),
  }))
  .select((row: any) => ({
    id: row.left.id,
    project_id: row.left.project_id,
    title: row.left.title,
    description: row.left.description,
    lifecycle: row.left.lifecycle,
    priority: row.left.priority,
    size: row.left.size,
    source_doc: row.left.source_doc,
    source_section: row.left.source_section,
    source_anchor: row.left.source_anchor,
    source_line: row.left.source_line,
    source_text: row.left.source_text,
    completion_bar: row.left.completion_bar,
    created_at: row.left.created_at,
    updated_at: row.left.updated_at,
    started_at: row.left.started_at,
    finished_at: row.left.finished_at,
    archived_at: row.left.archived_at,
    version: row.left.version,
    computed_status: row.left.computed_status,
    ready: row.left.ready,
    blocked: row.left.blocked,
    unfinished_dependency_count: row.left.unfinished_dependency_count,
    comment_count: row.right.comment_count ?? 0,
    comment_authors: row.right.comment_authors ?? [],
    last_comment_at: row.right.last_comment_at ?? null,
  }))
  .materialized("daemon");

export const taskAssignmentMatcherModel = Unblock.surface.view("taskAssignmentMatcherModel")
  .from(taskCommentMatcherModel)
  .leftJoin(
    assignmentSummary,
    (task: any, assignment: any) =>
      task.id === assignment.task_id && task.project_id === assignment.project_id,
  )
  .returns(z.object({
    id: z.string(),
    project_id: z.string(),
    title: z.string(),
    description: z.string(),
    lifecycle: Lifecycle,
    priority: Priority,
    size: TaskSize.nullable(),
    source_doc: z.string().nullable(),
    source_section: z.string().nullable(),
    source_anchor: z.string().nullable(),
    source_line: z.number().int32().nullable(),
    source_text: z.string().nullable(),
    completion_bar: z.string().nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
    started_at: Timestamp.nullable(),
    finished_at: Timestamp.nullable(),
    archived_at: Timestamp.nullable(),
    version: z.number().int64(),
    computed_status: ComputedStatus,
    ready: z.boolean(),
    blocked: z.boolean(),
    unfinished_dependency_count: z.number().int64(),
    comment_count: z.number().int64(),
    comment_authors: z.array(z.string()),
    last_comment_at: Timestamp.nullable(),
    assigned_track_id: z.string().nullable(),
    assigned_machine: z.string().nullable(),
    assigned_actor: z.string().nullable(),
    assigned_name: z.string().nullable(),
    assigned_position: z.string().nullable(),
  }))
  .select((row: any) => ({
    id: row.left.id,
    project_id: row.left.project_id,
    title: row.left.title,
    description: row.left.description,
    lifecycle: row.left.lifecycle,
    priority: row.left.priority,
    size: row.left.size,
    source_doc: row.left.source_doc,
    source_section: row.left.source_section,
    source_anchor: row.left.source_anchor,
    source_line: row.left.source_line,
    source_text: row.left.source_text,
    completion_bar: row.left.completion_bar,
    created_at: row.left.created_at,
    updated_at: row.left.updated_at,
    started_at: row.left.started_at,
    finished_at: row.left.finished_at,
    archived_at: row.left.archived_at,
    version: row.left.version,
    computed_status: row.left.computed_status,
    ready: row.left.ready,
    blocked: row.left.blocked,
    unfinished_dependency_count: row.left.unfinished_dependency_count,
    comment_count: row.left.comment_count,
    comment_authors: row.left.comment_authors,
    last_comment_at: row.left.last_comment_at,
    assigned_track_id: row.right.track_id ?? null,
    assigned_machine: row.right.machine ?? null,
    assigned_actor: row.right.actor ?? null,
    assigned_name: row.right.name ?? null,
    assigned_position: row.right.position ?? null,
  }))
  .materialized("daemon");

export const taskMatcherReadModel = Unblock.surface.view("taskMatcherReadModel")
  .from(taskAssignmentMatcherModel)
  .leftJoin(
    taskDependencySummary,
    (task: any, dependencies: any) =>
      task.id === dependencies.task_id && task.project_id === dependencies.project_id,
  )
  .leftJoin(
    taskUnblockSummary,
    (row: any, unblocks: any) =>
      row.left.id === unblocks.task_id && row.left.project_id === unblocks.project_id,
  )
  .leftJoin(
    parentSummary,
    (row: any, parent: any) =>
      row.left.left.id === parent.task_id && row.left.left.project_id === parent.project_id,
  )
  .leftJoin(
    hierarchyStatus,
    (row: any, hierarchy: any) =>
      row.left.left.left.id === hierarchy.task_id && row.left.left.left.project_id === hierarchy.project_id,
  )
  .returns(z.object({
    id: z.string(),
    project_id: z.string(),
    title: z.string(),
    description: z.string(),
    lifecycle: Lifecycle,
    priority: Priority,
    size: TaskSize.nullable(),
    source_doc: z.string().nullable(),
    source_section: z.string().nullable(),
    source_anchor: z.string().nullable(),
    source_line: z.number().int32().nullable(),
    source_text: z.string().nullable(),
    completion_bar: z.string().nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
    started_at: Timestamp.nullable(),
    finished_at: Timestamp.nullable(),
    archived_at: Timestamp.nullable(),
    version: z.number().int64(),
    computed_status: ComputedStatus,
    ready: z.boolean(),
    blocked: z.boolean(),
    unfinished_dependency_count: z.number().int64(),
    comment_count: z.number().int64(),
    comment_authors: z.array(z.string()),
    last_comment_at: Timestamp.nullable(),
    assigned_track_id: z.string().nullable(),
    assigned_machine: z.string().nullable(),
    assigned_actor: z.string().nullable(),
    assigned_name: z.string().nullable(),
    assigned_position: z.string().nullable(),
    dependency_count: z.number().int64(),
    dependency_ids: z.array(z.string()),
    unblocks_count: z.number().int64(),
    unblocks_task_ids: z.array(z.string()),
    parent_task_id: z.string().nullable(),
    descendants_count: z.number().int64(),
    unfinished_descendants_count: z.number().int64(),
    rollup_status: RollupStatus,
  }))
  .select((row: any) => ({
    id: row.left.left.left.left.id,
    project_id: row.left.left.left.left.project_id,
    title: row.left.left.left.left.title,
    description: row.left.left.left.left.description,
    lifecycle: row.left.left.left.left.lifecycle,
    priority: row.left.left.left.left.priority,
    size: row.left.left.left.left.size,
    source_doc: row.left.left.left.left.source_doc,
    source_section: row.left.left.left.left.source_section,
    source_anchor: row.left.left.left.left.source_anchor,
    source_line: row.left.left.left.left.source_line,
    source_text: row.left.left.left.left.source_text,
    completion_bar: row.left.left.left.left.completion_bar,
    created_at: row.left.left.left.left.created_at,
    updated_at: row.left.left.left.left.updated_at,
    started_at: row.left.left.left.left.started_at,
    finished_at: row.left.left.left.left.finished_at,
    archived_at: row.left.left.left.left.archived_at,
    version: row.left.left.left.left.version,
    computed_status: row.left.left.left.left.computed_status,
    ready: row.left.left.left.left.ready,
    blocked: row.left.left.left.left.blocked,
    unfinished_dependency_count: row.left.left.left.left.unfinished_dependency_count,
    comment_count: row.left.left.left.left.comment_count,
    comment_authors: row.left.left.left.left.comment_authors,
    last_comment_at: row.left.left.left.left.last_comment_at,
    assigned_track_id: row.left.left.left.left.assigned_track_id,
    assigned_machine: row.left.left.left.left.assigned_machine,
    assigned_actor: row.left.left.left.left.assigned_actor,
    assigned_name: row.left.left.left.left.assigned_name,
    assigned_position: row.left.left.left.left.assigned_position,
    dependency_count: row.left.left.left.right.dependency_count ?? 0,
    dependency_ids: row.left.left.left.right.dependency_ids ?? [],
    unblocks_count: row.left.left.right.unblocks_count ?? 0,
    unblocks_task_ids: row.left.left.right.unblocks_task_ids ?? [],
    parent_task_id: row.left.right.parent_task_id ?? null,
    descendants_count: row.right.descendants_count ?? 0,
    unfinished_descendants_count: row.right.unfinished_descendants_count ?? 0,
    rollup_status: row.right.rollup_status ?? "leaf",
  }))
  .materialized("daemon");

export const readyTasks = Unblock.surface.view("readyTasks")
  .from(taskReadModel)
  .where((task: any) => task.ready === true)
  .returns(z.object({
    task_id: z.string(),
    project_id: z.string(),
    priority: Priority,
    updated_at: Timestamp,
  }))
  .select((task: any) => ({
    task_id: task.id,
    project_id: task.project_id,
    priority: task.priority,
    updated_at: task.updated_at,
  }))
  .materialized("daemon");

Task.surface.tag("task.ready")
  .from(taskStatus)
  .where((status: any) => status.ready === true)
  .select((status: any) => ({ subject_id: status.task_id, value: true }))
  .materialized("daemon");

Task.surface.tag("task.blocked")
  .from(taskStatus)
  .where((status: any) => status.blocked === true)
  .select((status: any) => ({ subject_id: status.task_id, value: true }))
  .materialized("daemon");

Task.surface.tag("task.started")
  .when((task: any) =>
    task.archived_at === null && task.lifecycle === "started"
  )
  .materialized("daemon");

Task.surface.tag("task.finished")
  .when((task: any) =>
    task.archived_at === null && task.lifecycle === "finished"
  )
  .materialized("daemon");

Task.surface.tag("task.archived")
  .when((task: any) => task.archived_at !== null)
  .materialized("daemon");

Task.surface.tag("task.blocked_by_children")
  .from(hierarchyStatus)
  .where((status: any) => status.rollup_status === "blocked_by_children")
  .select((status: any) => ({ subject_id: status.task_id, value: true }))
  .materialized("daemon");

export const instructionSelectorCatalog = Unblock.surface.view("instructionSelectorCatalog")
  .from(Instruction)
  .returns(z.object({
    project_id: z.string(),
    instruction_id: z.string(),
    selector_text: z.string(),
    selector_hash: z.string(),
    selector_fragment_id: z.string().nullable(),
    selector_fragment_hash: z.string().nullable(),
    body: z.string(),
  }))
  .select((instruction: any) => ({
    project_id: instruction.project_id,
    instruction_id: instruction.id,
    selector_text: instruction.selector_text,
    selector_hash: instruction.selector_hash,
    selector_fragment_id: instruction.selector_fragment_id,
    selector_fragment_hash: instruction.selector_fragment_hash,
    body: instruction.body,
  }))
  .materialized("daemon");

export const savedSelectorCatalog = Unblock.surface.view("savedSelectorCatalog")
  .from(SavedSelector)
  .where((selector: any) => selector.archived_at === null)
  .returns(z.object({
    project_id: z.string(),
    selector_id: z.string(),
    kind: SelectorKind,
    name: z.string(),
    selector_text: z.string(),
    selector_hash: z.string(),
    selector_fragment_id: z.string().nullable(),
    selector_fragment_hash: z.string().nullable(),
  }))
  .select((selector: any) => ({
    project_id: selector.project_id,
    selector_id: selector.id,
    kind: selector.kind,
    name: selector.name,
    selector_text: selector.selector_text,
    selector_hash: selector.selector_hash,
    selector_fragment_id: selector.selector_fragment_id,
    selector_fragment_hash: selector.selector_fragment_hash,
  }))
  .materialized("daemon");

rowsBy(directDependencySummary, ["project_id", "task_id"]);
rowsBy(directDependentSummary, ["project_id", "task_id"]);
rowsBy(unfinishedDirectDependencySummary, ["project_id", "task_id"]);
rowsBy(taskDependencySummary, ["project_id", "task_id"]);
rowsBy(taskUnblockSummary, ["project_id", "task_id"]);
rowsBy(childSummary, ["project_id", "task_id"]);
rowsBy(descendantSummary, ["project_id", "task_id"]);
rowsBy(unfinishedDescendantSummary, ["project_id", "task_id"]);
rowsBy(parentSummary, ["project_id", "task_id"]);
rowsBy(commentSummary, ["project_id", "task_id"]);
rowsBy(assignmentSummary, ["project_id", "task_id"]);
rowsBy(taskStatus, ["project_id", "task_id"]);
rowsBy(hierarchyStatus, ["project_id", "task_id"]);
rowsBy(taskReadModel, ["project_id", "id"]);
rowsBy(taskCommentMatcherModel, ["project_id", "id"]);
rowsBy(taskAssignmentMatcherModel, ["project_id", "id"]);
rowsBy(taskMatcherReadModel, ["project_id", "id"]);
rowsBy(readyTasks, ["project_id", "task_id"]);
rowsBy(instructionSelectorCatalog, ["project_id", "instruction_id"]);
rowsBy(savedSelectorCatalog, ["project_id", "selector_id"]);
rowsBy(projectRows, ["id"], ["id"]);
rowsBy(taskRows, ["project_id", "id"]);
rowsBy(taskLabelRows, ["project_id", "task_id", "label_id"]);
rowsBy(commentRows, ["project_id", "id"]);
rowsBy(trackRows, ["project_id", "id"]);
rowsBy(instructionRows, ["project_id", "id"]);
rowsBy(savedSelectorRows, ["project_id", "kind", "id"]);
rowsBy(activityRows, ["project_id", "id"]);
rowsBy(taskDependencyRows, ["project_id", "task_id", "depends_on_task_id"]);
rowsBy(taskHierarchyRows, ["project_id", "task_id"]);
rowsBy(taskAssignmentRows, ["project_id", "task_id"]);

function rowsBy(
  surface: { declaration: { output: any } },
  identityFields: string[],
  replacementScopeFields: string[] = ["project_id"],
) {
  const output = surface.declaration.output;
  if (output.kind !== "rows") {
    throw new Error("rowsBy can only be used with row surfaces");
  }
  output.identity = {
    parts: identityFields.map((field) => ({ kind: "field", field })),
  };
  output.replacement_scope = {
    parts: replacementScopeFields.map((field) => ({ kind: "field", field })),
  };
  return surface;
}
