import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  connectorEvent,
  createMemoryStore,
  createServices,
  type AppStore,
  type ConnectorConnection,
  type ConnectorCursorRecord,
  type ConnectorRepository,
  type ConnectorSyncRun,
  type HostedSecret,
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

  it("applies hosted connector inbox events and records observability", async () => {
    const store = await seededStore();
    installConnectorState(store);
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
