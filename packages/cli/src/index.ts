#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { parse as parseYaml } from "yaml";
import {
  createServices,
  createPostgresStore,
  createSqliteStore,
  defaultUnblockConfigPath,
  ensureUnblockConfig,
  formatActivity,
  formatExplain,
  formatMatcherQueryGrammar,
  formatTaskMarkdown,
  formatTaskTable,
  MigrationService,
  UnblockError,
  prioritySchema,
  readUnblockConfig,
  readUnblockConfigSync,
  resolveUnblockStorageConfig,
  runStorageCrudBenchmark,
  slugify,
  updateUnblockConfig,
  type AddTaskInput,
  type ComputedStatus,
  type EditInstructionInput,
  type EditQueueFeedInput,
  type EditSavedViewInput,
  type EditTaskInput,
  type Lifecycle,
  type OutputFormat,
  type Priority,
  type TaskSize,
  type TaskListFilters,
  type TaskSort
} from "@unblock/core";

interface GlobalOptions {
  db?: string;
  format?: OutputFormat;
  project?: string;
  actor?: string;
  storageMode?: string;
  postgresUrl?: string;
}

const DEFAULT_API_PORT = 39217;
const DEFAULT_WEB_PORT = 39218;

const program = new Command();
const TASK_MUTATION_HELP = `
Required context:
  Pass --project <id> and --actor <name>. Machine comes from unblock config.
`;
const TRACK_MUTATION_HELP = `
Required context:
  Pass --project <id> and --actor <name>. Machine comes from unblock config.

Track references:
  Commands accept the displayed queue id, actor, or machine:actor.
`;

program
  .name("unblock")
  .description("Dependency-first implementation task manager")
  .version("0.1.0")
  .option("--db <path>", "SQLite database path", process.env.UNBLOCK_DB)
  .option("--storage-mode <mode>", "storage mode: sqlite, postgres, or hosted", process.env.UNBLOCK_STORAGE_MODE)
  .option("--postgres-url <url>", "Postgres connection URL", process.env.UNBLOCK_POSTGRES_URL)
  .option("--project <id>", "project id for task, dependency, tag, queue, import, export, and activity commands")
  .option("--actor <name>", "actor identity for mutating commands; required for provenance")
  .addOption(new Option("--format <format>", "output format").choices(["table", "json", "markdown"]).default("table"));

program.command("serve")
  .description("Start the API and web dev servers")
  .option("--api-port <port>", "API server port", parseInteger, DEFAULT_API_PORT)
  .option("--web-port <port>", "web server port", parseInteger, DEFAULT_WEB_PORT)
  .option("--host <host>", "web server host", "0.0.0.0")
  .action(async (options: { apiPort: number; webPort: number; host: string }) => {
    const root = findWorkspaceRoot();
    const config = await ensureUnblockConfig(configPath());
    const storage = storageConfig(config.config);
    const env = {
      ...process.env,
      UNBLOCK_STORAGE_MODE: storage.mode,
      UNBLOCK_DB: storage.sqlitePath,
      UNBLOCK_CONFIG: config.path,
      UNBLOCK_POSTGRES_URL: storage.postgresUrl,
      UNBLOCK_API_PORT: String(options.apiPort),
      UNBLOCK_WEB_PORT: String(options.webPort),
      UNBLOCK_WEB_HOST: options.host
    };

    console.log(`Storage:  ${storage.mode}`);
    console.log(`Database: ${storage.mode === "sqlite" ? storage.sqlitePath : storage.postgresUrl || "(not configured)"}`);
    console.log(`Config:   ${config.path}`);
    for (const issue of config.issues) {
      console.log(`Config warning: ${issue}`);
    }
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
    const store = await openStore();
    try {
      const migration = new MigrationService(store);
      const status = await migration.status();
      const config = await readUnblockConfig(configPath());
      print({
        database: databaseLabel(),
        storage: storageConfig(config.config),
        capabilities: store.capabilities,
        config: {
          path: config.path,
          exists: config.exists,
          issues: config.issues,
          value: config.config
        },
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
    const store = await openStore();
    try {
      const migration = new MigrationService(store);
      const status = await migration.migrate();
      console.log(`Database ready: ${databaseLabel()}`);
      console.log(`Applied: ${status.applied.length}`);
      console.log(`Pending: ${status.pending.length}`);
    } finally {
      await store.close?.();
    }
  });

db.command("status")
  .description("Show migration status")
  .action(async () => {
    const store = await openStore();
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
    const store = await openStore();
    try {
      const migration = new MigrationService(store);
      print(await migration.migrate(), format());
    } finally {
      await store.close?.();
    }
  });

const bench = program.command("bench").description("Benchmark commands");

bench.command("storage")
  .description("Run a CRUD storage throughput baseline against the configured store")
  .option("--project-id <id>", "project id to create for this benchmark")
  .option("--tasks <count>", "tasks to create", parseInteger)
  .option("--dependencies <count>", "dependencies to create", parseInteger)
  .option("--tags <count>", "tags to create", parseInteger)
  .option("--task-tags <count>", "task-tag assignments to create", parseInteger)
  .option("--instructions <count>", "instructions to create", parseInteger)
  .option("--comments <count>", "comments to create", parseInteger)
  .option("--activity <count>", "standalone activity records to append", parseInteger)
  .action(async (options: {
    projectId?: string;
    tasks?: number;
    dependencies?: number;
    tags?: number;
    taskTags?: number;
    instructions?: number;
    comments?: number;
    activity?: number;
  }) => {
    const store = await openStore();
    try {
      print(await runStorageCrudBenchmark(store, {
        projectId: options.projectId,
        machine: "storage-benchmark",
        actor: program.opts<GlobalOptions>().actor ?? "storage-benchmark",
        tasks: options.tasks,
        dependencies: options.dependencies,
        tags: options.tags,
        taskTags: options.taskTags,
        instructions: options.instructions,
        comments: options.comments,
        activity: options.activity
      }), format());
    } finally {
      await store.close?.();
    }
  });

const configCommand = program.command("config").description("Configuration commands");

configCommand.command("show")
  .description("Show unblock configuration")
  .action(async () => {
    const config = await readUnblockConfig(configPath());
    print({ path: config.path, issues: config.issues, value: config.config }, format());
  });

configCommand.command("set")
  .description("Set local machine, UI actor identity, or storage settings")
  .option("--machine <name>", "stable machine name")
  .option("--actor <name>", "default UI actor name")
  .option("--storage-mode <mode>", "storage mode: sqlite, postgres, or hosted")
  .option("--sqlite-path <path>", "SQLite database path for local mode")
  .option("--postgres-url <url>", "Postgres connection URL for postgres or hosted mode")
  .action(async (options: { machine?: string; actor?: string; storageMode?: string; sqlitePath?: string; postgresUrl?: string }) => {
    const current = await readUnblockConfig(configPath());
    const actor = options.actor ?? program.opts<GlobalOptions>().actor;
    const next = await updateUnblockConfig({
      identity: {
        machine: options.machine === undefined ? current.config.identity.machine : options.machine,
        actor: actor === undefined ? current.config.identity.actor : actor
      },
      storage: {
        mode: options.storageMode === undefined
          ? current.config.storage.mode
          : resolveUnblockStorageConfig(current.config, {}, { mode: options.storageMode }).mode,
        sqlitePath: options.sqlitePath === undefined ? current.config.storage.sqlitePath : options.sqlitePath,
        postgresUrl: options.postgresUrl === undefined ? current.config.storage.postgresUrl : options.postgresUrl
      }
    }, configPath());
    print({ path: next.path, value: next.config }, format());
  });

const project = program.command("project").description("Project commands");

project.command("add")
  .argument("<id>")
  .option("--name <name>", "display name")
  .option("--description <text>", "description")
  .action(async (id, options) => withGlobalMutationServices(async ({ services }) => {
    print(await services.projects.add({ id, name: options.name, description: options.description ?? null }), format());
  }));

project.command("list")
  .action(async () => withGlobalServices(async ({ services }) => print(await services.projects.list(), format())));

project.command("archive")
  .argument("<id>")
  .action(async (id) => withGlobalMutationServices(async ({ services }) => print(await services.projects.archive(id), format())));

project.command("restore")
  .argument("<id>")
  .action(async (id) => withGlobalMutationServices(async ({ services }) => print(await services.projects.restore(id), format())));

const task = program.command("task")
  .description("Task commands")
  .addHelpText("after", `
Required context:
  Pass --project <id> on every task command. Project context is never sticky.
  Mutating task commands also require --actor <name>; machine comes from unblock config.

Examples:
  unblock --project PRISM task list
  unblock --project PRISM --actor codex-a task add --id P-API --title "Implement API" --assign bw-mbp-codex-a
  unblock --project PRISM --actor codex-a task depend P-API --on P-SCHEMA,P-TESTS

Dependency rules:
  A dependency means TASK cannot proceed until DEP is finished.
  Any non-hierarchy task may depend on any other non-hierarchy task.
  Rejected: self-dependencies, cycles, parent/child, ancestor/descendant.`);

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
  .option("--assign <actorOrId>", "assign created task to actor queue id, actor, or machine:actor")
  .option("--track <actorOrId>", "alias for --assign")
  .option("--dry-run", "validate options and print the planned create without writing")
  .action(async (options) => {
    const input = addTaskInputFromOptions(options);
    const assign = assignmentTarget(options);
    if (options.dryRun) {
      print({ dryRun: true, action: "task.add", task: input, assign }, format());
      return;
    }
    await withMutationServices(async ({ services }) => {
      const created = await services.tasks.add(input);
      if (!assign) {
        print(created, format());
        return;
      }
      const assignment = await services.tracks.assign(assign, created.id);
      print({ task: created, assignment }, format());
    });
  });

task.command("upsert")
  .description("Create a task if missing, otherwise edit it")
  .requiredOption("--id <id>", "task id")
  .option("--title <title>", "task title; required when creating a missing task")
  .option("--parent <id>", "parent task id; use none for root")
  .option("--description <text>", "description")
  .option("--lifecycle <lifecycle>", "open, started, finished")
  .option("--priority <n>", "priority 0-4", parsePriority)
  .option("--size <size>", "XS, S, M, L, XL; use none to clear")
  .option("--source <doc>", "source document")
  .option("--section <section>", "source section")
  .option("--source-line <line>", "source line", parseInteger)
  .option("--completion-bar <text>", "completion bar")
  .option("--assign <actorOrId>", "assign upserted task to actor queue id, actor, or machine:actor")
  .option("--track <actorOrId>", "alias for --assign")
  .option("--dry-run", "validate options and print the planned upsert without writing")
  .action(async (options) => {
    const assign = assignmentTarget(options);
    if (options.dryRun) {
      print({
        dryRun: true,
        action: "task.upsert",
        id: options.id,
        create: addTaskInputFromOptions({ ...options, title: options.title ?? "<required when missing>" }),
        edit: editTaskInputFromOptions(options),
        assign
      }, format());
      return;
    }
    await withMutationServices(async ({ services }) => {
      const id = String(options.id);
      let taskAction: "created" | "updated";
      let taskResult;
      try {
        await services.tasks.get(id);
        taskResult = await services.tasks.edit(id, editTaskInputFromOptions(options));
        taskAction = "updated";
      } catch (error) {
        if (!(error instanceof UnblockError) || error.code !== "not_found") {
          throw error;
        }
        if (!options.title) {
          throw new UnblockError("validation", "task upsert requires --title when creating a missing task.");
        }
        taskResult = await services.tasks.add(addTaskInputFromOptions(options));
        taskAction = "created";
      }
      let assignment = null;
      let skippedAssignment = null;
      if (assign) {
        try {
          assignment = await services.tracks.assign(assign, taskResult.id);
        } catch (error) {
          if (!(error instanceof UnblockError) || error.code !== "conflict") {
            throw error;
          }
          skippedAssignment = { taskId: taskResult.id, assign, reason: error.message };
        }
      }
      print({ action: taskAction, task: taskResult, assignment, skippedAssignment }, format());
    });
  });

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
  .option("--dry-run", "validate options and print the planned edit without writing")
  .action(async (id, options) => {
    const input = editTaskInputFromOptions(options);
    if (options.dryRun) {
      print({ dryRun: true, action: "task.edit", id, changes: input }, format());
      return;
    }
    await withMutationServices(async ({ services }) => {
      const updated = await services.tasks.edit(id, input);
      print(updated, format());
    });
  });

task.command("list")
  .description("List tasks")
  .option("--search <query>", "search text")
  .option("--where <query>", "advanced matcher query")
  .option("--view <id>", "saved view id")
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
    const viewQuery = options.view ? (await services.views.get(options.view)).query : undefined;
    const filters = defined({
      search: options.search,
      where: combineMatcherQueries(viewQuery, options.where),
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
      throw new UnblockError("not_found", `task not found: ${id}`);
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

task.command("depend")
  .description("Add a hard dependency: TASK cannot proceed until DEP is finished")
  .argument("<taskId>")
  .requiredOption("--on <dependencyIds...>", "dependency tasks, comma-separated or repeated; must not be ancestors or descendants of TASK")
  .option("--dry-run", "print the dependency edges without writing")
  .action(async (taskId, options: { on: string[]; dryRun?: boolean }) => {
    const dependencies = parseIdList(options.on);
    if (options.dryRun) {
      print({ dryRun: true, action: "task.depend", taskId, dependencies }, format());
      return;
    }
    await withMutationServices(async ({ services }) => {
      const added = [];
      for (const dependencyId of dependencies) {
        added.push(await services.dependencies.add(taskId, dependencyId));
      }
      print({ taskId, added }, format());
    });
  });

task.command("undepend")
  .description("Remove a hard dependency from TASK")
  .argument("<taskId>")
  .requiredOption("--on <dependencyId>", "dependency task to remove")
  .action(async (taskId, options: { on: string }) => withMutationServices(async ({ services }) => {
    await services.dependencies.remove(taskId, options.on);
    console.log(`Removed dependency ${taskId} -> ${options.on}`);
  }));

task.command("set-dependencies")
  .description("Replace all dependencies for TASK")
  .argument("<taskId>")
  .option("--on <dependencyIds...>", "complete dependency task list; entries must not be ancestors or descendants of TASK")
  .option("--dry-run", "print the replacement dependency set without writing")
  .action(async (taskId, options: { on?: string[]; dryRun?: boolean }) => {
    const dependencies = options.on === undefined ? [] : parseIdList(options.on);
    if (options.dryRun) {
      print({ dryRun: true, action: "task.set-dependencies", taskId, dependencies }, format());
      return;
    }
    await withMutationServices(async ({ services }) => {
      print(await services.dependencies.set(taskId, dependencies), format());
    });
  });

task.command("dependencies")
  .description("List dependencies for TASK")
  .argument("<taskId>")
  .action(async (taskId) => withServices(async ({ services }) => print(await services.dependencies.list(taskId), format())));

task.command("import-tree")
  .description("Import or upsert a task tree from JSON or YAML")
  .argument("<file>")
  .option("--dry-run", "parse and print the flattened import plan without writing")
  .addHelpText("after", `
Input shape:
  tasks:
    - id: P-ROLLOUT
      title: Rollout
      assign: bw-mbp-codex-a
      tags: [backend]
      dependsOn: [P-SCHEMA, P-TESTS]
      children:
        - id: P-ROLLOUT-API
          title: API slice
  dependencies:
    - task: P-ROLLOUT-API
      on: [P-SCHEMA]

Use "track" as an alias for "assign"; use "dependsOn", "depends_on", or "dependencies" for task dependencies.`)
  .action(async (file, options: { dryRun?: boolean }) => {
    const plan = parseTaskImportTree(file, await readFile(file, "utf8"));
    if (options.dryRun) {
      print({ dryRun: true, ...plan }, format());
      return;
    }
    await withMutationServices(async ({ services }) => {
      const created = [];
      const updated = [];
      const assignments = [];
      const assignmentsSkipped = [];
      const tagAssignments = [];
      const tagsCreated = [];
      const dependencies = [];
      const dependenciesSkipped = [];
      for (const taskItem of plan.tasks) {
        try {
          await services.tasks.get(taskItem.id);
          updated.push(await services.tasks.edit(taskItem.id, taskItem.input));
        } catch (error) {
          if (!(error instanceof UnblockError) || error.code !== "not_found") {
            throw error;
          }
          created.push(await services.tasks.add({ id: taskItem.id, title: taskItem.title, ...taskItem.input }));
        }
        if (taskItem.assign) {
          try {
            assignments.push(await services.tracks.assign(taskItem.assign, taskItem.id));
          } catch (error) {
            if (!(error instanceof UnblockError) || error.code !== "conflict") {
              throw error;
            }
            assignmentsSkipped.push({ taskId: taskItem.id, assign: taskItem.assign, reason: error.message });
          }
        }
        for (const tagName of taskItem.tags) {
          try {
            await services.tags.assign(taskItem.id, [tagName]);
          } catch (error) {
            if (!(error instanceof UnblockError) || error.code !== "not_found") {
              throw error;
            }
            tagsCreated.push(await services.tags.add({ id: tagName, name: tagName }));
            await services.tags.assign(taskItem.id, [tagName]);
          }
          tagAssignments.push({ taskId: taskItem.id, tag: tagName });
        }
      }
      for (const edge of plan.dependencies) {
        try {
          dependencies.push(await services.dependencies.add(edge.taskId, edge.dependsOnTaskId));
        } catch (error) {
          if (!(error instanceof UnblockError) || error.code !== "conflict") {
            throw error;
          }
          dependenciesSkipped.push({ ...edge, reason: error.message });
        }
      }
      print({
        tasksCreated: created.length,
        tasksUpdated: updated.length,
        dependenciesAdded: dependencies.length,
        dependenciesSkipped: dependenciesSkipped.length,
        assignmentsCreated: assignments.length,
        assignmentsSkipped: assignmentsSkipped.length,
        tagAssignmentsCreated: tagAssignments.length,
        tagsCreated: tagsCreated.length,
        created,
        updated,
        dependencies,
        skippedDependencies: dependenciesSkipped,
        assignments,
        skippedAssignments: assignmentsSkipped,
        tags: tagsCreated,
        tagAssignments
      }, format());
    });
  });

task.command("comment")
  .description("Add a flat chronological markdown comment to TASK")
  .argument("<taskId>")
  .requiredOption("--body <markdown>", "comment body")
  .action(async (taskId, options: { body: string }) => withMutationServices(async ({ services }) => {
    print(await services.comments.add(taskId, { body: options.body }), format());
  }));

task.command("comments")
  .description("List comments for TASK in chronological order")
  .argument("<taskId>")
  .requiredOption("--limit <n>", "maximum comments to return", parseInteger)
  .option("--include-archived", "include archived comments")
  .action(async (taskId, options: { limit: number; includeArchived?: boolean }) => withServices(async ({ services }) => {
    print(await services.comments.list(taskId, { limit: options.limit, includeArchived: options.includeArchived }), format());
  }));

task.command("edit-comment")
  .description("Edit a comment body")
  .argument("<commentId>")
  .requiredOption("--body <markdown>", "new comment body")
  .action(async (commentId, options: { body: string }) => withMutationServices(async ({ services }) => {
    print(await services.comments.edit(commentId, { body: options.body }), format());
  }));

task.command("archive-comment")
  .description("Archive a comment")
  .argument("<commentId>")
  .action(async (commentId) => withMutationServices(async ({ services }) => print(await services.comments.archive(commentId), format())));

task.command("restore-comment")
  .description("Restore an archived comment")
  .argument("<commentId>")
  .action(async (commentId) => withMutationServices(async ({ services }) => print(await services.comments.restore(commentId), format())));

task.command("release")
  .argument("<id>")
  .description("Release a started task back to ready or blocked work")
  .requiredOption("--reason <text>", "required release reason; stored as an automatic task comment")
  .action(async (id, options: { reason: string }) => withMutationServices(async ({ services }) => {
    print(await services.tasks.release(id, { reason: options.reason }), format());
  }));

for (const lifecycleCommand of [
  ["start", "started"],
  ["finish", "finished"],
  ["reopen", "open"]
] as const) {
  task.command(lifecycleCommand[0])
    .argument("<id>")
    .description(`Set task lifecycle to ${lifecycleCommand[1]}`)
    .action(async (id) => withMutationServices(async ({ services }) => {
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
  .action(async (id) => withMutationServices(async ({ services }) => print(await services.tasks.archive(id), format())));

task.command("restore")
  .argument("<id>")
  .description("Restore an archived task")
  .action(async (id) => withMutationServices(async ({ services }) => print(await services.tasks.restore(id), format())));

for (const bulkLifecycleCommand of [
  ["bulk-start", "start"],
  ["bulk-finish", "finish"],
  ["bulk-reopen", "reopen"],
  ["bulk-archive", "archive"]
] as const) {
  task.command(bulkLifecycleCommand[0])
    .description(`Run ${bulkLifecycleCommand[1]} on tasks matched by a query`)
    .requiredOption("--where <query>", "advanced matcher query")
    .requiredOption("--limit <n>", "maximum tasks to mutate", parseInteger)
    .action(async (options) => withMutationServices(async ({ services }) => {
      const selected = await selectTasksByWhere(services, options.where, options.limit);
      const updated = [];
      for (const item of selected) {
        if (bulkLifecycleCommand[1] === "start") updated.push(await services.tasks.start(item.id));
        if (bulkLifecycleCommand[1] === "finish") updated.push(await services.tasks.finish(item.id));
        if (bulkLifecycleCommand[1] === "reopen") updated.push(await services.tasks.reopen(item.id));
        if (bulkLifecycleCommand[1] === "archive") updated.push(await services.tasks.archive(item.id));
      }
      print({ action: bulkLifecycleCommand[1], matched: selected.length, ids: selected.map((taskItem) => taskItem.id), updated }, format());
    }));
}

task.command("bulk-assign")
  .description("Assign tasks matched by a query to an actor queue")
  .requiredOption("--where <query>", "advanced matcher query")
  .requiredOption("--limit <n>", "maximum tasks to mutate", parseInteger)
  .requiredOption("--to <actorOrId>", "actor queue id, actor, or machine:actor")
  .action(async (options) => withMutationServices(async ({ services }) => {
    const selected = await selectTasksByWhere(services, options.where, options.limit);
    const assignments = [];
    for (const item of selected) {
      assignments.push(await services.tracks.assign(options.to, item.id));
    }
    print({ action: "assign", matched: selected.length, ids: selected.map((taskItem) => taskItem.id), assignments }, format());
  }));

task.command("bulk-unassign")
  .description("Unassign tasks matched by a query from their current actor queues")
  .requiredOption("--where <query>", "advanced matcher query")
  .requiredOption("--limit <n>", "maximum tasks to mutate", parseInteger)
  .action(async (options) => withMutationServices(async ({ services }) => {
    const selected = await selectTasksByWhere(services, options.where, options.limit);
    const ids: string[] = [];
    for (const item of selected) {
      if (item.assignedTrack) {
        await services.tracks.unassign(item.assignedTrack.trackId, item.id);
        ids.push(item.id);
      }
    }
    print({ action: "unassign", matched: selected.length, changed: ids.length, ids }, format());
  }));

task.command("bulk-tag")
  .description("Assign a tag to tasks matched by a query")
  .requiredOption("--where <query>", "advanced matcher query")
  .requiredOption("--limit <n>", "maximum tasks to mutate", parseInteger)
  .requiredOption("--tag <tag>", "tag id or name")
  .action(async (options) => withMutationServices(async ({ services }) => {
    const selected = await selectTasksByWhere(services, options.where, options.limit);
    for (const item of selected) {
      await services.tags.assign(item.id, [options.tag]);
    }
    print({ action: "tag", matched: selected.length, ids: selected.map((taskItem) => taskItem.id), tag: options.tag }, format());
  }));

task.command("delete")
  .argument("<id>")
  .description("Hard delete a task")
  .action(async (id) => withMutationServices(async ({ services }) => {
    await services.tasks.delete(id);
    console.log(`Deleted ${id}`);
  }));

const tag = program.command("tag")
  .description("Tag commands")
  .addHelpText("after", `
Project scope:
  Pass --project <id> on every tag command. Project context is never sticky.`);

tag.command("add")
  .argument("<name>")
  .option("--id <id>", "tag id")
  .option("--color <color>", "display color")
  .option("--description <text>", "description")
  .action(async (name, options) => withMutationServices(async ({ services }) => print(await services.tags.add({ id: options.id, name, color: options.color ?? null, description: options.description ?? null }), format())));

tag.command("edit")
  .argument("<id>")
  .option("--name <name>", "tag name")
  .option("--color <color>", "display color")
  .option("--description <text>", "description")
  .action(async (id, options) => withMutationServices(async ({ services }) => print(await services.tags.edit(id, options), format())));

tag.command("archive")
  .argument("<id>")
  .action(async (id) => withMutationServices(async ({ services }) => print(await services.tags.archive(id), format())));

tag.command("assign")
  .argument("<taskId>")
  .argument("[tags...]")
  .action(async (taskId, tags) => withMutationServices(async ({ services }) => {
    await services.tags.assign(taskId, tags);
    console.log(`Assigned tags to ${taskId}`);
  }));

tag.command("remove")
  .argument("<taskId>")
  .argument("<tag>")
  .action(async (taskId, tagId) => withMutationServices(async ({ services }) => {
    await services.tags.remove(taskId, tagId);
    console.log(`Removed tag ${tagId} from ${taskId}`);
  }));

tag.command("list")
  .action(async () => withServices(async ({ services }) => print(await services.tags.list(), format())));

tag.command("tasks")
  .argument("<tag>")
  .action(async (tagId) => withServices(async ({ services }) => printTasks(await services.query.list({ tag: tagId }))));

const track = program.command("track")
  .description("Actor queue commands")
  .addHelpText("after", `
Required context:
  Pass --project <id> on every actor queue command. Project context is never sticky.
  Mutating track commands also require --actor <name>; machine comes from unblock config.

Track references:
  Commands accept the displayed queue id, actor, or machine:actor.
  Example: unblock --project PRISM --actor codex-a track assign bw-mbp-codex-a P-API`);

track.command("add")
  .argument("<actor>")
  .option("--id <id>", "track id")
  .option("--name <name>", "display name")
  .action(async (actor, options) => withMutationServices(async ({ services }) => print(await services.tracks.add({ id: options.id, actor, name: options.name ?? null }), format())));

track.command("rename")
  .argument("<actorOrId>")
  .argument("<name>")
  .action(async (actorOrId, name) => withMutationServices(async ({ services }) => print(await services.tracks.rename(actorOrId, name), format())));

track.command("archive")
  .argument("<actorOrId>")
  .action(async (actorOrId) => withMutationServices(async ({ services }) => print(await services.tracks.archive(actorOrId), format())));

track.command("assign")
  .argument("<actorOrId>")
  .argument("<taskId>")
  .action(async (actorOrId, taskId) => withMutationServices(async ({ services }) => print(await services.tracks.assign(actorOrId, taskId), format())));

track.command("unassign")
  .argument("<actorOrId>")
  .argument("<taskId>")
  .action(async (actorOrId, taskId) => withMutationServices(async ({ services }) => {
    await services.tracks.unassign(actorOrId, taskId);
    console.log(`Unassigned ${taskId}`);
  }));

track.command("list")
  .action(async () => withServices(async ({ services }) => print(await services.tracks.list(), format())));

track.command("show")
  .argument("<actorOrId>")
  .action(async (actorOrId) => withServices(async ({ services }) => {
    const tracks = await services.tracks.list();
    const selected = tracks.find((item) => matchesTrackReference(item, actorOrId));
    if (!selected) {
      throw new UnblockError("not_found", `track not found: ${actorOrId}`);
    }
    const tasks = await services.query.list({ assignedActor: `${selected.machine}:${selected.actor}`, includeFinished: true });
    print({ track: selected, tasks }, format());
  }));

const instruction = program.command("instruction")
  .description("Instruction commands")
  .addHelpText("after", `
Project scope:
  Pass --project <id> on every instruction command. Mutations also require --actor <name>.

${formatMatcherQueryGrammar()}`);

instruction.command("add")
  .requiredOption("--name <name>", "instruction name")
  .requiredOption("--when <query>", "task matcher query")
  .requiredOption("--body <text>", "instruction markdown body")
  .option("--id <id>", "instruction id")
  .option("--disabled", "create disabled")
  .action(async (options) => withMutationServices(async ({ services }) => {
    print(await services.instructions.add({ id: options.id, name: options.name, query: options.when, body: options.body, enabled: !options.disabled }), format());
  }));

instruction.command("edit")
  .argument("<id>")
  .option("--name <name>", "instruction name")
  .option("--when <query>", "task matcher query")
  .option("--body <text>", "instruction markdown body")
  .option("--enabled <value>", "true or false")
  .action(async (id, options) => withMutationServices(async ({ services }) => {
    const input: EditInstructionInput = defined({ name: options.name, query: options.when, body: options.body });
    if (options.enabled !== undefined) {
      input.enabled = options.enabled === "true";
    }
    print(await services.instructions.edit(id, input), format());
  }));

instruction.command("list")
  .option("--include-archived", "show archived instructions")
  .action(async (options) => withServices(async ({ services }) => print(await services.instructions.list(Boolean(options.includeArchived)), format())));

instruction.command("show")
  .argument("<id>")
  .action(async (id) => withServices(async ({ services }) => print(await services.instructions.get(id), format())));

instruction.command("archive")
  .argument("<id>")
  .action(async (id) => withMutationServices(async ({ services }) => print(await services.instructions.archive(id), format())));

instruction.command("restore")
  .argument("<id>")
  .action(async (id) => withMutationServices(async ({ services }) => print(await services.instructions.restore(id), format())));

instruction.command("preview")
  .requiredOption("--when <query>", "task matcher query")
  .action(async (options) => withServices(async ({ services }) => print(await services.instructions.preview(options.when), format())));

instruction.command("suggest")
  .argument("<field>", "matcher field")
  .requiredOption("--limit <n>", "maximum suggestions to return", parseInteger)
  .option("--prefix <text>", "only values starting with this prefix")
  .action(async (field, options) => withServices(async ({ services }) => {
    print(await services.instructions.suggest(field, { prefix: options.prefix, limit: options.limit }), format());
  }));

instruction.command("matches")
  .argument("<taskId>")
  .action(async (taskId) => withServices(async ({ services }) => print(await services.instructions.matchesForTask(taskId), format())));

program.command("query")
  .description("List tasks matched by an advanced matcher query")
  .requiredOption("--where <query>", "advanced matcher query")
  .requiredOption("--limit <n>", "maximum tasks to return", parseInteger)
  .option("--include-finished", "include finished tasks")
  .option("--include-archived", "include archived tasks")
  .option("--sort <sort>", "dependency, priority, depth, created, updated, id, title")
  .addHelpText("after", `
Project scope:
  Pass --project <id>. Project context is never sticky.

${formatMatcherQueryGrammar()}`)
  .action(async (options) => withServices(async ({ services }) => {
    const filters = defined({
      includeFinished: options.includeFinished,
      includeArchived: options.includeArchived,
      sort: options.sort as TaskSort | undefined
    }) as Omit<TaskListFilters, "where">;
    const tasks = await services.query.match(options.where, options.limit, filters);
    printTasks(tasks);
  }));

program.command("query-suggest")
  .description("List matcher field value suggestions")
  .argument("<field>", "matcher field")
  .requiredOption("--limit <n>", "maximum suggestions to return", parseInteger)
  .option("--prefix <text>", "only values matching this prefix")
  .action(async (field, options: { limit: number; prefix?: string }) => withServices(async ({ services }) => {
    const input: { prefix?: string; limit: number } = { limit: options.limit };
    if (options.prefix !== undefined) {
      input.prefix = options.prefix;
    }
    print(await services.query.suggest(field, input), format());
  }));

program.command("context")
  .description("Print a markdown task context bundle matched by a query")
  .requiredOption("--where <query>", "advanced matcher query")
  .requiredOption("--limit <n>", "maximum tasks to include", parseInteger)
  .action(async (options) => withServices(async ({ services }) => {
    console.log(await services.exports.markdown({ where: options.where, limit: options.limit }));
  }));

const view = program.command("view")
  .description("Saved task view commands")
  .addHelpText("after", `
Project scope:
  Pass --project <id> on every saved view command. Mutations also require --actor <name>.

${formatMatcherQueryGrammar()}`);

view.command("add")
  .requiredOption("--name <name>", "saved view name")
  .requiredOption("--where <query>", "advanced matcher query")
  .option("--id <id>", "saved view id")
  .action(async (options) => withMutationServices(async ({ services }) => print(await services.views.add({ id: options.id, name: options.name, query: options.where }), format())));

view.command("edit")
  .argument("<id>")
  .option("--name <name>", "saved view name")
  .option("--where <query>", "advanced matcher query")
  .action(async (id, options) => withMutationServices(async ({ services }) => {
    const input: EditSavedViewInput = defined({ name: options.name, query: options.where });
    print(await services.views.edit(id, input), format());
  }));

view.command("list")
  .option("--include-archived", "show archived saved views")
  .action(async (options) => withServices(async ({ services }) => print(await services.views.list(Boolean(options.includeArchived)), format())));

view.command("show")
  .argument("<id>")
  .action(async (id) => withServices(async ({ services }) => print(await services.views.get(id), format())));

view.command("archive")
  .argument("<id>")
  .action(async (id) => withMutationServices(async ({ services }) => print(await services.views.archive(id), format())));

view.command("restore")
  .argument("<id>")
  .action(async (id) => withMutationServices(async ({ services }) => print(await services.views.restore(id), format())));

view.command("tasks")
  .argument("<id>")
  .requiredOption("--limit <n>", "maximum tasks to return", parseInteger)
  .action(async (id, options) => withServices(async ({ services }) => printTasks(await services.views.tasks(id, options.limit))));

const feed = program.command("feed")
  .description("Query-backed queue feed commands")
  .addHelpText("after", `
Project scope:
  Pass --project <id> on every queue feed command. Mutations also require --actor <name>.

Feeds are saved matcher queries for ready task candidates.

${formatMatcherQueryGrammar()}`);

feed.command("add")
  .requiredOption("--name <name>", "queue feed name")
  .requiredOption("--where <query>", "advanced matcher query")
  .option("--id <id>", "queue feed id")
  .action(async (options) => withMutationServices(async ({ services }) => print(await services.feeds.add({ id: options.id, name: options.name, query: options.where }), format())));

feed.command("edit")
  .argument("<id>")
  .option("--name <name>", "queue feed name")
  .option("--where <query>", "advanced matcher query")
  .action(async (id, options) => withMutationServices(async ({ services }) => {
    const input: EditQueueFeedInput = defined({ name: options.name, query: options.where });
    print(await services.feeds.edit(id, input), format());
  }));

feed.command("list")
  .option("--include-archived", "show archived queue feeds")
  .action(async (options) => withServices(async ({ services }) => print(await services.feeds.list(Boolean(options.includeArchived)), format())));

feed.command("show")
  .argument("<id>")
  .action(async (id) => withServices(async ({ services }) => print(await services.feeds.get(id), format())));

feed.command("archive")
  .argument("<id>")
  .action(async (id) => withMutationServices(async ({ services }) => print(await services.feeds.archive(id), format())));

feed.command("restore")
  .argument("<id>")
  .action(async (id) => withMutationServices(async ({ services }) => print(await services.feeds.restore(id), format())));

feed.command("tasks")
  .argument("<id>")
  .requiredOption("--limit <n>", "maximum candidate tasks to return", parseInteger)
  .action(async (id, options) => withServices(async ({ services }) => printTasks(await services.feeds.tasks(id, options.limit))));

const imports = program.command("import")
  .description("Import data")
  .addHelpText("after", `
Project scope:
  Pass --project <id> on every import command. Project context is never sticky.`);

imports.command("markdown")
  .argument("<file>")
  .option("--dry-run", "parse without writing")
  .action(async (file, options) => withMutationServices(async ({ services }) => {
    const markdown = await readFile(file, "utf8");
    print(await services.imports.markdown(file, markdown, options.dryRun), format());
  }));

imports.command("json")
  .argument("<file>")
  .description("Import JSON export")
  .action(async (file) => withMutationServices(async ({ services }) => {
    const data = JSON.parse(await readFile(file, "utf8")) as unknown;
    print(await services.imports.json(file, data), format());
  }));

const exports = program.command("export")
  .description("Export data")
  .addHelpText("after", `
Project scope:
  Pass --project <id> on every export command. Project context is never sticky.`);

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
  .option("--where <query>", "advanced matcher query")
  .option("--limit <n>", "maximum tasks to include; required with --where", parseInteger)
  .action(async (file, options) => withServices(async ({ services }) => {
    if (options.where && options.limit === undefined) {
      throw new UnblockError("validation", "Exporting by query requires --limit <n>.");
    }
    await writeFile(file, await services.exports.markdown({ where: options.where, limit: options.limit }));
    console.log(`Wrote ${file}`);
  }));

program.command("activity")
  .description("Show recent activity")
  .addHelpText("after", `
Project scope:
  Pass --project <id>. Project context is never sticky.`)
  .option("--limit <n>", "limit", parseInteger)
  .option("--where <query>", "only include activity attached to tasks matched by this matcher query")
  .action(async (options) => withServices(async ({ services }) => {
    const activity = await services.activity.list(defined({ limit: options.limit ?? 100, where: options.where }));
    if (format() === "table") {
      console.log(formatActivity(activity));
    } else {
      print(activity, format());
    }
  }));

for (const command of task.commands) {
  if (!new Set(["list", "show", "explain", "dependencies", "comments"]).has(command.name())) {
    command.addHelpText("after", TASK_MUTATION_HELP);
  }
}

for (const command of track.commands) {
  if (!new Set(["list", "show"]).has(command.name())) {
    command.addHelpText("after", TRACK_MUTATION_HELP);
  }
}

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof UnblockError) {
    console.error(`${error.code}: ${error.message}`);
    if (program.opts<GlobalOptions>().format === "json") {
      console.error(JSON.stringify({ code: error.code, message: error.message, details: error.details }, null, 2));
    }
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function openStore() {
  const storage = storageConfig();
  if (storage.mode === "sqlite") {
    return createSqliteStore({ databasePath: storage.sqlitePath, autoMigrate: true });
  }
  return await createPostgresStore({ connectionString: storage.postgresUrl, autoMigrate: true });
}

function databaseLabel(): string {
  const storage = storageConfig();
  return storage.mode === "sqlite" ? storage.sqlitePath : storage.postgresUrl ?? "(not configured)";
}

function storageConfig(config = readUnblockConfigSync(configPath()).config) {
  const options = program.opts<GlobalOptions>();
  const storage = resolveUnblockStorageConfig(config, process.env, {
    mode: options.storageMode,
    sqlitePath: options.db,
    postgresUrl: options.postgresUrl
  });
  return {
    ...storage,
    sqlitePath: resolve(storage.sqlitePath)
  };
}

function configPath(): string {
  return resolve(process.env.UNBLOCK_CONFIG ?? defaultUnblockConfigPath());
}

function format(): OutputFormat {
  return program.opts<GlobalOptions>().format ?? "table";
}

async function withServices<T>(fn: (context: { services: ReturnType<typeof createServices> }) => Promise<T>): Promise<T> {
  const store = await openStore();
  try {
    const projectId = requiredProjectId();
    if (!await store.projects.get(projectId)) {
      throw new UnblockError("not_found", `project not found: ${projectId}. Create it with: unblock project add ${projectId}`);
    }
    return await fn({ services: createServices(store, { projectId }) });
  } finally {
    await store.close?.();
  }
}

async function withMutationServices<T>(fn: (context: { services: ReturnType<typeof createServices> }) => Promise<T>): Promise<T> {
  const store = await openStore();
  try {
    const projectId = requiredProjectId();
    if (!await store.projects.get(projectId)) {
      throw new UnblockError("not_found", `project not found: ${projectId}. Create it with: unblock project add ${projectId}`);
    }
    const provenance = await requiredProvenance();
    return await fn({ services: createServices(store, { projectId, ...provenance }) });
  } finally {
    await store.close?.();
  }
}

async function withGlobalServices<T>(fn: (context: { services: ReturnType<typeof createServices> }) => Promise<T>): Promise<T> {
  const store = await openStore();
  try {
    return await fn({ services: createServices(store) });
  } finally {
    await store.close?.();
  }
}

async function withGlobalMutationServices<T>(fn: (context: { services: ReturnType<typeof createServices> }) => Promise<T>): Promise<T> {
  const store = await openStore();
  try {
    const provenance = await requiredProvenance();
    return await fn({ services: createServices(store, provenance) });
  } finally {
    await store.close?.();
  }
}

async function requiredProvenance(): Promise<{ machine: string; actor: string }> {
  const actor = program.opts<GlobalOptions>().actor?.trim();
  if (!actor) {
    throw new UnblockError("validation", "Actor is required for mutating commands. Pass --actor <name> explicitly.");
  }
  const config = await readUnblockConfig(configPath());
  const machine = config.config.identity.machine.trim();
  if (!machine) {
    throw new UnblockError("validation", "Machine is required in config. Set it with: unblock config set --machine <name>");
  }
  return { machine, actor };
}

function requiredProjectId(): string {
  const projectId = program.opts<GlobalOptions>().project?.trim();
  if (!projectId) {
    throw new UnblockError("validation", "Project is required. Pass --project <id> on this command.");
  }
  return projectId;
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

function combineMatcherQueries(left?: string, right?: string): string | undefined {
  const first = left?.trim();
  const second = right?.trim();
  if (first && second) {
    return `(${first}) and (${second})`;
  }
  return first || second || undefined;
}

async function selectTasksByWhere(services: ReturnType<typeof createServices>, where: string, limit: number) {
  return services.query.match(where, limit, { includeFinished: true, includeArchived: true, sort: "dependency" });
}

function addTaskInputFromOptions(options: Record<string, unknown>): AddTaskInput {
  const id = stringOption(options.id, "id");
  const title = stringOption(options.title, "title");
  return defined({
    id,
    title,
    parentTaskId: options.parent === undefined ? null : parentOption(options.parent),
    description: optionalStringOption(options.description),
    lifecycle: optionalLifecycleOption(options.lifecycle),
    priority: options.priority as Priority | undefined,
    size: options.size === undefined ? null : taskSizeOption(options.size),
    sourceDoc: options.source === undefined ? null : nullableStringOption(options.source),
    sourceSection: options.section === undefined ? null : nullableStringOption(options.section),
    sourceLine: options.sourceLine === undefined ? null : options.sourceLine,
    completionBar: options.completionBar === undefined ? null : nullableStringOption(options.completionBar)
  }) as AddTaskInput;
}

function editTaskInputFromOptions(options: Record<string, unknown>): EditTaskInput {
  return defined({
    title: optionalStringOption(options.title),
    parentTaskId: options.parent === undefined ? undefined : parentOption(options.parent),
    description: optionalStringOption(options.description),
    lifecycle: optionalLifecycleOption(options.lifecycle),
    priority: options.priority as Priority | undefined,
    size: options.size === undefined ? undefined : taskSizeOption(options.size),
    sourceDoc: optionalStringOption(options.source),
    sourceSection: optionalStringOption(options.section),
    sourceLine: options.sourceLine,
    completionBar: optionalStringOption(options.completionBar)
  }) as EditTaskInput;
}

function assignmentTarget(options: Record<string, unknown>): string | null {
  const assign = options.assign ?? options.track;
  return assign === undefined ? null : stringOption(assign, "assign");
}

function parseIdList(values: string[] | string): string[] {
  const entries = Array.isArray(values) ? values : [values];
  const ids = entries.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new UnblockError("validation", "At least one dependency id is required.");
  }
  return [...new Set(ids)];
}

interface TaskImportPlan {
  source: string;
  tasks: PlannedTaskImport[];
  dependencies: PlannedDependencyImport[];
}

interface PlannedTaskImport {
  id: string;
  title: string;
  input: EditTaskInput;
  assign: string | null;
  tags: string[];
}

interface PlannedDependencyImport {
  taskId: string;
  dependsOnTaskId: string;
}

function parseTaskImportTree(file: string, content: string): TaskImportPlan {
  const parsed = file.endsWith(".json") ? JSON.parse(content) as unknown : parseYaml(content) as unknown;
  const root = Array.isArray(parsed) ? null : asRecord(parsed, "import file");
  const rawTasks = Array.isArray(parsed) ? parsed : arrayField(root as Record<string, unknown>, "tasks");
  const tasks: PlannedTaskImport[] = [];
  const dependencies: PlannedDependencyImport[] = [];
  const seenTaskIds = new Set<string>();

  for (const rawTask of rawTasks) {
    collectImportTask(rawTask, null, tasks, dependencies, seenTaskIds);
  }
  for (const rawEdge of optionalArrayField(root ?? {}, "dependencies")) {
    const edge = asRecord(rawEdge, "dependencies[]");
    const taskId = stringField(edge, ["task", "taskId"], "dependencies[].task");
    for (const dependsOnTaskId of stringListField(edge, ["on", "dependsOn", "depends_on"], "dependencies[].on")) {
      dependencies.push({ taskId, dependsOnTaskId });
    }
  }

  return { source: file, tasks, dependencies: dedupeDependencyEdges(dependencies) };
}

function collectImportTask(
  raw: unknown,
  inheritedParentTaskId: string | null,
  tasks: PlannedTaskImport[],
  dependencies: PlannedDependencyImport[],
  seenTaskIds: Set<string>
): void {
  const record = asRecord(raw, "tasks[]");
  const id = stringField(record, ["id"], "task.id");
  if (seenTaskIds.has(id)) {
    throw new UnblockError("validation", `Duplicate task id in import tree: ${id}`);
  }
  seenTaskIds.add(id);
  const title = stringField(record, ["title"], `task ${id}.title`);
  const parentTaskId = record.parent === undefined && record.parentTaskId === undefined
    ? inheritedParentTaskId
    : nullableStringOption(record.parent ?? record.parentTaskId);
  const input = defined({
    parentTaskId,
    title,
    description: optionalStringOption(record.description),
    lifecycle: optionalLifecycleOption(record.lifecycle),
    priority: optionalPriorityValue(record.priority),
    size: record.size === undefined ? undefined : taskSizeOption(record.size),
    sourceDoc: optionalStringOption(record.source ?? record.sourceDoc),
    sourceSection: optionalStringOption(record.section ?? record.sourceSection),
    sourceLine: optionalIntegerValue(record.sourceLine ?? record.line),
    completionBar: optionalStringOption(record.completionBar)
  }) as EditTaskInput;
  tasks.push({
    id,
    title,
    input,
    assign: record.assign === undefined && record.track === undefined ? null : stringOption(record.assign ?? record.track, `task ${id}.assign`),
    tags: stringListField(record, ["tags"], `task ${id}.tags`, true)
  });
  for (const dependsOnTaskId of stringListField(record, ["dependsOn", "depends_on", "dependencies"], `task ${id}.dependsOn`, true)) {
    dependencies.push({ taskId: id, dependsOnTaskId });
  }
  for (const child of optionalArrayField(record, "children")) {
    collectImportTask(child, id, tasks, dependencies, seenTaskIds);
  }
}

function dedupeDependencyEdges(edges: PlannedDependencyImport[]): PlannedDependencyImport[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.taskId}\0${edge.dependsOnTaskId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UnblockError("validation", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function arrayField(record: Record<string, unknown>, field: string): unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    throw new UnblockError("validation", `${field} must be an array.`);
  }
  return value;
}

function optionalArrayField(record: Record<string, unknown>, field: string): unknown[] {
  const value = record[field];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new UnblockError("validation", `${field} must be an array.`);
  }
  return value;
}

function stringField(record: Record<string, unknown>, fields: string[], label: string): string {
  for (const field of fields) {
    if (record[field] !== undefined) {
      return stringOption(record[field], label);
    }
  }
  throw new UnblockError("validation", `${label} is required.`);
}

function stringListField(record: Record<string, unknown>, fields: string[], label: string, optional = false): string[] {
  const value = fields.map((field) => record[field]).find((entry) => entry !== undefined);
  if (value === undefined || value === null) {
    return optional ? [] : (() => { throw new UnblockError("validation", `${label} is required.`); })();
  }
  if (Array.isArray(value)) {
    const result = value.map((entry) => stringOption(entry, label)).filter(Boolean);
    if (!optional && result.length === 0) {
      throw new UnblockError("validation", `${label} must not be empty.`);
    }
    return result;
  }
  return parseIdList(stringOption(value, label));
}

function stringOption(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UnblockError("validation", `${name} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalStringOption(value: unknown): string | undefined {
  return value === undefined ? undefined : stringOption(value, "value");
}

function nullableStringOption(value: unknown): string | null {
  if (value === null || value === "none") {
    return null;
  }
  return stringOption(value, "value");
}

function parentOption(value: unknown): string | null {
  return nullableStringOption(value);
}

function optionalLifecycleOption(value: unknown): Lifecycle | undefined {
  if (value === undefined) {
    return undefined;
  }
  const lifecycle = stringOption(value, "lifecycle");
  if (lifecycle !== "open" && lifecycle !== "started" && lifecycle !== "finished") {
    throw new UnblockError("validation", `Invalid lifecycle: ${lifecycle}`);
  }
  return lifecycle;
}

function taskSizeOption(value: unknown): TaskSize | null {
  if (value === null || value === "none") {
    return null;
  }
  const size = stringOption(value, "size").toUpperCase();
  if (size !== "XS" && size !== "S" && size !== "M" && size !== "L" && size !== "XL") {
    throw new UnblockError("validation", `Invalid size: ${size}`);
  }
  return size;
}

function optionalPriorityValue(value: unknown): Priority | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : parseInteger(stringOption(value, "priority"));
  return prioritySchema.parse(parsed);
}

function optionalIntegerValue(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === "number" ? value : parseInteger(stringOption(value, "integer"));
}

function matchesTrackReference(trackItem: { id: string; machine: string; actor: string }, actorOrId: string): boolean {
  const raw = actorOrId.trim();
  const actorRef = `${trackItem.machine}:${trackItem.actor}`;
  return trackItem.id === raw
    || trackItem.id === slugify(raw)
    || trackItem.actor === raw
    || actorRef === raw
    || slugify(actorRef) === raw;
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
  throw new UnblockError("workspace_not_found", "Could not locate the unblock workspace root for serve.");
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
