import { describe, expect, it } from "vitest";
import { connectorEvent } from "./connector-events.js";
import {
  connectorObservabilitySnapshot,
  observeConnectorInboxEvent,
  requestConnectorReconciliation
} from "./connector-reconciliation.js";
import { createMemoryStore } from "./memory-store.js";
import type { ConnectorRepository, OutboxEventRepository } from "./store.js";
import type { ConnectorConnection, ConnectorCursorRecord, ConnectorSyncRun, OutboxEvent } from "./types.js";

describe("connector reconciliation", () => {
  it("creates connector state and queues reconciliation through the outbox", async () => {
    const store = createMemoryStore() as any;
    store.connectors = new FakeConnectors();
    store.outbox = new FakeOutbox();

    const request = await requestConnectorReconciliation(store, {
      tenantId: "TENANT",
      projectId: "PROJECT",
      connectionId: "github-main",
      provider: "github",
      displayName: "GitHub",
      reason: "operator"
    });

    expect(request.connection).toMatchObject({ id: "github-main", provider: "github", status: "active" });
    expect(request.run).toMatchObject({ runType: "reconciliation", status: "queued" });
    expect(request.event).toMatchObject({ kind: "connector.reconciliation.requested" });
    expect(store.outbox.events[0]).toMatchObject({
      eventType: "connector.reconciliation.requested",
      subjectId: "github-main"
    });
  });

  it("observes inbox events as sync runs and cursor lag", async () => {
    const store = createMemoryStore() as any;
    store.connectors = new FakeConnectors();
    const event = connectorEvent({
      kind: "connector.cursor.updated",
      scope: { tenantId: "TENANT", projectId: "PROJECT", connectionId: "github-main", provider: "github" },
      cursor: { name: "issues", value: "cursor-1", observedAt: "2026-05-14T10:00:00.000Z" },
      occurredAt: "2026-05-14T10:00:00.000Z"
    });

    const observed = await observeConnectorInboxEvent(store, event, { now: "2026-05-14T10:00:10.000Z" });
    const snapshot = await connectorObservabilitySnapshot(store, {
      projectId: "PROJECT",
      now: "2026-05-14T10:00:20.000Z"
    });

    expect(observed?.run).toMatchObject({ runType: "cursor_recovery", status: "succeeded" });
    expect(snapshot.connections).toHaveLength(1);
    expect(snapshot.connections[0]).toMatchObject({
      id: "github-main",
      lastSuccessAt: "2026-05-14T10:00:10.000Z",
      lagMs: 20_000
    });
  });
});

class FakeConnectors implements ConnectorRepository {
  connections: ConnectorConnection[] = [];
  cursors: ConnectorCursorRecord[] = [];
  runs: ConnectorSyncRun[] = [];

  async upsertConnection(connection: ConnectorConnection) {
    const index = this.connections.findIndex((item) => item.projectId === connection.projectId && item.id === connection.id);
    if (index >= 0) {
      this.connections[index] = connection;
    } else {
      this.connections.push(connection);
    }
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
    if (index >= 0) {
      this.cursors[index] = cursor;
    } else {
      this.cursors.push(cursor);
    }
  }

  async listCursors(projectId: string, connectionId: string) {
    return this.cursors.filter((cursor) => cursor.projectId === projectId && cursor.connectionId === connectionId);
  }

  async recordSyncRun(run: ConnectorSyncRun) {
    this.runs.push(run);
  }

  async updateSyncRun(run: ConnectorSyncRun) {
    const index = this.runs.findIndex((item) => item.projectId === run.projectId && item.connectionId === run.connectionId && item.id === run.id);
    if (index >= 0) {
      this.runs[index] = run;
    } else {
      this.runs.push(run);
    }
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
