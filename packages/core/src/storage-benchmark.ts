import { performance } from "node:perf_hooks";
import type { AppStore } from "./store.js";
import type { AddTaskInput, TaskSize } from "./types.js";
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
    for (const tag of tags) {
      await services.tags.add(tag);
    }
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
    for (let index = 0; index < commentCount; index += 1) {
      await services.comments.add(taskId(index), { body: `Benchmark comment ${index}.` });
    }
  });

  await measure(phases, "activity.append", activityCount, async () => {
    for (let index = 0; index < activityCount; index += 1) {
      await services.activity.record("benchmark.activity", "project", projectId, `Benchmark activity ${index}`, { index });
    }
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

async function measure(phases: StorageCrudBenchmarkPhase[], name: string, count: number, fn: () => Promise<void>): Promise<void> {
  const startedAt = performance.now();
  await fn();
  const elapsedMs = roundMs(performance.now() - startedAt);
  phases.push({ name, count, elapsedMs, opsPerSecond: rate(count, elapsedMs) });
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
