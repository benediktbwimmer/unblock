#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import {
  createServices,
  createSqliteStore,
  defaultNotJiraDbPath,
  formatActivity,
  formatExplain,
  formatTaskMarkdown,
  formatTaskTable,
  MigrationService,
  NotJiraError,
  prioritySchema,
  type ComputedStatus,
  type OutputFormat,
  type Priority,
  type TaskListFilters,
  type TaskSort
} from "@not-jira/core";

interface GlobalOptions {
  db?: string;
  format?: OutputFormat;
}

const program = new Command();

program
  .name("not-jira")
  .description("Dependency-first implementation task manager")
  .version("0.1.0")
  .option("--db <path>", "SQLite database path", process.env.NOT_JIRA_DB)
  .addOption(new Option("--format <format>", "output format").choices(["table", "json", "markdown"]).default("table"));

program.command("serve")
  .description("Start the API and web dev servers")
  .option("--api-port <port>", "API server port", parseInteger, 3000)
  .option("--web-port <port>", "web server port", parseInteger, 5173)
  .option("--host <host>", "web server host", "0.0.0.0")
  .action(async (options: { apiPort: number; webPort: number; host: string }) => {
    const root = findWorkspaceRoot();
    const databasePath = dbPath();
    const env = {
      ...process.env,
      NOT_JIRA_DB: databasePath,
      NOT_JIRA_API_PORT: String(options.apiPort),
      NOT_JIRA_WEB_PORT: String(options.webPort),
      NOT_JIRA_WEB_HOST: options.host
    };

    console.log(`Database: ${databasePath}`);
    console.log(`API:      http://localhost:${options.apiPort}`);
    console.log(`Web:      http://localhost:${options.webPort}`);
    console.log("Press Ctrl-C to stop both servers.");

    const children = [
      spawnManaged("api", "npm", ["run", "--silent", "dev:server"], root, { ...env, PORT: String(options.apiPort) }),
      spawnManaged("web", "npm", ["run", "--silent", "dev:web"], root, env)
    ];

    await waitForInterrupt(children);
  });

program.command("doctor")
  .description("Check local configuration")
  .action(async () => {
    const store = openStore();
    try {
      const migration = new MigrationService(store);
      const status = await migration.status();
      print({
        database: dbPath(),
        appliedMigrations: status.applied.length,
        pendingMigrations: status.pending.map((item) => item.id)
      }, "json");
    } finally {
      await store.close?.();
    }
  });

const db = program.command("db").description("Database maintenance");

db.command("init")
  .description("Create or migrate the database")
  .action(async () => {
    const store = openStore();
    try {
      const migration = new MigrationService(store);
      const status = await migration.migrate();
      console.log(`Database ready: ${dbPath()}`);
      console.log(`Applied: ${status.applied.length}`);
      console.log(`Pending: ${status.pending.length}`);
    } finally {
      await store.close?.();
    }
  });

db.command("status")
  .description("Show migration status")
  .action(async () => {
    const store = openStore();
    try {
      const migration = new MigrationService(store);
      const status = await migration.status();
      print(status, format());
    } finally {
      await store.close?.();
    }
  });

db.command("migrate")
  .description("Run migrations")
  .action(async () => {
    const store = openStore();
    try {
      const migration = new MigrationService(store);
      print(await migration.migrate(), format());
    } finally {
      await store.close?.();
    }
  });

const task = program.command("task").description("Task commands");

task.command("add")
  .description("Create a task")
  .requiredOption("--id <id>", "task id")
  .requiredOption("--title <title>", "task title")
  .option("--parent <id>", "parent task id")
  .option("--description <text>", "description")
  .option("--priority <n>", "priority 0-4", parsePriority)
  .option("--size <size>", "XS, S, M, L, XL")
  .option("--source <doc>", "source document")
  .option("--section <section>", "source section")
  .option("--source-line <line>", "source line", parseInteger)
  .option("--completion-bar <text>", "completion bar")
  .action(async (options) => withServices(async ({ services }) => {
    const created = await services.tasks.add(defined({
      id: options.id,
      title: options.title,
      parentTaskId: options.parent ?? null,
      description: options.description,
      priority: options.priority,
      size: options.size ?? null,
      sourceDoc: options.source ?? null,
      sourceSection: options.section ?? null,
      sourceLine: options.sourceLine ?? null,
      completionBar: options.completionBar ?? null
    }));
    print(created, format());
  }));

task.command("edit")
  .description("Edit a task")
  .argument("<id>")
  .option("--title <title>", "task title")
  .option("--parent <id>", "parent task id; use none for root")
  .option("--description <text>", "description")
  .option("--lifecycle <lifecycle>", "open, started, finished")
  .option("--priority <n>", "priority 0-4", parsePriority)
  .option("--size <size>", "XS, S, M, L, XL; use none to clear")
  .option("--source <doc>", "source document")
  .option("--section <section>", "source section")
  .option("--source-line <line>", "source line", parseInteger)
  .option("--completion-bar <text>", "completion bar")
  .action(async (id, options) => withServices(async ({ services }) => {
    const updated = await services.tasks.edit(id, defined({
      title: options.title,
      parentTaskId: options.parent === undefined ? undefined : options.parent === "none" ? null : options.parent,
      description: options.description,
      lifecycle: options.lifecycle,
      priority: options.priority,
      size: options.size === undefined ? undefined : options.size === "none" ? null : options.size,
      sourceDoc: options.source,
      sourceSection: options.section,
      sourceLine: options.sourceLine,
      completionBar: options.completionBar
    }));
    print(updated, format());
  }));

task.command("list")
  .description("List tasks")
  .option("--search <query>", "search text")
  .option("--status <status>", "ready, blocked, started, finished, archived, open")
  .option("--lifecycle <lifecycle>", "open, started, finished")
  .option("--priority-min <n>", "minimum priority", parsePriority)
  .option("--priority-max <n>", "maximum priority", parsePriority)
  .option("--size <size>", "size filter")
  .option("--parent <id>", "parent task id; use root for root tasks")
  .option("--source <doc>", "source document")
  .option("--section <section>", "source section")
  .option("--tag <tag>", "tag id or name")
  .option("--actor <actor>", "assigned actor")
  .option("--include-finished", "show finished tasks")
  .option("--include-archived", "show archived tasks")
  .option("--sort <sort>", "dependency, priority, depth, created, updated, id, title")
  .action(async (options) => withServices(async ({ services }) => {
    const parentTaskId = options.parent === undefined ? undefined : options.parent === "root" ? null : options.parent;
    const filters = defined({
      search: options.search,
      status: options.status as ComputedStatus | "open" | undefined,
      lifecycle: options.lifecycle,
      priorityMin: options.priorityMin,
      priorityMax: options.priorityMax,
      size: options.size,
      parentTaskId,
      sourceDoc: options.source,
      sourceSection: options.section,
      tag: options.tag,
      assignedActor: options.actor,
      includeFinished: options.includeFinished,
      includeArchived: options.includeArchived,
      sort: options.sort as TaskSort | undefined
    }) as TaskListFilters;
    const tasks = await services.query.list(filters);
    printTasks(tasks);
  }));

task.command("show")
  .description("Show a task")
  .argument("<id>")
  .action(async (id) => withServices(async ({ services }) => {
    const tasks = await services.query.list({ includeFinished: true, includeArchived: true });
    const item = tasks.find((candidate) => candidate.id === id.toUpperCase());
    if (!item) {
      throw new NotJiraError("not_found", `task not found: ${id}`);
    }
    print(item, format());
  }));

task.command("explain")
  .description("Explain whether a task is assignable")
  .argument("<id>")
  .action(async (id) => withServices(async ({ services }) => {
    const explanation = await services.query.explain(id);
    if (format() === "json") {
      print(explanation, "json");
    } else {
      console.log(formatExplain(explanation));
    }
  }));

for (const lifecycleCommand of [
  ["start", "started"],
  ["finish", "finished"],
  ["reopen", "open"]
] as const) {
  task.command(lifecycleCommand[0])
    .argument("<id>")
    .description(`Set task lifecycle to ${lifecycleCommand[1]}`)
    .action(async (id) => withServices(async ({ services }) => {
      const result = lifecycleCommand[0] === "start"
        ? await services.tasks.start(id)
        : lifecycleCommand[0] === "finish"
          ? await services.tasks.finish(id)
          : await services.tasks.reopen(id);
      print(result, format());
    }));
}

task.command("archive")
  .argument("<id>")
  .description("Archive a task")
  .action(async (id) => withServices(async ({ services }) => print(await services.tasks.archive(id), format())));

task.command("delete")
  .argument("<id>")
  .description("Hard delete a task")
  .action(async (id) => withServices(async ({ services }) => {
    await services.tasks.delete(id);
    console.log(`Deleted ${id}`);
  }));

const deps = program.command("deps").description("Dependency commands");

deps.command("add")
  .argument("<taskId>")
  .argument("<dependsOnTaskId>")
  .description("Add a dependency")
  .action(async (taskId, dependsOnTaskId) => withServices(async ({ services }) => print(await services.dependencies.add(taskId, dependsOnTaskId), format())));

deps.command("remove")
  .argument("<taskId>")
  .argument("<dependsOnTaskId>")
  .description("Remove a dependency")
  .action(async (taskId, dependsOnTaskId) => withServices(async ({ services }) => {
    await services.dependencies.remove(taskId, dependsOnTaskId);
    console.log(`Removed dependency ${taskId} -> ${dependsOnTaskId}`);
  }));

deps.command("set")
  .argument("<taskId>")
  .argument("[dependencyIds...]")
  .description("Replace dependencies for a task")
  .action(async (taskId, dependencyIds) => withServices(async ({ services }) => print(await services.dependencies.set(taskId, dependencyIds), format())));

deps.command("list")
  .argument("<taskId>")
  .description("List dependencies for a task")
  .action(async (taskId) => withServices(async ({ services }) => print(await services.dependencies.list(taskId), format())));

deps.command("graph")
  .argument("<taskId>")
  .description("Print dependency explanation for a task")
  .action(async (taskId) => withServices(async ({ services }) => console.log(formatExplain(await services.query.explain(taskId)))));

const tag = program.command("tag").description("Tag commands");

tag.command("add")
  .argument("<name>")
  .option("--id <id>", "tag id")
  .option("--color <color>", "display color")
  .option("--description <text>", "description")
  .action(async (name, options) => withServices(async ({ services }) => print(await services.tags.add({ id: options.id, name, color: options.color ?? null, description: options.description ?? null }), format())));

tag.command("edit")
  .argument("<id>")
  .option("--name <name>", "tag name")
  .option("--color <color>", "display color")
  .option("--description <text>", "description")
  .action(async (id, options) => withServices(async ({ services }) => print(await services.tags.edit(id, options), format())));

tag.command("archive")
  .argument("<id>")
  .action(async (id) => withServices(async ({ services }) => print(await services.tags.archive(id), format())));

tag.command("assign")
  .argument("<taskId>")
  .argument("[tags...]")
  .action(async (taskId, tags) => withServices(async ({ services }) => {
    await services.tags.assign(taskId, tags);
    console.log(`Assigned tags to ${taskId}`);
  }));

tag.command("remove")
  .argument("<taskId>")
  .argument("<tag>")
  .action(async (taskId, tagId) => withServices(async ({ services }) => {
    await services.tags.remove(taskId, tagId);
    console.log(`Removed tag ${tagId} from ${taskId}`);
  }));

tag.command("list")
  .action(async () => withServices(async ({ services }) => print(await services.tags.list(), format())));

tag.command("tasks")
  .argument("<tag>")
  .action(async (tagId) => withServices(async ({ services }) => printTasks(await services.query.list({ tag: tagId }))));

const track = program.command("track").description("Actor queue commands");

track.command("add")
  .argument("<actor>")
  .option("--id <id>", "track id")
  .option("--name <name>", "display name")
  .action(async (actor, options) => withServices(async ({ services }) => print(await services.tracks.add({ id: options.id, actor, name: options.name ?? null }), format())));

track.command("rename")
  .argument("<actorOrId>")
  .argument("<name>")
  .action(async (actorOrId, name) => withServices(async ({ services }) => print(await services.tracks.rename(actorOrId, name), format())));

track.command("archive")
  .argument("<actorOrId>")
  .action(async (actorOrId) => withServices(async ({ services }) => print(await services.tracks.archive(actorOrId), format())));

track.command("assign")
  .argument("<actorOrId>")
  .argument("<taskId>")
  .action(async (actorOrId, taskId) => withServices(async ({ services }) => print(await services.tracks.assign(actorOrId, taskId), format())));

track.command("unassign")
  .argument("<actorOrId>")
  .argument("<taskId>")
  .action(async (actorOrId, taskId) => withServices(async ({ services }) => {
    await services.tracks.unassign(actorOrId, taskId);
    console.log(`Unassigned ${taskId}`);
  }));

track.command("list")
  .action(async () => withServices(async ({ services }) => print(await services.tracks.list(), format())));

track.command("show")
  .argument("<actorOrId>")
  .action(async (actorOrId) => withServices(async ({ services }) => {
    const tracks = await services.tracks.list();
    const selected = tracks.find((item) => item.id === actorOrId || item.actor === actorOrId);
    if (!selected) {
      throw new NotJiraError("not_found", `track not found: ${actorOrId}`);
    }
    const tasks = await services.query.list({ assignedActor: selected.actor, includeFinished: true });
    print({ track: selected, tasks }, format());
  }));

const imports = program.command("import").description("Import data");

imports.command("markdown")
  .argument("<file>")
  .option("--dry-run", "parse without writing")
  .action(async (file, options) => withServices(async ({ services }) => {
    const markdown = await readFile(file, "utf8");
    print(await services.imports.markdown(file, markdown, options.dryRun), format());
  }));

imports.command("json")
  .argument("<file>")
  .description("Import JSON export")
  .action(async (file) => withServices(async ({ services }) => {
    const data = JSON.parse(await readFile(file, "utf8")) as unknown;
    print(await services.imports.json(file, data), format());
  }));

const exports = program.command("export").description("Export data");

exports.command("json")
  .argument("<file>")
  .option("--include-activity", "include activity records")
  .action(async (file, options) => withServices(async ({ services }) => {
    const data = await services.exports.json(options.includeActivity);
    await writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
    console.log(`Wrote ${file}`);
  }));

exports.command("markdown")
  .argument("<file>")
  .action(async (file) => withServices(async ({ services }) => {
    await writeFile(file, await services.exports.markdown());
    console.log(`Wrote ${file}`);
  }));

program.command("activity")
  .description("Show recent activity")
  .option("--limit <n>", "limit", parseInteger)
  .action(async (options) => withServices(async ({ services }) => {
    const activity = await services.activity.list(options.limit ?? 100);
    if (format() === "table") {
      console.log(formatActivity(activity));
    } else {
      print(activity, format());
    }
  }));

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof NotJiraError) {
    console.error(`${error.code}: ${error.message}`);
    if (program.opts<GlobalOptions>().format === "json") {
      console.error(JSON.stringify({ code: error.code, message: error.message, details: error.details }, null, 2));
    }
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

function openStore() {
  return createSqliteStore({ databasePath: dbPath(), autoMigrate: true });
}

function dbPath(): string {
  return resolve(program.opts<GlobalOptions>().db ?? process.env.NOT_JIRA_DB ?? defaultNotJiraDbPath());
}

function format(): OutputFormat {
  return program.opts<GlobalOptions>().format ?? "table";
}

async function withServices<T>(fn: (context: { services: ReturnType<typeof createServices> }) => Promise<T>): Promise<T> {
  const store = openStore();
  try {
    return await fn({ services: createServices(store) });
  } finally {
    await store.close?.();
  }
}

function printTasks(tasks: Parameters<typeof formatTaskTable>[0]): void {
  if (format() === "json") {
    print(tasks, "json");
    return;
  }
  if (format() === "markdown") {
    console.log(formatTaskMarkdown(tasks));
    return;
  }
  console.log(formatTaskTable(tasks));
}

function print(value: unknown, outputFormat: OutputFormat): void {
  if (outputFormat === "json") {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (typeof value === "string") {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer: ${value}`);
  }
  return parsed;
}

function parsePriority(value: string): Priority {
  const parsed = parseInteger(value);
  return prioritySchema.parse(parsed);
}

function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function findWorkspaceRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const packageJson = join(current, "package.json");
    if (existsSync(packageJson) && existsSync(join(current, "packages", "server")) && existsSync(join(current, "packages", "web"))) {
      return current;
    }
    current = dirname(current);
  }
  throw new NotJiraError("workspace_not_found", "Could not locate the not-jira workspace root for serve.");
}

function spawnManaged(label: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout?.on("data", (chunk: Buffer) => writePrefixed(label, chunk));
  child.stderr?.on("data", (chunk: Buffer) => writePrefixed(label, chunk));
  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      console.error(`[${label}] exited with code ${code}`);
    } else if (signal) {
      console.error(`[${label}] stopped by ${signal}`);
    }
  });

  return child;
}

function writePrefixed(label: string, chunk: Buffer): void {
  for (const line of chunk.toString().split(/\r?\n/)) {
    if (line.trim().length > 0) {
      console.log(`[${label}] ${line}`);
    }
  }
}

async function waitForInterrupt(children: ChildProcess[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const stop = () => {
      if (settled) {
        return;
      }
      settled = true;
      for (const child of children) {
        if (!child.killed) {
          child.kill("SIGTERM");
        }
      }
      setTimeout(() => {
        for (const child of children) {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        }
        resolvePromise();
      }, 800);
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    for (const child of children) {
      child.on("error", (error) => {
        if (!settled) {
          settled = true;
          for (const other of children) {
            if (!other.killed) {
              other.kill("SIGTERM");
            }
          }
          rejectPromise(error);
        }
      });
    }
  });
}
