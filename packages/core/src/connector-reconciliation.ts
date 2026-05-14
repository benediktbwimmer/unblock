import { randomUUID } from "node:crypto";
import { validation } from "./errors.js";
import {
  connectorEvent,
  connectorProviderSchema,
  outboxEventForConnector,
  type ConnectorEvent,
  type ConnectorProvider
} from "./connector-events.js";
import type { AppStore, ConnectorRepository, OutboxEventRepository } from "./store.js";
import {
  nowIso,
  type ConnectorConnection,
  type ConnectorConnectionStatus,
  type ConnectorObservabilitySnapshot,
  type ConnectorSyncRun,
  type ConnectorSyncRunStatus,
  type ConnectorSyncRunType,
  type OutboxEvent
} from "./types.js";

export interface ConnectorConnectionInput {
  projectId: string;
  connectionId: string;
  provider: ConnectorProvider;
  displayName?: string | undefined;
  status?: ConnectorConnectionStatus | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ConnectorReconciliationRequestInput extends ConnectorConnectionInput {
  tenantId: string;
  reason?: string | undefined;
  cursorName?: string | undefined;
  runId?: string | undefined;
  now?: string | undefined;
}

export interface ConnectorReconciliationRequest {
  connection: ConnectorConnection;
  run: ConnectorSyncRun;
  event: ConnectorEvent;
  outboxEvent: OutboxEvent;
}

export interface ConnectorInboxObservation {
  connection: ConnectorConnection;
  run: ConnectorSyncRun;
}

export async function upsertConnectorConnection(store: AppStore, input: ConnectorConnectionInput): Promise<ConnectorConnection> {
  const connectors = requireConnectors(store.connectors);
  const now = nowIso();
  const existing = await connectors.getConnection(input.projectId, input.connectionId);
  const connection: ConnectorConnection = {
    projectId: input.projectId,
    id: input.connectionId,
    provider: connectorProviderSchema.parse(input.provider),
    displayName: input.displayName ?? existing?.displayName ?? input.connectionId,
    status: input.status ?? existing?.status ?? "active",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    archivedAt: input.status === "archived" ? (existing?.archivedAt ?? now) : (existing?.archivedAt ?? null),
    lastSyncAt: existing?.lastSyncAt ?? null,
    lastErrorAt: existing?.lastErrorAt ?? null,
    metadata: { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) }
  };
  await connectors.upsertConnection(connection);
  return connection;
}

export async function requestConnectorReconciliation(
  store: AppStore,
  input: ConnectorReconciliationRequestInput
): Promise<ConnectorReconciliationRequest> {
  const connectors = requireConnectors(store.connectors);
  const outbox = requireOutbox(store.outbox);
  const now = input.now ?? nowIso();
  const connection = await upsertConnectorConnection(store, input);
  const run: ConnectorSyncRun = {
    projectId: input.projectId,
    id: input.runId ?? randomUUID(),
    connectionId: input.connectionId,
    runType: "reconciliation",
    status: "queued",
    startedAt: now,
    finishedAt: null,
    error: null,
    evidence: {
      reason: input.reason ?? "manual",
      cursorName: input.cursorName ?? null
    }
  };
  await connectors.recordSyncRun(run);
  const event = connectorEvent({
    kind: "connector.reconciliation.requested",
    scope: {
      tenantId: input.tenantId,
      projectId: input.projectId,
      connectionId: input.connectionId,
      provider: connectorProviderSchema.parse(input.provider)
    },
    evidence: {
      runId: run.id,
      reason: input.reason ?? "manual",
      cursorName: input.cursorName ?? null
    },
    occurredAt: now
  });
  const outboxEvent = await outbox.enqueue(outboxEventForConnector(event, {
    subjectType: "connector",
    subjectId: input.connectionId,
    availableAt: now
  }));
  return { connection, run, event, outboxEvent };
}

export async function observeConnectorInboxEvent(
  store: AppStore,
  event: ConnectorEvent,
  input: {
    status?: ConnectorSyncRunStatus | undefined;
    runType?: ConnectorSyncRunType | undefined;
    evidence?: Record<string, unknown> | undefined;
    error?: Record<string, unknown> | null | undefined;
    now?: string | undefined;
  } = {}
): Promise<ConnectorInboxObservation | null> {
  const connectors = store.connectors;
  if (!connectors) return null;
  const now = input.now ?? nowIso();
  const existing = await connectors.getConnection(event.scope.projectId, event.scope.connectionId);
  const failed = input.status === "failed" || input.status === "dead_letter" || input.status === "operator_review";
  const connection: ConnectorConnection = {
    projectId: event.scope.projectId,
    id: event.scope.connectionId,
    provider: event.scope.provider,
    displayName: existing?.displayName ?? event.scope.connectionId,
    status: failed ? "error" : (existing?.status ?? "active"),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    archivedAt: existing?.archivedAt ?? null,
    lastSyncAt: failed ? (existing?.lastSyncAt ?? null) : now,
    lastErrorAt: failed ? now : (existing?.lastErrorAt ?? null),
    metadata: existing?.metadata ?? {}
  };
  await connectors.upsertConnection(connection);
  if (event.cursor) {
    await connectors.upsertCursor({
      projectId: event.scope.projectId,
      connectionId: event.scope.connectionId,
      name: event.cursor.name,
      value: event.cursor.value,
      observedAt: event.cursor.observedAt,
      updatedAt: now
    });
  }
  const run: ConnectorSyncRun = {
    projectId: event.scope.projectId,
    id: event.flowRunId ?? event.id,
    connectionId: event.scope.connectionId,
    runType: input.runType ?? runTypeForEvent(event),
    status: input.status ?? statusForEvent(event),
    startedAt: event.occurredAt,
    finishedAt: now,
    error: input.error ?? (event.error ? { ...event.error } : null),
    evidence: {
      correlationId: event.correlationId,
      idempotencyKey: event.idempotencyKey,
      eventKind: event.kind,
      ...event.evidence,
      ...(input.evidence ?? {})
    }
  };
  await connectors.recordSyncRun(run);
  return { connection, run };
}

export async function connectorObservabilitySnapshot(
  store: AppStore,
  options: { projectId?: string | undefined; now?: string | undefined; recentRunLimit?: number | undefined } = {}
): Promise<ConnectorObservabilitySnapshot> {
  const connectors = requireConnectors(store.connectors);
  const generatedAt = options.now ?? nowIso();
  const connections = await connectors.listConnections(options.projectId);
  const enriched = await Promise.all(connections.map(async (connection) => {
    const [cursors, recentRuns] = await Promise.all([
      connectors.listCursors(connection.projectId, connection.id),
      connectors.listSyncRuns({ projectId: connection.projectId, connectionId: connection.id, limit: options.recentRunLimit ?? 20 })
    ]);
    const lastSuccessAt = recentRuns
      .filter((run) => run.status === "succeeded" && run.finishedAt)
      .map((run) => run.finishedAt as string)
      .sort()
      .at(-1) ?? null;
    const newestCursor = cursors
      .map((cursor) => cursor.observedAt)
      .sort()
      .at(-1) ?? null;
    return {
      ...connection,
      cursors,
      recentRuns,
      retryCount: recentRuns.filter((run) => run.status === "failed").length,
      deadLetterCount: recentRuns.filter((run) => run.status === "dead_letter").length,
      lastSuccessAt,
      lagMs: newestCursor ? Math.max(0, Date.parse(generatedAt) - Date.parse(newestCursor)) : null
    };
  }));
  return {
    projectId: options.projectId ?? null,
    generatedAt,
    connections: enriched
  };
}

function requireConnectors(connectors: ConnectorRepository | undefined): ConnectorRepository {
  if (!connectors) validation("Connector orchestration requires a store with connector support.");
  return connectors;
}

function requireOutbox(outbox: OutboxEventRepository | undefined): OutboxEventRepository {
  if (!outbox) validation("Connector reconciliation requires a store with outbox support.");
  return outbox;
}

function runTypeForEvent(event: ConnectorEvent): ConnectorSyncRunType {
  if (event.kind.startsWith("connector.reconciliation.")) return "reconciliation";
  if (event.kind.startsWith("connector.cursor.")) return "cursor_recovery";
  if (event.kind.startsWith("connector.outbound.")) return "outbound";
  return "inbound";
}

function statusForEvent(event: ConnectorEvent): ConnectorSyncRunStatus {
  if (event.kind === "connector.dead_letter.created") return "dead_letter";
  if (event.kind === "connector.operator_review.requested") return "operator_review";
  return event.error ? "failed" : "succeeded";
}
