import { randomUUID } from "node:crypto";
import {
  assertDependencySetHasNoCycle,
  assertNoCycle,
  assertNoParentCycle,
  buildHierarchyIndexes,
  buildGraphIndexes,
  computeDepths,
  computeHierarchyRollups,
  computeTransitiveDependents,
  isDescendant,
  listDescendantIds,
  sortTaskViews
} from "./graph.js";
import type { AppStore, RepositorySet } from "./store.js";
import {
  addTaskSchema,
  DEFAULT_PROJECT_ID,
  editTaskSchema,
  nowIso,
  normalizeId,
  slugify,
  type AddProjectInput,
  type AddCommentInput,
  type AddInstructionInput,
  type AddQueueFeedInput,
  type AddSavedViewInput,
  type Activity,
  type Comment,
  type AddTagInput,
  type AddTaskInput,
  type AddTrackInput,
  type Dependency,
  type DependencyExplanation,
  type EditTaskInput,
  type EditCommentInput,
  type EditInstructionInput,
  type EditQueueFeedInput,
  type EditSavedViewInput,
  type ImportIssue,
  type Instruction,
  type InstructionMatch,
  type MatcherPreview,
  type ImportResult,
  type JsonExport,
  type JsonImportResult,
  type MatcherFieldValueSuggestion,
  type Priority,
  type Project,
  type QueueFeed,
  type ActivityListOptions,
  type ActivityView,
  type ReleaseTaskInput,
  type RollupStatus,
  type SavedView,
  type SourceSectionCoverage,
  type Tag,
  type TagCoverage,
  type Task,
  type TaskTag,
  type TaskListFilters,
  type TaskPathSummary,
  type TaskView,
  type Track,
  type TrackAssignment
} from "./types.js";
import { conflict, notFound, validation } from "./errors.js";
import { parseMarkdownTracker } from "./markdown-import.js";
import { exportMarkdown, exportStoreJson } from "./exporters.js";
import { matcherQueryGrammar, matchMatcherQuery, validateMatcherQuery } from "./matcher-query.js";

export interface Services {
  projects: ProjectService;
  tasks: TaskService;
  dependencies: DependencyService;
  comments: CommentService;
  tags: TagService;
  tracks: TrackService;
  instructions: InstructionService;
  views: SavedViewService;
  feeds: QueueFeedService;
  query: QueryService;
  imports: ImportService;
  exports: ExportService;
  activity: ActivityService;
}

export interface ServiceOptions {
  actor?: string | null;
  machine?: string | null;
  projectId?: string | null;
}

export function createServices(store: AppStore, options: ServiceOptions = {}): Services {
  const projectId = options.projectId ? normalizeId(options.projectId) : DEFAULT_PROJECT_ID;
  const activity = new ActivityService(store, options.machine ?? null, options.actor ?? null, projectId);
  const projects = new ProjectService(store, activity);
  const query = new QueryService(store, projectId);
  const tasks = new TaskService(store, activity, projectId);
  const dependencies = new DependencyService(store, activity, projectId);
  const comments = new CommentService(store, activity, projectId);
  const tags = new TagService(store, activity, projectId);
  const tracks = new TrackService(store, activity, query, projectId);
  const instructions = new InstructionService(store, activity, query, projectId);
  const views = new SavedViewService(store, activity, query, projectId);
  const feeds = new QueueFeedService(store, activity, query, projectId);
  const imports = new ImportService(store, activity, tasks, tracks, projectId);
  const exports = new ExportService(store, projectId);
  return { projects, tasks, dependencies, comments, tags, tracks, instructions, views, feeds, query, imports, exports, activity };
}

function makeActivity(projectId: string | null, type: string, subjectType: Activity["subjectType"], subjectId: string | null, message: string, data: Record<string, unknown>, provenance: { machine: string; actor: string }): Activity {
  return {
    projectId,
    id: randomUUID(),
    type,
    subjectType,
    subjectId,
    message,
    data,
    machine: provenance.machine,
    actor: provenance.actor,
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
  constructor(private readonly store: AppStore, private readonly machine: string | null, private readonly actor: string | null, private readonly projectId: string) {}

  async record(type: string, subjectType: Activity["subjectType"], subjectId: string | null, message: string, data: Record<string, unknown> = {}): Promise<Activity> {
    const activity = this.make(this.projectId, type, subjectType, subjectId, message, data);
    await this.store.activity.append(activity);
    return activity;
  }

  make(projectId: string | null, type: string, subjectType: Activity["subjectType"], subjectId: string | null, message: string, data: Record<string, unknown> = {}): Activity {
    return makeActivity(projectId, type, subjectType, subjectId, message, data, this.provenance());
  }

  provenance(): { machine: string; actor: string } {
    const machine = this.machine?.trim();
    const actor = this.actor?.trim();
    if (!machine || !actor) {
      validation("Machine and actor are required for mutating commands.");
    }
    return { machine, actor };
  }

  async list(options: number | ActivityListOptions = 100): Promise<ActivityView[]> {
    const normalized = typeof options === "number" ? { limit: options } : options;
    const limit = normalizeQueryLimit(normalized.limit ?? 100);
    const rawLimit = normalized.where?.trim() ? Math.max(limit * 10, 500) : limit;
    let activity = await this.store.activity.list(this.projectId, rawLimit);
    const query = new QueryService(this.store, this.projectId);
    const tasks = await query.list({ includeArchived: true, includeFinished: true });
    const taskById = new Map(tasks.map((task) => [task.id, task]));

    if (normalized.where?.trim()) {
      const dependencies = await this.store.dependencies.list(this.projectId);
      const matchingTaskIds = new Set(matchMatcherQuery(normalized.where, tasks, dependencies).map((match) => match.task.id));
      activity = activity.filter((item) => {
        const taskId = activityTaskId(item);
        return Boolean(taskId && matchingTaskIds.has(taskId));
      }).slice(0, limit);
    }

    return activity.map((item) => {
      const taskId = activityTaskId(item);
      return { ...item, task: taskId ? taskById.get(taskId) ?? null : null };
    });
  }
}

export class ProjectService {
  constructor(private readonly store: AppStore, private readonly activity: ActivityService) {}

  async add(input: AddProjectInput): Promise<Project> {
    const id = normalizeId(input.id);
    const now = nowIso();
    const project: Project = {
      id,
      name: input.name?.trim() || id,
      description: input.description ?? null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    };
    await this.store.transaction(async (repos) => {
      if (await repos.projects.get(id)) {
        conflict(`Project already exists: ${id}`);
      }
      await repos.projects.create(project);
      await repos.activity.append(this.activity.make(null, "project.created", "project", id, `Created project ${id}`, { name: project.name }));
    });
    return project;
  }

  async archive(idInput: string): Promise<Project> {
    const id = normalizeId(idInput);
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const project = await repos.projects.get(id) ?? notFound("project", id);
      const next = { ...project, archivedAt: now, updatedAt: now };
      await repos.projects.update(next);
      await repos.activity.append(this.activity.make(null, "project.archived", "project", id, `Archived project ${id}`));
      return next;
    });
  }

  async restore(idInput: string): Promise<Project> {
    const id = normalizeId(idInput);
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const project = await repos.projects.get(id) ?? notFound("project", id);
      const next = { ...project, archivedAt: null, updatedAt: now };
      await repos.projects.update(next);
      await repos.activity.append(this.activity.make(null, "project.restored", "project", id, `Restored project ${id}`));
      return next;
    });
  }

  async list(): Promise<Project[]> {
    return this.store.projects.list();
  }
}

export class TaskService {
  constructor(private readonly store: AppStore, private readonly activity: ActivityService, private readonly projectId: string) {}

  async add(input: AddTaskInput): Promise<Task> {
    const parsed = addTaskSchema.parse(input);
    const id = normalizeId(parsed.id);
    const parentTaskId = parsed.parentTaskId ? normalizeId(parsed.parentTaskId) : null;
    const now = nowIso();
    const task: Task = {
      projectId: this.projectId,
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
      if (await repos.tasks.get(this.projectId, task.id)) {
        conflict(`Task already exists: ${task.id}`);
      }
      const parent = await ensureParentTask(repos, this.projectId, task.id, task.parentTaskId);
      ensureFinishedParentDoesNotContainUnfinishedChild(parent, task);
      await repos.tasks.create(task);
      await repos.activity.append(this.activity.make(this.projectId, "task.created", "task", task.id, `Created ${task.id}`, { title: task.title }));
    });

    return task;
  }

  async addMany(inputs: AddTaskInput[]): Promise<Task[]> {
    const now = nowIso();
    const tasks = inputs.map((input) => {
      const parsed = addTaskSchema.parse(input);
      const id = normalizeId(parsed.id);
      const parentTaskId = parsed.parentTaskId ? normalizeId(parsed.parentTaskId) : null;
      return {
        projectId: this.projectId,
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
      } satisfies Task;
    });
    if (tasks.length === 0) return [];

    const byInputId = new Set<string>();
    for (const task of tasks) {
      if (byInputId.has(task.id)) {
        conflict(`Task already exists: ${task.id}`);
      }
      byInputId.add(task.id);
    }

    await this.store.transaction(async (repos) => {
      const existing = await repos.tasks.list(this.projectId);
      const taskById = new Map(existing.map((task) => [task.id, task]));
      for (const task of tasks) {
        if (taskById.has(task.id)) {
          conflict(`Task already exists: ${task.id}`);
        }
        taskById.set(task.id, task);
      }
      const combined = [...taskById.values()];
      for (const task of tasks) {
        const parent = task.parentTaskId ? taskById.get(task.parentTaskId) ?? notFound("task", task.parentTaskId) : null;
        if (parent?.archivedAt) {
          validation("Archived tasks cannot be parents in V1.", { taskId: task.id, parentTaskId: task.parentTaskId });
        }
        if (task.parentTaskId) {
          assertNoParentCycle(task.id, task.parentTaskId, combined);
        }
        ensureFinishedParentDoesNotContainUnfinishedChild(parent, task);
      }
      for (const task of tasks) {
        await repos.tasks.create(task);
      }
      await repos.activity.append(this.activity.make(this.projectId, "task.batch_created", "project", this.projectId, `Created ${tasks.length} tasks`, { count: tasks.length }));
    });

    return tasks;
  }

  async upsertFromImport(input: AddTaskInput): Promise<"created" | "updated" | "skipped"> {
    const parsed = addTaskSchema.parse(input);
    const id = normalizeId(parsed.id);
    const parentTaskId = parsed.parentTaskId ? normalizeId(parsed.parentTaskId) : null;
    const existing = await this.store.tasks.get(this.projectId, id);
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
    return (await this.store.tasks.get(this.projectId, normalizeId(id))) ?? notFound("task", id);
  }

  async edit(id: string, input: EditTaskInput): Promise<Task> {
    const parsed = editTaskSchema.parse(input);
    const taskId = normalizeId(id);
    const parentTaskId = Object.hasOwn(parsed, "parentTaskId") ? (parsed.parentTaskId ? normalizeId(parsed.parentTaskId) : null) : undefined;
    const now = nowIso();
    const updated = await this.store.transaction(async (repos) => {
      const existing = await repos.tasks.get(this.projectId, taskId) ?? notFound("task", taskId);
      let parent: Task | null | undefined;
      if (parentTaskId !== undefined) {
        parent = await ensureParentTask(repos, this.projectId, taskId, parentTaskId);
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
      if (next.parentTaskId && parent === undefined) {
        parent = await repos.tasks.get(this.projectId, next.parentTaskId) ?? notFound("task", next.parentTaskId);
      }
      ensureFinishedParentDoesNotContainUnfinishedChild(parent ?? null, next);
      await ensureTaskCanBeFinished(repos, next);
      await repos.tasks.update(next);
      await repos.activity.append(this.activity.make(this.projectId, "task.updated", "task", taskId, `Updated ${taskId}`, { input: parsed }));
      if (existing.lifecycle !== next.lifecycle) {
        await repos.activity.append(this.activity.make(this.projectId, `task.${next.lifecycle}`, "task", taskId, `Set ${taskId} ${next.lifecycle}`, { from: existing.lifecycle, to: next.lifecycle }));
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

  async release(id: string, input: ReleaseTaskInput): Promise<Task> {
    const taskId = normalizeId(id);
    const reason = normalizeCommentBody(input.reason);
    const provenance = this.activity.provenance();
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const task = await repos.tasks.get(this.projectId, taskId) ?? notFound("task", taskId);
      if (task.archivedAt) {
        validation("Archived tasks cannot be released.", { taskId });
      }
      if (task.lifecycle !== "started") {
        validation("Only started tasks can be released.", { taskId, lifecycle: task.lifecycle });
      }
      const comment: Comment = {
        projectId: this.projectId,
        id: randomUUID(),
        taskId,
        machine: provenance.machine,
        actor: provenance.actor,
        body: `Released: ${reason}`,
        createdAt: now,
        updatedAt: now,
        archivedAt: null
      };
      const updated: Task = {
        ...task,
        lifecycle: "open",
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
        version: task.version + 1
      };
      await repos.tasks.update(updated);
      await repos.comments.create(comment);
      await repos.activity.append(this.activity.make(this.projectId, "comment.created", "comment", comment.id, `Commented on ${taskId}`, { taskId }));
      await repos.activity.append(this.activity.make(this.projectId, "task.released", "task", taskId, `Released ${taskId}`, { from: "started", to: "open", reason, commentId: comment.id, taskId }));
      return updated;
    });
  }

  async archive(id: string): Promise<Task> {
    const taskId = normalizeId(id);
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const task = await repos.tasks.get(this.projectId, taskId) ?? notFound("task", taskId);
      const updated = { ...task, archivedAt: now, updatedAt: now, version: task.version + 1 };
      await repos.tasks.update(updated);
      await repos.activity.append(this.activity.make(this.projectId, "task.archived", "task", taskId, `Archived ${taskId}`));
      return updated;
    });
  }

  async restore(id: string): Promise<Task> {
    const taskId = normalizeId(id);
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const task = await repos.tasks.get(this.projectId, taskId) ?? notFound("task", taskId);
      if (!task.archivedAt) {
        return task;
      }
      if (task.parentTaskId) {
        const parent = await repos.tasks.get(this.projectId, task.parentTaskId);
        if (parent?.archivedAt) {
          validation("Cannot restore a task while its parent is archived.", { taskId, parentTaskId: parent.id });
        }
      }
      const updated = { ...task, archivedAt: null, updatedAt: now, version: task.version + 1 };
      const tasks = await repos.tasks.list(this.projectId);
      validateFinishedParents(tasks.map((candidate) => candidate.id === taskId ? updated : candidate));
      await repos.tasks.update(updated);
      await repos.activity.append(this.activity.make(this.projectId, "task.restored", "task", taskId, `Restored ${taskId}`));
      return updated;
    });
  }

  async delete(id: string): Promise<void> {
    const taskId = normalizeId(id);
    await this.store.transaction(async (repos) => {
      const task = await repos.tasks.get(this.projectId, taskId) ?? notFound("task", taskId);
      const dependents = await repos.dependencies.listDependents(this.projectId, taskId);
      if (dependents.length > 0) {
        conflict("Cannot hard delete a task with dependents.", { taskId, dependents });
      }
      await repos.tasks.delete(this.projectId, task.id);
      await repos.activity.append(this.activity.make(this.projectId, "task.deleted", "task", taskId, `Deleted ${taskId}`));
    });
  }
}

export class DependencyService {
  constructor(private readonly store: AppStore, private readonly activity: ActivityService, private readonly projectId: string) {}

  async add(taskIdInput: string, dependsOnTaskIdInput: string): Promise<Dependency> {
    const taskId = normalizeId(taskIdInput);
    const dependsOnTaskId = normalizeId(dependsOnTaskIdInput);
    const createdAt = nowIso();
    const dependency: Dependency = { projectId: this.projectId, taskId, dependsOnTaskId, createdAt };

    await this.store.transaction(async (repos) => {
      await ensureTaskPair(repos, this.projectId, taskId, dependsOnTaskId);
      if (repos.dependencies.hasDependency && repos.dependencies.hasDependencyPath && repos.dependencies.hasHierarchyPath) {
        if (await repos.dependencies.hasDependency(this.projectId, taskId, dependsOnTaskId)) {
          return;
        }
        if (await repos.dependencies.hasDependencyPath(this.projectId, dependsOnTaskId, taskId)) {
          conflict("Dependency would create a cycle.", { taskId });
        }
        if (await repos.dependencies.hasHierarchyPath(this.projectId, taskId, dependsOnTaskId)) {
          validation("A task cannot depend on one of its descendants because hierarchy already gates parent completion.", {
            projectId: this.projectId,
            taskId,
            dependsOnTaskId,
          });
        }
        if (await repos.dependencies.hasHierarchyPath(this.projectId, dependsOnTaskId, taskId)) {
          validation("A task cannot depend on one of its ancestors because that would deadlock hierarchy completion.", {
            projectId: this.projectId,
            taskId,
            dependsOnTaskId,
          });
        }
        await repos.dependencies.add(dependency);
        await repos.activity.append(this.activity.make(this.projectId, "dependency.added", "task", taskId, `${taskId} now depends on ${dependsOnTaskId}`, { taskId, dependsOnTaskId }));
        return;
      }
      const dependencies = await repos.dependencies.list(this.projectId);
      const tasks = await repos.tasks.list(this.projectId);
      assertNoCycle(taskId, dependsOnTaskId, dependencies);
      assertNoHierarchyDependency(taskId, dependsOnTaskId, tasks);
      if (dependencies.some((edge) => edge.taskId === taskId && edge.dependsOnTaskId === dependsOnTaskId)) {
        return;
      }
      await repos.dependencies.add(dependency);
      await repos.activity.append(this.activity.make(this.projectId, "dependency.added", "task", taskId, `${taskId} now depends on ${dependsOnTaskId}`, { taskId, dependsOnTaskId }));
    });

    return dependency;
  }

  async addMany(inputs: Array<{ taskId: string; dependsOnTaskId: string }>): Promise<Dependency[]> {
    const createdAt = nowIso();
    const requested = inputs.map((input) => ({
      projectId: this.projectId,
      taskId: normalizeId(input.taskId),
      dependsOnTaskId: normalizeId(input.dependsOnTaskId),
      createdAt
    }));
    const unique = new Map<string, Dependency>();
    for (const dependency of requested) {
      unique.set(dependencyKey(dependency.taskId, dependency.dependsOnTaskId), dependency);
    }
    const dependencies = [...unique.values()];
    if (dependencies.length === 0) return [];

    const added: Dependency[] = [];
    await this.store.transaction(async (repos) => {
      const tasks = await repos.tasks.list(this.projectId);
      const taskById = new Map(tasks.map((task) => [task.id, task]));
      const existing = await repos.dependencies.list(this.projectId);
      const existingKeys = new Set(existing.map((edge) => dependencyKey(edge.taskId, edge.dependsOnTaskId)));
      const candidates = dependencies.filter((dependency) => !existingKeys.has(dependencyKey(dependency.taskId, dependency.dependsOnTaskId)));
      for (const dependency of candidates) {
        const task = taskById.get(dependency.taskId) ?? notFound("task", dependency.taskId);
        const dependencyTask = taskById.get(dependency.dependsOnTaskId) ?? notFound("task", dependency.dependsOnTaskId);
        if (task.archivedAt) {
          validation("Archived tasks cannot receive new dependencies in V1.", { taskId: task.id });
        }
        if (dependencyTask.archivedAt) {
          validation("Archived tasks cannot be dependencies in V1.", { dependsOnTaskId: dependencyTask.id });
        }
      }
      validateDependencyGraph(tasks, [...existing, ...candidates]);
      if (repos.dependencies.addMany) {
        await repos.dependencies.addMany(candidates);
      } else {
        for (const dependency of candidates) {
          await repos.dependencies.add(dependency);
        }
      }
      if (candidates.length > 0) {
        await repos.activity.append(this.activity.make(this.projectId, "dependency.batch_added", "project", this.projectId, `Added ${candidates.length} dependencies`, { count: candidates.length }));
      }
      added.push(...candidates);
    });
    return added;
  }

  async remove(taskIdInput: string, dependsOnTaskIdInput: string): Promise<void> {
    const taskId = normalizeId(taskIdInput);
    const dependsOnTaskId = normalizeId(dependsOnTaskIdInput);
    await this.store.transaction(async (repos) => {
      await repos.dependencies.remove(this.projectId, taskId, dependsOnTaskId);
      await repos.activity.append(this.activity.make(this.projectId, "dependency.removed", "task", taskId, `${taskId} no longer depends on ${dependsOnTaskId}`, { taskId, dependsOnTaskId }));
    });
  }

  async set(taskIdInput: string, dependencyIdsInput: string[]): Promise<Dependency[]> {
    const taskId = normalizeId(taskIdInput);
    const dependencyIds = [...new Set(dependencyIdsInput.map(normalizeId))];
    const createdAt = nowIso();
    const dependencies = dependencyIds.map((dependsOnTaskId) => ({ projectId: this.projectId, taskId, dependsOnTaskId, createdAt }));

    await this.store.transaction(async (repos) => {
      if (!await repos.tasks.get(this.projectId, taskId)) {
        notFound("task", taskId);
      }
      for (const dependsOnTaskId of dependencyIds) {
        const dependencyTask = await repos.tasks.get(this.projectId, dependsOnTaskId) ?? notFound("task", dependsOnTaskId);
        if (dependencyTask.archivedAt) {
          validation("Archived tasks cannot be dependencies in V1.", { dependsOnTaskId });
        }
      }
      const allDependencies = await repos.dependencies.list(this.projectId);
      const tasks = await repos.tasks.list(this.projectId);
      assertDependencySetHasNoCycle(taskId, dependencyIds, allDependencies);
      for (const dependsOnTaskId of dependencyIds) {
        assertNoHierarchyDependency(taskId, dependsOnTaskId, tasks);
      }
      await repos.dependencies.replaceForTask(this.projectId, taskId, dependencies);
      await repos.activity.append(this.activity.make(this.projectId, "dependency.set", "task", taskId, `Set dependencies for ${taskId}`, { dependencyIds }));
    });

    return dependencies;
  }

  async list(taskIdInput: string): Promise<Dependency[]> {
    return this.store.dependencies.listForTask(this.projectId, normalizeId(taskIdInput));
  }
}

export class CommentService {
  constructor(private readonly store: AppStore, private readonly activity: ActivityService, private readonly projectId: string) {}

  async add(taskIdInput: string, input: AddCommentInput): Promise<Comment> {
    const taskId = normalizeId(taskIdInput);
    const body = normalizeCommentBody(input.body);
    const provenance = this.activity.provenance();
    const now = nowIso();
    const comment: Comment = {
      projectId: this.projectId,
      id: randomUUID(),
      taskId,
      machine: provenance.machine,
      actor: provenance.actor,
      body,
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    };
    await this.store.transaction(async (repos) => {
      await repos.tasks.get(this.projectId, taskId) ?? notFound("task", taskId);
      await repos.comments.create(comment);
      await repos.activity.append(this.activity.make(this.projectId, "comment.created", "comment", comment.id, `Commented on ${taskId}`, { taskId }));
    });
    return comment;
  }

  async list(taskIdInput: string, options: { includeArchived?: boolean | undefined; limit?: number | undefined } = {}): Promise<Comment[]> {
    const taskId = normalizeId(taskIdInput);
    await this.store.tasks.get(this.projectId, taskId) ?? notFound("task", taskId);
    const comments = (await this.store.comments.listForTask(this.projectId, taskId))
      .filter((comment) => options.includeArchived || !comment.archivedAt);
    if (options.limit === undefined) {
      return comments;
    }
    const limit = normalizeQueryLimit(options.limit);
    return comments.slice(Math.max(0, comments.length - limit));
  }

  async get(idInput: string): Promise<Comment> {
    const id = normalizeCommentId(idInput);
    return await this.store.comments.get(this.projectId, id) ?? notFound("comment", id);
  }

  async edit(idInput: string, input: EditCommentInput): Promise<Comment> {
    const id = normalizeCommentId(idInput);
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const existing = await repos.comments.get(this.projectId, id) ?? notFound("comment", id);
      const next: Comment = {
        ...existing,
        body: input.body === undefined ? existing.body : normalizeCommentBody(input.body),
        updatedAt: now
      };
      await repos.comments.update(next);
      await repos.activity.append(this.activity.make(this.projectId, "comment.updated", "comment", id, `Updated comment on ${next.taskId}`, { taskId: next.taskId }));
      return next;
    });
  }

  async archive(idInput: string): Promise<Comment> {
    const id = normalizeCommentId(idInput);
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const existing = await repos.comments.get(this.projectId, id) ?? notFound("comment", id);
      const next = { ...existing, archivedAt: now, updatedAt: now };
      await repos.comments.update(next);
      await repos.activity.append(this.activity.make(this.projectId, "comment.archived", "comment", id, `Archived comment on ${existing.taskId}`, { taskId: existing.taskId }));
      return next;
    });
  }

  async restore(idInput: string): Promise<Comment> {
    const id = normalizeCommentId(idInput);
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const existing = await repos.comments.get(this.projectId, id) ?? notFound("comment", id);
      const next = { ...existing, archivedAt: null, updatedAt: now };
      await repos.comments.update(next);
      await repos.activity.append(this.activity.make(this.projectId, "comment.restored", "comment", id, `Restored comment on ${existing.taskId}`, { taskId: existing.taskId }));
      return next;
    });
  }
}

export class TagService {
  constructor(private readonly store: AppStore, private readonly activity: ActivityService, private readonly projectId: string) {}

  async add(input: AddTagInput): Promise<Tag> {
    const now = nowIso();
    const tag: Tag = {
      projectId: this.projectId,
      id: input.id ? normalizeId(input.id) : normalizeId(slugify(input.name)),
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
      if (await repos.tags.get(this.projectId, tag.id)) {
        conflict(`Tag already exists: ${tag.id}`);
      }
      if (await repos.tags.findByName(this.projectId, tag.name)) {
        conflict(`Tag name already exists: ${tag.name}`);
      }
      await repos.tags.create(tag);
      await repos.activity.append(this.activity.make(this.projectId, "tag.created", "tag", tag.id, `Created tag ${tag.name}`));
    });
    return tag;
  }

  async edit(id: string, input: Partial<AddTagInput>): Promise<Tag> {
    const tagId = normalizeId(id);
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const existing = await repos.tags.get(this.projectId, tagId) ?? notFound("tag", tagId);
      const next: Tag = {
        ...existing,
        name: input.name?.trim() ?? existing.name,
        color: Object.hasOwn(input, "color") ? input.color ?? null : existing.color,
        description: Object.hasOwn(input, "description") ? input.description ?? null : existing.description,
        sortOrder: input.sortOrder ?? existing.sortOrder,
        updatedAt: now
      };
      await repos.tags.update(next);
      await repos.activity.append(this.activity.make(this.projectId, "tag.updated", "tag", tagId, `Updated tag ${next.name}`));
      return next;
    });
  }

  async archive(id: string): Promise<Tag> {
    const tagId = normalizeId(id);
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const tag = await repos.tags.get(this.projectId, tagId) ?? notFound("tag", tagId);
      const next = { ...tag, archivedAt: now, updatedAt: now };
      await repos.tags.update(next);
      await repos.activity.append(this.activity.make(this.projectId, "tag.archived", "tag", tagId, `Archived tag ${tag.name}`));
      return next;
    });
  }

  async assign(taskIdInput: string, tagIdsOrNames: string[]): Promise<void> {
    const taskId = normalizeId(taskIdInput);
    const createdAt = nowIso();
    await this.store.transaction(async (repos) => {
      await repos.tasks.get(this.projectId, taskId) ?? notFound("task", taskId);
      const taskTags: Array<{ taskTag: TaskTag; tag: Tag }> = [];
      for (const tagIdOrName of tagIdsOrNames) {
        const tag = await repos.tags.get(this.projectId, normalizeId(tagIdOrName)) ?? await repos.tags.findByName(this.projectId, tagIdOrName) ?? notFound("tag", tagIdOrName);
        if (tag.archivedAt) {
          validation("Archived tags cannot be assigned.", { tagId: tag.id });
        }
        if (repos.tags.hasTaskTag && await repos.tags.hasTaskTag(this.projectId, taskId, tag.id)) {
          continue;
        }
        taskTags.push({ taskTag: { projectId: this.projectId, taskId, tagId: tag.id, createdAt }, tag });
      }
      if (taskTags.length === 0) {
        return;
      }
      if (repos.tags.addTaskTags) {
        await repos.tags.addTaskTags(taskTags);
      } else {
        for (const { taskTag } of taskTags) {
          await repos.tags.addTaskTag(taskTag);
        }
      }
      await repos.activity.append(this.activity.make(this.projectId, "tag.assigned", "task", taskId, `Assigned tags to ${taskId}`, { tags: tagIdsOrNames }));
    });
  }

  async assignMany(inputs: Array<{ taskId: string; tagIdsOrNames: string[] }>): Promise<void> {
    const createdAt = nowIso();
    const normalized = inputs
      .map((input) => ({
        taskId: normalizeId(input.taskId),
        tagIdsOrNames: input.tagIdsOrNames.filter((tag) => tag.trim().length > 0),
      }))
      .filter((input) => input.tagIdsOrNames.length > 0);
    if (normalized.length === 0) return;

    await this.store.transaction(async (repos) => {
      const uniqueTaskIds = [...new Set(normalized.map((input) => input.taskId))];
      const taskIds = uniqueTaskIds.length <= 100
        ? new Set((await Promise.all(uniqueTaskIds.map(async (taskId) =>
          await repos.tasks.get(this.projectId, taskId) ?? notFound("task", taskId)
        ))).map((task) => task.id))
        : new Set((await repos.tasks.list(this.projectId)).map((task) => task.id));
      const uniqueTagRefs = [...new Set(normalized.flatMap((input) => input.tagIdsOrNames))];
      const tags = uniqueTagRefs.length <= 100
        ? await Promise.all(uniqueTagRefs.map(async (tagIdOrName) =>
          await repos.tags.get(this.projectId, normalizeId(tagIdOrName)) ?? await repos.tags.findByName(this.projectId, tagIdOrName) ?? notFound("tag", tagIdOrName)
        ))
        : await repos.tags.list(this.projectId);
      const tagsById = new Map(tags.map((tag) => [tag.id, tag]));
      const tagsByName = new Map(tags.map((tag) => [tag.name, tag]));
      const assigned = new Set<string>();
      const taskTags: Array<{ taskTag: TaskTag; tag: Tag }> = [];

      for (const input of normalized) {
        if (!taskIds.has(input.taskId)) {
          notFound("task", input.taskId);
        }
        for (const tagIdOrName of input.tagIdsOrNames) {
          const tag = tagsById.get(normalizeId(tagIdOrName)) ?? tagsByName.get(tagIdOrName) ?? notFound("tag", tagIdOrName);
          if (tag.archivedAt) {
            validation("Archived tags cannot be assigned.", { tagId: tag.id });
          }
          const key = `${input.taskId}\0${tag.id}`;
          if (assigned.has(key)) continue;
          assigned.add(key);
          taskTags.push({
            taskTag: { projectId: this.projectId, taskId: input.taskId, tagId: tag.id, createdAt },
            tag,
          });
        }
      }

      let newTaskTags = taskTags;
      if (repos.tags.hasTaskTag && taskTags.length <= 100) {
        const existing = await Promise.all(taskTags.map(async (item) =>
          await repos.tags.hasTaskTag!(this.projectId, item.taskTag.taskId, item.taskTag.tagId)
        ));
        newTaskTags = taskTags.filter((_item, index) => !existing[index]);
      }
      if (newTaskTags.length === 0) {
        return;
      }

      if (repos.tags.addTaskTags) {
        await repos.tags.addTaskTags(newTaskTags);
      } else {
        for (const { taskTag } of newTaskTags) {
          await repos.tags.addTaskTag(taskTag);
        }
      }
      await repos.activity.append(this.activity.make(this.projectId, "tag.batch_assigned", "project", this.projectId, `Assigned ${newTaskTags.length} task tags`, { count: newTaskTags.length }));
    });
  }

  async remove(taskIdInput: string, tagIdOrName: string): Promise<void> {
    const taskId = normalizeId(taskIdInput);
    await this.store.transaction(async (repos) => {
      const tag = await repos.tags.get(this.projectId, normalizeId(tagIdOrName)) ?? await repos.tags.findByName(this.projectId, tagIdOrName) ?? notFound("tag", tagIdOrName);
      const hasTag = repos.tags.hasTaskTag
        ? await repos.tags.hasTaskTag(this.projectId, taskId, tag.id)
        : (await repos.tags.listTaskTags(this.projectId)).some((taskTag) => taskTag.taskId === taskId && taskTag.tagId === tag.id);
      if (!hasTag) return;
      await repos.tags.removeTaskTag(this.projectId, taskId, tag.id);
      await repos.activity.append(this.activity.make(this.projectId, "tag.removed", "task", taskId, `Removed tag ${tag.name} from ${taskId}`, { tagId: tag.id }));
    });
  }

  async list(): Promise<Tag[]> {
    return this.store.tags.list(this.projectId);
  }
}

export class TrackService {
  constructor(private readonly store: AppStore, private readonly activity: ActivityService, private readonly query: QueryService, private readonly projectId: string) {}

  async add(input: AddTrackInput): Promise<Track> {
    const now = nowIso();
    const provenance = this.activity.provenance();
    const identity = parseActorRef(input.machine ? `${input.machine}:${input.actor}` : input.actor, provenance.machine);
    const track: Track = {
      projectId: this.projectId,
      id: input.id ? normalizeId(input.id) : slugify(`${identity.machine}:${identity.actor}`),
      machine: identity.machine,
      actor: identity.actor,
      name: input.name ?? null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    };
    await this.store.transaction(async (repos) => {
      if (await repos.tracks.get(this.projectId, track.id)) {
        conflict(`Track already exists: ${track.id}`);
      }
      if (await repos.tracks.findByActor(this.projectId, identity.machine, identity.actor)) {
        conflict(`Track actor already exists: ${formatActorRef(identity)}`);
      }
      await repos.tracks.create(track);
      await repos.activity.append(this.activity.make(this.projectId, "track.created", "track", track.id, `Created actor queue ${formatActorRef(track)}`));
    });
    return track;
  }

  async rename(actorOrId: string, name: string): Promise<Track> {
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const track = await findTrack(repos, this.projectId, actorOrId, this.activity.provenance().machine);
      const next = { ...track, name, updatedAt: now };
      await repos.tracks.update(next);
      await repos.activity.append(this.activity.make(this.projectId, "track.renamed", "track", track.id, `Renamed actor queue ${formatActorRef(track)}`, { name }));
      return next;
    });
  }

  async archive(actorOrId: string): Promise<Track> {
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const track = await findTrack(repos, this.projectId, actorOrId, this.activity.provenance().machine);
      const next = { ...track, archivedAt: now, updatedAt: now };
      await repos.tracks.update(next);
      await repos.activity.append(this.activity.make(this.projectId, "track.archived", "track", track.id, `Archived actor queue ${formatActorRef(track)}`));
      return next;
    });
  }

  async assign(actorOrId: string, taskIdInput: string): Promise<TrackAssignment> {
    const taskId = normalizeId(taskIdInput);
    const assignedAt = nowIso();
    return this.store.transaction(async (repos) => {
      const track = await findTrack(repos, this.projectId, actorOrId, this.activity.provenance().machine);
      const task = await repos.tasks.get(this.projectId, taskId) ?? notFound("task", taskId);
      if (track.archivedAt) {
        validation("Archived tracks cannot receive assignments.", { trackId: track.id });
      }
      if (task.archivedAt) {
        validation("Archived tasks cannot be assigned.", { taskId });
      }
      if (task.lifecycle === "finished") {
        validation("Finished tasks cannot be assigned.", { taskId });
      }
      const assignments = await repos.tracks.listAssignments(this.projectId);
      if (assignments.some((assignment) => assignment.taskId === taskId)) {
        conflict("Task is already assigned to an actor queue.", { taskId });
      }
      const trackAssignments = assignments.filter((assignment) => assignment.trackId === track.id);
      const position = String(trackAssignments.length + 1).padStart(6, "0");
      const assignment = { projectId: this.projectId, trackId: track.id, taskId, position, assignedAt };
      await repos.tracks.assign(assignment);
      await repos.activity.append(this.activity.make(this.projectId, "track.assigned", "track", track.id, `Assigned ${taskId} to ${formatActorRef(track)}`, { taskId, machine: track.machine, actor: track.actor }));
      return assignment;
    });
  }

  async unassign(actorOrId: string, taskIdInput: string): Promise<void> {
    const taskId = normalizeId(taskIdInput);
    await this.store.transaction(async (repos) => {
      const track = await findTrack(repos, this.projectId, actorOrId, this.activity.provenance().machine);
      await repos.tracks.unassign(this.projectId, track.id, taskId);
      await repos.activity.append(this.activity.make(this.projectId, "track.unassigned", "track", track.id, `Unassigned ${taskId} from ${formatActorRef(track)}`, { taskId }));
    });
  }

  async list(): Promise<Track[]> {
    return this.store.tracks.list(this.projectId);
  }
}

export class InstructionService {
  constructor(private readonly store: AppStore, private readonly activity: ActivityService, private readonly query: QueryService, private readonly projectId: string) {}

  async add(input: AddInstructionInput): Promise<Instruction> {
    const errors = validateMatcherQuery(input.query);
    if (errors.length > 0) {
      validation("Instruction matcher is invalid.", { errors });
    }
    const now = nowIso();
    const instruction: Instruction = {
      projectId: this.projectId,
      id: input.id ? normalizeId(input.id) : normalizeId(slugify(input.name)),
      name: input.name.trim(),
      query: input.query.trim(),
      body: input.body,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    };
    if (!instruction.name) {
      validation("Instruction name is required.");
    }
    await this.store.transaction(async (repos) => {
      if (await repos.instructions.get(this.projectId, instruction.id)) {
        conflict(`Instruction already exists: ${instruction.id}`);
      }
      const existing = (await repos.instructions.list(this.projectId)).find((item) => item.name === instruction.name);
      if (existing) {
        conflict(`Instruction name already exists: ${instruction.name}`);
      }
      await repos.instructions.create(instruction);
      await repos.activity.append(this.activity.make(this.projectId, "instruction.created", "instruction", instruction.id, `Created instruction ${instruction.name}`, { query: instruction.query }));
    });
    return instruction;
  }

  async addMany(inputs: AddInstructionInput[]): Promise<Instruction[]> {
    const now = nowIso();
    const instructions = inputs.map((input) => {
      const errors = validateMatcherQuery(input.query);
      if (errors.length > 0) {
        validation("Instruction matcher is invalid.", { errors });
      }
      const instruction: Instruction = {
        projectId: this.projectId,
        id: input.id ? normalizeId(input.id) : normalizeId(slugify(input.name)),
        name: input.name.trim(),
        query: input.query.trim(),
        body: input.body,
        enabled: input.enabled ?? true,
        createdAt: now,
        updatedAt: now,
        archivedAt: null
      };
      if (!instruction.name) {
        validation("Instruction name is required.");
      }
      return instruction;
    });
    const seenIds = new Set<string>();
    const seenNames = new Set<string>();
    for (const instruction of instructions) {
      if (seenIds.has(instruction.id)) conflict(`Instruction already exists: ${instruction.id}`);
      if (seenNames.has(instruction.name)) conflict(`Instruction name already exists: ${instruction.name}`);
      seenIds.add(instruction.id);
      seenNames.add(instruction.name);
    }

    await this.store.transaction(async (repos) => {
      const existing = await repos.instructions.list(this.projectId);
      const existingIds = new Set(existing.map((instruction) => instruction.id));
      const existingNames = new Set(existing.map((instruction) => instruction.name));
      for (const instruction of instructions) {
        if (existingIds.has(instruction.id)) conflict(`Instruction already exists: ${instruction.id}`);
        if (existingNames.has(instruction.name)) conflict(`Instruction name already exists: ${instruction.name}`);
      }
      if (repos.instructions.createMany) {
        await repos.instructions.createMany(instructions);
      } else {
        for (const instruction of instructions) {
          await repos.instructions.create(instruction);
        }
      }
      if (instructions.length > 0) {
        await repos.activity.append(this.activity.make(this.projectId, "instruction.batch_created", "project", this.projectId, `Created ${instructions.length} instructions`, { count: instructions.length }));
      }
    });
    return instructions;
  }

  async edit(idInput: string, input: EditInstructionInput): Promise<Instruction> {
    const id = normalizeId(idInput);
    if (input.query !== undefined) {
      const errors = validateMatcherQuery(input.query);
      if (errors.length > 0) {
        validation("Instruction matcher is invalid.", { errors });
      }
    }
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const existing = await repos.instructions.get(this.projectId, id) ?? notFound("instruction", id);
      const next: Instruction = {
        ...existing,
        name: input.name?.trim() ?? existing.name,
        query: input.query?.trim() ?? existing.query,
        body: input.body ?? existing.body,
        enabled: input.enabled ?? existing.enabled,
        updatedAt: now
      };
      if (!next.name) {
        validation("Instruction name is required.");
      }
      const duplicateName = (await repos.instructions.list(this.projectId)).find((item) => item.id !== id && item.name === next.name);
      if (duplicateName) {
        conflict(`Instruction name already exists: ${next.name}`);
      }
      await repos.instructions.update(next);
      await repos.activity.append(this.activity.make(this.projectId, "instruction.updated", "instruction", next.id, `Updated instruction ${next.name}`));
      return next;
    });
  }

  async archive(idInput: string): Promise<Instruction> {
    const id = normalizeId(idInput);
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const existing = await repos.instructions.get(this.projectId, id) ?? notFound("instruction", id);
      const next = { ...existing, archivedAt: now, updatedAt: now };
      await repos.instructions.update(next);
      await repos.activity.append(this.activity.make(this.projectId, "instruction.archived", "instruction", id, `Archived instruction ${existing.name}`));
      return next;
    });
  }

  async restore(idInput: string): Promise<Instruction> {
    const id = normalizeId(idInput);
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const existing = await repos.instructions.get(this.projectId, id) ?? notFound("instruction", id);
      const next = { ...existing, archivedAt: null, updatedAt: now };
      await repos.instructions.update(next);
      await repos.activity.append(this.activity.make(this.projectId, "instruction.restored", "instruction", id, `Restored instruction ${existing.name}`));
      return next;
    });
  }

  async list(includeArchived = false): Promise<Instruction[]> {
    return (await this.store.instructions.list(this.projectId)).filter((instruction) => includeArchived || !instruction.archivedAt);
  }

  async get(idInput: string): Promise<Instruction> {
    const id = normalizeId(idInput);
    return await this.store.instructions.get(this.projectId, id) ?? notFound("instruction", id);
  }

  async preview(query: string): Promise<MatcherPreview> {
    return this.query.previewMatcherQuery(query);
  }

  async matchesForTask(taskIdInput: string): Promise<InstructionMatch[]> {
    const taskId = normalizeId(taskIdInput);
    const matches = await this.query.matchingInstructions();
    return matches.filter((match) => match.task.id === taskId);
  }

  async suggest(fieldInput: string, input: { prefix?: string; limit: number }): Promise<MatcherFieldValueSuggestion[]> {
    return this.query.suggest(fieldInput, input);
  }
}

export class SavedViewService {
  constructor(private readonly store: AppStore, private readonly activity: ActivityService, private readonly query: QueryService, private readonly projectId: string) {}

  async add(input: AddSavedViewInput): Promise<SavedView> {
    const errors = validateMatcherQuery(input.query);
    if (errors.length > 0) {
      validation("Saved view matcher is invalid.", { errors });
    }
    const now = nowIso();
    const view: SavedView = {
      projectId: this.projectId,
      id: input.id ? normalizeId(input.id) : normalizeId(slugify(input.name)),
      name: input.name.trim(),
      query: input.query.trim(),
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    };
    if (!view.name) validation("Saved view name is required.");
    await this.store.transaction(async (repos) => {
      if (await repos.views.get(this.projectId, view.id)) conflict(`Saved view already exists: ${view.id}`);
      const duplicate = (await repos.views.list(this.projectId)).find((item) => item.name === view.name);
      if (duplicate) conflict(`Saved view name already exists: ${view.name}`);
      await repos.views.create(view);
      await repos.activity.append(this.activity.make(this.projectId, "view.created", "view", view.id, `Created saved view ${view.name}`, { query: view.query }));
    });
    return view;
  }

  async edit(idInput: string, input: EditSavedViewInput): Promise<SavedView> {
    const id = normalizeId(idInput);
    if (input.query !== undefined) {
      const errors = validateMatcherQuery(input.query);
      if (errors.length > 0) validation("Saved view matcher is invalid.", { errors });
    }
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const existing = await repos.views.get(this.projectId, id) ?? notFound("saved view", id);
      const next: SavedView = { ...existing, name: input.name?.trim() ?? existing.name, query: input.query?.trim() ?? existing.query, updatedAt: now };
      if (!next.name) validation("Saved view name is required.");
      const duplicate = (await repos.views.list(this.projectId)).find((item) => item.id !== id && item.name === next.name);
      if (duplicate) conflict(`Saved view name already exists: ${next.name}`);
      await repos.views.update(next);
      await repos.activity.append(this.activity.make(this.projectId, "view.updated", "view", next.id, `Updated saved view ${next.name}`));
      return next;
    });
  }

  async archive(idInput: string): Promise<SavedView> {
    const id = normalizeId(idInput);
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const existing = await repos.views.get(this.projectId, id) ?? notFound("saved view", id);
      const next = { ...existing, archivedAt: now, updatedAt: now };
      await repos.views.update(next);
      await repos.activity.append(this.activity.make(this.projectId, "view.archived", "view", id, `Archived saved view ${existing.name}`));
      return next;
    });
  }

  async restore(idInput: string): Promise<SavedView> {
    const id = normalizeId(idInput);
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const existing = await repos.views.get(this.projectId, id) ?? notFound("saved view", id);
      const next = { ...existing, archivedAt: null, updatedAt: now };
      await repos.views.update(next);
      await repos.activity.append(this.activity.make(this.projectId, "view.restored", "view", id, `Restored saved view ${existing.name}`));
      return next;
    });
  }

  async list(includeArchived = false): Promise<SavedView[]> {
    return (await this.store.views.list(this.projectId)).filter((view) => includeArchived || !view.archivedAt);
  }

  async get(idInput: string): Promise<SavedView> {
    const id = normalizeId(idInput);
    return await this.store.views.get(this.projectId, id) ?? notFound("saved view", id);
  }

  async tasks(idInput: string, limit?: number): Promise<TaskView[]> {
    const view = await this.get(idInput);
    return limit === undefined ? this.query.list({ where: view.query }) : (await this.query.list({ where: view.query })).slice(0, limit);
  }
}

export class QueueFeedService {
  constructor(private readonly store: AppStore, private readonly activity: ActivityService, private readonly query: QueryService, private readonly projectId: string) {}

  async add(input: AddQueueFeedInput): Promise<QueueFeed> {
    const errors = validateMatcherQuery(input.query);
    if (errors.length > 0) {
      validation("Queue feed matcher is invalid.", { errors });
    }
    const now = nowIso();
    const feed: QueueFeed = {
      projectId: this.projectId,
      id: input.id ? normalizeId(input.id) : normalizeId(slugify(input.name)),
      name: input.name.trim(),
      query: input.query.trim(),
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    };
    if (!feed.name) validation("Queue feed name is required.");
    await this.store.transaction(async (repos) => {
      if (await repos.feeds.get(this.projectId, feed.id)) conflict(`Queue feed already exists: ${feed.id}`);
      const duplicate = (await repos.feeds.list(this.projectId)).find((item) => item.name === feed.name);
      if (duplicate) conflict(`Queue feed name already exists: ${feed.name}`);
      await repos.feeds.create(feed);
      await repos.activity.append(this.activity.make(this.projectId, "feed.created", "feed", feed.id, `Created queue feed ${feed.name}`, { query: feed.query }));
    });
    return feed;
  }

  async edit(idInput: string, input: EditQueueFeedInput): Promise<QueueFeed> {
    const id = normalizeId(idInput);
    if (input.query !== undefined) {
      const errors = validateMatcherQuery(input.query);
      if (errors.length > 0) validation("Queue feed matcher is invalid.", { errors });
    }
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const existing = await repos.feeds.get(this.projectId, id) ?? notFound("queue feed", id);
      const next: QueueFeed = { ...existing, name: input.name?.trim() ?? existing.name, query: input.query?.trim() ?? existing.query, updatedAt: now };
      if (!next.name) validation("Queue feed name is required.");
      const duplicate = (await repos.feeds.list(this.projectId)).find((item) => item.id !== id && item.name === next.name);
      if (duplicate) conflict(`Queue feed name already exists: ${next.name}`);
      await repos.feeds.update(next);
      await repos.activity.append(this.activity.make(this.projectId, "feed.updated", "feed", next.id, `Updated queue feed ${next.name}`));
      return next;
    });
  }

  async archive(idInput: string): Promise<QueueFeed> {
    const id = normalizeId(idInput);
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const existing = await repos.feeds.get(this.projectId, id) ?? notFound("queue feed", id);
      const next = { ...existing, archivedAt: now, updatedAt: now };
      await repos.feeds.update(next);
      await repos.activity.append(this.activity.make(this.projectId, "feed.archived", "feed", id, `Archived queue feed ${existing.name}`));
      return next;
    });
  }

  async restore(idInput: string): Promise<QueueFeed> {
    const id = normalizeId(idInput);
    const now = nowIso();
    return this.store.transaction(async (repos) => {
      const existing = await repos.feeds.get(this.projectId, id) ?? notFound("queue feed", id);
      const next = { ...existing, archivedAt: null, updatedAt: now };
      await repos.feeds.update(next);
      await repos.activity.append(this.activity.make(this.projectId, "feed.restored", "feed", id, `Restored queue feed ${existing.name}`));
      return next;
    });
  }

  async list(includeArchived = false): Promise<QueueFeed[]> {
    return (await this.store.feeds.list(this.projectId)).filter((feed) => includeArchived || !feed.archivedAt);
  }

  async get(idInput: string): Promise<QueueFeed> {
    const id = normalizeId(idInput);
    return await this.store.feeds.get(this.projectId, id) ?? notFound("queue feed", id);
  }

  async tasks(idInput: string, limit?: number): Promise<TaskView[]> {
    const feed = await this.get(idInput);
    const tasks = await this.query.list({ where: feed.query, status: "ready" });
    return limit === undefined ? tasks : tasks.slice(0, limit);
  }
}

export class QueryService {
  constructor(private readonly store: AppStore, private readonly projectId: string) {}

  async suggest(fieldInput: string, input: { prefix?: string; limit: number }): Promise<MatcherFieldValueSuggestion[]> {
    const field = normalizeMatcherSuggestionField(fieldInput);
    const limit = normalizeSuggestionLimit(input.limit);
    const prefix = input.prefix?.trim().toLowerCase() ?? "";
    const tasks = await this.list({ includeFinished: true });
    const counts = new Map<string, MatcherFieldValueSuggestion>();
    const ranks = new Map<string, number>();
    const taskSuggestionRank = new Map([...tasks].sort((a, b) => a.hierarchyDepth - b.hierarchyDepth || a.id.localeCompare(b.id)).map((task, index) => [task.id, index]));
    const add = (valueInput: string | null | undefined, detail: string, count = 1, rank?: number) => {
      const value = valueInput?.trim();
      if (!value) {
        return;
      }
      if (prefix && !matchesSuggestionPrefix(value, prefix)) {
        return;
      }
      const key = suggestionKey(field, value);
      const existing = counts.get(key);
      if (existing) {
        existing.count += count;
      } else {
        counts.set(key, { field, value, label: value, detail, count });
      }
      if (rank !== undefined) {
        ranks.set(key, Math.min(ranks.get(key) ?? Number.MAX_SAFE_INTEGER, rank));
      }
    };

    if (field === "status") {
      for (const status of ["ready", "blocked", "started", "finished", "archived"]) add(status, "computed status", 0);
    } else if (field === "lifecycle") {
      for (const lifecycle of ["open", "started", "finished"]) add(lifecycle, "lifecycle", 0);
    } else if (field === "priority") {
      for (const priority of [0, 1, 2, 3, 4]) {
        add(String(priority), "priority", 0);
        add(`P${priority}`, "priority label", 0);
      }
    } else if (field === "comments") {
      for (const count of [0, 1, 2, 3, 5, 10]) add(String(count), "comment count", 0);
    } else if (["created", "updated", "started", "finished", "archived"].includes(field)) {
      add("now", "current instant", 0);
      add("today", "local day start", 0);
      add("now - 30m", "relative time", 0);
      add("now - 6h", "relative time", 0);
      add("now - 2d", "relative time", 0);
      add("now - 1w", "relative time", 0);
    }

    for (const task of tasks) {
      if (field === "id") add(task.id, `task id / depth ${task.hierarchyDepth}`, 1, taskSuggestionRank.get(task.id));
      if (field === "id prefix") {
        for (const prefixValue of idPrefixes(task.id)) add(prefixValue, "task id prefix");
      }
      if (field === "tag") {
        for (const tag of task.tags) {
          add(tag.name, "tag name");
          add(tag.id, "tag id");
        }
      }
      if (field === "assigned" && task.assignedTrack) {
        add(formatActorRef(task.assignedTrack), "machine:actor");
      }
      if (field === "machine" && task.assignedTrack) add(task.assignedTrack.machine, "assigned machine");
      if (field === "actor" && task.assignedTrack) add(task.assignedTrack.actor, "assigned actor");
      if (field === "parent") add(task.parentTaskId ?? "root", task.parentTaskId ? "parent task id" : "root parent");
      if (field === "source doc") add(task.sourceDoc, "source doc");
      if (field === "source section") add(task.sourceSection, "source section");
    }

    return [...counts.values()]
      .sort((a, b) => {
        if (field === "id") {
          return (ranks.get(suggestionKey(field, a.value)) ?? Number.MAX_SAFE_INTEGER)
            - (ranks.get(suggestionKey(field, b.value)) ?? Number.MAX_SAFE_INTEGER)
            || a.value.localeCompare(b.value);
        }
        return b.count - a.count || a.value.localeCompare(b.value);
      })
      .slice(0, limit);
  }

  async list(filters: TaskListFilters = {}): Promise<TaskView[]> {
    const where = filters.where?.trim();
    const nativeTaskIds = where && this.store.matcher
      ? new Set(await this.store.matcher.matchTaskIds(this.projectId, where, (({ where: _where, ...baseFilters }) => baseFilters)(filters)))
      : null;
    const [allTasks, dependencies, comments, tags, taskTags, tracks, assignments] = await Promise.all([
      this.store.tasks.list(this.projectId),
      this.store.dependencies.list(this.projectId),
      this.store.comments.list(this.projectId),
      this.store.tags.list(this.projectId),
      this.store.tags.listTaskTags(this.projectId),
      this.store.tracks.list(this.projectId),
      this.store.tracks.listAssignments(this.projectId)
    ]);

    const tasks = nativeTaskIds ? allTasks.filter((task) => nativeTaskIds.has(task.id)) : allTasks;
    const taskById = new Map(allTasks.map((task) => [task.id, task]));
    const tagById = new Map(tags.map((tag) => [tag.id, tag]));
    const trackById = new Map(tracks.map((track) => [track.id, track]));
    const activeTaskIds = new Set(allTasks.filter((task) => !task.archivedAt).map((task) => task.id));
    const activeDependencies = dependencies.filter((dependency) => activeTaskIds.has(dependency.taskId) && activeTaskIds.has(dependency.dependsOnTaskId));
    const graph = buildGraphIndexes(activeDependencies);
    const depths = computeDepths(allTasks.filter((task) => !task.archivedAt), activeDependencies);
    const transitiveDependents = computeTransitiveDependents(allTasks.filter((task) => !task.archivedAt && task.lifecycle !== "finished"), activeDependencies);

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
    const recentCommentThreshold = Date.now() - 24 * 60 * 60 * 1000;
    const commentsByTask = new Map<string, Comment[]>();
    for (const comment of comments) {
      if (comment.archivedAt) {
        continue;
      }
      const existing = commentsByTask.get(comment.taskId) ?? [];
      existing.push(comment);
      commentsByTask.set(comment.taskId, existing);
    }

    let views = tasks.map((task): TaskView => {
      const taskComments = commentsByTask.get(task.id) ?? [];
      const sortedComments = [...taskComments].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const commentAuthors = [...new Set(sortedComments.map((comment) => formatActorRef(comment)))].sort();
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
        rollupStatus: "leaf",
        unfinishedDescendantsCount: 0,
        criticalChildPath: [],
        assignedTrack: assignment && track ? { trackId: track.id, machine: track.machine, actor: track.actor, name: track.name, position: assignment.position } : null,
        tags: [...(tagsByTask.get(task.id) ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
        commentCount: sortedComments.length,
        recentCommentCount: sortedComments.filter((comment) => Date.parse(comment.createdAt) >= recentCommentThreshold).length,
        lastCommentAt: sortedComments.at(-1)?.createdAt ?? null,
        commentAuthors
      };
    });

    const statusByTask = new Map(allTasks.map((task) => {
      const dependencyIds = graph.dependenciesByTask.get(task.id) ?? [];
      const blocked = task.lifecycle !== "finished" && dependencyIds.some((dependencyId) => taskById.get(dependencyId)?.lifecycle !== "finished");
      const computedStatus = task.archivedAt
        ? "archived"
        : task.lifecycle === "finished"
          ? "finished"
          : task.lifecycle === "started"
            ? "started"
            : blocked
              ? "blocked"
              : "ready";
      return [task.id, computedStatus] as const;
    }));
    const rollups = computeHierarchyRollups(allTasks, statusByTask);
    views = views.map((task) => {
      const parentTask = task.parentTaskId ? taskById.get(task.parentTaskId) : null;
      const rollup = rollups.get(task.id);
      const descendantsCount = rollup?.descendantsCount ?? 0;
      const subtreeFinishedCount = rollup?.subtreeFinishedCount ?? 0;
      const unfinishedDescendantsCount = Math.max(0, descendantsCount - subtreeFinishedCount);
      return {
        ...task,
        parent: parentTask ? { id: parentTask.id, title: parentTask.title, lifecycle: parentTask.lifecycle } : null,
        childrenCount: rollup?.childrenCount ?? 0,
        descendantsCount,
        leafDescendantsCount: rollup?.leafDescendantsCount ?? 0,
        finishedLeafDescendantsCount: rollup?.finishedLeafDescendantsCount ?? 0,
        subtreeProgress: rollup?.subtreeProgress ?? task.subtreeProgress,
        subtreeOpenCount: rollup?.subtreeOpenCount ?? 0,
        subtreeReadyCount: rollup?.subtreeReadyCount ?? 0,
        subtreeBlockedCount: rollup?.subtreeBlockedCount ?? 0,
        subtreeStartedCount: rollup?.subtreeStartedCount ?? 0,
        subtreeFinishedCount,
        hierarchyDepth: rollup?.hierarchyDepth ?? 0,
        rollupStatus: computeRollupStatus(rollup?.childrenCount ?? 0, unfinishedDescendantsCount),
        unfinishedDescendantsCount
      };
    });
    const hierarchy = buildHierarchyIndexes(allTasks.filter((task) => !task.archivedAt));
    const viewById = new Map(views.map((task) => [task.id, task]));
    views = views.map((task) => ({
      ...task,
      criticalChildPath: task.rollupStatus === "blocked-by-children"
        ? computeCriticalChildPath(task.id, hierarchy.childrenByParent, viewById)
        : []
    }));

    views = this.applyFilters(views, filters);
    if (where && !nativeTaskIds) {
      const queryMatches = new Set(matchMatcherQuery(where, views, activeDependencies).map((match) => match.task.id));
      views = views.filter((task) => queryMatches.has(task.id));
    }
    return sortTaskViews(views, filters.sort);
  }

  async match(query: string, limit: number, filters: Omit<TaskListFilters, "where"> = {}): Promise<TaskView[]> {
    const normalizedLimit = normalizeQueryLimit(limit);
    return (await this.list({ ...filters, where: query })).slice(0, normalizedLimit);
  }

  async matchIds(query: string, limit: number, filters: Omit<TaskListFilters, "where"> = {}): Promise<string[]> {
    const normalizedLimit = normalizeQueryLimit(limit);
    if (this.store.matcher) {
      return (await this.store.matcher.matchTaskIds(this.projectId, query, filters)).slice(0, normalizedLimit);
    }
    return (await this.match(query, normalizedLimit, filters)).map((task) => task.id);
  }

  async explain(idInput: string): Promise<DependencyExplanation> {
    const id = normalizeId(idInput);
    const views = await this.list({ includeFinished: true, includeArchived: true });
    const viewById = new Map(views.map((task) => [task.id, task]));
    const dependencies = await this.store.dependencies.listForTask(this.projectId, id);
    const allDependencies = await this.store.dependencies.list(this.projectId);
    const directDependents = allDependencies
      .filter((dependency) => dependency.dependsOnTaskId === id)
      .map((dependency) => viewById.get(dependency.taskId))
      .filter((task): task is TaskView => Boolean(task && !task.archivedAt));
    const task = viewById.get(id) ?? notFound("task", id);
    const dependencyViews = dependencies
      .map((dependency) => viewById.get(dependency.dependsOnTaskId))
      .filter((dependency): dependency is TaskView => Boolean(dependency && !dependency.archivedAt));
    const unfinishedDependencies = dependencyViews.filter((dependency) => dependency.lifecycle !== "finished");
    const finishedDependencies = dependencyViews.filter((dependency) => dependency.lifecycle === "finished");
    const assignable = !task.archivedAt && task.lifecycle !== "finished";
    const reason = assignable
      ? unfinishedDependencies.length > 0
        ? `Task can be assigned, but ${formatCount(unfinishedDependencies.length, "dependency", "dependencies")} ${unfinishedDependencies.length === 1 ? "is" : "are"} unfinished.`
        : "Task has no unfinished dependencies and can be assigned."
      : task.archivedAt
        ? "Archived tasks cannot be assigned."
        : task.lifecycle === "finished"
          ? "Finished tasks cannot be assigned."
          : "Task cannot be assigned.";

    return {
      task,
      dependencies: dependencyViews,
      unfinishedDependencies,
      finishedDependencies,
      directDependents,
      transitiveDependentsCount: task.transitiveDependentsCount,
      assignable,
      reason,
      instructions: (await this.matchingInstructions()).filter((match) => match.task.id === task.id)
    };
  }

  async previewMatcherQuery(query: string): Promise<MatcherPreview> {
    const errors = validateMatcherQuery(query);
    if (errors.length > 0) {
      return { ok: false, query, errors, matches: [] };
    }
    if (this.store.matcher) {
      const tasks = await this.list({ includeArchived: true, includeFinished: true });
      const taskById = new Map(tasks.map((task) => [task.id, task]));
      const taskIds = await this.store.matcher.matchTaskIds(this.projectId, query, { includeArchived: true, includeFinished: true });
      return {
        ok: true,
        query,
        errors: [],
        matches: taskIds
          .map((taskId) => taskById.get(taskId))
          .filter((task): task is TaskView => Boolean(task))
          .map((task) => ({
            instruction: {
              projectId: this.projectId,
              id: "__preview__",
              name: "Preview",
              query,
              body: "",
              enabled: true,
              createdAt: nowIso(),
              updatedAt: nowIso(),
              archivedAt: null
            },
            task,
            reasons: ["matched by Prism selector fragment"]
          }))
      };
    }
    const [tasks, dependencies] = await Promise.all([
      this.list({ includeArchived: true, includeFinished: true }),
      this.store.dependencies.list(this.projectId)
    ]);
    return {
      ok: true,
      query,
      errors: [],
      matches: matchMatcherQuery(query, tasks, dependencies).map((match) => ({
        instruction: {
          projectId: this.projectId,
          id: "__preview__",
          name: "Preview",
          query,
          body: "",
          enabled: true,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          archivedAt: null
        },
        task: match.task,
        reasons: match.reasons
      }))
    };
  }

  async matchingInstructions(): Promise<InstructionMatch[]> {
    const instructions = await this.store.instructions.list(this.projectId);
    const enabled = instructions.filter((instruction) => instruction.enabled && !instruction.archivedAt);
    const matches: InstructionMatch[] = [];
    if (this.store.matcher) {
      const tasks = await this.list({ includeArchived: true, includeFinished: true });
      const taskById = new Map(tasks.map((task) => [task.id, task]));
      const taskIdsByQuery = await this.matchTaskIdsByInstructionQuery(enabled);
      for (const instruction of enabled) {
        for (const taskId of taskIdsByQuery.get(instruction.query) ?? []) {
          const task = taskById.get(taskId);
          if (task) {
            matches.push({ instruction, task, reasons: ["matched by Prism selector fragment"] });
          }
        }
      }
      return matches.sort((a, b) => a.instruction.name.localeCompare(b.instruction.name) || a.task.id.localeCompare(b.task.id));
    }
    const [tasks, dependencies] = await Promise.all([
      this.list({ includeArchived: true, includeFinished: true }),
      this.store.dependencies.list(this.projectId)
    ]);
    for (const instruction of enabled) {
      for (const match of matchMatcherQuery(instruction.query, tasks, dependencies)) {
        matches.push({ instruction, task: match.task, reasons: match.reasons });
      }
    }
    return matches.sort((a, b) => a.instruction.name.localeCompare(b.instruction.name) || a.task.id.localeCompare(b.task.id));
  }

  async matchingInstructionIds(): Promise<Array<{ instructionId: string; taskId: string }>> {
    const instructions = await this.store.instructions.list(this.projectId);
    const enabled = instructions.filter((instruction) => instruction.enabled && !instruction.archivedAt);
    if (this.store.matcher) {
      const matches: Array<{ instructionId: string; taskId: string }> = [];
      const taskIdsByQuery = await this.matchTaskIdsByInstructionQuery(enabled);
      for (const instruction of enabled) {
        for (const taskId of taskIdsByQuery.get(instruction.query) ?? []) {
          matches.push({ instructionId: instruction.id, taskId });
        }
      }
      return matches.sort((a, b) => a.instructionId.localeCompare(b.instructionId) || a.taskId.localeCompare(b.taskId));
    }
    return (await this.matchingInstructions()).map((match) => ({
      instructionId: match.instruction.id,
      taskId: match.task.id,
    }));
  }

  private async matchTaskIdsByInstructionQuery(instructions: Instruction[]): Promise<Map<string, string[]>> {
    if (!this.store.matcher) return new Map();
    if (this.store.matcher.matchTaskIdsByInstructionQuery) {
      return await this.store.matcher.matchTaskIdsByInstructionQuery(this.projectId, instructions, {
        includeArchived: true,
        includeFinished: true,
      });
    }
    const queries = [...new Set(instructions.map((instruction) => instruction.query))];
    const entries = await Promise.all(queries.map(async (query) => [
      query,
      await this.store.matcher!.matchTaskIds(this.projectId, query, { includeArchived: true, includeFinished: true })
    ] as const));
    return new Map(entries);
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
      if (filters.assignedActor) {
        const assignedRef = task.assignedTrack ? formatActorRef(task.assignedTrack) : null;
        if (task.assignedTrack?.actor !== filters.assignedActor && assignedRef !== filters.assignedActor) {
          return false;
        }
      }
      if (search) {
        const haystack = [
          task.id,
          task.title,
          task.description,
          task.sourceDoc,
          task.sourceSection,
          task.sourceText,
          task.assignedTrack ? formatActorRef(task.assignedTrack) : null,
          task.assignedTrack?.machine,
          task.assignedTrack?.actor,
          task.assignedTrack?.name,
          ...task.tags.flatMap((tag) => [tag.id, tag.name, tag.description])
        ].filter(Boolean).join("\n").toLowerCase();
        if (!haystack.includes(search)) {
          return false;
        }
      }
      return true;
    });
  }
}

function computeRollupStatus(childrenCount: number, unfinishedDescendantsCount: number): RollupStatus {
  if (childrenCount === 0) {
    return "leaf";
  }
  return unfinishedDescendantsCount === 0 ? "complete" : "blocked-by-children";
}

function computeCriticalChildPath(taskId: string, childrenByParent: Map<string, string[]>, viewById: Map<string, TaskView>): TaskPathSummary[] {
  const children = (childrenByParent.get(taskId) ?? [])
    .map((childId) => viewById.get(childId))
    .filter((child): child is TaskView => child !== undefined && child.lifecycle !== "finished")
    .sort(compareCriticalChildren);
  const child = children[0];
  if (!child) {
    return [];
  }
  const summary = summarizePathTask(child);
  if (child.childrenCount === 0 || child.blocked) {
    return [summary];
  }
  return [summary, ...computeCriticalChildPath(child.id, childrenByParent, viewById)];
}

function summarizePathTask(task: TaskView): TaskPathSummary {
  return {
    id: task.id,
    title: task.title,
    lifecycle: task.lifecycle,
    computedStatus: task.computedStatus,
    unfinishedDependenciesCount: task.unfinishedDependenciesCount
  };
}

function compareCriticalChildren(a: TaskView, b: TaskView): number {
  return criticalStatusRank(a) - criticalStatusRank(b)
    || b.unfinishedDescendantsCount - a.unfinishedDescendantsCount
    || b.transitiveDependentsCount - a.transitiveDependentsCount
    || b.priority - a.priority
    || a.dependencyDepth - b.dependencyDepth
    || a.createdAt.localeCompare(b.createdAt)
    || a.id.localeCompare(b.id);
}

function criticalStatusRank(task: TaskView): number {
  if (task.blocked) {
    return 0;
  }
  if (task.ready) {
    return 1;
  }
  if (task.computedStatus === "started") {
    return 2;
  }
  if (task.rollupStatus === "blocked-by-children") {
    return 3;
  }
  return 4;
}

export class ImportService {
  constructor(
    private readonly store: AppStore,
    private readonly activity: ActivityService,
    private readonly tasks: TaskService,
    private readonly tracks: TrackService,
    private readonly projectId: string
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
        const identity = parseActorRef(importedTask.assignee, this.activity.provenance().machine);
        const actorRef = formatActorRef(identity);
        const existingTrack = await this.store.tracks.findByActor(this.projectId, identity.machine, identity.actor);
        if (!existingTrack) {
          await this.tracks.add({ machine: identity.machine, actor: identity.actor });
        }
        const views = await this.store.tracks.listAssignments(this.projectId);
        if (!views.some((assignment) => assignment.taskId === importedTask.id)) {
          try {
            await this.tracks.assign(actorRef, importedTask.id);
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
    const data = scopeJsonExport(normalizeJsonImport(input, now), this.projectId);
    const issues: ImportIssue[] = [];

    let tasksCreated = 0;
    let tasksUpdated = 0;
    let tagsCreated = 0;
    let tagsUpdated = 0;
    let tracksCreated = 0;
    let tracksUpdated = 0;
    let instructionsCreated = 0;
    let instructionsUpdated = 0;
    let commentsCreated = 0;
    let commentsUpdated = 0;
    let dependenciesAdded = 0;
    let taskTagsAdded = 0;
    let assignmentsAdded = 0;
    let skipped = 0;

    await this.store.transaction(async (repos) => {
      const existingTasks = await repos.tasks.list(this.projectId);
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
      validateFinishedParents(combinedTasks);

      const existingDependencies = await repos.dependencies.list(this.projectId);
      const importedDependencyKeys = new Set(data.dependencies.map((edge) => dependencyKey(edge.taskId, edge.dependsOnTaskId)));
      const combinedDependencies = [
        ...existingDependencies.filter((edge) => !importedDependencyKeys.has(dependencyKey(edge.taskId, edge.dependsOnTaskId))),
        ...data.dependencies
      ];
      validateDependencyGraph(combinedTasks, combinedDependencies);

      const existingTags = await repos.tags.list(this.projectId);
      const existingTagById = new Map(existingTags.map((tag) => [tag.id, tag]));
      const existingTracks = await repos.tracks.list(this.projectId);
      const existingTrackById = new Map(existingTracks.map((track) => [track.id, track]));
      const existingInstructions = await repos.instructions.list(this.projectId);
      const existingInstructionById = new Map(existingInstructions.map((instruction) => [instruction.id, instruction]));
      const existingComments = await repos.comments.list(this.projectId);
      const existingCommentById = new Map(existingComments.map((comment) => [comment.id, comment]));
      const existingTaskTags = new Set((await repos.tags.listTaskTags(this.projectId)).map((taskTag) => taskTagKey(taskTag.taskId, taskTag.tagId)));
      const existingAssignments = new Map((await repos.tracks.listAssignments(this.projectId)).map((assignment) => [assignment.taskId, assignment]));

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

      for (const instruction of data.instructions ?? []) {
        const errors = validateMatcherQuery(instruction.query);
        if (errors.length > 0) {
          validation("Imported instruction matcher is invalid.", { instructionId: instruction.id, errors });
        }
        if (existingInstructionById.has(instruction.id)) {
          await repos.instructions.update(instruction);
          instructionsUpdated += 1;
        } else {
          await repos.instructions.create(instruction);
          instructionsCreated += 1;
        }
      }

      for (const comment of data.comments ?? []) {
        if (!combinedTaskById.has(comment.taskId)) {
          validation("Imported comment references a missing task.", { commentId: comment.id, taskId: comment.taskId });
        }
        if (existingCommentById.has(comment.id)) {
          await repos.comments.update(comment);
          commentsUpdated += 1;
        } else {
          await repos.comments.create(comment);
          commentsCreated += 1;
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

      await repos.activity.append(this.activity.make(this.projectId, "import.completed", "import", null, `Imported ${filePath}`, {
        filePath,
        tasksCreated,
        tasksUpdated,
        tagsCreated,
        tagsUpdated,
        tracksCreated,
        tracksUpdated,
        instructionsCreated,
        instructionsUpdated,
        commentsCreated,
        commentsUpdated,
        dependenciesAdded,
        taskTagsAdded,
        assignmentsAdded,
        skipped,
        issues: issues.length
      }));
    });

    return {
      tasksCreated,
      tasksUpdated,
      tagsCreated,
      tagsUpdated,
      tracksCreated,
      tracksUpdated,
      instructionsCreated,
      instructionsUpdated,
      commentsCreated,
      commentsUpdated,
      dependenciesAdded,
      taskTagsAdded,
      assignmentsAdded,
      skipped,
      issues
    };
  }
}

export class ExportService {
  constructor(private readonly store: AppStore, private readonly projectId: string) {}

  async json(includeActivity = false): Promise<JsonExport> {
    return exportStoreJson(this.store, includeActivity, this.projectId);
  }

  async markdown(options: { where?: string; limit?: number } = {}): Promise<string> {
    const query = new QueryService(this.store, this.projectId);
    const filters: TaskListFilters = { includeFinished: true, includeArchived: true };
    if (options.where) {
      filters.where = options.where;
    }
    const [rawTasks, data] = await Promise.all([
      query.list(filters),
      this.json(false)
    ]);
    const tasks = options.limit === undefined ? rawTasks : rawTasks.slice(0, normalizeQueryLimit(options.limit));
    return exportMarkdown(tasks, scopeExportData(data, new Set(tasks.map((task) => task.id))));
  }
}

function scopeExportData(data: JsonExport, taskIds: Set<string>): JsonExport {
  const trackIds = new Set(data.assignments.filter((assignment) => taskIds.has(assignment.taskId)).map((assignment) => assignment.trackId));
  const tagIds = new Set(data.taskTags.filter((taskTag) => taskIds.has(taskTag.taskId)).map((taskTag) => taskTag.tagId));
  const scoped: JsonExport = {
    tasks: data.tasks.filter((task) => taskIds.has(task.id)),
    dependencies: data.dependencies.filter((dependency) => taskIds.has(dependency.taskId) && taskIds.has(dependency.dependsOnTaskId)),
    tags: data.tags.filter((tag) => tagIds.has(tag.id)),
    taskTags: data.taskTags.filter((taskTag) => taskIds.has(taskTag.taskId) && tagIds.has(taskTag.tagId)),
    tracks: data.tracks.filter((track) => trackIds.has(track.id)),
    assignments: data.assignments.filter((assignment) => taskIds.has(assignment.taskId) && trackIds.has(assignment.trackId))
  };
  if (data.instructions) scoped.instructions = data.instructions;
  if (data.views) scoped.views = data.views;
  if (data.feeds) scoped.feeds = data.feeds;
  if (data.comments) scoped.comments = data.comments.filter((comment) => taskIds.has(comment.taskId));
  return scoped;
}

async function ensureTaskPair(repos: RepositorySet, projectId: string, taskId: string, dependsOnTaskId: string): Promise<void> {
  const task = await repos.tasks.get(projectId, taskId) ?? notFound("task", taskId);
  const dependency = await repos.tasks.get(projectId, dependsOnTaskId) ?? notFound("task", dependsOnTaskId);
  if (task.archivedAt) {
    validation("Archived tasks cannot have dependencies changed.", { taskId });
  }
  if (dependency.archivedAt) {
    validation("Archived tasks cannot be dependencies in V1.", { dependsOnTaskId });
  }
}

function formatCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function activityTaskId(activity: Activity): string | null {
  const dataTaskId = typeof activity.data.taskId === "string" ? normalizeId(activity.data.taskId) : null;
  if (dataTaskId) {
    return dataTaskId;
  }
  return activity.subjectType === "task" && activity.subjectId ? normalizeId(activity.subjectId) : null;
}

function normalizeMatcherSuggestionField(input: string): string {
  const normalized = input.trim().toLowerCase().replace(/\s+/g, " ");
  const fields: string[] = matcherQueryGrammar().fields;
  if (!fields.includes(normalized)) {
    validation("Unknown matcher field.", { field: input, fields });
  }
  return normalized;
}

function normalizeSuggestionLimit(input: number): number {
  if (!Number.isInteger(input) || input < 1) {
    validation("Suggestion limit must be a positive integer.", { limit: input });
  }
  return Math.min(input, 500);
}

function suggestionKey(field: string, value: string): string {
  return `${field}\u0000${value.toLowerCase()}`;
}

function matchesSuggestionPrefix(value: string, prefix: string): boolean {
  const valueLower = value.toLowerCase();
  const prefixLower = prefix.toLowerCase();
  if (valueLower.startsWith(prefixLower)) {
    return true;
  }
  const compactValue = compactSuggestionToken(valueLower);
  const compactPrefix = compactSuggestionToken(prefixLower);
  if (!compactPrefix) {
    return true;
  }
  if (compactValue.startsWith(compactPrefix)) {
    return true;
  }
  const abbreviation = valueLower.split(/[^a-z0-9]+/).filter(Boolean).map((part) => part[0]).join("");
  if (abbreviation.startsWith(compactPrefix)) {
    return true;
  }
  const valueParts = valueLower.split(/[^a-z0-9]+/).filter(Boolean);
  const prefixParts = prefixLower.split(/[^a-z0-9]+/).filter(Boolean);
  return prefixParts.length > 1
    && prefixParts.length <= valueParts.length
    && prefixParts.every((part, index) => valueParts[index]?.startsWith(part));
}

function compactSuggestionToken(value: string): string {
  return value.replace(/[^a-z0-9]+/g, "");
}

function normalizeQueryLimit(input: number): number {
  if (!Number.isInteger(input) || input < 1) {
    validation("Query limit must be a positive integer.", { limit: input });
  }
  return Math.min(input, 1000);
}

function normalizeCommentId(input: string): string {
  const id = input.trim();
  if (!id) {
    validation("Comment id is required.");
  }
  return id;
}

function normalizeCommentBody(input: string): string {
  const body = input.trim();
  if (!body) {
    validation("Comment body is required.");
  }
  if (body.length > 20000) {
    validation("Comment body is too long.", { maxLength: 20000 });
  }
  return body;
}

function idPrefixes(id: string): string[] {
  const parts = id.split("-");
  const prefixes: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    prefixes.push(parts.slice(0, index).join("-"));
  }
  return prefixes;
}

async function ensureParentTask(repos: RepositorySet, projectId: string, taskId: string, parentTaskId: string | null): Promise<Task | null> {
  if (!parentTaskId) {
    return null;
  }
  const parent = await repos.tasks.get(projectId, parentTaskId) ?? notFound("task", parentTaskId);
  if (parent.archivedAt) {
    validation("Archived tasks cannot be parents in V1.", { taskId, parentTaskId });
  }
  const tasks = await repos.tasks.list(projectId);
  assertNoParentCycle(taskId, parentTaskId, tasks);
  return parent;
}

function ensureFinishedParentDoesNotContainUnfinishedChild(parent: Task | null, child: Task): void {
  if (parent?.lifecycle === "finished" && child.lifecycle !== "finished") {
    validation("Finished parent tasks cannot contain unfinished children. Reopen the parent first.", {
      parentTaskId: parent.id,
      childTaskId: child.id
    });
  }
}

async function ensureTaskCanBeFinished(repos: RepositorySet, task: Task): Promise<void> {
  if (task.lifecycle !== "finished") {
    return;
  }
  const tasks = await repos.tasks.list(task.projectId);
  const taskById = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  taskById.set(task.id, task);
  const unfinishedDescendants = listDescendantIds(task.id, [...taskById.values()])
    .map((descendantId) => taskById.get(descendantId))
    .filter((candidate): candidate is Task => candidate !== undefined && !candidate.archivedAt && candidate.lifecycle !== "finished");
  if (unfinishedDescendants.length > 0) {
    validation("Parent tasks cannot be finished while descendants are unfinished.", {
      taskId: task.id,
      unfinishedDescendants: unfinishedDescendants.map((descendant) => descendant.id)
    });
  }
}

function validateFinishedParents(tasks: Task[]): void {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    if (task.lifecycle !== "finished") {
      continue;
    }
    const unfinishedDescendantIds = listDescendantIds(task.id, tasks).filter((descendantId) => {
      const descendant = taskById.get(descendantId);
      return Boolean(descendant && !descendant.archivedAt && descendant.lifecycle !== "finished");
    });
    if (unfinishedDescendantIds.length > 0) {
      validation("Finished parent tasks cannot contain unfinished descendants.", {
        taskId: task.id,
        unfinishedDescendants: unfinishedDescendantIds
      });
    }
  }
}

async function findTrack(repos: RepositorySet, projectId: string, actorOrId: string, defaultMachine: string): Promise<Track> {
  const raw = actorOrId.trim();
  const identity = parseActorRef(actorOrId, defaultMachine);
  return await repos.tracks.get(projectId, raw)
    ?? await repos.tracks.get(projectId, normalizeId(raw))
    ?? await repos.tracks.get(projectId, slugify(raw))
    ?? await repos.tracks.findByActor(projectId, identity.machine, identity.actor)
    ?? notFound("track", actorOrId);
}

function parseActorRef(input: string, defaultMachine: string): { machine: string; actor: string } {
  const value = input.trim();
  if (!value) {
    validation("Actor is required.");
  }
  const separator = value.indexOf(":");
  const machine = separator === -1 ? defaultMachine.trim() : value.slice(0, separator).trim();
  const actor = separator === -1 ? value : value.slice(separator + 1).trim();
  if (!machine || !actor) {
    validation("Actor identity must be actor or machine:actor.", { input });
  }
  return { machine, actor };
}

function formatActorRef(identity: { machine: string; actor: string }): string {
  return `${identity.machine}:${identity.actor}`;
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
    const actorKey = formatActorRef(track);
    if (actors.has(actorKey)) {
      validation("JSON import contains duplicate track actors.", { actor: actorKey });
    }
    trackIds.add(track.id);
    actors.add(actorKey);
  }

  const instructions = ensureArray(record.instructions, "instructions").map((instruction) => normalizeImportedInstruction(instruction, now));
  const instructionIds = new Set<string>();
  const instructionNames = new Set<string>();
  for (const instruction of instructions) {
    if (instructionIds.has(instruction.id)) {
      validation("JSON import contains duplicate instruction ids.", { instructionId: instruction.id });
    }
    if (instructionNames.has(instruction.name)) {
      validation("JSON import contains duplicate instruction names.", { name: instruction.name });
    }
    instructionIds.add(instruction.id);
    instructionNames.add(instruction.name);
  }

  const comments = ensureArray(record.comments, "comments").map((comment) => normalizeImportedComment(comment, now));
  const commentIds = new Set<string>();
  for (const comment of comments) {
    if (commentIds.has(comment.id)) {
      validation("JSON import contains duplicate comment ids.", { commentId: comment.id });
    }
    commentIds.add(comment.id);
  }

  return {
    tasks,
    dependencies: ensureArray(record.dependencies, "dependencies").map((dependency) => normalizeImportedDependency(dependency, now)),
    tags,
    taskTags: ensureArray(record.taskTags, "taskTags").map((taskTag) => normalizeImportedTaskTag(taskTag, now)),
    tracks,
    assignments: ensureArray(record.assignments, "assignments").map((assignment) => normalizeImportedAssignment(assignment, now)),
    instructions,
    comments
  };
}

function scopeJsonExport(data: JsonExport, projectId: string): JsonExport {
  const scoped: JsonExport = {
    tasks: data.tasks.map((task) => ({ ...task, projectId })),
    dependencies: data.dependencies.map((dependency) => ({ ...dependency, projectId })),
    tags: data.tags.map((tag) => ({ ...tag, projectId })),
    taskTags: data.taskTags.map((taskTag) => ({ ...taskTag, projectId })),
    tracks: data.tracks.map((track) => ({ ...track, projectId })),
    assignments: data.assignments.map((assignment) => ({ ...assignment, projectId }))
  };
  if (data.instructions) {
    scoped.instructions = data.instructions.map((instruction) => ({ ...instruction, projectId }));
  }
  if (data.views) {
    scoped.views = data.views.map((view) => ({ ...view, projectId }));
  }
  if (data.feeds) {
    scoped.feeds = data.feeds.map((feed) => ({ ...feed, projectId }));
  }
  if (data.comments) {
    scoped.comments = data.comments.map((comment) => ({ ...comment, projectId }));
  }
  if (data.activity) {
    scoped.activity = data.activity.map((activity) => ({
      ...activity,
      projectId,
      machine: activity.machine ?? "unknown-machine",
      actor: activity.actor ?? "unknown"
    }));
  }
  return scoped;
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
    projectId: DEFAULT_PROJECT_ID,
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
    projectId: DEFAULT_PROJECT_ID,
    taskId: normalizeId(stringField(record, "taskId")),
    dependsOnTaskId: normalizeId(stringField(record, "dependsOnTaskId")),
    createdAt: optionalStringField(record, "createdAt") ?? now
  };
}

function normalizeImportedTag(input: unknown, now: string): Tag {
  const record = requireRecord(input, "tag");
  return {
    projectId: DEFAULT_PROJECT_ID,
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
    projectId: DEFAULT_PROJECT_ID,
    taskId: normalizeId(stringField(record, "taskId")),
    tagId: normalizeId(stringField(record, "tagId")),
    createdAt: optionalStringField(record, "createdAt") ?? now
  };
}

function normalizeImportedTrack(input: unknown, now: string): Track {
  const record = requireRecord(input, "track");
  const actor = stringField(record, "actor").trim();
  const machine = optionalStringField(record, "machine") ?? "unknown-machine";
  return {
    projectId: DEFAULT_PROJECT_ID,
    id: normalizeId(optionalStringField(record, "id") ?? slugify(`${machine}:${actor}`)),
    machine,
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
    projectId: DEFAULT_PROJECT_ID,
    trackId: normalizeId(stringField(record, "trackId")),
    taskId: normalizeId(stringField(record, "taskId")),
    position: optionalStringField(record, "position") ?? "000001",
    assignedAt: optionalStringField(record, "assignedAt") ?? now
  };
}

function normalizeImportedInstruction(input: unknown, now: string): Instruction {
  const record = requireRecord(input, "instruction");
  const name = stringField(record, "name").trim();
  const query = stringField(record, "query").trim();
  return {
    projectId: DEFAULT_PROJECT_ID,
    id: normalizeId(optionalStringField(record, "id") ?? slugify(name)),
    name,
    query,
    body: optionalStringField(record, "body") ?? "",
    enabled: booleanField(record, "enabled") ?? true,
    createdAt: optionalStringField(record, "createdAt") ?? now,
    updatedAt: optionalStringField(record, "updatedAt") ?? now,
    archivedAt: optionalStringField(record, "archivedAt")
  };
}

function normalizeImportedComment(input: unknown, now: string): Comment {
  const record = requireRecord(input, "comment");
  const id = optionalStringField(record, "id")?.trim() || randomUUID();
  return {
    projectId: DEFAULT_PROJECT_ID,
    id,
    taskId: normalizeId(stringField(record, "taskId")),
    machine: optionalStringField(record, "machine") ?? "unknown-machine",
    actor: optionalStringField(record, "actor") ?? "unknown",
    body: normalizeCommentBody(stringField(record, "body")),
    createdAt: optionalStringField(record, "createdAt") ?? now,
    updatedAt: optionalStringField(record, "updatedAt") ?? now,
    archivedAt: optionalStringField(record, "archivedAt")
  };
}

function validateDependencyGraph(tasks: Task[], dependencies: Dependency[]): void {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Set<string>();
  const uniqueDependencies: Dependency[] = [];
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
    uniqueDependencies.push(dependency);
  }
  assertDependencyGraphIsAcyclic(uniqueDependencies);
  assertDependenciesDoNotConflictWithHierarchy(uniqueDependencies, tasks);
}

function assertDependencyGraphIsAcyclic(dependencies: Dependency[]): void {
  const graph = buildGraphIndexes(dependencies);
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (taskId: string, rootId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) {
      conflict("Dependency would create a cycle.", { taskId: rootId });
    }
    visiting.add(taskId);
    for (const dependencyId of graph.dependenciesByTask.get(taskId) ?? []) {
      visit(dependencyId, rootId);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };

  for (const dependency of dependencies) {
    visit(dependency.taskId, dependency.taskId);
  }
}

function assertDependenciesDoNotConflictWithHierarchy(dependencies: Dependency[], tasks: Task[]): void {
  const hierarchy = buildHierarchyIndexes(tasks);
  const ancestorsByTask = new Map<string, Set<string>>();
  const ancestors = (taskId: string): Set<string> => {
    const cached = ancestorsByTask.get(taskId);
    if (cached) return cached;
    const result = new Set<string>();
    let current = hierarchy.parentByChild.get(taskId) ?? null;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      result.add(current);
      current = hierarchy.parentByChild.get(current) ?? null;
    }
    ancestorsByTask.set(taskId, result);
    return result;
  };

  for (const dependency of dependencies) {
    const taskAncestors = ancestors(dependency.taskId);
    const dependencyAncestors = ancestors(dependency.dependsOnTaskId);
    if (dependencyAncestors.has(dependency.taskId)) {
      validation("A task cannot depend on one of its descendants because hierarchy already gates parent completion.", dependency);
    }
    if (taskAncestors.has(dependency.dependsOnTaskId)) {
      validation("A task cannot depend on one of its ancestors because that would deadlock hierarchy completion.", dependency);
    }
  }
}

function assertNoHierarchyDependency(taskId: string, dependsOnTaskId: string, tasks: Task[]): void {
  if (isDescendant(taskId, dependsOnTaskId, tasks)) {
    validation("A task cannot depend on one of its descendants because hierarchy already gates parent completion.", { taskId, dependsOnTaskId });
  }
  if (isDescendant(dependsOnTaskId, taskId, tasks)) {
    validation("A task cannot depend on one of its ancestors because that would deadlock hierarchy completion.", { taskId, dependsOnTaskId });
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

function booleanField(record: Record<string, unknown>, field: string): boolean | undefined {
  const value = record[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    validation(`JSON import field must be a boolean: ${field}`);
  }
  return value;
}
