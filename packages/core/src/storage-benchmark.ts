import { performance } from "node:perf_hooks";
import type { AppStore } from "./store.js";
import type { AddTaskInput, JsonExport, TaskSize } from "./types.js";
import { createServices } from "./services.js";

export interface StorageCrudBenchmarkOptions {
  projectId?: string | undefined;
  machine?: string | undefined;
  actor?: string | undefined;
  tasks?: number | undefined;
  dependencies?: number | undefined;
  tags?: number | undefined;
  taskTags?: number | undefined;
  instructions?: number | undefined;
  comments?: number | undefined;
  activity?: number | undefined;
}

export interface StorageCrudBenchmarkPhase {
  name: string;
  count: number;
  elapsedMs: number;
  opsPerSecond: number;
}

export interface StorageCrudBenchmarkReport {
  ok: boolean;
  storage: {
    dialect: string;
    transactionalWrites: boolean;
    matcherQuery: string;
    outboxInbox: boolean;
  };
  projectId: string;
  counts: {
    tasks: number;
    dependencies: number;
    tags: number;
    taskTags: number;
    instructions: number;
    comments: number;
    activity: number;
  };
  phases: StorageCrudBenchmarkPhase[];
  totals: {
    operations: number;
    elapsedMs: number;
    opsPerSecond: number;
  };
}

export interface MatcherReadBenchmarkOptions {
  projectId?: string | undefined;
  machine?: string | undefined;
  actor?: string | undefined;
  tasks?: number | undefined;
  tags?: number | undefined;
  tracks?: number | undefined;
  instructions?: number | undefined;
  comments?: number | undefined;
  iterations?: number | undefined;
  pollers?: number | undefined;
}

export interface MatcherReadBenchmarkPhase {
  name: string;
  count: number;
  elapsedMs: number;
  opsPerSecond: number;
  avgMs: number;
  resultCount: number;
}

export interface MatcherReadBenchmarkReport {
  ok: boolean;
  storage: {
    dialect: string;
    matcherQuery: string;
  };
  projectId: string;
  counts: {
    tasks: number;
    tags: number;
    tracks: number;
    instructions: number;
    comments: number;
    iterations: number;
    pollers: number;
  };
  phases: MatcherReadBenchmarkPhase[];
  totals: {
    reads: number;
    elapsedMs: number;
    opsPerSecond: number;
  };
}

export async function runStorageCrudBenchmark(store: AppStore, options: StorageCrudBenchmarkOptions = {}): Promise<StorageCrudBenchmarkReport> {
  const projectId = normalizeProjectId(options.projectId ?? `BENCH-${Date.now().toString(36)}`);
  const machine = options.machine?.trim() || "storage-benchmark";
  const actor = options.actor?.trim() || "storage-benchmark";
  const taskCount = positiveInteger(options.tasks, 1000);
  const tagCount = positiveInteger(options.tags, Math.min(20, taskCount));
  const dependencyCount = Math.min(positiveInteger(options.dependencies, Math.max(0, taskCount - 1)), Math.max(0, taskCount - 1));
  const taskTagCount = Math.min(positiveInteger(options.taskTags, taskCount), taskCount * Math.max(1, tagCount));
  const instructionCount = positiveInteger(options.instructions, tagCount);
  const commentCount = Math.min(positiveInteger(options.comments, taskCount), taskCount);
  const activityCount = positiveInteger(options.activity, taskCount);
  const phases: StorageCrudBenchmarkPhase[] = [];
  const startedAt = performance.now();

  const global = createServices(store, { machine, actor });
  await measure(phases, "project.create", 1, async () => {
    await global.projects.add({ id: projectId, name: `Storage benchmark ${projectId}` });
  });

  const services = createServices(store, { projectId, machine, actor });
  const tags = Array.from({ length: tagCount }, (_item, index) => ({
    id: `TAG-${index.toString().padStart(3, "0")}`,
    name: `bench-tag-${index.toString().padStart(3, "0")}`
  }));
  await measure(phases, "tags.create", tags.length, async () => {
    await services.tags.addMany(tags);
  });

  const sizes: TaskSize[] = ["XS", "S", "M", "L", "XL"];
  const tasks = Array.from({ length: taskCount }, (_item, index): AddTaskInput => ({
    id: taskId(index),
    title: `Benchmark task ${index}`,
    description: `Synthetic storage benchmark task ${index}.`,
    priority: (index % 5) as 0 | 1 | 2 | 3 | 4,
    size: sizes[index % sizes.length] ?? null
  }));
  await measure(phases, "tasks.create", tasks.length, async () => {
    await services.tasks.addMany(tasks);
  });

  const dependencies = Array.from({ length: dependencyCount }, (_item, index) => ({
    taskId: taskId(index + 1),
    dependsOnTaskId: taskId(index)
  }));
  await measure(phases, "dependencies.create", dependencies.length, async () => {
    await services.dependencies.addMany(dependencies);
  });

  const taskTags = Array.from({ length: taskTagCount }, (_item, index) => ({
    taskId: taskId(index % taskCount),
    tagIdsOrNames: [tags[index % tags.length]?.id ?? "TAG-000"]
  }));
  await measure(phases, "task_tags.assign", taskTags.length, async () => {
    await services.tags.assignMany(taskTags);
  });

  const instructions = Array.from({ length: instructionCount }, (_item, index) => ({
    id: `INST-${index.toString().padStart(3, "0")}`,
    name: `Benchmark instruction ${index}`,
    query: `tag = ${tags[index % tags.length]?.name ?? "bench-tag-000"}`,
    body: `Synthetic instruction ${index}.`
  }));
  await measure(phases, "instructions.create", instructions.length, async () => {
    await services.instructions.addMany(instructions);
  });

  await measure(phases, "comments.create", commentCount, async () => {
    await services.comments.addMany(Array.from({ length: commentCount }, (_item, index) => ({
      taskId: taskId(index),
      body: `Benchmark comment ${index}.`
    })));
  });

  await measure(phases, "activity.append", activityCount, async () => {
    await services.activity.recordMany(Array.from({ length: activityCount }, (_item, index) => ({
      type: "benchmark.activity",
      subjectType: "project",
      subjectId: projectId,
      message: `Benchmark activity ${index}`,
      data: { index }
    })));
  });

  const elapsedMs = roundMs(performance.now() - startedAt);
  const operations = phases.reduce((sum, phase) => sum + phase.count, 0);
  return {
    ok: true,
    storage: {
      dialect: store.capabilities?.dialect ?? "unknown",
      transactionalWrites: store.capabilities?.transactionalWrites ?? false,
      matcherQuery: store.capabilities?.matcherQuery ?? "unknown",
      outboxInbox: store.capabilities?.outboxInbox ?? false
    },
    projectId,
    counts: {
      tasks: taskCount,
      dependencies: dependencyCount,
      tags: tagCount,
      taskTags: taskTagCount,
      instructions: instructionCount,
      comments: commentCount,
      activity: activityCount
    },
    phases,
    totals: {
      operations,
      elapsedMs,
      opsPerSecond: rate(operations, elapsedMs)
    }
  };
}

export async function runMatcherReadBenchmark(store: AppStore, options: MatcherReadBenchmarkOptions = {}): Promise<MatcherReadBenchmarkReport> {
  const projectId = normalizeProjectId(options.projectId ?? `MATCHER-BENCH-${Date.now().toString(36)}`);
  const machine = options.machine?.trim() || "matcher-benchmark";
  const actor = options.actor?.trim() || "matcher-benchmark";
  const taskCount = positiveInteger(options.tasks, 2000);
  const tagCount = positiveInteger(options.tags, Math.min(20, taskCount));
  const trackCount = positiveInteger(options.tracks, 8);
  const instructionCount = positiveInteger(options.instructions, tagCount);
  const commentCount = Math.min(positiveInteger(options.comments, Math.floor(taskCount / 2)), taskCount);
  const iterations = positiveInteger(options.iterations, 50);
  const pollers = positiveInteger(options.pollers, 20);
  const phases: MatcherReadBenchmarkPhase[] = [];

  const global = createServices(store, { machine, actor });
  await global.projects.add({ id: projectId, name: `Matcher benchmark ${projectId}` });
  const services = createServices(store, { projectId, machine, actor });
  await services.imports.json("matcher-benchmark.json", matcherBenchmarkData({
    taskCount,
    tagCount,
    trackCount,
    instructionCount,
    commentCount,
    machine
  }));

  const rootId = taskId(0);
  const dependencyTarget = taskId(Math.min(taskCount - 1, 1));
  const unblockTarget = taskId(Math.min(taskCount - 1, Math.max(2, Math.floor(taskCount / 2))));
  const commonQueries = [
    `tag = bench-tag-000`,
    `assigned = ${machine}:bench-actor-0`,
    `depends on ${dependencyTarget}`,
    `unblocks ${unblockTarget}`,
    `descendant of ${rootId}`,
    `comments > 0`,
    `status = blocked`,
    `source doc = bench.md and source section = section-0`
  ];

  await services.query.match(commonQueries[0] ?? "id prefix = T", 10, { includeFinished: true, sort: "id" });
  const startedAt = performance.now();
  for (const query of commonQueries) {
    await measureRead(phases, `matcher.${query}`, iterations, async () =>
      (await services.query.match(query, 100, { includeFinished: true, sort: "id" })).length
    );
  }

  await measureRead(phases, "dashboard.ready", iterations, async () =>
    (await services.query.list({ status: "ready", sort: "priority" })).length
  );
  await measureRead(phases, "queue.backend_ready", iterations, async () =>
    (await services.query.match("tag = bench-tag-000 and status = ready", 100, { sort: "priority" })).length
  );
  await measureRead(phases, "context.dependency_slice", iterations, async () =>
    (await services.exports.markdown({ where: `depends on ${dependencyTarget}`, limit: 50 })).length
  );
  await measureRead(phases, "instructions.matching_ids", iterations, async () =>
    (await services.query.matchingInstructionIds()).length
  );
  await measureRead(phases, "polling.concurrent_ready", iterations, async () => {
    const results = await Promise.all(Array.from({ length: pollers }, async () =>
      (await services.query.list({ status: "ready", sort: "priority" })).length
    ));
    return results.reduce((sum, count) => sum + count, 0);
  }, pollers);

  const elapsedMs = roundMs(performance.now() - startedAt);
  const reads = phases.reduce((sum, phase) => sum + phase.count, 0);
  return {
    ok: true,
    storage: {
      dialect: store.capabilities?.dialect ?? "unknown",
      matcherQuery: store.capabilities?.matcherQuery ?? "unknown"
    },
    projectId,
    counts: {
      tasks: taskCount,
      tags: tagCount,
      tracks: trackCount,
      instructions: instructionCount,
      comments: commentCount,
      iterations,
      pollers
    },
    phases,
    totals: {
      reads,
      elapsedMs,
      opsPerSecond: rate(reads, elapsedMs)
    }
  };
}

async function measure(phases: StorageCrudBenchmarkPhase[], name: string, count: number, fn: () => Promise<void>): Promise<void> {
  const startedAt = performance.now();
  await fn();
  const elapsedMs = roundMs(performance.now() - startedAt);
  phases.push({ name, count, elapsedMs, opsPerSecond: rate(count, elapsedMs) });
}

async function measureRead(phases: MatcherReadBenchmarkPhase[], name: string, iterations: number, fn: () => Promise<number>, operationsPerIteration = 1): Promise<void> {
  const startedAt = performance.now();
  let resultCount = 0;
  for (let index = 0; index < iterations; index += 1) {
    resultCount += await fn();
  }
  const elapsedMs = roundMs(performance.now() - startedAt);
  const count = iterations * operationsPerIteration;
  phases.push({
    name,
    count,
    elapsedMs,
    opsPerSecond: rate(count, elapsedMs),
    avgMs: count > 0 ? roundMs(elapsedMs / count) : 0,
    resultCount
  });
}

function rate(count: number, elapsedMs: number): number {
  if (elapsedMs <= 0) {
    return count;
  }
  return Math.round((count / elapsedMs) * 100000) / 100;
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeProjectId(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || `BENCH-${Date.now().toString(36)}`;
}

function taskId(index: number): string {
  return `T-${index.toString().padStart(6, "0")}`;
}

function matcherBenchmarkData(options: {
  taskCount: number;
  tagCount: number;
  trackCount: number;
  instructionCount: number;
  commentCount: number;
  machine: string;
}): JsonExport {
  const now = "2026-05-01T00:00:00.000Z";
  const groupSize = 50;
  const tasks: JsonExport["tasks"] = [];
  const dependencies: JsonExport["dependencies"] = [];
  const taskTags: JsonExport["taskTags"] = [];
  const assignments: JsonExport["assignments"] = [];
  const comments: JsonExport["comments"] = [];

  for (let index = 0; index < options.taskCount; index += 1) {
    const id = taskId(index);
    const groupStart = index - (index % groupSize);
    const isRoot = index % groupSize === 0;
    const lifecycle = !isRoot && index % 17 === 0 ? "finished" : index % 13 === 0 ? "started" : "open";
    tasks.push({
      projectId: "DEFAULT",
      id,
      parentTaskId: isRoot ? null : taskId(groupStart),
      title: `Matcher benchmark task ${index}`,
      description: `Synthetic matcher benchmark task ${index}.`,
      lifecycle,
      priority: (index % 5) as 0 | 1 | 2 | 3 | 4,
      size: null,
      sourceDoc: "bench.md",
      sourceSection: `section-${index % 10}`,
      sourceAnchor: null,
      sourceLine: null,
      sourceText: null,
      completionBar: null,
      createdAt: now,
      updatedAt: now,
      startedAt: lifecycle === "started" ? now : null,
      finishedAt: lifecycle === "finished" ? now : null,
      archivedAt: !isRoot && index % 101 === 0 ? "2026-05-02T00:00:00.000Z" : null,
      version: 1
    });
    taskTags.push({ projectId: "DEFAULT", taskId: id, tagId: tagId(index % options.tagCount), createdAt: now });
    if (index > 0 && index % groupSize !== 1) {
      dependencies.push({ projectId: "DEFAULT", taskId: id, dependsOnTaskId: taskId(index - 1), createdAt: now });
    }
    if (index < options.taskCount / 3) {
      assignments.push({
        projectId: "DEFAULT",
        trackId: `${options.machine}-bench-actor-${index % options.trackCount}`,
        taskId: id,
        position: String(index + 1).padStart(6, "0"),
        assignedAt: now
      });
    }
    if (index < options.commentCount) {
      comments.push({
        projectId: "DEFAULT",
        id: `C-${index.toString().padStart(6, "0")}`,
        taskId: id,
        machine: options.machine,
        actor: `bench-actor-${index % options.trackCount}`,
        body: `Matcher benchmark comment ${index}.`,
        createdAt: now,
        updatedAt: now,
        archivedAt: null
      });
    }
  }

  return {
    tasks,
    dependencies,
    tags: Array.from({ length: options.tagCount }, (_item, index) => ({
      projectId: "DEFAULT",
      id: tagId(index),
      name: `bench-tag-${index.toString().padStart(3, "0")}`,
      color: null,
      description: null,
      sortOrder: index,
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    })),
    taskTags,
    tracks: Array.from({ length: options.trackCount }, (_item, index) => ({
      projectId: "DEFAULT",
      id: `${options.machine}-bench-actor-${index}`,
      machine: options.machine,
      actor: `bench-actor-${index}`,
      name: `Benchmark actor ${index}`,
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    })),
    assignments,
    instructions: Array.from({ length: options.instructionCount }, (_item, index) => ({
      projectId: "DEFAULT",
      id: `INST-${index.toString().padStart(3, "0")}`,
      name: `Matcher benchmark instruction ${index}`,
      query: index % 3 === 0
        ? `tag = ${tagId(index % options.tagCount)} and status = ready`
        : index % 3 === 1
          ? `depends on ${taskId(Math.min(options.taskCount - 1, index + 1))}`
          : `assigned = ${options.machine}:bench-actor-${index % options.trackCount}`,
      body: `Matcher benchmark instruction ${index}.`,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    })),
    comments,
    activity: []
  };
}

function tagId(index: number): string {
  return `TAG-${index.toString().padStart(3, "0")}`;
}
