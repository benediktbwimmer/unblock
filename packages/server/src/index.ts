import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import {
  createServices,
  createPostgresPool,
  createPostgresStore,
  createSqliteStore,
  createHostedSecret,
  connectorSyncPolicyRecordInputSchema,
  connectorSyncQueueItemStatusSchema,
  defaultUnblockConfigPath,
  formatExplain,
  applyConnectorInboxEvent,
  connectorEventSchema,
  connectorObservabilitySnapshot,
  githubConnectionInputSchema,
  githubConnectorAuthModel,
  hasHostedPermission,
  hostedPermissionForRequest,
  githubIssueMappingInputSchema,
  listGitHubConnections,
  listGitHubIssueMappings,
  listConnectorSyncPolicies,
  listConnectorSyncQueueItems,
  matcherQueryGrammar,
  MigrationService,
  nowIso,
  observeConnectorInboxEvent,
  parseHostedSecretKey,
  requestConnectorReconciliation,
  rotateHostedSecret,
  setConnectorConnectionStatus,
  UnblockError,
  upsertGitHubIssueMapping,
  upsertGitHubConnection,
  updateConnectorSyncQueueItemStatus,
  upsertConnectorSyncPolicy,
  publicUnblockConfig,
  readUnblockConfig,
  resolveUnblockStorageConfig,
  runPostgresMigrations,
  updateUnblockConfig,
  type ComputedStatus,
  type AppStore,
  type ConnectorEvent,
  withAdditionalHostedRoles,
  type Lifecycle,
  type Priority,
  type TaskListFilters,
  type TaskSize,
  type TaskSort,
  type HostedSecret,
  type ConnectorProvider
} from "@unblock/core";
import {
  enforceHostedRateLimit,
  enforceHostedRequest,
  hostedConfigStatus,
  hostedRuntimeConfig,
  requestId,
  resolveHostedIdentity,
  syncHostedIdentity,
  type HostedRequestContext
} from "./hosted-auth.js";

export type UnblockBackend = "sqlite" | "postgres" | "hosted" | "prism";

const defaultConnectorObservationTtlMs = 1_000;

export interface ServerOptions {
  backend?: UnblockBackend | undefined;
  databasePath?: string | undefined;
  postgresUrl?: string | undefined;
  configPath?: string | undefined;
  storeFactory?: (() => AppStore | Promise<AppStore>) | undefined;
  hostedAuth?: ReturnType<typeof hostedRuntimeConfig> | undefined;
}

type SharedPostgresRuntime = {
  pool: ReturnType<typeof createPostgresPool>;
  migrations: Promise<void>;
  stores: Map<string, Promise<AppStore>>;
};

export function createApp(options: ServerOptions = {}) {
  const app = new Hono();
  const postgresRuntimes = new Map<string, SharedPostgresRuntime>();
  const connectorObservationNextAt = new Map<string, number>();
  app.use("*", cors());

  app.get("/api/health", async (c) => c.json({
    ok: true,
    mode: await isHostedMode(options) ? "hosted" : "local",
    time: new Date().toISOString()
  }));
  app.get("/api/config", async (c) => {
    const result = await readUnblockConfig(options.configPath ?? process.env.UNBLOCK_CONFIG ?? defaultUnblockConfigPath());
    return c.json({
      ...publicUnblockConfig(result.config),
      issues: result.issues
    });
  });
  app.patch("/api/config", async (c) => {
    const body = await c.req.json<{ identity?: { machine?: string; actor?: string } }>();
    const result = await updateUnblockConfig({
      identity: {
        machine: body.identity?.machine?.trim() ?? "",
        actor: body.identity?.actor?.trim() ?? ""
      }
    }, options.configPath ?? process.env.UNBLOCK_CONFIG ?? defaultUnblockConfigPath());
    return c.json({
      ...publicUnblockConfig(result.config),
      issues: result.issues
    });
  });

  app.use("/api/*", async (c, next) => {
    const startedAt = Date.now();
    const id = requestId(c.req.raw.headers);
    c.header("x-request-id", id);
    const hosted = await hostedContextForRequest(c, options, id);
    const store = await openStore(options, hosted?.identity.tenantId, postgresRuntimes);
    c.set("services", createServices(store));
    c.set("store", store);
    c.set("configPath", options.configPath ?? process.env.UNBLOCK_CONFIG ?? defaultUnblockConfigPath());
    if (hosted) {
      c.set("hosted", hosted);
      const hostedConfig = options.hostedAuth ?? hostedRuntimeConfig();
      await syncHostedIdentity(store, hosted.identity, hostedConfig.identitySyncTtlMs ?? 0);
      const rateLimit = enforceHostedRateLimit(hosted.identity, hostedConfig);
      c.header("x-ratelimit-remaining", String(rateLimit.remaining));
      c.header("x-ratelimit-reset", String(Math.ceil(rateLimit.resetAt / 1000)));
    }
    try {
      await next();
    } finally {
      if (hosted && process.env.UNBLOCK_STRUCTURED_LOGS !== "false") {
        console.info(JSON.stringify({
          event: "http.request",
          requestId: id,
          tenantId: hosted.identity.tenantId,
          principalId: hosted.identity.principalId,
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          durationMs: Date.now() - startedAt
        }));
      }
      await store.close?.();
    }
  });

  app.onError((error, c) => {
    if (error instanceof UnblockError) {
      return c.json({ error: { code: error.code, message: error.message, details: error.details } }, error.code === "not_found" ? 404 : 400);
    }
    if (typeof error === "object" && error !== null && "status" in error && error.status === 429) {
      const retryAfter = "retryAfter" in error ? Number(error.retryAfter) : 60;
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: { code: "rate_limited", message: error instanceof Error ? error.message : "Rate limit exceeded." } }, 429);
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

  app.get("/api/projects", async (c) => c.json(await c.get("services").projects.list()));
  app.post("/api/projects", async (c) => c.json(await (await globalMutationServices(c)).projects.add(await c.req.json()), 201));
  app.post("/api/projects/:id/archive", async (c) => c.json(await (await globalMutationServices(c)).projects.archive(c.req.param("id"))));
  app.post("/api/projects/:id/restore", async (c) => c.json(await (await globalMutationServices(c)).projects.restore(c.req.param("id"))));

  app.get("/api/admin/me", async (c) => {
    const hosted = await requireHosted(c);
    await authorizeHosted(c, null);
    return c.json({
      tenantId: hosted.identity.tenantId,
      principalId: hosted.identity.principalId,
      organizationId: hosted.identity.organizationId,
      roles: hosted.identity.roles,
      permissions: hosted.identity.permissions,
      issuedBy: hosted.identity.issuedBy
    });
  });

  app.get("/api/audit", async (c) => {
    const hosted = await requireHosted(c);
    const projectId = c.req.query("projectId")?.trim() || null;
    await authorizeHosted(c, projectId);
    return c.json(await c.get("store").hostedAudit?.list({
      tenantId: hosted.identity.tenantId,
      projectId: c.req.query("projectId") === undefined ? undefined : projectId,
      limit: parseOptionalInteger(c.req.query("limit")) ?? 100
    }) ?? []);
  });

  app.get("/api/secrets", async (c) => {
    await requireHosted(c);
    const projectId = c.req.query("projectId")?.trim() || null;
    await authorizeHosted(c, projectId);
    const secrets = await c.get("store").hostedSecrets?.list(c.req.query("projectId") === undefined ? undefined : projectId) ?? [];
    return c.json(secrets.map(redactSecret));
  });

  app.post("/api/secrets", async (c) => {
    const hosted = await requireHosted(c);
    const projectId = c.req.query("projectId")?.trim() || null;
    await authorizeHosted(c, projectId);
    const body = await c.req.json<{ name?: string; purpose?: string; plaintext?: string }>();
    const repo = c.get("store").hostedSecrets;
    if (!repo) throw new UnblockError("validation", "Hosted secret repository is not available.");
    const existing = await repo.findByName(projectId, body.name ?? "");
    if (existing) throw new UnblockError("conflict", `Hosted secret already exists: ${body.name}`);
    const secret = createHostedSecret({
      tenantId: hosted.identity.tenantId,
      projectId,
      name: body.name ?? "",
      purpose: body.purpose ?? "",
      plaintext: body.plaintext ?? "",
      key: parseHostedSecretKey(process.env.UNBLOCK_HOSTED_SECRET_KEY),
      keyId: process.env.UNBLOCK_HOSTED_SECRET_KEY_ID ?? "default"
    });
    await repo.create(secret);
    return c.json(redactSecret(secret), 201);
  });

  app.post("/api/secrets/:id/rotate", async (c) => {
    await requireHosted(c);
    await authorizeHosted(c, null);
    const repo = c.get("store").hostedSecrets;
    if (!repo) throw new UnblockError("validation", "Hosted secret repository is not available.");
    const current = await repo.get(c.req.param("id"));
    if (!current) throw new UnblockError("not_found", `secret not found: ${c.req.param("id")}`);
    const body = await c.req.json<{ plaintext?: string }>();
    const rotated = rotateHostedSecret(
      current,
      body.plaintext ?? "",
      parseHostedSecretKey(process.env.UNBLOCK_HOSTED_SECRET_KEY),
      process.env.UNBLOCK_HOSTED_SECRET_KEY_ID ?? current.keyId
    );
    await repo.update(rotated);
    return c.json(redactSecret(rotated));
  });

  app.delete("/api/secrets/:id", async (c) => {
    await requireHosted(c);
    await authorizeHosted(c, null);
    const repo = c.get("store").hostedSecrets;
    if (!repo) throw new UnblockError("validation", "Hosted secret repository is not available.");
    await repo.archive(c.req.param("id"), nowIso());
    return c.json({ ok: true });
  });

  app.get("/api/hosted/metrics", async (c) => {
    const hosted = await requireHosted(c);
    const projectId = c.req.query("projectId")?.trim();
    await authorizeHosted(c, projectId ?? null);
    const store = c.get("store");
    const projects = await store.projects.list();
    const visibleProjects = projectId ? projects.filter((project) => project.id === projectId) : projects;
    const taskLists = await Promise.all(visibleProjects.map((project) => store.tasks.list(project.id)));
    const tasks = taskLists.flat();
    return c.json({
      tenantId: hosted.identity.tenantId,
      projectCount: visibleProjects.length,
      taskCount: tasks.length,
      openTaskCount: tasks.filter((task) => task.lifecycle === "open" && !task.archivedAt).length,
      startedTaskCount: tasks.filter((task) => task.lifecycle === "started" && !task.archivedAt).length,
      finishedTaskCount: tasks.filter((task) => task.lifecycle === "finished" && !task.archivedAt).length,
      archivedTaskCount: tasks.filter((task) => task.archivedAt).length,
      generatedAt: new Date().toISOString()
    });
  });

  app.get("/api/hosted/config", async (c) => {
    await requireHosted(c);
    await authorizeHosted(c, null);
    return c.json(hostedConfigStatus());
  });

  app.get("/api/connectors/status", async (c) => {
    await requireHosted(c);
    const projectId = c.req.query("projectId")?.trim();
    await authorizeHosted(c, projectId ?? null);
    return c.json(await connectorObservabilitySnapshot(c.get("store"), {
      projectId,
      recentRunLimit: parseOptionalInteger(c.req.query("limit")) ?? 20
    }));
  });

  app.get("/api/connectors/runs", async (c) => {
    await requireHosted(c);
    const projectId = c.req.query("projectId")?.trim();
    await authorizeHosted(c, projectId ?? null);
    const connectors = c.get("store").connectors;
    if (!connectors) throw new UnblockError("validation", "Connector repository is not available.");
    return c.json(await connectors.listSyncRuns({
      projectId,
      connectionId: c.req.query("connectionId")?.trim(),
      limit: parseOptionalInteger(c.req.query("limit")) ?? 100
    }));
  });

  app.get("/api/connectors/cursors", async (c) => {
    await requireHosted(c);
    const projectId = requireProjectId(c);
    const connectionId = c.req.query("connectionId")?.trim();
    if (!connectionId) throw new UnblockError("validation", "connectionId is required.");
    await authorizeHosted(c, projectId);
    const connectors = c.get("store").connectors;
    if (!connectors) throw new UnblockError("validation", "Connector repository is not available.");
    return c.json(await connectors.listCursors(projectId, connectionId));
  });

  app.get("/api/connectors/sync-policies", async (c) => {
    await requireHosted(c);
    const projectId = c.req.query("projectId")?.trim();
    await authorizeHosted(c, projectId ?? null);
    return c.json(await listConnectorSyncPolicies(c.get("store"), {
      projectId,
      connectionId: c.req.query("connectionId")?.trim(),
      includeArchived: c.req.query("includeArchived") === "true",
      limit: parseOptionalInteger(c.req.query("limit")) ?? 100
    }));
  });

  app.post("/api/connectors/sync-policies", async (c) => {
    await requireHosted(c);
    const body = connectorSyncPolicyRecordInputSchema.parse(await c.req.json());
    await authorizeHosted(c, body.projectId);
    return c.json(await upsertConnectorSyncPolicy(c.get("store"), body), 201);
  });

  app.get("/api/connectors/sync-queue", async (c) => {
    await requireHosted(c);
    const projectId = c.req.query("projectId")?.trim();
    await authorizeHosted(c, projectId ?? null);
    const statusQuery = c.req.query("status")?.trim();
    const status = statusQuery ? connectorSyncQueueItemStatusSchema.parse(statusQuery) : undefined;
    return c.json(await listConnectorSyncQueueItems(c.get("store"), {
      projectId,
      connectionId: c.req.query("connectionId")?.trim(),
      status,
      limit: parseOptionalInteger(c.req.query("limit")) ?? 100
    }));
  });

  app.post("/api/connectors/sync-queue/:id/status", async (c) => {
    await requireHosted(c);
    const projectId = requireProjectId(c);
    await authorizeHosted(c, projectId);
    const body = await c.req.json<{ status?: string; resolvedAt?: string | null; error?: Record<string, unknown> | null }>();
    const status = connectorSyncQueueItemStatusSchema.parse(body.status);
    return c.json(await updateConnectorSyncQueueItemStatus(c.get("store"), {
      projectId,
      id: c.req.param("id"),
      status,
      resolvedAt: body.resolvedAt,
      error: body.error
    }));
  });

  app.post("/api/connectors/reconcile", async (c) => {
    const hosted = await requireHosted(c);
    const body = await c.req.json<{
      projectId?: string;
      connectionId?: string;
      provider?: ConnectorProvider;
      displayName?: string;
      reason?: string;
      cursorName?: string;
    }>();
    const projectId = body.projectId?.trim();
    const connectionId = body.connectionId?.trim();
    if (!projectId) throw new UnblockError("validation", "projectId is required.");
    if (!connectionId) throw new UnblockError("validation", "connectionId is required.");
    if (!body.provider) throw new UnblockError("validation", "provider is required.");
    await authorizeHosted(c, projectId);
    const request = await requestConnectorReconciliation(c.get("store"), {
      tenantId: hosted.identity.tenantId,
      projectId,
      connectionId,
      provider: body.provider,
      displayName: body.displayName,
      reason: body.reason,
      cursorName: body.cursorName
    });
    return c.json({
      connection: request.connection,
      run: request.run,
      outboxEventId: request.outboxEvent.id,
      event: request.event
    }, 202);
  });

  app.post("/api/connectors/inbox", async (c) => {
    await requireHosted(c);
    const event = connectorEventSchema.parse(await c.req.json());
    await authorizeHosted(c, event.scope.projectId);
    const result = await applyConnectorInboxEvent(c.get("store"), event, { source: "prism-flows" });
    const observation = result.applied && shouldObserveSuccessfulConnectorInboxEvent(event, connectorObservationNextAt)
      ? await observeConnectorInboxEvent(c.get("store"), event, { evidence: result.evidence })
      : null;
    return c.json({ ...result, observation });
  });

  app.post("/api/connectors/inbox/batch", async (c) => {
    await requireHosted(c);
    const events = connectorEventSchema.array().parse(await c.req.json());
    const results = [];
    for (const event of events) {
      await authorizeHosted(c, event.scope.projectId);
      const result = await applyConnectorInboxEvent(c.get("store"), event, { source: "prism-flows" });
      const observation = result.applied && shouldObserveSuccessfulConnectorInboxEvent(event, connectorObservationNextAt)
        ? await observeConnectorInboxEvent(c.get("store"), event, { evidence: result.evidence })
        : null;
      results.push({ ...result, observation });
    }
    return c.json({
      count: results.length,
      applied: results.filter((result) => result.applied).length,
      duplicate: results.filter((result) => result.duplicate).length,
      results
    });
  });

  app.get("/api/connectors/github/auth-model", async (c) => {
    await requireHosted(c);
    await authorizeHosted(c, null);
    const publicBaseUrl = connectorPublicIngressUrl();
    return c.json({
      ...githubConnectorAuthModel,
      webhook: {
        url: publicBaseUrl ? `${publicBaseUrl}/webhooks/github/issues` : null,
        secretPurpose: "github.webhook_secret",
        events: githubConnectorAuthModel.subscribeEvents
      }
    });
  });

  app.get("/api/connectors/github/setup", async (c) => {
    await requireHosted(c);
    const projectId = c.req.query("projectId")?.trim() ?? null;
    await authorizeHosted(c, projectId);
    const publicBaseUrl = connectorPublicIngressUrl();
    return c.json({
      provider: "github",
      projectId,
      authModel: githubConnectorAuthModel.mode,
      requiredPermissions: githubConnectorAuthModel.repositoryPermissions,
      subscribeEvents: githubConnectorAuthModel.subscribeEvents,
      requiredSecrets: [
        { name: "github-private-key", purpose: "github.private_key" },
        { name: "github-webhook-secret", purpose: "github.webhook_secret" }
      ],
      webhookUrl: publicBaseUrl ? `${publicBaseUrl}/webhooks/github/issues` : null,
      connectionEndpoint: "/api/connectors/github/connections"
    });
  });

  app.get("/api/connectors/github/connections", async (c) => {
    await requireHosted(c);
    const projectId = c.req.query("projectId")?.trim();
    await authorizeHosted(c, projectId ?? null);
    const connections = await listGitHubConnections(c.get("store"), projectId);
    if (c.req.query("includeState") !== "true") return c.json(connections);
    const connectors = c.get("store").connectors;
    if (!connectors) return c.json(connections);
    return c.json(await Promise.all(connections.map(async (connection) => ({
      ...connection,
      cursors: await connectors.listCursors(connection.projectId, connection.id),
      recentRuns: await connectors.listSyncRuns({
        projectId: connection.projectId,
        connectionId: connection.id,
        limit: parseOptionalInteger(c.req.query("runLimit")) ?? 10
      })
    }))));
  });

  app.post("/api/connectors/github/connections", async (c) => {
    await requireHosted(c);
    const body = githubConnectionInputSchema.parse(await c.req.json());
    await authorizeHosted(c, body.projectId);
    return c.json(await upsertGitHubConnection(c.get("store"), body), 201);
  });

  app.post("/api/connectors/github/connections/:id/pause", async (c) => {
    await requireHosted(c);
    const projectId = requireProjectId(c);
    await authorizeHosted(c, projectId);
    return c.json(await setConnectorConnectionStatus(c.get("store"), {
      projectId,
      connectionId: c.req.param("id"),
      status: "paused"
    }));
  });

  app.post("/api/connectors/github/connections/:id/resume", async (c) => {
    await requireHosted(c);
    const projectId = requireProjectId(c);
    await authorizeHosted(c, projectId);
    return c.json(await setConnectorConnectionStatus(c.get("store"), {
      projectId,
      connectionId: c.req.param("id"),
      status: "active"
    }));
  });

  app.delete("/api/connectors/github/connections/:id", async (c) => {
    await requireHosted(c);
    const projectId = requireProjectId(c);
    await authorizeHosted(c, projectId);
    return c.json(await setConnectorConnectionStatus(c.get("store"), {
      projectId,
      connectionId: c.req.param("id"),
      status: "archived"
    }));
  });

  app.get("/api/connectors/github/mappings", async (c) => {
    await requireHosted(c);
    const projectId = c.req.query("projectId")?.trim();
    await authorizeHosted(c, projectId ?? null);
    return c.json(await listGitHubIssueMappings(c.get("store"), {
      projectId,
      connectionId: c.req.query("connectionId")?.trim(),
      limit: parseOptionalInteger(c.req.query("limit")) ?? 100
    }));
  });

  app.post("/api/connectors/github/mappings", async (c) => {
    await requireHosted(c);
    const body = githubIssueMappingInputSchema.parse(await c.req.json());
    await authorizeHosted(c, body.projectId);
    return c.json(await upsertGitHubIssueMapping(c.get("store"), body), 201);
  });

  app.post("/api/connectors/github/mappings/batch", async (c) => {
    await requireHosted(c);
    const mappings = githubIssueMappingInputSchema.array().parse(await c.req.json());
    const results = [];
    for (const mapping of mappings) {
      await authorizeHosted(c, mapping.projectId);
      results.push(await upsertGitHubIssueMapping(c.get("store"), mapping));
    }
    return c.json({ count: results.length, results }, 201);
  });

  app.get("/api/tasks", async (c) => {
    const services = await scopedServices(c);
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
      where: query.where,
      sort: query.sort as TaskSort | undefined
    }) as TaskListFilters;
    return c.json(await services.query.list(filters));
  });

  app.get("/api/query", async (c) => {
    const services = await scopedServices(c);
    const where = c.req.query("where") ?? "";
    const limit = parseRequiredInteger(c.req.query("limit"), "limit");
    const filters = defined({
      includeFinished: c.req.query("includeFinished") === "true",
      includeArchived: c.req.query("includeArchived") === "true",
      sort: c.req.query("sort") as TaskSort | undefined
    }) as Omit<TaskListFilters, "where">;
    return c.json(await services.query.match(where, limit, filters));
  });

  app.post("/api/tasks", async (c) => {
    const services = await scopedServices(c);
    return c.json(await services.tasks.add(await c.req.json()), 201);
  });

  app.get("/api/tasks/:id", async (c) => {
    const services = await scopedServices(c);
    const tasks = await services.query.list({ includeFinished: true, includeArchived: true });
    const task = tasks.find((item) => item.id === c.req.param("id").toUpperCase());
    if (!task) {
      throw new UnblockError("not_found", `task not found: ${c.req.param("id")}`);
    }
    return c.json(task);
  });

  app.patch("/api/tasks/:id", async (c) => c.json(await (await scopedServices(c)).tasks.edit(c.req.param("id"), await c.req.json())));
  app.delete("/api/tasks/:id", async (c) => {
    await (await scopedServices(c)).tasks.delete(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/api/tasks/:id/archive", async (c) => c.json(await (await scopedServices(c)).tasks.archive(c.req.param("id"))));
  app.post("/api/tasks/:id/restore", async (c) => c.json(await (await scopedServices(c)).tasks.restore(c.req.param("id"))));
  app.post("/api/tasks/:id/start", async (c) => c.json(await (await scopedServices(c)).tasks.start(c.req.param("id"))));
  app.post("/api/tasks/:id/finish", async (c) => c.json(await (await scopedServices(c)).tasks.finish(c.req.param("id"))));
  app.post("/api/tasks/:id/release", async (c) => c.json(await (await scopedServices(c)).tasks.release(c.req.param("id"), await c.req.json())));
  app.post("/api/tasks/:id/reopen", async (c) => c.json(await (await scopedServices(c)).tasks.reopen(c.req.param("id"))));

  app.get("/api/tasks/:id/explain", async (c) => {
    const explanation = await (await scopedServices(c)).query.explain(c.req.param("id"));
    if (c.req.query("format") === "text") {
      return c.text(formatExplain(explanation));
    }
    return c.json(explanation);
  });

  app.get("/api/tasks/:id/comments", async (c) => c.json(await (await scopedServices(c)).comments.list(c.req.param("id"), {
    includeArchived: c.req.query("includeArchived") === "true",
    limit: parseOptionalInteger(c.req.query("limit"))
  })));
  app.post("/api/tasks/:id/comments", async (c) => c.json(await (await scopedServices(c)).comments.add(c.req.param("id"), await c.req.json()), 201));
  app.patch("/api/comments/:id", async (c) => c.json(await (await scopedServices(c)).comments.edit(c.req.param("id"), await c.req.json())));
  app.post("/api/comments/:id/archive", async (c) => c.json(await (await scopedServices(c)).comments.archive(c.req.param("id"))));
  app.post("/api/comments/:id/restore", async (c) => c.json(await (await scopedServices(c)).comments.restore(c.req.param("id"))));

  app.put("/api/tasks/:id/dependencies", async (c) => {
    const body = await c.req.json<{ dependencyIds: string[] }>();
    return c.json(await (await scopedServices(c)).dependencies.set(c.req.param("id"), body.dependencyIds ?? []));
  });
  app.post("/api/tasks/:id/dependencies/:dependencyId", async (c) => c.json(await (await scopedServices(c)).dependencies.add(c.req.param("id"), c.req.param("dependencyId"))));
  app.delete("/api/tasks/:id/dependencies/:dependencyId", async (c) => {
    await (await scopedServices(c)).dependencies.remove(c.req.param("id"), c.req.param("dependencyId"));
    return c.json({ ok: true });
  });

  app.get("/api/tags", async (c) => c.json(await (await scopedServices(c)).tags.list()));
  app.post("/api/tags", async (c) => c.json(await (await scopedServices(c)).tags.add(await c.req.json()), 201));
  app.patch("/api/tags/:id", async (c) => c.json(await (await scopedServices(c)).tags.edit(c.req.param("id"), await c.req.json())));
  app.post("/api/tags/:id/archive", async (c) => c.json(await (await scopedServices(c)).tags.archive(c.req.param("id"))));
  app.post("/api/tasks/:id/tags/:tagId", async (c) => {
    await (await scopedServices(c)).tags.assign(c.req.param("id"), [c.req.param("tagId")]);
    return c.json({ ok: true });
  });
  app.delete("/api/tasks/:id/tags/:tagId", async (c) => {
    await (await scopedServices(c)).tags.remove(c.req.param("id"), c.req.param("tagId"));
    return c.json({ ok: true });
  });

  app.get("/api/tracks", async (c) => c.json(await (await scopedServices(c)).tracks.list()));
  app.post("/api/tracks", async (c) => c.json(await (await scopedServices(c)).tracks.add(await c.req.json()), 201));
  app.patch("/api/tracks/:id", async (c) => {
    const body = await c.req.json<{ name: string }>();
    return c.json(await (await scopedServices(c)).tracks.rename(c.req.param("id"), body.name));
  });
  app.post("/api/tracks/:id/archive", async (c) => c.json(await (await scopedServices(c)).tracks.archive(c.req.param("id"))));
  app.post("/api/tracks/:id/assignments", async (c) => {
    const body = await c.req.json<{ taskId: string }>();
    return c.json(await (await scopedServices(c)).tracks.assign(c.req.param("id"), body.taskId), 201);
  });
  app.delete("/api/tracks/:id/assignments/:taskId", async (c) => {
    await (await scopedServices(c)).tracks.unassign(c.req.param("id"), c.req.param("taskId"));
    return c.json({ ok: true });
  });

  app.get("/api/activity", async (c) => {
    const where = c.req.query("where");
    const input: { limit: number; where?: string } = { limit: Number(c.req.query("limit") ?? 100) };
    if (where !== undefined) {
      input.where = where;
    }
    return c.json(await (await scopedServices(c)).activity.list(input));
  });
  app.get("/api/matcher/grammar", (c) => c.json(matcherQueryGrammar()));
  app.get("/api/matcher/suggest", async (c) => {
    const field = c.req.query("field") ?? "";
    const limit = Number(c.req.query("limit"));
    const input: { prefix?: string; limit: number } = { limit };
    const prefix = c.req.query("prefix");
    if (prefix !== undefined) {
      input.prefix = prefix;
    }
    return c.json(await (await scopedServices(c)).query.suggest(field, input));
  });
  app.get("/api/instructions", async (c) => c.json(await (await scopedServices(c)).instructions.list(c.req.query("includeArchived") === "true")));
  app.post("/api/instructions", async (c) => c.json(await (await scopedServices(c)).instructions.add(await c.req.json()), 201));
  app.get("/api/instructions/:id", async (c) => c.json(await (await scopedServices(c)).instructions.get(c.req.param("id"))));
  app.patch("/api/instructions/:id", async (c) => c.json(await (await scopedServices(c)).instructions.edit(c.req.param("id"), await c.req.json())));
  app.post("/api/instructions/:id/archive", async (c) => c.json(await (await scopedServices(c)).instructions.archive(c.req.param("id"))));
  app.post("/api/instructions/:id/restore", async (c) => c.json(await (await scopedServices(c)).instructions.restore(c.req.param("id"))));
  app.post("/api/instructions/preview", async (c) => {
    const body = await c.req.json<{ query: string }>();
    return c.json(await (await scopedServices(c)).instructions.preview(body.query ?? ""));
  });
  app.get("/api/tasks/:id/instructions", async (c) => c.json(await (await scopedServices(c)).instructions.matchesForTask(c.req.param("id"))));
  app.get("/api/views", async (c) => c.json(await (await scopedServices(c)).views.list(c.req.query("includeArchived") === "true")));
  app.post("/api/views", async (c) => c.json(await (await scopedServices(c)).views.add(await c.req.json()), 201));
  app.get("/api/views/:id", async (c) => c.json(await (await scopedServices(c)).views.get(c.req.param("id"))));
  app.patch("/api/views/:id", async (c) => c.json(await (await scopedServices(c)).views.edit(c.req.param("id"), await c.req.json())));
  app.post("/api/views/:id/archive", async (c) => c.json(await (await scopedServices(c)).views.archive(c.req.param("id"))));
  app.post("/api/views/:id/restore", async (c) => c.json(await (await scopedServices(c)).views.restore(c.req.param("id"))));
  app.get("/api/views/:id/tasks", async (c) => c.json(await (await scopedServices(c)).views.tasks(c.req.param("id"), parseOptionalInteger(c.req.query("limit")))));
  app.get("/api/feeds", async (c) => c.json(await (await scopedServices(c)).feeds.list(c.req.query("includeArchived") === "true")));
  app.post("/api/feeds", async (c) => c.json(await (await scopedServices(c)).feeds.add(await c.req.json()), 201));
  app.get("/api/feeds/:id", async (c) => c.json(await (await scopedServices(c)).feeds.get(c.req.param("id"))));
  app.patch("/api/feeds/:id", async (c) => c.json(await (await scopedServices(c)).feeds.edit(c.req.param("id"), await c.req.json())));
  app.post("/api/feeds/:id/archive", async (c) => c.json(await (await scopedServices(c)).feeds.archive(c.req.param("id"))));
  app.post("/api/feeds/:id/restore", async (c) => c.json(await (await scopedServices(c)).feeds.restore(c.req.param("id"))));
  app.get("/api/feeds/:id/tasks", async (c) => c.json(await (await scopedServices(c)).feeds.tasks(c.req.param("id"), parseOptionalInteger(c.req.query("limit")))));
  app.post("/api/import/markdown", async (c) => {
    const body = await c.req.json<{ filePath: string; markdown: string; dryRun?: boolean }>();
    return c.json(await (await scopedServices(c)).imports.markdown(body.filePath, body.markdown, Boolean(body.dryRun)));
  });
  app.post("/api/export/json", async (c) => c.json(await (await scopedServices(c)).exports.json(c.req.query("includeActivity") === "true")));
  app.post("/api/export/markdown", async (c) => c.text(await (await scopedServices(c)).exports.markdown(defined({ where: c.req.query("where"), limit: parseOptionalInteger(c.req.query("limit")) }) as { where?: string; limit?: number })));
  app.get("/api/source-coverage", async (c) => c.json(await (await scopedServices(c)).query.sourceCoverage()));
  app.get("/api/tag-coverage", async (c) => c.json(await (await scopedServices(c)).query.tagCoverage()));
  app.get("/api/ready", async (c) => c.json(await (await scopedServices(c)).query.list({ status: "ready" })));

  return app;
}

async function scopedServices(c: Context): Promise<ReturnType<typeof createServices>> {
  const projectId = requireProjectId(c);
  if (!await c.get("store").projects.get(projectId)) {
    throw new UnblockError("not_found", `project not found: ${projectId}`);
  }
  await authorizeHosted(c, projectId);
  if (c.req.method === "GET" || c.req.path.startsWith("/api/export/")) {
    return createServices(c.get("store"), { projectId });
  }
  const { machine, actor } = await requireConfigIdentity(c);
  return createServices(c.get("store"), { projectId, machine, actor });
}

async function globalMutationServices(c: Context): Promise<ReturnType<typeof createServices>> {
  await authorizeHosted(c, null);
  const { machine, actor } = await requireConfigIdentity(c);
  return createServices(c.get("store"), { machine, actor });
}

async function authorizeHosted(c: Context, projectId: string | null): Promise<void> {
  const hosted = c.get("hosted");
  if (!hosted) return;
  const store = c.get("store");
  let effective = hosted;
  if (projectId) {
    const permission = hostedPermissionForRequest(c.req.method, c.req.path);
    if (!hasHostedPermission(hosted.identity, permission)) {
      const projectRole = await store.hostedIdentity?.projectRole(projectId, hosted.identity.principalId);
      if (projectRole) {
        effective = {
          ...hosted,
          identity: withAdditionalHostedRoles(hosted.identity, [projectRole])
        };
      }
    }
  }
  await enforceHostedRequest(store, effective, c.req.method, c.req.path, projectId, c.req.raw);
}

async function requireHosted(c: Context): Promise<HostedRequestContext> {
  const hosted = c.get("hosted");
  if (!hosted) {
    throw new UnblockError("validation", "This endpoint is only available in hosted mode.");
  }
  return hosted;
}

async function requireConfigIdentity(c: Context): Promise<{ machine: string; actor: string }> {
  const config = await readUnblockConfig(c.get("configPath"));
  const machine = config.config.identity.machine.trim();
  const actor = config.config.identity.actor.trim();
  if (!machine || !actor) {
    throw new UnblockError("validation", "Machine and actor must be set in config before mutating.");
  }
  return { machine, actor };
}

function requireProjectId(c: Context): string {
  const projectId = c.req.query("projectId")?.trim();
  if (!projectId) {
    throw new UnblockError("validation", "projectId is required for this endpoint.");
  }
  return projectId;
}

function redactSecret(secret: HostedSecret) {
  return {
    tenantId: secret.tenantId,
    projectId: secret.projectId,
    id: secret.id,
    name: secret.name,
    purpose: secret.purpose,
    keyId: secret.keyId,
    algorithm: secret.algorithm,
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
    rotatedAt: secret.rotatedAt,
    archivedAt: secret.archivedAt,
    redacted: true
  };
}

declare module "hono" {
  interface ContextVariableMap {
    services: ReturnType<typeof createServices>;
    store: AppStore;
    configPath: string;
    hosted?: HostedRequestContext;
  }
}

async function openStore(
  options: ServerOptions,
  requestTenantId?: string | undefined,
  postgresRuntimes?: Map<string, SharedPostgresRuntime>,
): Promise<AppStore> {
  if (options.storeFactory) {
    return await options.storeFactory();
  }

  const backend = options.backend ?? process.env.UNBLOCK_BACKEND;
  if ((backend ?? "").trim().toLowerCase() === "prism") {
    return openLegacyPrismStore();
  }
  const explicitPostgresUrl = options.postgresUrl ?? process.env.UNBLOCK_POSTGRES_URL;
  if (
    explicitPostgresUrl &&
    ((backend ?? "").trim().toLowerCase() === "postgres" ||
      (backend ?? "").trim().toLowerCase() === "hosted")
  ) {
    return openPostgresStoreForUrl(
      explicitPostgresUrl,
      requestTenantId,
      postgresRuntimes,
    );
  }

  const config = await readUnblockConfig(options.configPath ?? process.env.UNBLOCK_CONFIG ?? defaultUnblockConfigPath());
  const storage = resolveUnblockStorageConfig(config.config, process.env, {
    mode: backend,
    sqlitePath: options.databasePath,
    postgresUrl: options.postgresUrl
  });
  if (storage.mode === "sqlite") {
    return createSqliteStore(defined({ databasePath: storage.sqlitePath, autoMigrate: true }));
  }
  return openPostgresStoreForUrl(
    storage.postgresUrl,
    requestTenantId,
    postgresRuntimes,
  );
}

async function openPostgresStoreForUrl(
  postgresUrl: string,
  requestTenantId?: string | undefined,
  postgresRuntimes?: Map<string, SharedPostgresRuntime>,
): Promise<AppStore> {
  const tenantId = requestTenantId ?? process.env.UNBLOCK_TENANT_ID;
  if (postgresRuntimes) {
    const runtime = sharedPostgresRuntime(postgresRuntimes, postgresUrl);
    await runtime.migrations;
    const key = tenantId ?? "__default__";
    let store = runtime.stores.get(key);
    if (!store) {
      store = createPostgresStore({
        pool: runtime.pool,
        tenantId,
        autoMigrate: false
      });
      runtime.stores.set(key, store);
    }
    return await store;
  }

  return await createPostgresStore({
    connectionString: postgresUrl,
    tenantId,
    autoMigrate: true
  });
}

function sharedPostgresRuntime(
  runtimes: Map<string, SharedPostgresRuntime>,
  connectionString: string,
): SharedPostgresRuntime {
  const existing = runtimes.get(connectionString);
  if (existing) return existing;
  const pool = createPostgresPool({
    connectionString,
    max: positiveIntegerEnv("UNBLOCK_POSTGRES_POOL_MAX")
  });
  const migrations = (async () => {
    const store = await createPostgresStore({ pool, autoMigrate: false });
    await runPostgresMigrations(store);
  })();
  const runtime = { pool, migrations, stores: new Map<string, Promise<AppStore>>() };
  runtimes.set(connectionString, runtime);
  return runtime;
}

function positiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function shouldObserveSuccessfulConnectorInboxEvent(
  event: ConnectorEvent,
  connectorObservationNextAt: Map<string, number>,
  now = Date.now()
): boolean {
  if (event.kind !== "connector.inbound.task_upserted") {
    return true;
  }
  const ttlMs = nonNegativeIntegerEnv("UNBLOCK_CONNECTOR_OBSERVATION_TTL_MS") ?? defaultConnectorObservationTtlMs;
  if (ttlMs === 0) {
    return true;
  }
  const key = [
    event.scope.tenantId,
    event.scope.projectId,
    event.scope.connectionId,
    event.scope.provider,
    event.kind
  ].join(":");
  const nextAt = connectorObservationNextAt.get(key) ?? 0;
  if (nextAt > now) {
    return false;
  }
  connectorObservationNextAt.set(key, now + ttlMs);
  return true;
}

function nonNegativeIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

async function hostedContextForRequest(c: Context, options: ServerOptions, id: string): Promise<HostedRequestContext | null> {
  if (!await isHostedMode(options)) return null;
  const config = options.hostedAuth ?? hostedRuntimeConfig();
  const identity = await resolveHostedIdentity(c.req.raw.headers, config);
  return { identity, requestId: id };
}

async function isHostedMode(options: ServerOptions): Promise<boolean> {
  const backend = (options.backend ?? process.env.UNBLOCK_BACKEND ?? process.env.UNBLOCK_STORAGE_MODE)?.trim().toLowerCase();
  if (backend === "hosted") return true;
  if (backend) return false;
  const config = await readUnblockConfig(options.configPath ?? process.env.UNBLOCK_CONFIG ?? defaultUnblockConfigPath());
  return resolveUnblockStorageConfig(config.config, process.env, {
    mode: options.backend,
    sqlitePath: options.databasePath,
    postgresUrl: options.postgresUrl
  }).mode === "hosted";
}

async function openLegacyPrismStore(): Promise<AppStore> {
  const moduleName = process.env.UNBLOCK_PRISM_STORE_MODULE ?? "@unblock/prism-app/store";
  try {
    const storeModule = await import(moduleName) as {
      createPrismStore?: (options: {
        endpoint?: string;
        projectId?: string;
        shardId?: string;
        actorId?: string;
      }) => AppStore | Promise<AppStore>;
    };
    if (!storeModule.createPrismStore) {
      throw new Error(`${moduleName} does not export createPrismStore`);
    }
    const prismOptions: {
      endpoint?: string;
      projectId?: string;
      shardId?: string;
      actorId?: string;
    } = {};
    if (process.env.UNBLOCK_PRISM_ENDPOINT) prismOptions.endpoint = process.env.UNBLOCK_PRISM_ENDPOINT;
    if (process.env.UNBLOCK_PRISM_PROJECT_ID) prismOptions.projectId = process.env.UNBLOCK_PRISM_PROJECT_ID;
    const prismShardId = process.env.UNBLOCK_PRISM_SHARD_ID ?? process.env.UNBLOCK_TENANT_ID;
    if (prismShardId) prismOptions.shardId = prismShardId;
    if (process.env.UNBLOCK_PRISM_ACTOR_ID) prismOptions.actorId = process.env.UNBLOCK_PRISM_ACTOR_ID;
    return await storeModule.createPrismStore(prismOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UnblockError(
      "validation",
      `UNBLOCK_BACKEND=prism requires a Prism AppStore module. Set UNBLOCK_PRISM_STORE_MODULE or pass ServerOptions.storeFactory. Cause: ${message}`
    );
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

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new UnblockError("validation", `Invalid integer: ${value}`);
  }
  return parsed;
}

function parseRequiredInteger(value: string | undefined, name: string): number {
  const parsed = parseOptionalInteger(value);
  if (parsed === undefined) {
    throw new UnblockError("validation", `${name} is required.`);
  }
  return parsed;
}

function connectorPublicIngressUrl(): string | null {
  return (
    process.env.PRISM_PUBLIC_INGRESS_URL ??
      process.env.UNBLOCK_CONNECTOR_INGRESS_URL ??
      process.env.UNBLOCK_PUBLIC_BASE_URL ??
      ""
  ).replace(/\/+$/, "") || null;
}

function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? process.env.UNBLOCK_API_PORT ?? 39217);
  serve({
    fetch: createApp({
      databasePath: process.env.UNBLOCK_DB,
      postgresUrl: process.env.UNBLOCK_POSTGRES_URL,
      configPath: process.env.UNBLOCK_CONFIG ?? defaultUnblockConfigPath()
    }).fetch,
    port
  });
  console.log(`unblock API listening on http://localhost:${port}`);
}
