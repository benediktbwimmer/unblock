import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  createServices,
  createSqliteStore,
  defaultNotJiraDbPath,
  formatExplain,
  MigrationService,
  NotJiraError,
  type ComputedStatus,
  type Lifecycle,
  type Priority,
  type TaskListFilters,
  type TaskSize,
  type TaskSort
} from "@not-jira/core";

export interface ServerOptions {
  databasePath?: string | undefined;
}

export function createApp(options: ServerOptions = {}) {
  const app = new Hono();
  app.use("*", cors());

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.use("/api/*", async (c, next) => {
    const store = createSqliteStore(defined({ databasePath: options.databasePath, autoMigrate: true }));
    c.set("services", createServices(store));
    c.set("store", store);
    try {
      await next();
    } finally {
      await store.close?.();
    }
  });

  app.onError((error, c) => {
    if (error instanceof NotJiraError) {
      return c.json({ error: { code: error.code, message: error.message, details: error.details } }, error.code === "not_found" ? 404 : 400);
    }
    return c.json({ error: { code: "internal", message: error instanceof Error ? error.message : String(error) } }, 500);
  });

  app.get("/api/db/status", async (c) => {
    const migration = new MigrationService(c.get("store"));
    return c.json(await migration.status());
  });

  app.post("/api/db/migrate", async (c) => {
    const migration = new MigrationService(c.get("store"));
    return c.json(await migration.migrate());
  });

  app.get("/api/tasks", async (c) => {
    const services = c.get("services");
    const query = c.req.query();
    const filters = defined({
      search: query.search,
      status: query.status as ComputedStatus | "open" | undefined,
      lifecycle: query.lifecycle as Lifecycle | undefined,
      priorityMin: parseOptionalPriority(query.priorityMin),
      priorityMax: parseOptionalPriority(query.priorityMax),
      size: query.size as TaskSize | undefined,
      parentTaskId: query.parent === undefined ? undefined : query.parent === "root" ? null : query.parent,
      sourceDoc: query.sourceDoc,
      sourceSection: query.sourceSection,
      tag: query.tag,
      assignedActor: query.actor,
      includeFinished: query.includeFinished === "true",
      includeArchived: query.includeArchived === "true",
      sort: query.sort as TaskSort | undefined
    }) as TaskListFilters;
    return c.json(await services.query.list(filters));
  });

  app.post("/api/tasks", async (c) => {
    const services = c.get("services");
    return c.json(await services.tasks.add(await c.req.json()), 201);
  });

  app.get("/api/tasks/:id", async (c) => {
    const services = c.get("services");
    const tasks = await services.query.list({ includeFinished: true, includeArchived: true });
    const task = tasks.find((item) => item.id === c.req.param("id").toUpperCase());
    if (!task) {
      throw new NotJiraError("not_found", `task not found: ${c.req.param("id")}`);
    }
    return c.json(task);
  });

  app.patch("/api/tasks/:id", async (c) => c.json(await c.get("services").tasks.edit(c.req.param("id"), await c.req.json())));
  app.delete("/api/tasks/:id", async (c) => {
    await c.get("services").tasks.delete(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/tasks/:id/archive", async (c) => c.json(await c.get("services").tasks.archive(c.req.param("id"))));
  app.post("/api/tasks/:id/start", async (c) => c.json(await c.get("services").tasks.start(c.req.param("id"))));
  app.post("/api/tasks/:id/finish", async (c) => c.json(await c.get("services").tasks.finish(c.req.param("id"))));
  app.post("/api/tasks/:id/reopen", async (c) => c.json(await c.get("services").tasks.reopen(c.req.param("id"))));

  app.get("/api/tasks/:id/explain", async (c) => {
    const explanation = await c.get("services").query.explain(c.req.param("id"));
    if (c.req.query("format") === "text") {
      return c.text(formatExplain(explanation));
    }
    return c.json(explanation);
  });

  app.put("/api/tasks/:id/dependencies", async (c) => {
    const body = await c.req.json<{ dependencyIds: string[] }>();
    return c.json(await c.get("services").dependencies.set(c.req.param("id"), body.dependencyIds ?? []));
  });
  app.post("/api/tasks/:id/dependencies/:dependencyId", async (c) => c.json(await c.get("services").dependencies.add(c.req.param("id"), c.req.param("dependencyId"))));
  app.delete("/api/tasks/:id/dependencies/:dependencyId", async (c) => {
    await c.get("services").dependencies.remove(c.req.param("id"), c.req.param("dependencyId"));
    return c.json({ ok: true });
  });

  app.get("/api/tags", async (c) => c.json(await c.get("services").tags.list()));
  app.post("/api/tags", async (c) => c.json(await c.get("services").tags.add(await c.req.json()), 201));
  app.patch("/api/tags/:id", async (c) => c.json(await c.get("services").tags.edit(c.req.param("id"), await c.req.json())));
  app.post("/api/tags/:id/archive", async (c) => c.json(await c.get("services").tags.archive(c.req.param("id"))));
  app.post("/api/tasks/:id/tags/:tagId", async (c) => {
    await c.get("services").tags.assign(c.req.param("id"), [c.req.param("tagId")]);
    return c.json({ ok: true });
  });
  app.delete("/api/tasks/:id/tags/:tagId", async (c) => {
    await c.get("services").tags.remove(c.req.param("id"), c.req.param("tagId"));
    return c.json({ ok: true });
  });

  app.get("/api/tracks", async (c) => c.json(await c.get("services").tracks.list()));
  app.post("/api/tracks", async (c) => c.json(await c.get("services").tracks.add(await c.req.json()), 201));
  app.patch("/api/tracks/:id", async (c) => {
    const body = await c.req.json<{ name: string }>();
    return c.json(await c.get("services").tracks.rename(c.req.param("id"), body.name));
  });
  app.post("/api/tracks/:id/archive", async (c) => c.json(await c.get("services").tracks.archive(c.req.param("id"))));
  app.post("/api/tracks/:id/assignments", async (c) => {
    const body = await c.req.json<{ taskId: string }>();
    return c.json(await c.get("services").tracks.assign(c.req.param("id"), body.taskId), 201);
  });
  app.delete("/api/tracks/:id/assignments/:taskId", async (c) => {
    await c.get("services").tracks.unassign(c.req.param("id"), c.req.param("taskId"));
    return c.json({ ok: true });
  });

  app.get("/api/activity", async (c) => c.json(await c.get("services").activity.list(Number(c.req.query("limit") ?? 100))));
  app.post("/api/import/markdown", async (c) => {
    const body = await c.req.json<{ filePath: string; markdown: string; dryRun?: boolean }>();
    return c.json(await c.get("services").imports.markdown(body.filePath, body.markdown, Boolean(body.dryRun)));
  });
  app.post("/api/export/json", async (c) => c.json(await c.get("services").exports.json(c.req.query("includeActivity") === "true")));
  app.post("/api/export/markdown", async (c) => c.text(await c.get("services").exports.markdown()));
  app.get("/api/source-coverage", async (c) => c.json(await c.get("services").query.sourceCoverage()));
  app.get("/api/tag-coverage", async (c) => c.json(await c.get("services").query.tagCoverage()));
  app.get("/api/ready", async (c) => c.json(await c.get("services").query.list({ status: "ready" })));

  return app;
}

declare module "hono" {
  interface ContextVariableMap {
    services: ReturnType<typeof createServices>;
    store: ReturnType<typeof createSqliteStore>;
  }
}

function parseOptionalPriority(value: string | undefined): Priority | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (parsed === 0 || parsed === 1 || parsed === 2 || parsed === 3 || parsed === 4) {
    return parsed;
  }
  return undefined;
}

function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  serve({
    fetch: createApp({ databasePath: process.env.NOT_JIRA_DB ?? defaultNotJiraDbPath() }).fetch,
    port
  });
  console.log(`not-jira API listening on http://localhost:${port}`);
}
