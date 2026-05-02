import { randomUUID } from "node:crypto";
import {
  assertDependencySetHasNoCycle,
  assertNoCycle,
  assertNoParentCycle,
  buildGraphIndexes,
  computeDepths,
  computeHierarchyRollups,
  computeTransitiveDependents,
  isDescendant,
  sortTaskViews
} from "./graph.js";
import type { AppStore, RepositorySet } from "./store.js";
import {
  addTaskSchema,
  editTaskSchema,
  nowIso,
  normalizeId,
  slugify,
  type Activity,
  type AddTagInput,
  type AddTaskInput,
  type AddTrackInput,
  type Dependency,
  type DependencyExplanation,
  type EditTaskInput,
  type ImportIssue,
  type ImportResult,
  type JsonExport,
  type JsonImportResult,
  type Priority,
  type SourceSectionCoverage,
  type Tag,
  type TagCoverage,
  type Task,
  type TaskTag,
  type TaskListFilters,
  type TaskView,
  type Track,
  type TrackAssignment
} from "./types.js";
import { conflict, notFound, validation } from "./errors.js";
import { parseMarkdownTracker } from "./markdown-import.js";
import { exportMarkdown, exportStoreJson } from "./exporters.js";

export interface Services {
  tasks: TaskService;
  dependencies: DependencyService;
  tags: TagService;
  tracks: TrackService;
  query: QueryService;
  imports: ImportService;
  exports: ExportService;
  activity: ActivityService;
}

export interface ServiceOptions {
  actor?: string | null;
}

export function createServices(store: AppStore, options: ServiceOptions = {}): Services {
  const activity = new ActivityService(store, options.actor ?? null);
  const query = new QueryService(store);
  const tasks = new TaskService(store, activity);
  const dependencies = new DependencyService(store, activity);
  const tags = new TagService(store, activity);
  const tracks = new TrackService(store, activity, query);
  const imports = new ImportService(store, activity, tasks, tracks);
  const exports = new ExportService(store);
  return { tasks, dependencies, tags, tracks, query, imports, exports, activity };
}

function makeActivity(type: string, subjectType: Activity["subjectType"], subjectId: string | null, message: string, data: Record<string, unknown>, actor: string | null): Activity {
  return {
    id: randomUUID(),
    type,
    subjectType,
    subjectId,
    message,
    data,
    actor,
    createdAt: nowIso()
  };
}

function applyLifecycleTimestamps(task: Task, lifecycle: Task["lifecycle"], now: string): Task {
  if (task.lifecycle === lifecycle) {
    return task;
  }
  if (lifecycle === "started") {
    return {
      ...task,
      lifecycle,
      startedAt: task.startedAt ?? now,
      finishedAt: null,
      updatedAt: now,
      version: task.version + 1
    };
  }
  if (lifecycle === "finished") {
    return {
      ...task,
      lifecycle,
      startedAt: task.startedAt ?? now,
      finishedAt: now,
      updatedAt: now,
      version: task.version + 1
    };
  }
  return {
    ...task,
    lifecycle,
    finishedAt: null,
    updatedAt: now,
    version: task.version + 1
  };
}

export class ActivityService {
  constructor(private readonly store: AppStore, private readonly actor: string | null) {}

  async record(type: string, subjectType: Activity["subjectType"], subjectId: string | null, message: string, data: Record<string, unknown> = {}): Promise<Activity> {
    const activity = makeActivity(type, subjectType, subjectId, message, data, this.actor);
    await this.store.activity.append(activity);
    return activity;
  }

  async list(limit = 100): Promise<Activity[]> {
    return this.store.activity.list(limit);
  }
}

export class TaskService {
  constructor(private readonly store: AppStore, private readonly activity: ActivityService) {}

  async add(input: AddTaskInput): Promise<Task> {
    const parsed = addTaskSchema.parse(input);
    const id = normalizeId(parsed.id);
    const parentTaskId = parsed.parentTaskId ? normalizeId(parsed.parentTaskId) : null;
    const now = nowIso();
    const task: Task = {
      id,
      parentTaskId,
      title: parsed.title,
      description: parsed.description,
      lifecycle: parsed.lifecycle,
      priority: parsed.priority,
      size: parsed.size,
      sourceDoc: parsed.sourceDoc,
      sourceSection: parsed.sourceSection,
      sourceAnchor: parsed.sourceAnchor,
      sourceLine: parsed.sourceLine,
      sourceText: parsed.sourceText,
      completionBar: parsed.completionBar,
      createdAt: now,
      updatedAt: now,
      startedAt: parsed.lifecycle === "started" || parsed.lifecycle === "finished" ? now : null,
      finishedAt: parsed.lifecycle === "finished" ? now : null,
      archivedAt: null,
      version: 1
    };

    await this.store.transaction(async (repos) => {
      if (await repos.tasks.get(task.id)) {
        conflict(`Task already exists: ${task.id}`);
      }
      await ensureParentTask(repos, task.id, task.parentTaskId);
      await repos.tasks.create(task);
      await repos.activity.append(makeActivity("task.created", "task", task.id, `Created ${task.id}`, { title: task.title }, null));
    });

    return task;
  }

  async upsertFromImport(input: AddTaskInput): Promise<"created" | "updated" | "skipped"> {
    const parsed = addTaskSchema.parse(input);
    const id = normalizeId(parsed.id);
    const parentTaskId = parsed.parentTaskId ? normalizeId(parsed.parentTaskId) : null;
    const existing = await this.store.tasks.get(id);
    if (!existing) {
      await this.add({ ...parsed, id });
      return "created";
    }

    const shouldUpdate = existing.title !== parsed.title
      || existing.lifecycle !== parsed.lifecycle
      || existing.parentTaskId !== parentTaskId
      || existing.sourceDoc !== parsed.sourceDoc
      || existing.sourceSection !== parsed.sourceSection
      || existing.sourceLine !== parsed.sourceLine
      || existing.sourceText !== parsed.sourceText
      || existing.completionBar !== parsed.completionBar;

    if (!shouldUpdate) {
      return "skipped";
    }

    await this.edit(id, {
      title: parsed.title,
      parentTaskId,
      lifecycle: parsed.lifecycle,
      sourceDoc: parsed.sourceDoc,
      sourceSection: parsed.sourceSection,
      sourceLine: parsed.sourceLine,
      sourceText: parsed.sourceText,
      completionBar: parsed.completionBar
    });
    return "updated";
  }

  async get(id: string): Promise<Task> {
    return (await this.store.tasks.get(normalizeId(id))) ?? notFound("task", id);
  }

  async edit(id: string, input: EditTaskInput): Promise<Task> {
    const parsed = editTaskSchema.parse(input);
    const taskId = normalizeId(id);
    const parentTaskId = Object.hasOwn(parsed, "parentTaskId") ? (parsed.parentTaskId ? normalizeId(parsed.parentTaskId) : null) : undefined;
    const now = nowIso();
    const updated = await this.store.transaction(async (repos) => {
      const existing = await repos.tasks.get(taskId) ?? notFound("task", taskId);
      if (parentTaskId !== undefined) {
        await ensureParentTask(repos, taskId, parentTaskId);
      }
      const lifecycle = parsed.lifecycle ?? existing.lifecycle;
      const withLifecycle = applyLifecycleTimestamps(existing, lifecycle, now);
      const next: Task = {
        ...withLifecycle,
        parentTaskId: parentTaskId !== undefined ? parentTaskId : withLifecycle.parentTaskId,
        title: parsed.title ?? withLifecycle.title,
        description: parsed.description ?? withLifecycle.description,
        priority: parsed.priority ?? withLifecycle.priority,
        size: Object.hasOwn(parsed, "size") ? parsed.size ?? null : withLifecycle.size,
        sourceDoc: Object.hasOwn(parsed, "sourceDoc") ? parsed.sourceDoc ?? null : withLifecycle.sourceDoc,
        sourceSection: Object.hasOwn(parsed, "sourceSection") ? parsed.sourceSection ?? null : withLifecycle.sourceSection,
        sourceAnchor: Object.hasOwn(parsed, "sourceAnchor") ? parsed.sourceAnchor ?? null : withLifecycle.sourceAnchor,
        sourceLine: Object.hasOwn(parsed, "sourceLine") ? parsed.sourceLine ?? null : withLifecycle.sourceLine,
        sourceText: Object.hasOwn(parsed, "sourceText") ? parsed.sourceText ?? null : withLifecycle.sourceText,
        completionBar: Object.hasOwn(parsed, "completionBar") ? parsed.completionBar ?? null : withLifecycle.completionBar,
        updatedAt: now,
        version: existing.version + 1
      };
      await repos.tasks.update(next);
      await repos.activity.append(makeActivity("task.updated", "task", taskId, `Updated ${taskId}`, { input: parsed }, null));
      if (existing.lifecycle !== next.lifecycle) {
        await repos.activity.append(makeActivity(`task.${next.lifecycle}`, "task", taskId, `Set ${taskId} ${next.lifecycle}`, { from: existing.lifecycle, to: next.lifecycle }, null));
      }
      return next;
    });
    return updated;
  }

  async start(id: string): Promise<Task> {
    return this.edit(id, { lifecycle: "started" });
  }

  async finish(id: string): Promise<Task> {
    return this.edit(id, { lifecycle: "finished" });
  }

  async reopen(id: string): Promise<Task> {
    return this.edit(id, { lifecycle: "open" });
  }

  async archive(id: string): Promise<Task> {
    const taskId = normalizeId(id);
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const task = await repos.tasks.get(taskId) ?? notFound("task", taskId);
      const updated = { ...task, archivedAt: now, updatedAt: now, version: task.version + 1 };
      await repos.tasks.update(updated);
      await repos.activity.append(makeActivity("task.archived", "task", taskId, `Archived ${taskId}`, {}, null));
      return updated;
    });
  }

  async delete(id: string): Promise<void> {
    const taskId = normalizeId(id);
    await this.store.transaction(async (repos) => {
      const task = await repos.tasks.get(taskId) ?? notFound("task", taskId);
      const dependents = await repos.dependencies.listDependents(taskId);
      if (dependents.length > 0) {
        conflict("Cannot hard delete a task with dependents.", { taskId, dependents });
      }
      await repos.tasks.delete(task.id);
      await repos.activity.append(makeActivity("task.deleted", "task", taskId, `Deleted ${taskId}`, {}, null));
    });
  }
}

export class DependencyService {
  constructor(private readonly store: AppStore, private readonly activity: ActivityService) {}

  async add(taskIdInput: string, dependsOnTaskIdInput: string): Promise<Dependency> {
    const taskId = normalizeId(taskIdInput);
    const dependsOnTaskId = normalizeId(dependsOnTaskIdInput);
    const createdAt = nowIso();
    const dependency: Dependency = { taskId, dependsOnTaskId, createdAt };

    await this.store.transaction(async (repos) => {
      await ensureTaskPair(repos, taskId, dependsOnTaskId);
      const dependencies = await repos.dependencies.list();
      const tasks = await repos.tasks.list();
      assertNoCycle(taskId, dependsOnTaskId, dependencies);
      if (isDescendant(taskId, dependsOnTaskId, tasks)) {
        validation("A task cannot depend on one of its descendants in V1.", { taskId, dependsOnTaskId });
      }
      if (dependencies.some((edge) => edge.taskId === taskId && edge.dependsOnTaskId === dependsOnTaskId)) {
        return;
      }
      await repos.dependencies.add(dependency);
      await repos.activity.append(makeActivity("dependency.added", "task", taskId, `${taskId} now depends on ${dependsOnTaskId}`, { taskId, dependsOnTaskId }, null));
    });

    return dependency;
  }

  async remove(taskIdInput: string, dependsOnTaskIdInput: string): Promise<void> {
    const taskId = normalizeId(taskIdInput);
    const dependsOnTaskId = normalizeId(dependsOnTaskIdInput);
    await this.store.transaction(async (repos) => {
      await repos.dependencies.remove(taskId, dependsOnTaskId);
      await repos.activity.append(makeActivity("dependency.removed", "task", taskId, `${taskId} no longer depends on ${dependsOnTaskId}`, { taskId, dependsOnTaskId }, null));
    });
  }

  async set(taskIdInput: string, dependencyIdsInput: string[]): Promise<Dependency[]> {
    const taskId = normalizeId(taskIdInput);
    const dependencyIds = [...new Set(dependencyIdsInput.map(normalizeId))];
    const createdAt = nowIso();
    const dependencies = dependencyIds.map((dependsOnTaskId) => ({ taskId, dependsOnTaskId, createdAt }));

    await this.store.transaction(async (repos) => {
      if (!await repos.tasks.get(taskId)) {
        notFound("task", taskId);
      }
      for (const dependsOnTaskId of dependencyIds) {
        const dependencyTask = await repos.tasks.get(dependsOnTaskId) ?? notFound("task", dependsOnTaskId);
        if (dependencyTask.archivedAt) {
          validation("Archived tasks cannot be dependencies in V1.", { dependsOnTaskId });
        }
      }
      const allDependencies = await repos.dependencies.list();
      const tasks = await repos.tasks.list();
      assertDependencySetHasNoCycle(taskId, dependencyIds, allDependencies);
      for (const dependsOnTaskId of dependencyIds) {
        if (isDescendant(taskId, dependsOnTaskId, tasks)) {
          validation("A task cannot depend on one of its descendants in V1.", { taskId, dependsOnTaskId });
        }
      }
      await repos.dependencies.replaceForTask(taskId, dependencies);
      await repos.activity.append(makeActivity("dependency.set", "task", taskId, `Set dependencies for ${taskId}`, { dependencyIds }, null));
    });

    return dependencies;
  }

  async list(taskIdInput: string): Promise<Dependency[]> {
    return this.store.dependencies.listForTask(normalizeId(taskIdInput));
  }
}

export class TagService {
  constructor(private readonly store: AppStore, private readonly activity: ActivityService) {}

  async add(input: AddTagInput): Promise<Tag> {
    const now = nowIso();
    const tag: Tag = {
      id: input.id ? normalizeId(input.id) : slugify(input.name),
      name: input.name.trim(),
      color: input.color ?? null,
      description: input.description ?? null,
      sortOrder: input.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    };
    if (!tag.name) {
      validation("Tag name is required.");
    }
    await this.store.transaction(async (repos) => {
      if (await repos.tags.get(tag.id)) {
        conflict(`Tag already exists: ${tag.id}`);
      }
      if (await repos.tags.findByName(tag.name)) {
        conflict(`Tag name already exists: ${tag.name}`);
      }
      await repos.tags.create(tag);
      await repos.activity.append(makeActivity("tag.created", "tag", tag.id, `Created tag ${tag.name}`, {}, null));
    });
    return tag;
  }

  async edit(id: string, input: Partial<AddTagInput>): Promise<Tag> {
    const tagId = normalizeId(id);
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const existing = await repos.tags.get(tagId) ?? notFound("tag", tagId);
      const next: Tag = {
        ...existing,
        name: input.name?.trim() ?? existing.name,
        color: Object.hasOwn(input, "color") ? input.color ?? null : existing.color,
        description: Object.hasOwn(input, "description") ? input.description ?? null : existing.description,
        sortOrder: input.sortOrder ?? existing.sortOrder,
        updatedAt: now
      };
      await repos.tags.update(next);
      await repos.activity.append(makeActivity("tag.updated", "tag", tagId, `Updated tag ${next.name}`, {}, null));
      return next;
    });
  }

  async archive(id: string): Promise<Tag> {
    const tagId = normalizeId(id);
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const tag = await repos.tags.get(tagId) ?? notFound("tag", tagId);
      const next = { ...tag, archivedAt: now, updatedAt: now };
      await repos.tags.update(next);
      await repos.activity.append(makeActivity("tag.archived", "tag", tagId, `Archived tag ${tag.name}`, {}, null));
      return next;
    });
  }

  async assign(taskIdInput: string, tagIdsOrNames: string[]): Promise<void> {
    const taskId = normalizeId(taskIdInput);
    const createdAt = nowIso();
    await this.store.transaction(async (repos) => {
      await repos.tasks.get(taskId) ?? notFound("task", taskId);
      for (const tagIdOrName of tagIdsOrNames) {
        const tag = await repos.tags.get(normalizeId(tagIdOrName)) ?? await repos.tags.findByName(tagIdOrName) ?? notFound("tag", tagIdOrName);
        if (tag.archivedAt) {
          validation("Archived tags cannot be assigned.", { tagId: tag.id });
        }
        await repos.tags.addTaskTag({ taskId, tagId: tag.id, createdAt });
      }
      await repos.activity.append(makeActivity("tag.assigned", "task", taskId, `Assigned tags to ${taskId}`, { tags: tagIdsOrNames }, null));
    });
  }

  async remove(taskIdInput: string, tagIdOrName: string): Promise<void> {
    const taskId = normalizeId(taskIdInput);
    await this.store.transaction(async (repos) => {
      const tag = await repos.tags.get(normalizeId(tagIdOrName)) ?? await repos.tags.findByName(tagIdOrName) ?? notFound("tag", tagIdOrName);
      await repos.tags.removeTaskTag(taskId, tag.id);
      await repos.activity.append(makeActivity("tag.removed", "task", taskId, `Removed tag ${tag.name} from ${taskId}`, { tagId: tag.id }, null));
    });
  }

  async list(): Promise<Tag[]> {
    return this.store.tags.list();
  }
}

export class TrackService {
  constructor(private readonly store: AppStore, private readonly activity: ActivityService, private readonly query: QueryService) {}

  async add(input: AddTrackInput): Promise<Track> {
    const now = nowIso();
    const actor = input.actor.trim();
    if (!actor) {
      validation("Actor is required.");
    }
    const track: Track = {
      id: input.id ? normalizeId(input.id) : slugify(actor),
      actor,
      name: input.name ?? null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    };
    await this.store.transaction(async (repos) => {
      if (await repos.tracks.get(track.id)) {
        conflict(`Track already exists: ${track.id}`);
      }
      if (await repos.tracks.findByActor(actor)) {
        conflict(`Track actor already exists: ${actor}`);
      }
      await repos.tracks.create(track);
      await repos.activity.append(makeActivity("track.created", "track", track.id, `Created actor queue ${actor}`, {}, null));
    });
    return track;
  }

  async rename(actorOrId: string, name: string): Promise<Track> {
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const track = await findTrack(repos, actorOrId);
      const next = { ...track, name, updatedAt: now };
      await repos.tracks.update(next);
      await repos.activity.append(makeActivity("track.renamed", "track", track.id, `Renamed actor queue ${track.actor}`, { name }, null));
      return next;
    });
  }

  async archive(actorOrId: string): Promise<Track> {
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const track = await findTrack(repos, actorOrId);
      const next = { ...track, archivedAt: now, updatedAt: now };
      await repos.tracks.update(next);
      await repos.activity.append(makeActivity("track.archived", "track", track.id, `Archived actor queue ${track.actor}`, {}, null));
      return next;
    });
  }

  async assign(actorOrId: string, taskIdInput: string): Promise<TrackAssignment> {
    const taskId = normalizeId(taskIdInput);
    const assignedAt = nowIso();
    return this.store.transaction(async (repos) => {
      const track = await findTrack(repos, actorOrId);
      const task = await repos.tasks.get(taskId) ?? notFound("task", taskId);
      if (track.archivedAt) {
        validation("Archived tracks cannot receive assignments.", { trackId: track.id });
      }
      const view = (await this.query.list({ includeFinished: true, includeArchived: true })).find((item) => item.id === taskId) ?? notFound("task", taskId);
      if (task.archivedAt) {
        validation("Archived tasks cannot be assigned.", { taskId });
      }
      if (task.lifecycle === "finished") {
        validation("Finished tasks cannot be assigned.", { taskId });
      }
      if (view.blocked) {
        validation("Blocked tasks cannot be assigned.", { taskId, unfinishedDependenciesCount: view.unfinishedDependenciesCount });
      }
      const assignments = await repos.tracks.listAssignments();
      if (assignments.some((assignment) => assignment.taskId === taskId)) {
        conflict("Task is already assigned to an actor queue.", { taskId });
      }
      const trackAssignments = assignments.filter((assignment) => assignment.trackId === track.id);
      const position = String(trackAssignments.length + 1).padStart(6, "0");
      const assignment = { trackId: track.id, taskId, position, assignedAt };
      await repos.tracks.assign(assignment);
      await repos.activity.append(makeActivity("track.assigned", "track", track.id, `Assigned ${taskId} to ${track.actor}`, { taskId, actor: track.actor }, null));
      return assignment;
    });
  }

  async unassign(actorOrId: string, taskIdInput: string): Promise<void> {
    const taskId = normalizeId(taskIdInput);
    await this.store.transaction(async (repos) => {
      const track = await findTrack(repos, actorOrId);
      await repos.tracks.unassign(track.id, taskId);
      await repos.activity.append(makeActivity("track.unassigned", "track", track.id, `Unassigned ${taskId} from ${track.actor}`, { taskId }, null));
    });
  }

  async list(): Promise<Track[]> {
    return this.store.tracks.list();
  }
}

export class QueryService {
  constructor(private readonly store: AppStore) {}

  async list(filters: TaskListFilters = {}): Promise<TaskView[]> {
    const [tasks, dependencies, tags, taskTags, tracks, assignments] = await Promise.all([
      this.store.tasks.list(),
      this.store.dependencies.list(),
      this.store.tags.list(),
      this.store.tags.listTaskTags(),
      this.store.tracks.list(),
      this.store.tracks.listAssignments()
    ]);

    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const tagById = new Map(tags.map((tag) => [tag.id, tag]));
    const trackById = new Map(tracks.map((track) => [track.id, track]));
    const graph = buildGraphIndexes(dependencies);
    const depths = computeDepths(tasks, dependencies);
    const transitiveDependents = computeTransitiveDependents(tasks.filter((task) => task.lifecycle !== "finished"), dependencies);

    const tagsByTask = new Map<string, Tag[]>();
    for (const taskTag of taskTags) {
      const tag = tagById.get(taskTag.tagId);
      if (!tag || tag.archivedAt) {
        continue;
      }
      const existing = tagsByTask.get(taskTag.taskId) ?? [];
      existing.push(tag);
      tagsByTask.set(taskTag.taskId, existing);
    }

    const assignmentByTask = new Map(assignments.map((assignment) => [assignment.taskId, assignment]));

    let views = tasks.map((task): TaskView => {
      const dependencyIds = graph.dependenciesByTask.get(task.id) ?? [];
      let unfinishedDependenciesCount = 0;
      let finishedDependenciesCount = 0;
      for (const dependencyId of dependencyIds) {
        const dependency = taskById.get(dependencyId);
        if (!dependency || dependency.lifecycle !== "finished") {
          unfinishedDependenciesCount += 1;
        } else {
          finishedDependenciesCount += 1;
        }
      }
      const assignment = assignmentByTask.get(task.id);
      const track = assignment ? trackById.get(assignment.trackId) : null;
      const blocked = task.lifecycle !== "finished" && unfinishedDependenciesCount > 0;
      const ready = task.lifecycle === "open" && !blocked && !task.archivedAt;
      const computedStatus = task.archivedAt
        ? "archived"
        : task.lifecycle === "finished"
          ? "finished"
          : task.lifecycle === "started"
            ? "started"
            : blocked
              ? "blocked"
              : "ready";
      return {
        ...task,
        computedStatus,
        ready,
        blocked,
        unfinishedDependenciesCount,
        finishedDependenciesCount,
        dependencyDepth: depths.get(task.id) ?? 0,
        dependentsCount: graph.dependentsByTask.get(task.id)?.length ?? 0,
        transitiveDependentsCount: transitiveDependents.get(task.id)?.size ?? 0,
        parent: null,
        childrenCount: 0,
        descendantsCount: 0,
        leafDescendantsCount: 0,
        finishedLeafDescendantsCount: 0,
        subtreeProgress: task.lifecycle === "finished" ? 100 : 0,
        subtreeOpenCount: 0,
        subtreeReadyCount: 0,
        subtreeBlockedCount: 0,
        subtreeStartedCount: 0,
        subtreeFinishedCount: 0,
        hierarchyDepth: 0,
        assignedTrack: assignment && track ? { trackId: track.id, actor: track.actor, name: track.name, position: assignment.position } : null,
        tags: [...(tagsByTask.get(task.id) ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      };
    });

    const statusByTask = new Map(views.map((task) => [task.id, task.computedStatus]));
    const rollups = computeHierarchyRollups(tasks, statusByTask);
    views = views.map((task) => {
      const parentTask = task.parentTaskId ? taskById.get(task.parentTaskId) : null;
      const rollup = rollups.get(task.id);
      return {
        ...task,
        parent: parentTask ? { id: parentTask.id, title: parentTask.title, lifecycle: parentTask.lifecycle } : null,
        childrenCount: rollup?.childrenCount ?? 0,
        descendantsCount: rollup?.descendantsCount ?? 0,
        leafDescendantsCount: rollup?.leafDescendantsCount ?? 0,
        finishedLeafDescendantsCount: rollup?.finishedLeafDescendantsCount ?? 0,
        subtreeProgress: rollup?.subtreeProgress ?? task.subtreeProgress,
        subtreeOpenCount: rollup?.subtreeOpenCount ?? 0,
        subtreeReadyCount: rollup?.subtreeReadyCount ?? 0,
        subtreeBlockedCount: rollup?.subtreeBlockedCount ?? 0,
        subtreeStartedCount: rollup?.subtreeStartedCount ?? 0,
        subtreeFinishedCount: rollup?.subtreeFinishedCount ?? 0,
        hierarchyDepth: rollup?.hierarchyDepth ?? 0
      };
    });

    views = this.applyFilters(views, filters);
    return sortTaskViews(views, filters.sort);
  }

  async explain(idInput: string): Promise<DependencyExplanation> {
    const id = normalizeId(idInput);
    const views = await this.list({ includeFinished: true, includeArchived: true });
    const viewById = new Map(views.map((task) => [task.id, task]));
    const dependencies = await this.store.dependencies.listForTask(id);
    const allDependencies = await this.store.dependencies.list();
    const directDependents = allDependencies.filter((dependency) => dependency.dependsOnTaskId === id).map((dependency) => viewById.get(dependency.taskId)).filter((task): task is TaskView => Boolean(task));
    const task = viewById.get(id) ?? notFound("task", id);
    const dependencyViews = dependencies.map((dependency) => viewById.get(dependency.dependsOnTaskId)).filter((dependency): dependency is TaskView => Boolean(dependency));
    const unfinishedDependencies = dependencyViews.filter((dependency) => dependency.lifecycle !== "finished");
    const finishedDependencies = dependencyViews.filter((dependency) => dependency.lifecycle === "finished");
    const assignable = !task.archivedAt && task.lifecycle !== "finished" && unfinishedDependencies.length === 0;
    const reason = assignable
      ? "Task has no unfinished dependencies and can be assigned."
      : task.archivedAt
        ? "Archived tasks cannot be assigned."
        : task.lifecycle === "finished"
          ? "Finished tasks cannot be assigned."
          : `${unfinishedDependencies.length} dependencies are unfinished.`;

    return {
      task,
      dependencies: dependencyViews,
      unfinishedDependencies,
      finishedDependencies,
      directDependents,
      transitiveDependentsCount: task.transitiveDependentsCount,
      assignable,
      reason
    };
  }

  async sourceCoverage(): Promise<SourceSectionCoverage[]> {
    const views = await this.list({ includeArchived: true, includeFinished: true });
    const coverage = new Map<string, SourceSectionCoverage>();
    for (const task of views) {
      const key = `${task.sourceDoc ?? ""}\u0000${task.sourceSection ?? ""}`;
      const existing = coverage.get(key) ?? {
        sourceDoc: task.sourceDoc,
        sourceSection: task.sourceSection,
        total: 0,
        open: 0,
        ready: 0,
        blocked: 0,
        started: 0,
        finished: 0,
        archived: 0
      };
      existing.total += 1;
      if (task.archivedAt) {
        existing.archived += 1;
      } else if (task.computedStatus === "ready") {
        existing.ready += 1;
        existing.open += 1;
      } else if (task.computedStatus === "blocked") {
        existing.blocked += 1;
        existing.open += 1;
      } else if (task.computedStatus === "started") {
        existing.started += 1;
      } else if (task.computedStatus === "finished") {
        existing.finished += 1;
      }
      coverage.set(key, existing);
    }
    return [...coverage.values()].sort((a, b) => (a.sourceDoc ?? "").localeCompare(b.sourceDoc ?? "") || (a.sourceSection ?? "").localeCompare(b.sourceSection ?? ""));
  }

  async tagCoverage(): Promise<TagCoverage[]> {
    const views = await this.list({ includeArchived: true, includeFinished: true });
    const byTag = new Map<string, TagCoverage>();
    const untagged: TagCoverage = { tag: null, total: 0, open: 0, ready: 0, blocked: 0, started: 0, finished: 0 };
    for (const task of views) {
      const targets = task.tags.length > 0 ? task.tags : [null];
      for (const tag of targets) {
        const key = tag?.id ?? "__untagged";
        const existing = tag ? byTag.get(key) ?? { tag, total: 0, open: 0, ready: 0, blocked: 0, started: 0, finished: 0 } : untagged;
        existing.total += 1;
        if (task.computedStatus === "ready") {
          existing.ready += 1;
          existing.open += 1;
        } else if (task.computedStatus === "blocked") {
          existing.blocked += 1;
          existing.open += 1;
        } else if (task.computedStatus === "started") {
          existing.started += 1;
        } else if (task.computedStatus === "finished") {
          existing.finished += 1;
        }
        if (tag) {
          byTag.set(key, existing);
        }
      }
    }
    return [...byTag.values(), untagged].sort((a, b) => (a.tag?.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.tag?.sortOrder ?? Number.MAX_SAFE_INTEGER));
  }

  private applyFilters(views: TaskView[], filters: TaskListFilters): TaskView[] {
    const search = filters.search?.trim().toLowerCase();
    return views.filter((task) => {
      if (!filters.includeArchived && task.archivedAt) {
        return false;
      }
      if (!filters.includeFinished && task.lifecycle === "finished") {
        return false;
      }
      if (filters.status && filters.status !== "open" && task.computedStatus !== filters.status) {
        return false;
      }
      if (filters.status === "open" && task.lifecycle !== "open") {
        return false;
      }
      if (filters.lifecycle && task.lifecycle !== filters.lifecycle) {
        return false;
      }
      if (filters.priorityMin !== undefined && task.priority < filters.priorityMin) {
        return false;
      }
      if (filters.priorityMax !== undefined && task.priority > filters.priorityMax) {
        return false;
      }
      if (filters.size && task.size !== filters.size) {
        return false;
      }
      if (Object.hasOwn(filters, "parentTaskId") && task.parentTaskId !== (filters.parentTaskId ? normalizeId(filters.parentTaskId) : null)) {
        return false;
      }
      if (filters.sourceDoc && task.sourceDoc !== filters.sourceDoc) {
        return false;
      }
      if (filters.sourceSection && task.sourceSection !== filters.sourceSection) {
        return false;
      }
      if (filters.tag && !task.tags.some((tag) => tag.id === normalizeId(filters.tag ?? "") || tag.name === filters.tag)) {
        return false;
      }
      if (filters.assignedActor && task.assignedTrack?.actor !== filters.assignedActor) {
        return false;
      }
      if (search) {
        const haystack = [task.id, task.title, task.description, task.sourceDoc, task.sourceSection, task.sourceText].filter(Boolean).join("\n").toLowerCase();
        if (!haystack.includes(search)) {
          return false;
        }
      }
      return true;
    });
  }
}

export class ImportService {
  constructor(
    private readonly store: AppStore,
    private readonly activity: ActivityService,
    private readonly tasks: TaskService,
    private readonly tracks: TrackService
  ) {}

  async markdown(filePath: string, markdown: string, dryRun = false): Promise<ImportResult> {
    const plan = parseMarkdownTracker(filePath, markdown);
    if (dryRun) {
      return { created: 0, updated: 0, assigned: 0, skipped: plan.tasks.length, issues: plan.issues };
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let assigned = 0;

    for (const importedTask of plan.tasks) {
      const result = await this.tasks.upsertFromImport({
        id: importedTask.id,
        title: importedTask.title,
        lifecycle: importedTask.lifecycle,
        sourceDoc: importedTask.sourceDoc,
        parentTaskId: importedTask.parentTaskId,
        sourceSection: importedTask.sourceSection,
        sourceLine: importedTask.sourceLine,
        sourceText: importedTask.sourceText,
        completionBar: importedTask.completionBar
      });
      if (result === "created") {
        created += 1;
      } else if (result === "updated") {
        updated += 1;
      } else {
        skipped += 1;
      }

      if (importedTask.assignee && importedTask.lifecycle !== "finished") {
        const existingTrack = await this.store.tracks.findByActor(importedTask.assignee);
        if (!existingTrack) {
          await this.tracks.add({ actor: importedTask.assignee });
        }
        const views = await this.store.tracks.listAssignments();
        if (!views.some((assignment) => assignment.taskId === importedTask.id)) {
          try {
            await this.tracks.assign(importedTask.assignee, importedTask.id);
            assigned += 1;
          } catch {
            skipped += 1;
          }
        }
      }
    }

    await this.activity.record("import.completed", "import", null, `Imported ${filePath}`, { filePath, created, updated, skipped, assigned, issues: plan.issues.length });
    return { created, updated, skipped, assigned, issues: plan.issues };
  }

  async json(filePath: string, input: unknown): Promise<JsonImportResult> {
    const now = nowIso();
    const data = normalizeJsonImport(input, now);
    const issues: ImportIssue[] = [];

    let tasksCreated = 0;
    let tasksUpdated = 0;
    let tagsCreated = 0;
    let tagsUpdated = 0;
    let tracksCreated = 0;
    let tracksUpdated = 0;
    let dependenciesAdded = 0;
    let taskTagsAdded = 0;
    let assignmentsAdded = 0;
    let skipped = 0;

    await this.store.transaction(async (repos) => {
      const existingTasks = await repos.tasks.list();
      const existingTaskById = new Map(existingTasks.map((task) => [task.id, task]));
      const importedTaskById = new Map(data.tasks.map((task) => [task.id, task]));
      const combinedTasks = existingTasks.map((task) => importedTaskById.get(task.id) ?? task);
      for (const task of data.tasks) {
        if (!existingTaskById.has(task.id)) {
          combinedTasks.push(task);
        }
      }
      const combinedTaskById = new Map(combinedTasks.map((task) => [task.id, task]));

      for (const task of data.tasks) {
        if (task.parentTaskId && !combinedTaskById.has(task.parentTaskId)) {
          validation("Imported task references a missing parent.", { taskId: task.id, parentTaskId: task.parentTaskId });
        }
      }
      for (const task of combinedTasks) {
        assertNoParentCycle(task.id, task.parentTaskId, combinedTasks);
      }

      const existingDependencies = await repos.dependencies.list();
      const importedDependencyKeys = new Set(data.dependencies.map((edge) => dependencyKey(edge.taskId, edge.dependsOnTaskId)));
      const combinedDependencies = [
        ...existingDependencies.filter((edge) => !importedDependencyKeys.has(dependencyKey(edge.taskId, edge.dependsOnTaskId))),
        ...data.dependencies
      ];
      validateDependencyGraph(combinedTasks, combinedDependencies);

      const existingTags = await repos.tags.list();
      const existingTagById = new Map(existingTags.map((tag) => [tag.id, tag]));
      const existingTracks = await repos.tracks.list();
      const existingTrackById = new Map(existingTracks.map((track) => [track.id, track]));
      const existingTaskTags = new Set((await repos.tags.listTaskTags()).map((taskTag) => taskTagKey(taskTag.taskId, taskTag.tagId)));
      const existingAssignments = new Map((await repos.tracks.listAssignments()).map((assignment) => [assignment.taskId, assignment]));

      for (const task of data.tasks) {
        const parentless = { ...task, parentTaskId: null };
        if (existingTaskById.has(task.id)) {
          await repos.tasks.update(parentless);
          tasksUpdated += 1;
        } else {
          await repos.tasks.create(parentless);
          tasksCreated += 1;
        }
      }
      for (const task of data.tasks) {
        if (task.parentTaskId) {
          await repos.tasks.update(task);
        }
      }

      for (const tag of data.tags) {
        if (existingTagById.has(tag.id)) {
          await repos.tags.update(tag);
          tagsUpdated += 1;
        } else {
          await repos.tags.create(tag);
          tagsCreated += 1;
        }
      }

      for (const track of data.tracks) {
        if (existingTrackById.has(track.id)) {
          await repos.tracks.update(track);
          tracksUpdated += 1;
        } else {
          await repos.tracks.create(track);
          tracksCreated += 1;
        }
      }

      for (const dependency of data.dependencies) {
        const alreadyExists = existingDependencies.some((edge) => edge.taskId === dependency.taskId && edge.dependsOnTaskId === dependency.dependsOnTaskId);
        await repos.dependencies.add(dependency);
        if (alreadyExists) {
          skipped += 1;
        } else {
          dependenciesAdded += 1;
        }
      }

      for (const taskTag of data.taskTags) {
        if (!combinedTaskById.has(taskTag.taskId)) {
          validation("Imported task tag references a missing task.", { taskId: taskTag.taskId, tagId: taskTag.tagId });
        }
        if (!existingTagById.has(taskTag.tagId) && !data.tags.some((tag) => tag.id === taskTag.tagId)) {
          validation("Imported task tag references a missing tag.", { taskId: taskTag.taskId, tagId: taskTag.tagId });
        }
        const key = taskTagKey(taskTag.taskId, taskTag.tagId);
        await repos.tags.addTaskTag(taskTag);
        if (existingTaskTags.has(key)) {
          skipped += 1;
        } else {
          taskTagsAdded += 1;
        }
      }

      for (const assignment of data.assignments) {
        if (!combinedTaskById.has(assignment.taskId)) {
          validation("Imported assignment references a missing task.", { taskId: assignment.taskId, trackId: assignment.trackId });
        }
        if (!existingTrackById.has(assignment.trackId) && !data.tracks.some((track) => track.id === assignment.trackId)) {
          validation("Imported assignment references a missing track.", { taskId: assignment.taskId, trackId: assignment.trackId });
        }
        const existingAssignment = existingAssignments.get(assignment.taskId);
        if (existingAssignment && existingAssignment.trackId !== assignment.trackId) {
          conflict("Imported assignment conflicts with an existing assignment.", { taskId: assignment.taskId, existingAssignment, importedAssignment: assignment });
        }
        if (existingAssignment) {
          skipped += 1;
          continue;
        }
        await repos.tracks.assign(assignment);
        assignmentsAdded += 1;
      }

      await repos.activity.append(makeActivity("import.completed", "import", null, `Imported ${filePath}`, {
        filePath,
        tasksCreated,
        tasksUpdated,
        tagsCreated,
        tagsUpdated,
        tracksCreated,
        tracksUpdated,
        dependenciesAdded,
        taskTagsAdded,
        assignmentsAdded,
        skipped,
        issues: issues.length
      }, null));
    });

    return {
      tasksCreated,
      tasksUpdated,
      tagsCreated,
      tagsUpdated,
      tracksCreated,
      tracksUpdated,
      dependenciesAdded,
      taskTagsAdded,
      assignmentsAdded,
      skipped,
      issues
    };
  }
}

export class ExportService {
  constructor(private readonly store: AppStore) {}

  async json(includeActivity = false): Promise<JsonExport> {
    return exportStoreJson(this.store, includeActivity);
  }

  async markdown(): Promise<string> {
    const query = new QueryService(this.store);
    return exportMarkdown(await query.list({ includeFinished: true, includeArchived: true }));
  }
}

async function ensureTaskPair(repos: RepositorySet, taskId: string, dependsOnTaskId: string): Promise<void> {
  const task = await repos.tasks.get(taskId) ?? notFound("task", taskId);
  const dependency = await repos.tasks.get(dependsOnTaskId) ?? notFound("task", dependsOnTaskId);
  if (task.archivedAt) {
    validation("Archived tasks cannot have dependencies changed.", { taskId });
  }
  if (dependency.archivedAt) {
    validation("Archived tasks cannot be dependencies in V1.", { dependsOnTaskId });
  }
}

async function ensureParentTask(repos: RepositorySet, taskId: string, parentTaskId: string | null): Promise<void> {
  if (!parentTaskId) {
    return;
  }
  const parent = await repos.tasks.get(parentTaskId) ?? notFound("task", parentTaskId);
  if (parent.archivedAt) {
    validation("Archived tasks cannot be parents in V1.", { taskId, parentTaskId });
  }
  const tasks = await repos.tasks.list();
  assertNoParentCycle(taskId, parentTaskId, tasks);
}

async function findTrack(repos: RepositorySet, actorOrId: string): Promise<Track> {
  return await repos.tracks.get(normalizeId(actorOrId)) ?? await repos.tracks.findByActor(actorOrId) ?? notFound("track", actorOrId);
}

function normalizeJsonImport(input: unknown, now: string): JsonExport {
  if (!input || typeof input !== "object") {
    validation("JSON import must be an object.");
  }
  const record = input as Partial<JsonExport>;
  const tasks = ensureArray(record.tasks, "tasks").map((task) => normalizeImportedTask(task, now));
  const taskIds = new Set<string>();
  for (const task of tasks) {
    if (taskIds.has(task.id)) {
      validation("JSON import contains duplicate task ids.", { taskId: task.id });
    }
    taskIds.add(task.id);
  }

  const tags = ensureArray(record.tags, "tags").map((tag) => normalizeImportedTag(tag, now));
  const tagIds = new Set<string>();
  const tagNames = new Set<string>();
  for (const tag of tags) {
    if (tagIds.has(tag.id)) {
      validation("JSON import contains duplicate tag ids.", { tagId: tag.id });
    }
    if (tagNames.has(tag.name)) {
      validation("JSON import contains duplicate tag names.", { name: tag.name });
    }
    tagIds.add(tag.id);
    tagNames.add(tag.name);
  }

  const tracks = ensureArray(record.tracks, "tracks").map((track) => normalizeImportedTrack(track, now));
  const trackIds = new Set<string>();
  const actors = new Set<string>();
  for (const track of tracks) {
    if (trackIds.has(track.id)) {
      validation("JSON import contains duplicate track ids.", { trackId: track.id });
    }
    if (actors.has(track.actor)) {
      validation("JSON import contains duplicate track actors.", { actor: track.actor });
    }
    trackIds.add(track.id);
    actors.add(track.actor);
  }

  return {
    tasks,
    dependencies: ensureArray(record.dependencies, "dependencies").map((dependency) => normalizeImportedDependency(dependency, now)),
    tags,
    taskTags: ensureArray(record.taskTags, "taskTags").map((taskTag) => normalizeImportedTaskTag(taskTag, now)),
    tracks,
    assignments: ensureArray(record.assignments, "assignments").map((assignment) => normalizeImportedAssignment(assignment, now))
  };
}

function normalizeImportedTask(input: unknown, now: string): Task {
  const record = requireRecord(input, "task");
  const parsed = addTaskSchema.parse({
    id: stringField(record, "id"),
    parentTaskId: optionalStringField(record, "parentTaskId"),
    title: stringField(record, "title"),
    description: optionalStringField(record, "description") ?? "",
    lifecycle: optionalStringField(record, "lifecycle") ?? "open",
    priority: numberField(record, "priority") ?? 2,
    size: optionalStringField(record, "size"),
    sourceDoc: optionalStringField(record, "sourceDoc"),
    sourceSection: optionalStringField(record, "sourceSection"),
    sourceAnchor: optionalStringField(record, "sourceAnchor"),
    sourceLine: numberField(record, "sourceLine"),
    sourceText: optionalStringField(record, "sourceText"),
    completionBar: optionalStringField(record, "completionBar")
  });
  return {
    id: normalizeId(parsed.id),
    parentTaskId: parsed.parentTaskId ? normalizeId(parsed.parentTaskId) : null,
    title: parsed.title,
    description: parsed.description,
    lifecycle: parsed.lifecycle,
    priority: parsed.priority,
    size: parsed.size,
    sourceDoc: parsed.sourceDoc,
    sourceSection: parsed.sourceSection,
    sourceAnchor: parsed.sourceAnchor,
    sourceLine: parsed.sourceLine,
    sourceText: parsed.sourceText,
    completionBar: parsed.completionBar,
    createdAt: optionalStringField(record, "createdAt") ?? now,
    updatedAt: optionalStringField(record, "updatedAt") ?? now,
    startedAt: optionalStringField(record, "startedAt"),
    finishedAt: optionalStringField(record, "finishedAt"),
    archivedAt: optionalStringField(record, "archivedAt"),
    version: numberField(record, "version") ?? 1
  };
}

function normalizeImportedDependency(input: unknown, now: string): Dependency {
  const record = requireRecord(input, "dependency");
  return {
    taskId: normalizeId(stringField(record, "taskId")),
    dependsOnTaskId: normalizeId(stringField(record, "dependsOnTaskId")),
    createdAt: optionalStringField(record, "createdAt") ?? now
  };
}

function normalizeImportedTag(input: unknown, now: string): Tag {
  const record = requireRecord(input, "tag");
  return {
    id: normalizeId(optionalStringField(record, "id") ?? slugify(stringField(record, "name"))),
    name: stringField(record, "name").trim(),
    color: optionalStringField(record, "color"),
    description: optionalStringField(record, "description"),
    sortOrder: numberField(record, "sortOrder") ?? 0,
    createdAt: optionalStringField(record, "createdAt") ?? now,
    updatedAt: optionalStringField(record, "updatedAt") ?? now,
    archivedAt: optionalStringField(record, "archivedAt")
  };
}

function normalizeImportedTaskTag(input: unknown, now: string): TaskTag {
  const record = requireRecord(input, "taskTag");
  return {
    taskId: normalizeId(stringField(record, "taskId")),
    tagId: normalizeId(stringField(record, "tagId")),
    createdAt: optionalStringField(record, "createdAt") ?? now
  };
}

function normalizeImportedTrack(input: unknown, now: string): Track {
  const record = requireRecord(input, "track");
  const actor = stringField(record, "actor").trim();
  return {
    id: normalizeId(optionalStringField(record, "id") ?? slugify(actor)),
    actor,
    name: optionalStringField(record, "name"),
    createdAt: optionalStringField(record, "createdAt") ?? now,
    updatedAt: optionalStringField(record, "updatedAt") ?? now,
    archivedAt: optionalStringField(record, "archivedAt")
  };
}

function normalizeImportedAssignment(input: unknown, now: string): TrackAssignment {
  const record = requireRecord(input, "assignment");
  return {
    trackId: normalizeId(stringField(record, "trackId")),
    taskId: normalizeId(stringField(record, "taskId")),
    position: optionalStringField(record, "position") ?? "000001",
    assignedAt: optionalStringField(record, "assignedAt") ?? now
  };
}

function validateDependencyGraph(tasks: Task[], dependencies: Dependency[]): void {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Set<string>();
  for (const dependency of dependencies) {
    if (!taskById.has(dependency.taskId)) {
      validation("Dependency references a missing task.", dependency);
    }
    if (!taskById.has(dependency.dependsOnTaskId)) {
      validation("Dependency references a missing dependency task.", dependency);
    }
    if (dependency.taskId === dependency.dependsOnTaskId) {
      validation("A task cannot depend on itself.", dependency);
    }
    const key = dependencyKey(dependency.taskId, dependency.dependsOnTaskId);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    assertNoCycle(dependency.taskId, dependency.dependsOnTaskId, dependencies.filter((edge) => dependencyKey(edge.taskId, edge.dependsOnTaskId) !== key));
    if (isDescendant(dependency.taskId, dependency.dependsOnTaskId, tasks)) {
      validation("A task cannot depend on one of its descendants in V1.", dependency);
    }
  }
}

function dependencyKey(taskId: string, dependsOnTaskId: string): string {
  return `${taskId}\u0000${dependsOnTaskId}`;
}

function taskTagKey(taskId: string, tagId: string): string {
  return `${taskId}\u0000${tagId}`;
}

function ensureArray(value: unknown, field: string): unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    validation(`JSON import field must be an array: ${field}`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    validation(`JSON import ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    validation(`JSON import field must be a non-empty string: ${field}`);
  }
  return value;
}

function optionalStringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    validation(`JSON import field must be a string or null: ${field}`);
  }
  return value;
}

function numberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    validation(`JSON import field must be a number: ${field}`);
  }
  return value;
}
