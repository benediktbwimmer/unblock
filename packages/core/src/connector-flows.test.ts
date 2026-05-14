import { describe, expect, it } from "vitest";
import { connectorEvent, outboxEventForConnector } from "./connector-events.js";
import {
  applyConnectorInboxEvent,
  PrismFlowsExecutionClient,
  publishConnectorOutboxToPrismFlows,
  type PrismFlowClient,
  type PrismFlowStartInput
} from "./connector-flows.js";
import { createMemoryStore } from "./memory-store.js";
import { createServices } from "./services.js";
import type { InboxEventRepository, OutboxEventRepository } from "./store.js";
import type { InboxEvent, OutboxEvent } from "./types.js";
import { nowIso } from "./types.js";

describe("connector outbox publisher", () => {
  it("adapts connector outbox starts through the Prism Flows execution SDK", async () => {
    const starts: any[] = [];
    const client = new PrismFlowsExecutionClient({
      prismProjectId: "unblock-flows",
      client: {
        async startFlow(input) {
          starts.push(input);
          return { runId: "workflow:run", status: "running", created: true, evidence: { workflowKey: input.flowKey } };
        }
      }
    });

    const result = await client.startFlow({
      flowId: "github-issues-outbound",
      tenantId: "TENANT",
      projectId: "PROJECT",
      correlationId: "corr-1",
      idempotencyKey: "idem-1",
      payload: { event: {} } as any
    });

    expect(result).toMatchObject({ runId: "workflow:run", status: "started" });
    expect(starts[0]).toMatchObject({
      projectId: "unblock-flows",
      shardId: "tenant:TENANT:project:PROJECT",
      appId: "flows",
      flowId: "github-issues-outbound",
      workflowId: "github-issues-outbound",
      triggerId: "manual",
      flowKey: "idem-1",
      idempotencyKey: "idem-1",
      unblockProjectId: "PROJECT"
    });
  });

  it("publishes ready connector events to Prism Flows with idempotency evidence", async () => {
    const outbox = new FakeOutbox();
    const event = connectorEvent({
      kind: "connector.outbound.local_changed",
      scope: { tenantId: "TENANT", projectId: "PROJECT", connectionId: "mock-main", provider: "mock" },
      local: { kind: "task", id: "API" }
    });
    outbox.events.push(outboxEventForConnector(event));
    const starts: PrismFlowStartInput[] = [];
    const client: PrismFlowClient = {
      async startFlow(input) {
        starts.push(input);
        return { runId: "flow-run-1", status: "started", evidence: { queued: true } };
      }
    };

    const result = await publishConnectorOutboxToPrismFlows({ outbox } as any, client, { flowId: "unblock-connector-dispatch" });

    expect(result).toEqual({ scanned: 1, published: 1, failed: 0, dead: 0 });
    expect(starts[0]).toMatchObject({
      flowId: "unblock-connector-dispatch",
      tenantId: "TENANT",
      projectId: "PROJECT",
      correlationId: event.correlationId,
      idempotencyKey: event.idempotencyKey
    });
    expect(outbox.events[0]).toMatchObject({
      status: "processed",
      evidence: { flowRunId: "flow-run-1", queued: true }
    });
  });
});

describe("connector inbox applier", () => {
  it("applies Flow-produced task events exactly once", async () => {
    const store = createMemoryStore() as any;
    store.inbox = new FakeInbox();
    await createServices(store, { machine: "test", actor: "codex-e" }).projects.add({ id: "PROJECT", name: "Project" });
    const event = connectorEvent({
      kind: "connector.inbound.task_upserted",
      scope: { tenantId: "TENANT", projectId: "PROJECT", connectionId: "mock-main", provider: "mock" },
      external: { system: "mock", kind: "issue", id: "42", url: "https://example.com/issues/42" },
      task: { id: "MOCK-42", title: "Imported issue", description: "From mock" }
    });

    const first = await applyConnectorInboxEvent(store, event);
    const second = await applyConnectorInboxEvent(store, event);

    expect(first).toMatchObject({ applied: true, duplicate: false });
    expect(second).toMatchObject({ applied: false, duplicate: true });
    await expect(store.tasks.get("PROJECT", "MOCK-42")).resolves.toMatchObject({
      id: "MOCK-42",
      title: "Imported issue",
      sourceDoc: "https://example.com/issues/42",
      sourceSection: "mock:issue",
      sourceAnchor: "42"
    });
  });

  it("applies Flow-produced comments with connector provenance", async () => {
    const store = createMemoryStore() as any;
    store.inbox = new FakeInbox();
    const services = createServices(store, { projectId: "PROJECT", machine: "test", actor: "codex-e" });
    await createServices(store, { machine: "test", actor: "codex-e" }).projects.add({ id: "PROJECT", name: "Project" });
    await services.tasks.add({ id: "API", title: "API" });
    const event = connectorEvent({
      kind: "connector.inbound.comment_created",
      scope: { tenantId: "TENANT", projectId: "PROJECT", connectionId: "mock-main", provider: "mock" },
      local: { kind: "task", id: "API" },
      comment: { taskId: "API", body: "External comment", author: "Ada" }
    });

    const result = await applyConnectorInboxEvent(store, event);

    expect(result.evidence).toMatchObject({ action: "comment.created", taskId: "API" });
    expect(await services.comments.list("API")).toHaveLength(1);
  });
});

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

  async claim(id: string, claimedAt: string) {
    const event = await this.get(id);
    if (!event || (event.status !== "pending" && event.status !== "failed")) return null;
    Object.assign(event, { status: "claimed", claimedAt, attemptCount: event.attemptCount + 1 });
    return event;
  }

  async markProcessed(id: string, processedAt: string, evidence: Record<string, unknown> = {}) {
    const event = await this.get(id);
    if (!event) return null;
    Object.assign(event, { status: "processed", processedAt, evidence: { ...event.evidence, ...evidence } });
    return event;
  }

  async markFailed(id: string, error: Record<string, unknown>, availableAt: string, evidence: Record<string, unknown> = {}) {
    const event = await this.get(id);
    if (!event) return null;
    Object.assign(event, { status: "failed", error, availableAt, evidence: { ...event.evidence, ...evidence } });
    return event;
  }

  async markDead(id: string, error: Record<string, unknown>, evidence: Record<string, unknown> = {}) {
    const event = await this.get(id);
    if (!event) return null;
    Object.assign(event, { status: "dead", error, evidence: { ...event.evidence, ...evidence } });
    return event;
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
    if (!event || (event.status !== "received" && event.status !== "failed")) return null;
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
