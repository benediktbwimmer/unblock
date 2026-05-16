import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  connectorEvent,
  buildConnectorSyncQueueItem,
  connectorSyncPolicyPreset,
  createMemoryStore,
  createServices,
  type AppStore,
  type ConnectorConnection,
  type ConnectorCursorRecord,
  type ConnectorExternalMapping,
  type ConnectorRepository,
  type ConnectorSyncPolicyRecord,
  type ConnectorSyncQueueItem,
  type ConnectorSyncRun,
  type HostedSecret,
  type HostedSecretRepository,
  type InboxEvent,
  type InboxEventRepository,
  type OutboxEvent,
  type OutboxEventRepository
} from "@unblock/core";
import { createApp } from "./index.js";

const hostedAuth = {
  authMode: "trusted-headers" as const,
  workosClientId: "",
  workosIssuer: "https://api.workos.com",
  workosJwksUrl: "",
  rateLimitWindowMs: 60_000,
  rateLimitMax: 100
};

describe("hosted authorization", () => {
  it("allows project reads for viewers and denies writes without write permission", async () => {
    const store = await seededStore();
    const app = createApp({ backend: "hosted", storeFactory: () => store, hostedAuth });

    const read = await app.request("/api/tasks?projectId=HOSTED", { headers: hostedHeaders("viewer") });
    expect(read.status).toBe(200);

    const write = await app.request("/api/tasks?projectId=HOSTED", {
      method: "POST",
      headers: { ...hostedHeaders("viewer"), "content-type": "application/json" },
      body: JSON.stringify({ id: "DENIED", title: "Denied" })
    });
    expect(write.status).toBe(400);
    await expect(write.json()).resolves.toMatchObject({
      error: { code: "validation" }
    });
  });

  it("uses project membership roles as effective permissions", async () => {
    const store = await seededStore();
    installProjectRole(store, "member");
    const app = createApp({ backend: "hosted", storeFactory: () => store, hostedAuth });

    const write = await app.request("/api/tasks?projectId=HOSTED", {
      method: "POST",
      headers: { ...hostedHeaders("viewer"), "content-type": "application/json" },
      body: JSON.stringify({ id: "ALLOWED", title: "Allowed" })
    });

    expect(write.status).toBe(201);
    await expect(write.json()).resolves.toMatchObject({ id: "ALLOWED" });
  });

  it("exposes hosted admin identity and exportable audit events", async () => {
    const store = await seededStore();
    const auditEvents: unknown[] = [];
    store.hostedAudit = {
      async append(event) {
        auditEvents.push(event);
      },
      async list() {
        return auditEvents as never[];
      }
    };
    const app = createApp({ backend: "hosted", storeFactory: () => store, hostedAuth });

    const me = await app.request("/api/admin/me", { headers: hostedHeaders("admin") });
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({
      tenantId: "ORG_HOSTED",
      principalId: "user_123",
      roles: ["admin"]
    });

    const audit = await app.request("/api/audit", { headers: hostedHeaders("security_admin") });
    expect(audit.status).toBe(200);
    const body = await audit.json() as unknown[];
    expect(body.some((event: any) => event.eventType === "hosted.request.allowed")).toBe(true);
  });

  it("stores hosted connector secrets without returning plaintext", async () => {
    const previousKey = process.env.UNBLOCK_HOSTED_SECRET_KEY;
    process.env.UNBLOCK_HOSTED_SECRET_KEY = randomBytes(32).toString("hex");
    const store = await seededStore();
    const secrets: HostedSecret[] = [];
    store.hostedSecrets = {
      async create(secret) {
        secrets.push(secret);
      },
      async get(id) {
        return secrets.find((secret) => secret.id === id) ?? null;
      },
      async list() {
        return secrets;
      },
      async findByName(projectId, name) {
        return secrets.find((secret) => secret.projectId === projectId && secret.name === name && !secret.archivedAt) ?? null;
      },
      async update(secret) {
        const index = secrets.findIndex((item) => item.id === secret.id);
        secrets[index] = secret;
      },
      async archive(id, archivedAt) {
        const secret = secrets.find((item) => item.id === id);
        if (secret) secret.archivedAt = archivedAt;
      }
    };
    const app = createApp({ backend: "hosted", storeFactory: () => store, hostedAuth });

    try {
      const created = await app.request("/api/secrets?projectId=HOSTED", {
        method: "POST",
        headers: { ...hostedHeaders("security_admin"), "content-type": "application/json" },
        body: JSON.stringify({ name: "github-token", purpose: "github.connector", plaintext: "ghs_secret" })
      });
      expect(created.status).toBe(201);
      const body = await created.json() as any;
      expect(body.redacted).toBe(true);
      expect(JSON.stringify(body)).not.toContain("ghs_secret");
      expect(secrets[0]?.ciphertext).not.toContain("ghs_secret");

      const listed = await app.request("/api/secrets?projectId=HOSTED", { headers: hostedHeaders("security_admin") });
      expect(listed.status).toBe(200);
      expect(JSON.stringify(await listed.json())).not.toContain("ghs_secret");
    } finally {
      if (previousKey === undefined) {
        delete process.env.UNBLOCK_HOSTED_SECRET_KEY;
      } else {
        process.env.UNBLOCK_HOSTED_SECRET_KEY = previousKey;
      }
    }
  });

  it("queues hosted connector reconciliation and exposes connector status", async () => {
    const store = await seededStore();
    installConnectorState(store);
    const app = createApp({ backend: "hosted", storeFactory: () => store, hostedAuth });

    const queued = await app.request("/api/connectors/reconcile", {
      method: "POST",
      headers: { ...hostedHeaders("connector_admin"), "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "HOSTED",
        connectionId: "github-main",
        provider: "github",
        displayName: "GitHub",
        reason: "test"
      })
    });

    expect(queued.status).toBe(202);
    await expect(queued.json()).resolves.toMatchObject({
      connection: { id: "github-main", provider: "github" },
      run: { runType: "reconciliation", status: "queued" }
    });

    const status = await app.request("/api/connectors/status?projectId=HOSTED", {
      headers: hostedHeaders("connector_admin")
    });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      projectId: "HOSTED",
      connections: [{ id: "github-main", recentRuns: [{ status: "queued" }] }]
    });
  });

  it("registers GitHub App installation connections with secret references", async () => {
    const store = await seededStore();
    installConnectorState(store);
    installSecretState(store, [
      fakeSecret("github-private-key", "github.private_key"),
      fakeSecret("github-webhook-secret", "github.webhook_secret")
    ]);
    const app = createApp({ backend: "hosted", storeFactory: () => store, hostedAuth });

    const model = await app.request("/api/connectors/github/auth-model", {
      headers: hostedHeaders("connector_admin")
    });
    expect(model.status).toBe(200);
    await expect(model.json()).resolves.toMatchObject({
      mode: "github_app_installation",
      repositoryPermissions: { metadata: "read", issues: "write" }
    });

    const created = await app.request("/api/connectors/github/connections", {
      method: "POST",
      headers: { ...hostedHeaders("connector_admin"), "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "HOSTED",
        connectionId: "github-main",
        appId: "123",
        installationId: "456",
        repositoryOwner: "acme",
        repositoryName: "repo",
        privateKeySecretId: "github-private-key",
        webhookSecretId: "github-webhook-secret"
      })
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      provider: "github",
      metadata: {
        authModel: "github_app_installation",
        repositoryOwner: "acme",
        repositoryName: "repo",
        conflictPolicy: "operator_review"
      }
    });

    const listed = await app.request("/api/connectors/github/connections?projectId=HOSTED", {
      headers: hostedHeaders("connector_admin")
    });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject([{ id: "github-main", provider: "github" }]);

    const paused = await app.request("/api/connectors/github/connections/github-main/pause?projectId=HOSTED", {
      method: "POST",
      headers: hostedHeaders("connector_admin")
    });
    expect(paused.status).toBe(200);
    await expect(paused.json()).resolves.toMatchObject({ id: "github-main", status: "paused" });

    const resumed = await app.request("/api/connectors/github/connections/github-main/resume?projectId=HOSTED", {
      method: "POST",
      headers: hostedHeaders("connector_admin")
    });
    expect(resumed.status).toBe(200);
    await expect(resumed.json()).resolves.toMatchObject({ id: "github-main", status: "active" });

    const deleted = await app.request("/api/connectors/github/connections/github-main?projectId=HOSTED", {
      method: "DELETE",
      headers: hostedHeaders("connector_admin")
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({ id: "github-main", status: "archived" });
  });

  it("stores GitHub issue mapping records for connector reconciliation", async () => {
    const store = await seededStore();
    installConnectorState(store);
    const app = createApp({ backend: "hosted", storeFactory: () => store, hostedAuth });

    const created = await app.request("/api/connectors/github/mappings", {
      method: "POST",
      headers: { ...hostedHeaders("connector_admin"), "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "HOSTED",
        connectionId: "github-main",
        repositoryOwner: "acme",
        repositoryName: "repo",
        issueNumber: 42,
        issueUrl: "https://github.com/acme/repo/issues/42",
        taskId: "GH-42",
        externalVersion: "etag-1",
        localVersion: "1"
      })
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      externalId: "acme/repo#42",
      localId: "GH-42",
      syncDirection: "bidirectional",
      conflictPolicy: "operator_review"
    });

    const listed = await app.request("/api/connectors/github/mappings?projectId=HOSTED&connectionId=github-main", {
      headers: hostedHeaders("connector_admin")
    });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject([{ externalId: "acme/repo#42", localId: "GH-42" }]);
  });

  it("exposes connector sync policies and queue items", async () => {
    const store = await seededStore();
    installConnectorState(store);
    const app = createApp({ backend: "hosted", storeFactory: () => store, hostedAuth });
    const policy = connectorSyncPolicyPreset("github", "execution_layer");

    const created = await app.request("/api/connectors/sync-policies", {
      method: "POST",
      headers: { ...hostedHeaders("connector_admin"), "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "HOSTED",
        id: "github-default",
        connectionId: "github-main",
        name: "GitHub default",
        policy
      })
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      id: "github-default",
      policy: { preset: "execution_layer" }
    });

    const queueItem = buildConnectorSyncQueueItem({
      policy,
      mapping: {
        projectId: "HOSTED",
        connectionId: "github-main",
        provider: "github",
        externalKind: "issue",
        externalId: "acme/repo#42",
        externalUrl: "https://github.com/acme/repo/issues/42",
        externalVersion: "etag-1",
        localKind: "task",
        localId: "GH-42",
        localVersion: "1",
        syncDirection: "bidirectional",
        conflictPolicy: "operator_review",
        status: "active",
        createdAt: "2026-05-16T00:00:00.000Z",
        updatedAt: "2026-05-16T00:00:00.000Z",
        archivedAt: null,
        metadata: {}
      },
      diff: { field: "title", externalValue: "External", localValue: "Local" }
    });
    await store.connectors?.upsertSyncQueueItem?.(queueItem);

    const listed = await app.request("/api/connectors/sync-queue?projectId=HOSTED&connectionId=github-main", {
      headers: hostedHeaders("connector_admin")
    });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject([
      { id: queueItem.id, status: "pending", decision: { kind: "apply_inbound" } }
    ]);

    const resolved = await app.request(`/api/connectors/sync-queue/${queueItem.id}/status?projectId=HOSTED`, {
      method: "POST",
      headers: { ...hostedHeaders("connector_admin"), "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved", resolvedAt: "2026-05-16T00:00:01.000Z" })
    });
    expect(resolved.status).toBe(200);
    await expect(resolved.json()).resolves.toMatchObject({
      id: queueItem.id,
      status: "resolved",
      resolvedAt: "2026-05-16T00:00:01.000Z"
    });
  });

  it("accepts bulk GitHub mapping and connector inbox reconciliation writes", async () => {
    const store = await seededStore();
    installConnectorState(store);
    const app = createApp({ backend: "hosted", storeFactory: () => store, hostedAuth });

    const mappings = await app.request("/api/connectors/github/mappings/batch", {
      method: "POST",
      headers: { ...hostedHeaders("connector_admin"), "content-type": "application/json" },
      body: JSON.stringify([{
        projectId: "HOSTED",
        connectionId: "github-main",
        repositoryOwner: "acme",
        repositoryName: "repo",
        issueNumber: 43,
        issueUrl: "https://github.com/acme/repo/issues/43",
        taskId: "GH-43",
        externalVersion: "etag-43",
        localVersion: "1"
      }])
    });
    expect(mappings.status).toBe(201);
    await expect(mappings.json()).resolves.toMatchObject({ count: 1, results: [{ localId: "GH-43" }] });

    const event = connectorEvent({
      kind: "connector.inbound.task_upserted",
      scope: { tenantId: "ORG_HOSTED", projectId: "HOSTED", connectionId: "github-main", provider: "github" },
      external: { system: "github", kind: "issue", id: "43", url: "https://github.com/acme/repo/issues/43" },
      task: { id: "GH-43", title: "Bulk imported issue", description: "", lifecycle: "open", priority: 2 },
      evidence: {}
    });
    const inbox = await app.request("/api/connectors/inbox/batch", {
      method: "POST",
      headers: { ...hostedHeaders("connector_admin"), "content-type": "application/json" },
      body: JSON.stringify([event, event])
    });
    expect(inbox.status).toBe(200);
    await expect(inbox.json()).resolves.toMatchObject({ count: 2, applied: 1, duplicate: 1 });
    await expect(store.tasks.get("HOSTED", "GH-43")).resolves.toMatchObject({ title: "Bulk imported issue" });
  });

  it("applies hosted connector inbox events and records observability", async () => {
    const store = await seededStore();
    installConnectorState(store);
    const auditEvents: unknown[] = [];
    store.hostedAudit = {
      async append(event) {
        auditEvents.push(event);
      },
      async list() {
        return auditEvents as never[];
      }
    };
    const app = createApp({ backend: "hosted", storeFactory: () => store, hostedAuth });
    const event = connectorEvent({
      kind: "connector.inbound.task_upserted",
      scope: { tenantId: "ORG_HOSTED", projectId: "HOSTED", connectionId: "github-main", provider: "github" },
      external: { system: "github", kind: "issue", id: "42", url: "https://github.com/acme/repo/issues/42" },
      task: { id: "GH-42", title: "Imported GitHub issue", description: "From GitHub", lifecycle: "open", priority: 2 },
      evidence: {}
    });

    const applied = await app.request("/api/connectors/inbox", {
      method: "POST",
      headers: { ...hostedHeaders("connector_admin"), "content-type": "application/json" },
      body: JSON.stringify(event)
    });

    expect(applied.status).toBe(200);
    await expect(applied.json()).resolves.toMatchObject({ applied: true, duplicate: false });
    expect(auditEvents).toHaveLength(0);
    await expect(store.tasks.get("HOSTED", "GH-42")).resolves.toMatchObject({
      title: "Imported GitHub issue",
      sourceDoc: "https://github.com/acme/repo/issues/42"
    });
    const status = await app.request("/api/connectors/status?projectId=HOSTED", {
      headers: hostedHeaders("connector_admin")
    });
    await expect(status.json()).resolves.toMatchObject({
      connections: [{ id: "github-main", recentRuns: [{ status: "succeeded" }] }]
    });
  });

  it("throttles burst task-upsert connector success observations", async () => {
    const store = await seededStore();
    installConnectorState(store);
    const app = createApp({ backend: "hosted", storeFactory: () => store, hostedAuth });

    for (const issueNumber of [100, 101]) {
      const event = connectorEvent({
        kind: "connector.inbound.task_upserted",
        scope: { tenantId: "ORG_HOSTED", projectId: "HOSTED", connectionId: "github-main", provider: "github" },
        external: {
          system: "github",
          kind: "issue",
          id: String(issueNumber),
          url: `https://github.com/acme/repo/issues/${issueNumber}`
        },
        task: {
          id: `GH-${issueNumber}`,
          title: `Imported GitHub issue ${issueNumber}`,
          description: "",
          lifecycle: "open",
          priority: 2
        },
        evidence: {}
      });

      const applied = await app.request("/api/connectors/inbox", {
        method: "POST",
        headers: { ...hostedHeaders("connector_admin"), "content-type": "application/json" },
        body: JSON.stringify(event)
      });
      expect(applied.status).toBe(200);
      await expect(applied.json()).resolves.toMatchObject({ applied: true, duplicate: false });
    }

    await expect(store.tasks.get("HOSTED", "GH-100")).resolves.toMatchObject({ title: "Imported GitHub issue 100" });
    await expect(store.tasks.get("HOSTED", "GH-101")).resolves.toMatchObject({ title: "Imported GitHub issue 101" });
    expect((store.connectors as FakeConnectors).runs).toHaveLength(1);
  });

  it("returns hosted operational headers and tenant metrics", async () => {
    const store = await seededStore();
    const app = createApp({ backend: "hosted", storeFactory: () => store, hostedAuth });

    const metrics = await app.request("/api/hosted/metrics?projectId=HOSTED", {
      headers: { ...hostedHeaders("admin"), "x-request-id": "req_test_123" }
    });

    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("x-request-id")).toBe("req_test_123");
    expect(metrics.headers.get("x-ratelimit-remaining")).not.toBeNull();
    await expect(metrics.json()).resolves.toMatchObject({
      tenantId: "ORG_HOSTED",
      projectCount: 1,
      taskCount: 0
    });
  });

  it("reports redacted hosted deployment configuration status", async () => {
    const previous = {
      backend: process.env.UNBLOCK_BACKEND,
      postgres: process.env.UNBLOCK_POSTGRES_URL,
      key: process.env.UNBLOCK_HOSTED_SECRET_KEY,
      authMode: process.env.UNBLOCK_HOSTED_AUTH_MODE,
      structuredLogs: process.env.UNBLOCK_STRUCTURED_LOGS
    };
    process.env.UNBLOCK_BACKEND = "hosted";
    process.env.UNBLOCK_POSTGRES_URL = "postgres://example";
    process.env.UNBLOCK_HOSTED_SECRET_KEY = randomBytes(32).toString("hex");
    process.env.UNBLOCK_HOSTED_AUTH_MODE = "trusted-headers";
    process.env.UNBLOCK_STRUCTURED_LOGS = "false";
    const store = await seededStore();
    const app = createApp({ backend: "hosted", storeFactory: () => store, hostedAuth });

    try {
      const config = await app.request("/api/hosted/config", { headers: hostedHeaders("admin") });
      expect(config.status).toBe(200);
      const body = await config.json() as any;
      expect(body.ready).toBe(true);
      expect(JSON.stringify(body)).not.toContain(process.env.UNBLOCK_HOSTED_SECRET_KEY);
    } finally {
      restoreEnv("UNBLOCK_BACKEND", previous.backend);
      restoreEnv("UNBLOCK_POSTGRES_URL", previous.postgres);
      restoreEnv("UNBLOCK_HOSTED_SECRET_KEY", previous.key);
      restoreEnv("UNBLOCK_HOSTED_AUTH_MODE", previous.authMode);
      restoreEnv("UNBLOCK_STRUCTURED_LOGS", previous.structuredLogs);
    }
  });
});

async function seededStore(): Promise<AppStore> {
  const store = createMemoryStore();
  const services = createServices(store, { machine: "test", actor: "codex-e" });
  await services.projects.add({ id: "HOSTED", name: "Hosted" });
  return store;
}

function installProjectRole(store: AppStore, role: string): void {
  store.hostedIdentity = {
    async sync() {},
    async tenantRole() {
      return "viewer";
    },
    async projectRole() {
      return role;
    }
  };
}

function installConnectorState(store: AppStore): void {
  (store as any).connectors = new FakeConnectors();
  (store as any).outbox = new FakeOutbox();
  (store as any).inbox = new FakeInbox();
}

function installSecretState(store: AppStore, secrets: HostedSecret[]): void {
  (store as any).hostedSecrets = new FakeSecrets(secrets);
}

function fakeSecret(id: string, purpose: string): HostedSecret {
  return {
    tenantId: "ORG_HOSTED",
    projectId: "HOSTED",
    id,
    name: id,
    purpose,
    ciphertext: "redacted",
    keyId: "test",
    algorithm: "aes-256-gcm",
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
    rotatedAt: null,
    archivedAt: null
  };
}

function hostedHeaders(role: string): Record<string, string> {
  return {
    "x-unblock-principal-id": "user_123",
    "x-unblock-workos-organization-id": "org_hosted",
    "x-unblock-roles": role
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

class FakeConnectors implements ConnectorRepository {
  connections: ConnectorConnection[] = [];
  cursors: ConnectorCursorRecord[] = [];
  runs: ConnectorSyncRun[] = [];
  mappings: ConnectorExternalMapping[] = [];
  policies: ConnectorSyncPolicyRecord[] = [];
  queueItems: ConnectorSyncQueueItem[] = [];

  async upsertConnection(connection: ConnectorConnection) {
    const index = this.connections.findIndex((item) => item.projectId === connection.projectId && item.id === connection.id);
    if (index >= 0) this.connections[index] = connection;
    else this.connections.push(connection);
  }

  async getConnection(projectId: string, id: string) {
    return this.connections.find((connection) => connection.projectId === projectId && connection.id === id) ?? null;
  }

  async listConnections(projectId?: string) {
    return this.connections.filter((connection) => !projectId || connection.projectId === projectId);
  }

  async upsertCursor(cursor: ConnectorCursorRecord) {
    const index = this.cursors.findIndex((item) =>
      item.projectId === cursor.projectId && item.connectionId === cursor.connectionId && item.name === cursor.name
    );
    if (index >= 0) this.cursors[index] = cursor;
    else this.cursors.push(cursor);
  }

  async listCursors(projectId: string, connectionId: string) {
    return this.cursors.filter((cursor) => cursor.projectId === projectId && cursor.connectionId === connectionId);
  }

  async recordSyncRun(run: ConnectorSyncRun) {
    this.runs.unshift(run);
  }

  async updateSyncRun(run: ConnectorSyncRun) {
    const index = this.runs.findIndex((item) => item.projectId === run.projectId && item.connectionId === run.connectionId && item.id === run.id);
    if (index >= 0) this.runs[index] = run;
    else this.runs.unshift(run);
  }

  async listSyncRuns(options: { projectId?: string | undefined; connectionId?: string | undefined; limit?: number | undefined }) {
    return this.runs
      .filter((run) => !options.projectId || run.projectId === options.projectId)
      .filter((run) => !options.connectionId || run.connectionId === options.connectionId)
      .slice(0, options.limit ?? 100);
  }

  async upsertMapping(mapping: ConnectorExternalMapping) {
    const index = this.mappings.findIndex((item) =>
      item.projectId === mapping.projectId
        && item.connectionId === mapping.connectionId
        && item.externalKind === mapping.externalKind
        && item.externalId === mapping.externalId
    );
    if (index >= 0) this.mappings[index] = mapping;
    else this.mappings.push(mapping);
  }

  async getMappingByExternal(projectId: string, connectionId: string, externalKind: string, externalId: string) {
    return this.mappings.find((mapping) =>
      mapping.projectId === projectId
        && mapping.connectionId === connectionId
        && mapping.externalKind === externalKind
        && mapping.externalId === externalId
    ) ?? null;
  }

  async getMappingByLocal(projectId: string, connectionId: string, localKind: string, localId: string) {
    return this.mappings.find((mapping) =>
      mapping.projectId === projectId
        && mapping.connectionId === connectionId
        && mapping.localKind === localKind
        && mapping.localId === localId
        && !mapping.archivedAt
    ) ?? null;
  }

  async listMappings(options: { projectId?: string | undefined; connectionId?: string | undefined; provider?: string | undefined; limit?: number | undefined }) {
    return this.mappings
      .filter((mapping) => !options.projectId || mapping.projectId === options.projectId)
      .filter((mapping) => !options.connectionId || mapping.connectionId === options.connectionId)
      .filter((mapping) => !options.provider || mapping.provider === options.provider)
      .slice(0, options.limit ?? 100);
  }

  async upsertSyncPolicy(policy: ConnectorSyncPolicyRecord) {
    const index = this.policies.findIndex((item) => item.projectId === policy.projectId && item.id === policy.id);
    if (index >= 0) this.policies[index] = policy;
    else this.policies.push(policy);
  }

  async getSyncPolicy(projectId: string, connectionId: string, id: string) {
    return this.policies.find((policy) => policy.projectId === projectId && policy.connectionId === connectionId && policy.id === id) ?? null;
  }

  async listSyncPolicies(options: { projectId?: string | undefined; connectionId?: string | undefined; includeArchived?: boolean | undefined; limit?: number | undefined }) {
    return this.policies
      .filter((policy) => !options.projectId || policy.projectId === options.projectId)
      .filter((policy) => !options.connectionId || policy.connectionId === options.connectionId)
      .filter((policy) => options.includeArchived || !policy.archivedAt)
      .slice(0, options.limit ?? 100);
  }

  async upsertSyncQueueItem(item: ConnectorSyncQueueItem) {
    const index = this.queueItems.findIndex((candidate) => candidate.projectId === item.projectId && candidate.id === item.id);
    if (index >= 0) this.queueItems[index] = item;
    else this.queueItems.push(item);
  }

  async getSyncQueueItem(projectId: string, id: string) {
    return this.queueItems.find((item) => item.projectId === projectId && item.id === id) ?? null;
  }

  async listSyncQueueItems(options: { projectId?: string | undefined; connectionId?: string | undefined; status?: ConnectorSyncQueueItem["status"] | undefined; limit?: number | undefined }) {
    return this.queueItems
      .filter((item) => !options.projectId || item.projectId === options.projectId)
      .filter((item) => !options.connectionId || item.connectionId === options.connectionId)
      .filter((item) => !options.status || item.status === options.status)
      .slice(0, options.limit ?? 100);
  }

  async updateSyncQueueItemStatus(
    projectId: string,
    id: string,
    status: ConnectorSyncQueueItem["status"],
    options: { resolvedAt?: string | null | undefined; error?: Record<string, unknown> | null | undefined } = {}
  ) {
    const item = this.queueItems.find((candidate) => candidate.projectId === projectId && candidate.id === id);
    if (!item) return null;
    item.status = status;
    item.resolvedAt = options.resolvedAt ?? null;
    item.error = options.error ?? null;
    return item;
  }
}

class FakeSecrets implements HostedSecretRepository {
  constructor(private readonly secrets: HostedSecret[]) {}

  async create(secret: HostedSecret) {
    this.secrets.push(secret);
  }

  async get(id: string) {
    return this.secrets.find((secret) => secret.id === id) ?? null;
  }

  async list(projectId?: string | null | undefined) {
    return this.secrets.filter((secret) => projectId === undefined || secret.projectId === projectId);
  }

  async findByName(projectId: string | null, name: string) {
    return this.secrets.find((secret) => secret.projectId === projectId && secret.name === name && !secret.archivedAt) ?? null;
  }

  async update(secret: HostedSecret) {
    const index = this.secrets.findIndex((item) => item.id === secret.id);
    this.secrets[index] = secret;
  }

  async archive(id: string, archivedAt: string) {
    const secret = this.secrets.find((item) => item.id === id);
    if (secret) secret.archivedAt = archivedAt;
  }
}

class FakeOutbox implements OutboxEventRepository {
  events: OutboxEvent[] = [];

  async enqueue(event: OutboxEvent) {
    this.events.push(event);
    return event;
  }

  async get(id: string) {
    return this.events.find((event) => event.id === id) ?? null;
  }

  async findByIdempotencyKey(idempotencyKey: string) {
    return this.events.find((event) => event.idempotencyKey === idempotencyKey) ?? null;
  }

  async listReady() {
    return this.events.filter((event) => event.status === "pending" || event.status === "failed");
  }

  async claim() {
    return null;
  }

  async markProcessed() {
    return null;
  }

  async markFailed() {
    return null;
  }

  async markDead() {
    return null;
  }
}

class FakeInbox implements InboxEventRepository {
  events: InboxEvent[] = [];

  async receive(event: InboxEvent) {
    const existing = await this.findBySource(event.source, event.externalEventId);
    if (existing) return { event: existing, created: false };
    this.events.push(event);
    return { event, created: true };
  }

  async get(id: string) {
    return this.events.find((event) => event.id === id) ?? null;
  }

  async findBySource(source: string, externalEventId: string) {
    return this.events.find((event) => event.source === source && event.externalEventId === externalEventId) ?? null;
  }

  async markApplying(id: string) {
    const event = await this.get(id);
    if (!event) return null;
    Object.assign(event, { status: "applying" });
    return event;
  }

  async markApplied(id: string, appliedAt: string, evidence: Record<string, unknown> = {}) {
    const event = await this.get(id);
    if (!event) return null;
    Object.assign(event, { status: "applied", appliedAt, evidence: { ...event.evidence, ...evidence } });
    return event;
  }

  async markFailed(id: string, error: Record<string, unknown>, evidence: Record<string, unknown> = {}) {
    const event = await this.get(id);
    if (!event) return null;
    Object.assign(event, { status: "failed", error, evidence: { ...event.evidence, ...evidence } });
    return event;
  }

  async markDead(id: string, error: Record<string, unknown>, evidence: Record<string, unknown> = {}) {
    const event = await this.get(id);
    if (!event) return null;
    Object.assign(event, { status: "dead", error, evidence: { ...event.evidence, ...evidence } });
    return event;
  }
}
