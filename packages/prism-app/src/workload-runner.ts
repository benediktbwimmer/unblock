import { execFile as execFileCallback, spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { createServices, type AppStore } from "@unblock/core";
import { createPrismStore, type PrismStore } from "./store.js";

interface RunnerOptions {
  workloadId: string;
  unblockProjectId: string;
  prismProjectId: string;
  shardId: string;
  actorId: string;
  machine: string;
  endpoint: string;
  bind: string;
  postgresUrl: string | undefined;
  schema: string;
  prismCli: string;
  generatedDir: string;
  startPrism: boolean;
  migrate: boolean;
  activate: boolean;
  keepPrism: boolean;
  tasks: number;
  dependencyFanout: number;
  tags: number;
  tagFanout: number;
  instructions: number;
  queries: number;
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

interface RunnerReport {
  ok: boolean;
  workloadId: string;
  endpoint: string;
  schema: string;
  runtimeBackend: "runtime-v2";
  scale: {
    tasks: number;
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
    tasksVisible: number;
    dependenciesVisible: number;
    taskTagsVisible: number;
    instructionsVisible: number;
    matcherMatches: number;
    instructionMatches: number;
  };
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");
const DEFAULT_PRISM_REPO = resolve(PACKAGE_ROOT, "../../../prism-new2");

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.tasks < 2) throw new Error("--tasks must be at least 2");
  if (options.tags < 1) throw new Error("--tags must be at least 1");
  if (options.instructions < 1) throw new Error("--instructions must be at least 1");
  const generatedRuntimeSchema = await runtimeSchemaFromGeneratedSql(options.generatedDir);

  const phases: PhaseMetric[] = [];
  const startedAt = performance.now();
  let workloadStartedAt = startedAt;
  let prism: PrismProcess | null = null;
  let store: PrismStore | null = null;

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

    store = createPrismStore({
      endpoint: options.endpoint,
      projectId: options.prismProjectId,
      shardId: options.shardId,
      actorId: options.actorId,
    });
    const services = createServices(store, {
      projectId: options.unblockProjectId,
      machine: options.machine,
      actor: options.actorId,
    });
    const workload = buildWorkload(options);

    phases.push(await phase("unblock.project.create", async () => {
      await services.projects.add({
        id: options.unblockProjectId,
        name: `Prism workload ${options.workloadId}`,
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
      await waitFor("tags visible", options, async () =>
        (await store!.tags.list(options.unblockProjectId)).length >= options.tags
      );
    }, workload.tags.length));

    phases.push(await phase("unblock.tasks.create", async () => {
      const chunks = chunked(workload.tasks, Math.max(1, Math.ceil(workload.tasks.length / options.concurrency)));
      await parallelMap(chunks, options.concurrency, async (chunk) => {
        await services.tasks.addMany(chunk.map((task) => ({
          id: task.id,
          title: task.title,
          description: task.description,
          priority: task.priority,
          lifecycle: task.lifecycle,
        })));
      });
      await waitFor("tasks visible", options, async () =>
        (await store!.tasks.list(options.unblockProjectId)).length >= options.tasks
      );
    }, workload.tasks.length));

    phases.push(await phase("unblock.dependencies.create", async () => {
      await services.dependencies.addMany(workload.dependencies);
      await waitFor("dependencies visible", options, async () =>
        (await store!.dependencies.list(options.unblockProjectId)).length >= workload.dependencies.length
      );
    }, workload.dependencies.length));

    phases.push(await phase("unblock.task_tags.assign", async () => {
      const tagsByTask = new Map<string, string[]>();
      for (const assignment of workload.taskTags) {
        const tags = tagsByTask.get(assignment.taskId) ?? [];
        tags.push(assignment.tagId);
        tagsByTask.set(assignment.taskId, tags);
      }
      const chunks = chunked([...tagsByTask], Math.max(1, Math.ceil(tagsByTask.size / options.concurrency)));
      await parallelMap(chunks, options.concurrency, async (chunk) => {
        await services.tags.assignMany(
          chunk.map(([taskId, tagIds]) => ({ taskId, tagIdsOrNames: tagIds })),
        );
      });
      await waitFor("task tags visible", options, async () =>
        (await store!.tags.listTaskTags(options.unblockProjectId)).length >= workload.taskTags.length
      );
    }, workload.taskTags.length));

    phases.push(await phase("unblock.instructions.create", async () => {
      await services.instructions.addMany(workload.instructions);
      await waitFor("instructions visible", options, async () =>
        (await store!.instructions.list(options.unblockProjectId)).length >= workload.instructions.length
      );
    }, workload.instructions.length));

    let matcherMatches = 0;
    phases.push(await phase("unblock.matcher.query", async () => {
      const query = workload.matcherQuery;
      await waitFor("matcher query matches", options, async () => {
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
      await waitFor("instruction matches", options, async () => {
        const matches = await services.query.matchingInstructionIds();
        instructionMatches = matches.length;
        return instructionMatches > 0;
      });
    }, workload.instructions.length));

    const report: RunnerReport = {
      ok: true,
      workloadId: options.workloadId,
      endpoint: options.endpoint,
      schema: options.schema,
      runtimeBackend: "runtime-v2",
      scale: {
        tasks: options.tasks,
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
        workloadElapsedMs: Math.round(performance.now() - workloadStartedAt),
        wallElapsedMs: Math.round(performance.now() - startedAt),
        tasksVisible: (await store.tasks.list(options.unblockProjectId)).length,
        dependenciesVisible: (await store.dependencies.list(options.unblockProjectId)).length,
        taskTagsVisible: (await store.tags.listTaskTags(options.unblockProjectId)).length,
        instructionsVisible: (await store.instructions.list(options.unblockProjectId)).length,
        matcherMatches,
        instructionMatches,
      },
    };
    printReport(report, options);
  } finally {
    await store?.close?.();
    if (prism && !options.keepPrism) {
      await stopProcess(prism);
    }
  }
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
  ];
  if (options.postgresUrl) args.push("--postgres-url", options.postgresUrl);
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
  const schema = stringOption(args, "schema", "prism");
  return {
    workloadId,
    unblockProjectId: stringOption(args, "unblock-project-id", workloadId.toUpperCase().replace(/[^A-Z0-9]+/g, "-")),
    prismProjectId: stringOption(args, "prism-project-id", "prism"),
    shardId: stringOption(args, "shard-id", workloadId),
    actorId: stringOption(args, "actor-id", "unblock-bench"),
    machine: stringOption(args, "machine", "benchmark-runner"),
    endpoint,
    bind,
    postgresUrl: optionalStringOption(args, "postgres-url") ?? process.env.PRISM_POSTGRES_URL,
    schema,
    prismCli: stringOption(args, "prism-cli", defaultPrismCli()),
    generatedDir: stringOption(args, "generated-dir", join(PACKAGE_ROOT, "generated")),
    startPrism: booleanOption(args, "start-prism", true),
    migrate: booleanOption(args, "migrate", true),
    activate: booleanOption(args, "activate", true),
    keepPrism: booleanOption(args, "keep-prism", false),
    tasks: numberOption(args, "tasks", 50),
    dependencyFanout: numberOption(args, "dependency-fanout", 2),
    tags: numberOption(args, "tags", 6),
    tagFanout: numberOption(args, "tag-fanout", 1),
    instructions: numberOption(args, "instructions", 3),
    queries: numberOption(args, "queries", 5),
    concurrency: numberOption(args, "concurrency", Math.min(8, Math.max(1, cpus().length))),
    waitTimeoutMs: numberOption(args, "wait-timeout-ms", 60_000),
    waitPollMs: numberOption(args, "wait-poll-ms", 250),
    json: booleanOption(args, "json", false),
  };
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
