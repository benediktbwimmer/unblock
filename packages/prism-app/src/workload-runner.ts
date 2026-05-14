import { execFile as execFileCallback, spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { createServices, type AppStore } from "@unblock/core";
import { createPrismStore, prismShardIdForUnblockProject, type PrismStore } from "./store.js";

interface RunnerOptions {
  mode: "bulk" | "mixed";
  workloadId: string;
  unblockProjectId: string;
  tenantId: string;
  prismProjectId: string;
  shardId: string | undefined;
  actorId: string;
  machine: string;
  endpoint: string;
  bind: string;
  postgresUrl: string | undefined;
  schema: string;
  materializedSurfaceSchema: string | undefined;
  runtimeTablePrefix: string;
  prismCli: string;
  generatedDir: string;
  startPrism: boolean;
  migrate: boolean;
  activate: boolean;
  keepPrism: boolean;
  cleanupSchema: boolean;
  cleanupRuntimeTables: boolean;
  tasks: number;
  projects: number;
  dependencyFanout: number;
  tags: number;
  tagFanout: number;
  instructions: number;
  queries: number;
  mixedOperations: number;
  concurrency: number;
  waitTimeoutMs: number;
  waitPollMs: number;
  json: boolean;
}

type PrismProcess = ChildProcessByStdio<null, Readable, Readable>;

interface PhaseMetric {
  name: string;
  elapsedMs: number;
  count?: number;
}

interface WorkloadTotals {
  tasksVisible: number;
  dependenciesVisible: number;
  taskTagsVisible: number;
  instructionsVisible: number;
  matcherMatches: number;
  instructionMatches: number;
}

interface RunnerReport {
  ok: boolean;
  workloadId: string;
  endpoint: string;
  schema: string;
  runtimeTablePrefix: string;
  runtimeBackend: "runtime-v2";
  scale: {
    tasks: number;
    projects: number;
    mode: "bulk" | "mixed";
    mixedOperations: number;
    dependencyFanout: number;
    tags: number;
    tagFanout: number;
    instructions: number;
    queries: number;
    concurrency: number;
  };
  phases: PhaseMetric[];
  totals: {
    elapsedMs: number;
    workloadElapsedMs: number;
    wallElapsedMs: number;
  } & WorkloadTotals;
  throughput: {
    tasksPerSecond: number;
    dependenciesPerSecond: number;
    taskTagsPerSecond: number;
    projectsPerSecond: number;
  };
  projects?: ProjectReport[];
  mixed?: MixedWorkloadSummary;
}

interface ProjectReport {
  workloadId: string;
  unblockProjectId: string;
  shardId: string;
  phases: PhaseMetric[];
  totals: {
  } & WorkloadTotals;
  mixed?: MixedWorkloadSummary;
}

interface MixedWorkloadSummary {
  operations: number;
  elapsedMs?: number;
  operationCounts: Record<string, number>;
  operationStats?: Record<string, MixedOperationStats>;
  operationsPerSecond?: number;
}

interface MixedOperationStats {
  count: number;
  totalMs: number;
  maxMs: number;
  avgMs: number;
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");
const DEFAULT_PRISM_REPO = resolve(PACKAGE_ROOT, "../../../prism-new2");

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.tasks < 2) throw new Error("--tasks must be at least 2");
  if (options.projects < 1) throw new Error("--projects must be at least 1");
  if (options.tags < 1) throw new Error("--tags must be at least 1");
  if (options.instructions < 1) throw new Error("--instructions must be at least 1");
  const generatedRuntimeSchema = await runtimeSchemaFromGeneratedSql(options.generatedDir);
  options.materializedSurfaceSchema ??= options.schema;

  const phases: PhaseMetric[] = [];
  const startedAt = performance.now();
  let workloadStartedAt = startedAt;
  let prism: PrismProcess | null = null;

  try {
    if (options.migrate) {
      phases.push(await phase("prism.postgres.migrate", async () => {
        await runPrism(options, ["postgres", "migrate", "--schema", options.schema]);
      }));
    }

    if (options.activate) {
      if (generatedRuntimeSchema && generatedRuntimeSchema !== options.schema) {
        phases.push(await phase("prism.generated_runtime_schema.migrate", async () => {
          await runPrism(options, ["postgres", "migrate", "--schema", generatedRuntimeSchema]);
        }));
      }
      phases.push(await phase("prism.activate.apply", async () => {
        await runPrism(options, [
          "activate",
          "apply",
          options.generatedDir,
          "--schema",
          options.schema,
          "--project",
          options.prismProjectId,
          "--activated-by",
          "unblock-workload-runner",
        ]);
      }));
    }

    if (options.startPrism) {
      const start = performance.now();
      prism = startPrismServe(options);
      await waitForRuntimeHealth(options);
      phases.push({ name: "prism.serve.ready", elapsedMs: Math.round(performance.now() - start) });
    } else {
      phases.push(await phase("prism.runtime.health", async () => {
        await waitForRuntimeHealth(options);
      }));
    }
    workloadStartedAt = performance.now();

    const projectStartedAt = performance.now();
    const projectRunner = options.mode === "mixed" ? runProjectMixedWorkload : runProjectWorkload;
    const projectReports = await Promise.all(
      Array.from({ length: options.projects }, (_, index) => projectRunner(options, index)),
    );
    const workloadElapsedMs = Math.round(performance.now() - projectStartedAt);
    phases.push(...aggregateProjectPhases(projectReports));
    const totals = aggregateProjectTotals(projectReports);

    const mixed = aggregateMixedSummaries(projectReports);
    const report: RunnerReport = {
      ok: true,
      workloadId: options.workloadId,
      endpoint: options.endpoint,
      schema: options.schema,
      runtimeTablePrefix: options.runtimeTablePrefix,
      runtimeBackend: "runtime-v2",
      scale: {
        tasks: options.tasks,
        projects: options.projects,
        mode: options.mode,
        mixedOperations: options.mixedOperations,
        dependencyFanout: options.dependencyFanout,
        tags: options.tags,
        tagFanout: options.tagFanout,
        instructions: options.instructions,
        queries: options.queries,
        concurrency: options.concurrency,
      },
      phases,
      totals: {
        elapsedMs: Math.round(performance.now() - workloadStartedAt),
        workloadElapsedMs,
        wallElapsedMs: Math.round(performance.now() - startedAt),
        ...totals,
      },
      throughput: throughput(totals, options.projects, workloadElapsedMs),
      projects: projectReports,
      ...(mixed ? { mixed } : {}),
    };
    printReport(report, options);
  } finally {
    if (prism && !options.keepPrism) {
      await stopProcess(prism);
    }
    if (!options.keepPrism && options.cleanupRuntimeTables) {
      await dropRuntimeTables(options);
    }
    if (!options.keepPrism && options.cleanupSchema) {
      await dropCatalogSchema(options);
    }
  }
}

async function runProjectWorkload(options: RunnerOptions, projectIndex: number): Promise<ProjectReport> {
  const projectOptions = optionsForProject(options, projectIndex);
  const phases: PhaseMetric[] = [];
  const store = createPrismStore({
    endpoint: options.endpoint,
    projectId: options.prismProjectId,
    tenantId: options.tenantId,
    unblockProjectId: projectOptions.unblockProjectId,
    ...(projectOptions.shardId ? { shardId: projectOptions.shardId } : {}),
    actorId: options.actorId,
  });
  try {
    const services = createServices(store, {
      projectId: projectOptions.unblockProjectId,
      machine: options.machine,
      actor: options.actorId,
    });
    const workload = buildWorkload(projectOptions);

    phases.push(await phase("unblock.project.create", async () => {
      await services.projects.add({
        id: projectOptions.unblockProjectId,
        name: `Prism workload ${projectOptions.workloadId}`,
      });
    }, 1));

    phases.push(await phase("unblock.tags.create", async () => {
      await parallelMap(workload.tags, options.concurrency, async (tag, index) => {
        await services.tags.add({
          id: tag,
          name: tag.toLowerCase(),
          color: palette(index),
          sortOrder: index,
        });
      });
      await waitFor(`tags visible for ${projectOptions.unblockProjectId}`, options, async () =>
        (await store.tags.list(projectOptions.unblockProjectId)).length >= options.tags
      );
    }, workload.tags.length));

    phases.push(await phase("unblock.tasks.create", async () => {
      const chunks = chunked(workload.tasks, bulkChunkSize(workload.tasks.length, options.concurrency));
      await parallelMap(chunks, options.concurrency, async (chunk) => {
        await services.tasks.addMany(chunk.map((task) => ({
          id: task.id,
          title: task.title,
          description: task.description,
          priority: task.priority,
          lifecycle: task.lifecycle,
        })));
      });
      await waitFor(`tasks visible for ${projectOptions.unblockProjectId}`, options, async () =>
        (await store.tasks.list(projectOptions.unblockProjectId)).length >= options.tasks
      );
    }, workload.tasks.length));

    phases.push(await phase("unblock.dependencies.create", async () => {
      await services.dependencies.addMany(workload.dependencies);
      await waitFor(`dependencies visible for ${projectOptions.unblockProjectId}`, options, async () =>
        (await store.dependencies.list(projectOptions.unblockProjectId)).length >= workload.dependencies.length
      );
    }, workload.dependencies.length));

    phases.push(await phase("unblock.task_tags.assign", async () => {
      const tagsByTask = new Map<string, string[]>();
      for (const assignment of workload.taskTags) {
        const tags = tagsByTask.get(assignment.taskId) ?? [];
        tags.push(assignment.tagId);
        tagsByTask.set(assignment.taskId, tags);
      }
      const chunks = chunked([...tagsByTask], bulkChunkSize(tagsByTask.size, options.concurrency));
      await parallelMap(chunks, options.concurrency, async (chunk) => {
        await services.tags.assignMany(
          chunk.map(([taskId, tagIds]) => ({ taskId, tagIdsOrNames: tagIds })),
        );
      });
      await waitFor(`task tags visible for ${projectOptions.unblockProjectId}`, options, async () =>
        (await store.tags.listTaskTags(projectOptions.unblockProjectId)).length >= workload.taskTags.length
      );
    }, workload.taskTags.length));

    phases.push(await phase("unblock.instructions.create", async () => {
      await services.instructions.addMany(workload.instructions);
      await waitFor(`instructions visible for ${projectOptions.unblockProjectId}`, options, async () =>
        (await store.instructions.list(projectOptions.unblockProjectId)).length >= workload.instructions.length
      );
    }, workload.instructions.length));

    let matcherMatches = 0;
    phases.push(await phase("unblock.matcher.query", async () => {
      const query = workload.matcherQuery;
      await waitFor(`matcher query matches for ${projectOptions.unblockProjectId}`, options, async () => {
        const matches = await services.query.matchIds(query, options.tasks, { includeArchived: true, includeFinished: true });
        matcherMatches = matches.length;
        return matcherMatches > 0;
      });
      for (let index = 1; index < options.queries; index += 1) {
        matcherMatches += (await services.query.matchIds(query, options.tasks, { includeArchived: true, includeFinished: true })).length;
      }
    }, options.queries));

    let instructionMatches = 0;
    phases.push(await phase("unblock.instructions.match", async () => {
      await waitFor(`instruction matches for ${projectOptions.unblockProjectId}`, options, async () => {
        const matches = await services.query.matchingInstructionIds();
        instructionMatches = matches.length;
        return instructionMatches > 0;
      });
    }, workload.instructions.length));

    return {
      workloadId: projectOptions.workloadId,
      unblockProjectId: projectOptions.unblockProjectId,
      shardId: projectOptions.shardId ?? prismShardIdForUnblockProject(options.tenantId, projectOptions.unblockProjectId),
      phases,
      totals: {
        tasksVisible: (await store.tasks.list(projectOptions.unblockProjectId)).length,
        dependenciesVisible: (await store.dependencies.list(projectOptions.unblockProjectId)).length,
        taskTagsVisible: (await store.tags.listTaskTags(projectOptions.unblockProjectId)).length,
        instructionsVisible: (await store.instructions.list(projectOptions.unblockProjectId)).length,
        matcherMatches,
        instructionMatches,
      },
    };
  } finally {
    await store.close?.();
  }
}

async function runProjectMixedWorkload(options: RunnerOptions, projectIndex: number): Promise<ProjectReport> {
  const seed = await runProjectWorkload({ ...options, mode: "bulk", queries: Math.min(options.queries, 2) }, projectIndex);
  const projectOptions = optionsForProject(options, projectIndex);
  const store = createPrismStore({
    endpoint: options.endpoint,
    projectId: options.prismProjectId,
    tenantId: options.tenantId,
    unblockProjectId: projectOptions.unblockProjectId,
    ...(projectOptions.shardId ? { shardId: projectOptions.shardId } : {}),
    actorId: options.actorId,
  });
  try {
    const services = createServices(store, {
      projectId: projectOptions.unblockProjectId,
      machine: options.machine,
      actor: options.actorId,
    });
    const workload = buildWorkload(projectOptions);
    const operationStats = new Map<string, { count: number; totalMs: number; maxMs: number }>();
    const mixedPhase = await phase("unblock.mixed.operations", async () => {
      await parallelMap(Array.from({ length: options.mixedOperations }, (_, index) => index), options.concurrency, async (index) => {
        const startedAt = performance.now();
        const kind = await runMixedOperation(services, store, workload, projectOptions, index);
        const elapsedMs = Math.round(performance.now() - startedAt);
        const current = operationStats.get(kind) ?? { count: 0, totalMs: 0, maxMs: 0 };
        current.count += 1;
        current.totalMs += elapsedMs;
        current.maxMs = Math.max(current.maxMs, elapsedMs);
        operationStats.set(kind, current);
      });
    }, options.mixedOperations);

    const mixed: MixedWorkloadSummary = {
      operations: options.mixedOperations,
      elapsedMs: mixedPhase.elapsedMs,
      operationCounts: Object.fromEntries([...operationStats].sort(([left], [right]) => left.localeCompare(right)).map(([kind, stats]) => [kind, stats.count])),
      operationStats: mixedOperationStatsJson(operationStats),
      operationsPerSecond: roundRate(options.mixedOperations / Math.max(mixedPhase.elapsedMs / 1000, 0.001)),
    };
    return {
      ...seed,
      phases: [...seed.phases, mixedPhase],
      totals: {
        tasksVisible: (await store.tasks.list(projectOptions.unblockProjectId)).length,
        dependenciesVisible: (await store.dependencies.list(projectOptions.unblockProjectId)).length,
        taskTagsVisible: (await store.tags.listTaskTags(projectOptions.unblockProjectId)).length,
        instructionsVisible: (await store.instructions.list(projectOptions.unblockProjectId)).length,
        matcherMatches: seed.totals.matcherMatches,
        instructionMatches: seed.totals.instructionMatches,
      },
      mixed,
    };
  } finally {
    await store.close?.();
  }
}

async function runMixedOperation(
  services: ReturnType<typeof createServices>,
  store: PrismStore,
  workload: ReturnType<typeof buildWorkload>,
  projectOptions: RunnerOptions,
  index: number,
): Promise<string> {
  const task = workload.tasks[index % workload.tasks.length]!;
  const previous = workload.tasks[Math.max(0, (index % workload.tasks.length) - 1)]!;
  const tag = workload.tags[index % workload.tags.length]!;
  const instruction = workload.instructions[index % workload.instructions.length]!;
  switch (index % 10) {
    case 0:
      await services.tasks.edit(task.id, {
        title: `${task.title} update ${index}`,
        priority: ((task.priority + index) % 5) as 0 | 1 | 2 | 3 | 4,
      });
      return "task.update";
    case 1:
      await services.tasks.edit(task.id, {
        description: `${task.description} Mixed workload update ${index}.`,
        lifecycle: index % 4 === 1 ? "started" : "open",
      });
      return "task.lifecycle";
    case 2: {
      const taskIndex = index % workload.tasks.length;
      const dependencyIndex = taskIndex > 0 ? Math.max(0, taskIndex - 3) : 1;
      const dependencyTask = workload.tasks[dependencyIndex];
      if (!dependencyTask || dependencyTask.id === task.id) return "dependency.add.skipped";
      await services.dependencies.addMany([{ taskId: task.id, dependsOnTaskId: dependencyTask.id }]);
      return "dependency.add";
    }
    case 3:
      await services.dependencies.remove(task.id, previous.id);
      return "dependency.remove";
    case 4:
      await services.tags.assignMany([{ taskId: task.id, tagIdsOrNames: [tag] }]);
      return "tag.assign";
    case 5:
      await services.tags.remove(task.id, tag);
      return "tag.remove";
    case 6:
      await services.instructions.edit(instruction.id, {
        body: `${instruction.body} Mixed workload update ${index}.`,
        enabled: index % 20 !== 6,
      });
      return "instruction.update";
    case 7:
      await services.query.matchIds(workload.matcherQuery, 100, { includeArchived: true, includeFinished: true });
      return "matcher.query";
    case 8:
      await services.query.matchingInstructionIds();
      return "instruction.match";
    default:
      await Promise.all([
        services.query.list({ includeArchived: true, includeFinished: true }),
        store.dependencies.list(projectOptions.unblockProjectId),
        store.tags.listTaskTags(projectOptions.unblockProjectId),
      ]);
      return "read.scan";
  }
}

function optionsForProject(options: RunnerOptions, projectIndex: number): RunnerOptions {
  if (options.projects === 1) return options;
  const suffix = `p${projectIndex.toString().padStart(3, "0")}`;
  const unblockProjectId = `${options.unblockProjectId}-${suffix.toUpperCase()}`;
  const explicitShardId = options.shardId ? `${options.shardId}:project:${suffix}` : undefined;
  return {
    ...options,
    workloadId: `${options.workloadId}-${suffix}`,
    unblockProjectId,
    shardId: explicitShardId,
  };
}

function buildWorkload(options: RunnerOptions): {
  tags: string[];
  tasks: Array<{
    id: string;
    title: string;
    description: string;
    priority: 0 | 1 | 2 | 3 | 4;
    lifecycle: "open" | "started" | "finished";
  }>;
  dependencies: Array<{ taskId: string; dependsOnTaskId: string }>;
  taskTags: Array<{ taskId: string; tagId: string }>;
  instructions: Array<{ id: string; name: string; query: string; body: string; enabled: boolean }>;
  matcherQuery: string;
} {
  const prefix = options.workloadId.toUpperCase().replace(/[^A-Z0-9]+/g, "-");
  const tags = Array.from({ length: options.tags }, (_, index) => `${prefix}-TAG-${index}`);
  const tasks = Array.from({ length: options.tasks }, (_, index) => ({
    id: `${prefix}-TASK-${index.toString().padStart(5, "0")}`,
    title: `Task ${index} for ${options.workloadId}`,
    description: `Synthetic Prism runtime workload task ${index}.`,
    priority: (index % 5) as 0 | 1 | 2 | 3 | 4,
    lifecycle: (index % 11 === 0 ? "started" : "open") as "open" | "started",
  }));
  const dependencies: Array<{ taskId: string; dependsOnTaskId: string }> = [];
  for (let index = 1; index < tasks.length; index += 1) {
    for (let fanout = 1; fanout <= options.dependencyFanout && index - fanout >= 0; fanout += 1) {
      dependencies.push({ taskId: tasks[index]!.id, dependsOnTaskId: tasks[index - fanout]!.id });
    }
  }
  const taskTags: Array<{ taskId: string; tagId: string }> = [];
  for (let index = 0; index < tasks.length; index += 1) {
    for (let fanout = 0; fanout < options.tagFanout; fanout += 1) {
      taskTags.push({ taskId: tasks[index]!.id, tagId: tags[(index + fanout) % tags.length]! });
    }
  }
  const depth = Math.max(1, Math.min(options.dependencyFanout + 2, options.tasks - 1));
  const target = tasks[0]!.id;
  const matcherQuery = `tag = ${tags[0]} and depends on ${target} depth <= ${depth}`;
  const instructions = Array.from({ length: options.instructions }, (_, index) => ({
    id: `${prefix}-INSTRUCTION-${index.toString().padStart(3, "0")}`,
    name: `Instruction ${index} ${options.workloadId}`,
    query: index % 2 === 0
      ? matcherQuery
      : `priority >= ${index % 5} and tag = ${tags[index % tags.length]}`,
    body: `Synthetic instruction ${index} generated by the Prism workload runner.`,
    enabled: true,
  }));
  return { tags, tasks, dependencies, taskTags, instructions, matcherQuery };
}

function aggregateProjectPhases(projects: ProjectReport[]): PhaseMetric[] {
  const byName = new Map<string, { elapsedMs: number; count: number | undefined }>();
  for (const project of projects) {
    for (const phase of project.phases) {
      const current = byName.get(phase.name) ?? { elapsedMs: 0, count: undefined };
      current.elapsedMs = Math.max(current.elapsedMs, phase.elapsedMs);
      if (phase.count !== undefined) current.count = (current.count ?? 0) + phase.count;
      byName.set(phase.name, current);
    }
  }
  return [...byName].map(([name, metric]) => ({
    name: projects.length === 1 ? name : `${name}.max`,
    elapsedMs: metric.elapsedMs,
    ...(metric.count === undefined ? {} : { count: metric.count }),
  }));
}

function aggregateProjectTotals(projects: ProjectReport[]): WorkloadTotals {
  const totals = {
    tasksVisible: 0,
    dependenciesVisible: 0,
    taskTagsVisible: 0,
    instructionsVisible: 0,
    matcherMatches: 0,
    instructionMatches: 0,
  };
  for (const project of projects) {
    totals.tasksVisible += project.totals.tasksVisible;
    totals.dependenciesVisible += project.totals.dependenciesVisible;
    totals.taskTagsVisible += project.totals.taskTagsVisible;
    totals.instructionsVisible += project.totals.instructionsVisible;
    totals.matcherMatches += project.totals.matcherMatches;
    totals.instructionMatches += project.totals.instructionMatches;
  }
  return totals;
}

function aggregateMixedSummaries(projects: ProjectReport[]): MixedWorkloadSummary | undefined {
  const mixedProjects = projects.filter((project) => project.mixed);
  if (mixedProjects.length === 0) return undefined;
  const operationStats = new Map<string, { count: number; totalMs: number; maxMs: number }>();
  let operations = 0;
  let elapsedMs = 0;
  for (const project of mixedProjects) {
    const mixed = project.mixed!;
    operations += mixed.operations;
    elapsedMs = Math.max(elapsedMs, mixed.elapsedMs ?? phaseElapsed(project, "unblock.mixed.operations"));
    for (const [kind, stats] of Object.entries(mixed.operationStats ?? {})) {
      const current = operationStats.get(kind) ?? { count: 0, totalMs: 0, maxMs: 0 };
      current.count += stats.count;
      current.totalMs += stats.totalMs;
      current.maxMs = Math.max(current.maxMs, stats.maxMs);
      operationStats.set(kind, current);
    }
  }
  const seconds = Math.max(elapsedMs / 1000, 0.001);
  return {
    operations,
    elapsedMs,
    operationCounts: Object.fromEntries([...operationStats].sort(([left], [right]) => left.localeCompare(right)).map(([kind, stats]) => [kind, stats.count])),
    operationStats: mixedOperationStatsJson(operationStats),
    operationsPerSecond: roundRate(operations / seconds),
  };
}

function phaseElapsed(project: ProjectReport, phaseName: string): number {
  return project.phases
    .filter((phase) => phase.name === phaseName)
    .reduce((max, phase) => Math.max(max, phase.elapsedMs), 0);
}

function mixedOperationStatsJson(stats: Map<string, { count: number; totalMs: number; maxMs: number }>): Record<string, MixedOperationStats> {
  return Object.fromEntries([...stats].sort(([left], [right]) => left.localeCompare(right)).map(([kind, value]) => [kind, {
    count: value.count,
    totalMs: value.totalMs,
    maxMs: value.maxMs,
    avgMs: roundRate(value.totalMs / Math.max(value.count, 1)),
  }]));
}

function throughput(
  totals: ReturnType<typeof aggregateProjectTotals>,
  projectCount: number,
  elapsedMs: number,
): RunnerReport["throughput"] {
  const seconds = Math.max(elapsedMs / 1000, 0.001);
  return {
    tasksPerSecond: roundRate(totals.tasksVisible / seconds),
    dependenciesPerSecond: roundRate(totals.dependenciesVisible / seconds),
    taskTagsPerSecond: roundRate(totals.taskTagsVisible / seconds),
    projectsPerSecond: roundRate(projectCount / seconds),
  };
}

function roundRate(value: number): number {
  return Math.round(value * 10) / 10;
}

function startPrismServe(options: RunnerOptions): PrismProcess {
  const args = [
    "serve",
    "--roles",
    "all",
    "--runtime-v2-storage-backend",
    "postgres",
    "--bind",
    options.bind,
    "--runtime-advertised-grpc-addr",
    options.endpoint,
    "--schema",
    options.schema,
    "--runtime-v2-postgres-table-prefix",
    options.runtimeTablePrefix,
  ];
  if (options.postgresUrl) args.push("--postgres-url", options.postgresUrl);
  if (options.materializedSurfaceSchema) {
    args.push("--runtime-v2-materialized-surface-schema", options.materializedSurfaceSchema);
  }
  const child = spawn(options.prismCli, args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...(options.postgresUrl ? { PRISM_POSTGRES_URL: options.postgresUrl } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    if (!options.json) process.stderr.write(`[prism] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    if (!options.json) process.stderr.write(`[prism] ${chunk}`);
  });
  child.once("exit", (code, signal) => {
    if (code !== null && code !== 0 && !options.json) {
      process.stderr.write(`[prism] exited code=${code}\n`);
    }
    if (signal && !options.json) {
      process.stderr.write(`[prism] exited signal=${signal}\n`);
    }
  });
  return child;
}

async function waitForRuntimeHealth(options: RunnerOptions): Promise<void> {
  await waitFor("runtime health", options, async () => {
    try {
      await runPrism(options, ["runtime", "health", "--endpoint", options.endpoint, "--json"], { quiet: true });
      return true;
    } catch {
      return false;
    }
  });
}

async function waitFor(name: string, options: RunnerOptions, predicate: () => Promise<boolean>): Promise<void> {
  const started = performance.now();
  let lastError: unknown;
  while (performance.now() - started < options.waitTimeoutMs) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(options.waitPollMs);
  }
  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${name} after ${options.waitTimeoutMs}ms.${suffix}`);
}

async function phase(name: string, fn: () => Promise<void>, count?: number): Promise<PhaseMetric> {
  const started = performance.now();
  await fn();
  return { name, elapsedMs: Math.round(performance.now() - started), ...(count === undefined ? {} : { count }) };
}

async function runPrism(options: RunnerOptions, args: string[], settings: { quiet?: boolean } = {}): Promise<string> {
  return await execFileChecked(options.prismCli, args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...(options.postgresUrl ? { PRISM_POSTGRES_URL: options.postgresUrl } : {}),
    },
    quiet: settings.quiet ?? false,
  });
}

async function dropRuntimeTables(options: RunnerOptions): Promise<void> {
  if (!options.postgresUrl) return;
  validateRuntimeTablePrefix(options.runtimeTablePrefix);
  const prefix = sqlLiteral(options.runtimeTablePrefix);
  const sql = `
do $$
declare
  table_row record;
begin
  for table_row in
    select schemaname, tablename
      from pg_tables
     where schemaname = 'public'
       and tablename like ${prefix} || '\\_%' escape '\\'
  loop
    execute format('drop table if exists %I.%I cascade', table_row.schemaname, table_row.tablename);
  end loop;
end $$;
`;
  await execFileChecked("psql", [options.postgresUrl, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], {
    cwd: REPO_ROOT,
    env: process.env,
    quiet: true,
  });
}

async function dropCatalogSchema(options: RunnerOptions): Promise<void> {
  if (!options.postgresUrl) return;
  validatePostgresIdentifier(options.schema, "--schema");
  if (options.schema === "public") return;
  await execFileChecked("psql", [
    options.postgresUrl,
    "-v",
    "ON_ERROR_STOP=1",
    "-q",
    "-c",
    `drop schema if exists ${quotedIdentifier(options.schema)} cascade;`,
  ], {
    cwd: REPO_ROOT,
    env: process.env,
    quiet: true,
  });
}

async function runtimeSchemaFromGeneratedSql(generatedDir: string): Promise<string | null> {
  const sqlPath = join(generatedDir, "desired_schema.sql");
  if (!existsSync(sqlPath)) return null;
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile(sqlPath, "utf8");
  const match = /create\s+table\s+if\s+not\s+exists\s+([a-zA-Z_][a-zA-Z0-9_]*)\.commit_log/i.exec(sql);
  return match?.[1] ?? null;
}

function execFileChecked(command: string, args: string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  quiet: boolean;
}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFileCallback(command, args, { cwd: options.cwd, env: options.env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!options.quiet && stdout.trim()) process.stderr.write(stdout);
      if (!options.quiet && stderr.trim()) process.stderr.write(stderr);
      if (error) {
        const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
        reject(new Error(`${command} ${args.join(" ")} failed: ${error.message}${details ? `\n${details}` : ""}`));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

async function parallelMap<T>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index]!, index);
    }
  }));
}

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function bulkChunkSize(count: number, concurrency: number): number {
  return Math.max(250, Math.max(1, Math.ceil(count / concurrency)));
}

async function stopProcess(child: PrismProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())),
    sleep(5_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }),
  ]);
}

function parseArgs(args: string[]): RunnerOptions {
  const workloadId = stringOption(args, "workload-id", `bench-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`);
  const bind = stringOption(args, "bind", "127.0.0.1:50061");
  const endpoint = stringOption(args, "endpoint", `http://${bind}`);
  const explicitSchema = optionalStringOption(args, "schema");
  const schema = explicitSchema ?? catalogSchemaForWorkload(workloadId);
  validatePostgresIdentifier(schema, "--schema");
  const mode = parseMode(stringOption(args, "mode", args.includes("--mixed") ? "mixed" : "bulk"));
  const explicitRuntimeTablePrefix = optionalStringOption(args, "runtime-table-prefix");
  const runtimeTablePrefix = explicitRuntimeTablePrefix ?? runtimeTablePrefixForWorkload(workloadId);
  validateRuntimeTablePrefix(runtimeTablePrefix);
  return {
    mode,
    workloadId,
    unblockProjectId: stringOption(args, "unblock-project-id", workloadId.toUpperCase().replace(/[^A-Z0-9]+/g, "-")),
    tenantId: stringOption(args, "tenant-id", "bench-tenant"),
    prismProjectId: stringOption(args, "prism-project-id", "prism"),
    shardId: optionalStringOption(args, "shard-id"),
    actorId: stringOption(args, "actor-id", "unblock-bench"),
    machine: stringOption(args, "machine", "benchmark-runner"),
    endpoint,
    bind,
    postgresUrl: optionalStringOption(args, "postgres-url") ?? process.env.PRISM_POSTGRES_URL,
    schema,
    materializedSurfaceSchema: optionalStringOption(args, "materialized-surface-schema"),
    runtimeTablePrefix,
    prismCli: stringOption(args, "prism-cli", defaultPrismCli()),
    generatedDir: stringOption(args, "generated-dir", join(PACKAGE_ROOT, "generated")),
    startPrism: booleanOption(args, "start-prism", true),
    migrate: booleanOption(args, "migrate", true),
    activate: booleanOption(args, "activate", true),
    keepPrism: booleanOption(args, "keep-prism", false),
    cleanupSchema: booleanOption(args, "cleanup-schema", explicitSchema === undefined),
    cleanupRuntimeTables: booleanOption(args, "cleanup-runtime-tables", explicitRuntimeTablePrefix === undefined),
    tasks: numberOption(args, "tasks", 50),
    projects: numberOption(args, "projects", 1),
    dependencyFanout: numberOption(args, "dependency-fanout", 2),
    tags: numberOption(args, "tags", 6),
    tagFanout: numberOption(args, "tag-fanout", 1),
    instructions: numberOption(args, "instructions", 3),
    queries: numberOption(args, "queries", 5),
    mixedOperations: numberOption(args, "mixed-operations", 100),
    concurrency: numberOption(args, "concurrency", Math.min(8, Math.max(1, cpus().length))),
    waitTimeoutMs: numberOption(args, "wait-timeout-ms", 60_000),
    waitPollMs: numberOption(args, "wait-poll-ms", 250),
    json: booleanOption(args, "json", false),
  };
}

function runtimeTablePrefixForWorkload(workloadId: string): string {
  const digest = createHash("sha256").update(workloadId).digest("hex").slice(0, 16);
  return `prism_v2_b_${digest}`;
}

function validateRuntimeTablePrefix(prefix: string): void {
  validatePostgresIdentifier(prefix, "--runtime-table-prefix");
}

function catalogSchemaForWorkload(workloadId: string): string {
  const digest = createHash("sha256").update(workloadId).digest("hex").slice(0, 16);
  return `prism_bench_${digest}`;
}

function validatePostgresIdentifier(value: string, optionName: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,56}$/.test(value)) {
    throw new Error(`${optionName} must be an ASCII Postgres identifier with at most 57 chars`);
  }
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quotedIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function parseMode(value: string): "bulk" | "mixed" {
  if (value === "bulk" || value === "mixed") return value;
  throw new Error("--mode must be bulk or mixed");
}

function defaultPrismCli(): string {
  if (process.env.UNBLOCK_PRISM_CLI) return process.env.UNBLOCK_PRISM_CLI;
  if (process.env.PRISM_CLI) return process.env.PRISM_CLI;
  const repoBinary = resolve(DEFAULT_PRISM_REPO, "target/debug/prism");
  return existsSync(repoBinary) ? repoBinary : "prism";
}

function stringOption(args: string[], name: string, fallback: string): string {
  return optionalStringOption(args, name) ?? fallback;
}

function optionalStringOption(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index >= 0) return args[index + 1];
  return undefined;
}

function numberOption(args: string[], name: string, fallback: number): number {
  const raw = optionalStringOption(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number`);
  return Math.floor(value);
}

function booleanOption(args: string[], name: string, fallback: boolean): boolean {
  if (args.includes(`--${name}`)) return true;
  if (args.includes(`--no-${name}`)) return false;
  const raw = optionalStringOption(args, name);
  if (raw === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`--${name} must be true or false`);
}

function palette(index: number): string {
  const colors = ["#2563eb", "#16a34a", "#dc2626", "#ca8a04", "#0891b2", "#7c3aed", "#db2777", "#4b5563"];
  return colors[index % colors.length]!;
}

function printReport(report: RunnerReport, options: RunnerOptions): void {
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`ok=${report.ok} workload=${report.workloadId} runtime=${report.runtimeBackend} endpoint=${report.endpoint}`);
  for (const phase of report.phases) {
    console.log(`${phase.name}: ${phase.elapsedMs}ms${phase.count === undefined ? "" : ` count=${phase.count}`}`);
  }
  console.log(`workloadTotal: ${report.totals.workloadElapsedMs}ms wallTotal: ${report.totals.wallElapsedMs}ms tasks=${report.totals.tasksVisible} dependencies=${report.totals.dependenciesVisible} taskTags=${report.totals.taskTagsVisible} matcherMatches=${report.totals.matcherMatches} instructionMatches=${report.totals.instructionMatches}`);
  console.log(`throughput: tasks=${report.throughput.tasksPerSecond}/s dependencies=${report.throughput.dependenciesPerSecond}/s taskTags=${report.throughput.taskTagsPerSecond}/s projects=${report.throughput.projectsPerSecond}/s`);
  if (report.mixed) {
    console.log(`mixed: operations=${report.mixed.operations} elapsed=${report.mixed.elapsedMs}ms rate=${report.mixed.operationsPerSecond}/s counts=${JSON.stringify(report.mixed.operationCounts)}`);
    if (report.mixed.operationStats) {
      console.log(`mixedStats: ${JSON.stringify(report.mixed.operationStats)}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
