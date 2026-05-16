import { randomUUID } from "node:crypto";
import { UnblockError, validation } from "./errors.js";
import { createServices } from "./services.js";
import type {
  AppStore,
  InboxEventRepository,
  OutboxEventRepository,
} from "./store.js";
import {
  addTaskSchema,
  type Activity,
  type ConnectorExternalMapping,
  type EditTaskInput,
  type InboxEvent,
  nowIso,
  normalizeId,
  type OutboxEvent,
  type Task,
} from "./types.js";
import {
  githubIssueExternalId,
  githubIssueMappingInputSchema,
  upsertGitHubIssueMapping,
} from "./github-connector.js";
import {
  type ConnectorEvent,
  connectorEventSchema,
  type ConnectorFlowTrigger,
  connectorTriggerFromOutbox,
  inboxEventForConnector,
} from "./connector-events.js";

export interface PrismFlowStartInput {
  flowId: string;
  tenantId: string;
  projectId: string;
  correlationId: string;
  idempotencyKey: string;
  payload: ConnectorFlowTrigger;
  prismProjectId?: string | undefined;
  shardId?: string | undefined;
  appId?: string | undefined;
  workflowId?: string | undefined;
  triggerId?: string | undefined;
}

export interface PrismFlowStartResult {
  runId: string;
  status: "started" | "deduplicated" | "queued";
  url?: string | undefined;
  evidence?: Record<string, unknown> | undefined;
}

export interface PrismFlowClient {
  startFlow(input: PrismFlowStartInput): Promise<PrismFlowStartResult>;
}

export interface PrismFlowsExecutionSdkClient {
  startFlow(input: {
    projectId: string;
    shardId?: string | undefined;
    appId?: string | undefined;
    flowId: string;
    workflowId?: string | undefined;
    triggerId?: string | undefined;
    tenantId?: string | undefined;
    unblockProjectId?: string | undefined;
    correlationId?: string | undefined;
    idempotencyKey?: string | undefined;
    flowKey?: string | undefined;
    payload?: unknown;
    metadata?: Record<string, unknown> | undefined;
    mode?: "attach_or_start" | "start_new" | "replace_terminal" | undefined;
  }): Promise<{
    runId: string;
    status: string;
    created?: boolean | undefined;
    evidence?: Record<string, unknown> | undefined;
  }>;
}

export interface PrismFlowsExecutionClientOptions {
  client: PrismFlowsExecutionSdkClient;
  prismProjectId?: string | undefined;
  appId?: string | undefined;
  triggerId?: string | undefined;
  workflowByFlowId?: Record<string, string> | undefined;
}

export class PrismFlowsExecutionClient implements PrismFlowClient {
  constructor(private readonly options: PrismFlowsExecutionClientOptions) {}

  async startFlow(input: PrismFlowStartInput): Promise<PrismFlowStartResult> {
    const workflowId = input.workflowId ??
      this.options.workflowByFlowId?.[input.flowId] ?? input.flowId;
    const response = await this.options.client.startFlow({
      projectId: input.prismProjectId ?? this.options.prismProjectId ??
        "unblock-flows",
      shardId: input.shardId,
      appId: input.appId ?? this.options.appId ?? "flows",
      flowId: input.flowId,
      workflowId,
      triggerId: input.triggerId ?? this.options.triggerId ?? "manual",
      flowKey: input.idempotencyKey,
      idempotencyKey: input.idempotencyKey,
      tenantId: input.tenantId,
      unblockProjectId: input.projectId,
      correlationId: input.correlationId,
      payload: input.payload,
      metadata: {
        tenantId: input.tenantId,
        projectId: input.projectId,
        correlationId: input.correlationId,
        idempotencyKey: input.idempotencyKey,
        source: "unblock.connector_outbox",
      },
      mode: "attach_or_start",
    });
    return {
      runId: response.runId,
      status: response.created === false ? "deduplicated" : "started",
      evidence: response.evidence,
    };
  }
}

export interface ConnectorOutboxPublishOptions {
  flowId: string;
  limit?: number | undefined;
  now?: string | undefined;
  maxAttempts?: number | undefined;
  retryDelayMs?: (event: OutboxEvent, error: unknown) => number;
}

export interface ConnectorOutboxPublishResult {
  scanned: number;
  published: number;
  failed: number;
  dead: number;
}

export async function publishConnectorOutboxToPrismFlows(
  store: AppStore,
  client: PrismFlowClient,
  options: ConnectorOutboxPublishOptions,
): Promise<ConnectorOutboxPublishResult> {
  const outbox = requireOutbox(store.outbox);
  const now = options.now ?? nowIso();
  const ready = await outbox.listReady(options.limit ?? 100, now);
  const result: ConnectorOutboxPublishResult = {
    scanned: ready.length,
    published: 0,
    failed: 0,
    dead: 0,
  };
  for (const event of ready) {
    const claimed = await outbox.claim(event.id, nowIso());
    if (!claimed) continue;
    try {
      const trigger = connectorTriggerFromOutbox(claimed);
      const flowResult = await client.startFlow({
        flowId: options.flowId,
        tenantId: trigger.event.scope.tenantId,
        projectId: trigger.event.scope.projectId,
        correlationId: trigger.event.correlationId,
        idempotencyKey: trigger.event.idempotencyKey,
        payload: trigger,
      });
      await outbox.markProcessed(claimed.id, nowIso(), {
        flowId: options.flowId,
        flowRunId: flowResult.runId,
        flowRunUrl: flowResult.url ?? null,
        flowStatus: flowResult.status,
        correlationId: trigger.event.correlationId,
        idempotencyKey: trigger.event.idempotencyKey,
        ...(flowResult.evidence ?? {}),
      });
      result.published += 1;
    } catch (error) {
      const maxAttempts = options.maxAttempts ?? 8;
      const serialized = serializeConnectorError(error);
      if (claimed.attemptCount >= maxAttempts) {
        await outbox.markDead(claimed.id, serialized, { maxAttempts });
        result.dead += 1;
      } else {
        const delayMs = options.retryDelayMs?.(claimed, error) ??
          defaultRetryDelayMs(claimed.attemptCount);
        await outbox.markFailed(
          claimed.id,
          serialized,
          new Date(Date.now() + delayMs).toISOString(),
          { retryDelayMs: delayMs },
        );
        result.failed += 1;
      }
    }
  }
  return result;
}

export interface ConnectorInboxApplyResult {
  inboxEvent: InboxEvent;
  applied: boolean;
  duplicate: boolean;
  evidence: Record<string, unknown>;
}

interface ConnectorTaskUpsertStore {
  applyConnectorTaskUpsert(input: {
    inboxEvent: InboxEvent;
    task: Task;
    mapping: ConnectorExternalMapping;
    activity: Activity;
    evidence: Record<string, unknown>;
    appliedAt: string;
  }): Promise<{
    inboxEvent: InboxEvent;
    applied: boolean;
    duplicate: boolean;
    taskInserted: boolean;
  }>;
}

export async function applyConnectorInboxEvent(
  store: AppStore,
  eventInput: ConnectorEvent,
  options: {
    source?: string | undefined;
    machine?: string | undefined;
    actor?: string | undefined;
  } = {},
): Promise<ConnectorInboxApplyResult> {
  const event = connectorEventSchema.parse(eventInput);
  const fastPath = connectorTaskUpsertStore(store);
  if (fastPath && canUseConnectorTaskUpsertFastPath(event)) {
    return applyConnectorTaskUpsertFastPath(fastPath, event, options);
  }
  if (store.capabilities?.dialect === "postgres" || store.capabilities?.dialect === "hosted") {
    return await store.transaction(async (repos) =>
      applyConnectorInboxEventWithRepos(repos as AppStore, event, options)
    );
  }
  return await applyConnectorInboxEventWithRepos(store, event, options);
}

function connectorTaskUpsertStore(
  store: AppStore,
): ConnectorTaskUpsertStore | null {
  const candidate = store as AppStore & Partial<ConnectorTaskUpsertStore>;
  return typeof candidate.applyConnectorTaskUpsert === "function"
    ? candidate as ConnectorTaskUpsertStore
    : null;
}

function canUseConnectorTaskUpsertFastPath(event: ConnectorEvent): boolean {
  return event.kind === "connector.inbound.task_upserted" &&
    event.scope.provider === "github" &&
    !!event.task &&
    !!event.mapping;
}

async function applyConnectorTaskUpsertFastPath(
  store: ConnectorTaskUpsertStore,
  event: ConnectorEvent,
  options: {
    source?: string | undefined;
    machine?: string | undefined;
    actor?: string | undefined;
  },
): Promise<ConnectorInboxApplyResult> {
  if (!event.task) {
    validation("connector.inbound.task_upserted requires task payload.");
  }
  if (!event.mapping) {
    validation("connector.inbound.task_upserted requires mapping payload.");
  }
  const now = nowIso();
  const inboxEvent = inboxEventForConnector(
    event,
    options.source ?? "prism-flows",
  );
  const taskInput = addTaskSchema.parse({
    id: event.task.id,
    title: event.task.title,
    description: event.task.description,
    lifecycle: event.task.lifecycle,
    priority: event.task.priority,
    sourceDoc: event.external?.url ?? event.task.sourceUrl ?? null,
    sourceSection: event.external
      ? `${event.external.system}:${event.external.kind}`
      : null,
    sourceAnchor: event.external?.id ?? null,
  });
  const task: Task = {
    projectId: event.scope.projectId,
    id: normalizeId(taskInput.id),
    parentTaskId: taskInput.parentTaskId,
    title: taskInput.title,
    description: taskInput.description,
    lifecycle: taskInput.lifecycle,
    priority: taskInput.priority,
    size: taskInput.size,
    sourceDoc: taskInput.sourceDoc,
    sourceSection: taskInput.sourceSection,
    sourceAnchor: taskInput.sourceAnchor,
    sourceLine: taskInput.sourceLine,
    sourceText: taskInput.sourceText,
    completionBar: taskInput.completionBar,
    createdAt: now,
    updatedAt: now,
    startedAt: taskInput.lifecycle === "started" ||
        taskInput.lifecycle === "finished"
      ? now
      : null,
    finishedAt: taskInput.lifecycle === "finished" ? now : null,
    archivedAt: null,
    version: 1,
  };
  const mapping = githubIssueMappingForFastPath(event, task.id, now);
  const mappingEvidence = {
    provider: mapping.provider,
    externalKind: mapping.externalKind,
    externalId: mapping.externalId,
    localKind: mapping.localKind,
    localId: mapping.localId,
    status: mapping.status,
  };
  const machine = options.machine ?? "prism-flows";
  const actor = options.actor ?? `connector:${event.scope.provider}`;
  const activity: Activity = {
    projectId: task.projectId,
    id: randomUUID(),
    type: "task.upserted",
    subjectType: "task",
    subjectId: task.id,
    message: `Upserted ${task.id}`,
    data: { title: task.title },
    machine,
    actor,
    createdAt: now,
  };
  const evidence = {
    taskId: task.id,
    external: event.external ?? null,
    mapping: mappingEvidence,
  };
  const applied = await store.applyConnectorTaskUpsert({
    inboxEvent,
    task,
    mapping,
    activity,
    evidence,
    appliedAt: nowIso(),
  });
  const action = applied.taskInserted ? "task.created" : "task.updated";
  return {
    inboxEvent: applied.inboxEvent,
    applied: applied.applied,
    duplicate: applied.duplicate,
    evidence: applied.duplicate
      ? { duplicateOf: applied.inboxEvent.id }
      : { ...evidence, action },
  };
}

function githubIssueMappingForFastPath(
  event: ConnectorEvent,
  taskId: string,
  now: string,
): ConnectorExternalMapping {
  const parsed = githubIssueMappingInputSchema.parse(event.mapping);
  return {
    projectId: parsed.projectId,
    connectionId: parsed.connectionId,
    provider: "github",
    externalKind: "issue",
    externalId: githubIssueExternalId(parsed),
    externalUrl: parsed.issueUrl,
    externalVersion: parsed.externalVersion ?? null,
    localKind: "task",
    localId: taskId,
    localVersion: parsed.localVersion ?? null,
    syncDirection: parsed.syncDirection,
    conflictPolicy: parsed.conflictPolicy,
    status: parsed.status,
    createdAt: now,
    updatedAt: now,
    archivedAt: parsed.status === "archived" ? now : null,
    metadata: {
      ...parsed.metadata,
      repositoryOwner: parsed.repositoryOwner,
      repositoryName: parsed.repositoryName,
      issueNumber: parsed.issueNumber,
      issueNodeId: parsed.issueNodeId ?? null,
    },
  };
}

async function applyConnectorInboxEventWithRepos(
  store: AppStore,
  event: ConnectorEvent,
  options: {
    source?: string | undefined;
    machine?: string | undefined;
    actor?: string | undefined;
  },
): Promise<ConnectorInboxApplyResult> {
  const inbox = requireInbox(store.inbox);
  const inboxEvent = inboxEventForConnector(
    event,
    options.source ?? "prism-flows",
  );
  const received = inbox.receiveForApply
    ? await inbox.receiveForApply(inboxEvent)
    : await receiveAndMarkApplying(inbox, inboxEvent);
  if (!received.created) {
    return {
      inboxEvent: received.event,
      applied: false,
      duplicate: true,
      evidence: { duplicateOf: received.event.id },
    };
  }
  if (!received.claimed) {
    return {
      inboxEvent: received.event,
      applied: false,
      duplicate: true,
      evidence: { alreadyApplying: true },
    };
  }

  try {
    const evidence = await applyConnectorEventToStore(store, event, {
      machine: options.machine ?? "prism-flows",
      actor: options.actor ?? `connector:${event.scope.provider}`,
    });
    const applied = await inbox.markApplied(
      received.event.id,
      nowIso(),
      evidence,
    );
    return {
      inboxEvent: applied ?? received.event,
      applied: true,
      duplicate: false,
      evidence,
    };
  } catch (error) {
    const serialized = serializeConnectorError(error);
    await inbox.markFailed(received.event.id, serialized, {
      eventKind: event.kind,
    });
    throw error;
  }
}

async function receiveAndMarkApplying(
  inbox: InboxEventRepository,
  event: InboxEvent,
): Promise<{ event: InboxEvent; created: boolean; claimed: boolean }> {
  const received = await inbox.receive(event);
  if (!received.created) {
    return { ...received, claimed: false };
  }
  const applying = await inbox.markApplying(received.event.id);
  if (!applying) {
    return { event: received.event, created: true, claimed: false };
  }
  return { event: applying, created: true, claimed: true };
}

async function applyConnectorEventToStore(
  store: AppStore,
  event: ConnectorEvent,
  provenance: { machine: string; actor: string },
): Promise<Record<string, unknown>> {
  const services = createServices(store, {
    projectId: event.scope.projectId,
    ...provenance,
  });
  if (event.kind === "connector.inbound.task_upserted") {
    if (!event.task) {
      validation("connector.inbound.task_upserted requires task payload.");
    }
    const mapping = await persistConnectorMapping(store, event);
    try {
      const created = await services.tasks.add({
        id: event.task.id,
        title: event.task.title,
        description: event.task.description,
        lifecycle: event.task.lifecycle,
        priority: event.task.priority,
        sourceDoc: event.external?.url ?? event.task.sourceUrl ?? null,
        sourceSection: event.external
          ? `${event.external.system}:${event.external.kind}`
          : null,
        sourceAnchor: event.external?.id ?? null,
      });
      return {
        action: "task.created",
        taskId: created.id,
        external: event.external ?? null,
        mapping,
      };
    } catch (error) {
      if (!(error instanceof UnblockError) || error.code !== "conflict") {
        throw error;
      }
      const taskUpdate: EditTaskInput = {
        title: event.task.title,
        description: event.task.description,
        lifecycle: event.task.lifecycle,
        priority: event.task.priority,
      };
      const sourceDoc = event.external?.url ?? event.task.sourceUrl;
      if (sourceDoc !== undefined) taskUpdate.sourceDoc = sourceDoc;
      if (event.external) {
        taskUpdate.sourceSection =
          `${event.external.system}:${event.external.kind}`;
      }
      if (event.external?.id) taskUpdate.sourceAnchor = event.external.id;
      const updated = await services.tasks.edit(event.task.id, taskUpdate);
      return {
        action: "task.updated",
        taskId: updated.id,
        external: event.external ?? null,
        mapping,
      };
    }
  }

  if (event.kind === "connector.inbound.task_archived") {
    const taskId = event.local?.id ?? event.task?.id;
    if (!taskId) {
      validation("connector.inbound.task_archived requires local task id.");
    }
    const archived = await services.tasks.archive(taskId);
    const mapping = await persistConnectorMapping(store, event);
    return {
      action: "task.archived",
      taskId: archived.id,
      external: event.external ?? null,
      mapping,
    };
  }

  if (event.kind === "connector.inbound.comment_created") {
    if (!event.comment) {
      validation("connector.inbound.comment_created requires comment payload.");
    }
    const comment = await services.comments.add(event.comment.taskId, {
      body: event.comment.author
        ? `From ${event.comment.author}:\n\n${event.comment.body}`
        : event.comment.body,
    });
    return {
      action: "comment.created",
      commentId: comment.id,
      taskId: comment.taskId,
      external: event.external ?? null,
    };
  }

  if (event.kind === "connector.cursor.updated") {
    return { action: "cursor.observed", cursor: event.cursor ?? null };
  }

  if (
    event.kind === "connector.dead_letter.created" ||
    event.kind === "connector.operator_review.requested"
  ) {
    return {
      action: event.kind,
      error: event.error ?? null,
      evidence: event.evidence,
    };
  }

  return { action: "ignored", kind: event.kind };
}

async function persistConnectorMapping(
  store: AppStore,
  event: ConnectorEvent,
): Promise<Record<string, unknown> | null> {
  if (!event.mapping) return null;
  if (event.scope.provider === "github") {
    const mapping = await upsertGitHubIssueMapping(
      store,
      githubIssueMappingInputSchema.parse(event.mapping),
    );
    return {
      provider: mapping.provider,
      externalKind: mapping.externalKind,
      externalId: mapping.externalId,
      localKind: mapping.localKind,
      localId: mapping.localId,
      status: mapping.status,
    };
  }
  validation(`Unsupported connector mapping provider: ${event.scope.provider}`);
}

function requireOutbox(
  outbox: OutboxEventRepository | undefined,
): OutboxEventRepository {
  if (!outbox) {
    validation(
      "Connector outbox publishing requires a store with outbox support.",
    );
  }
  return outbox;
}

function requireInbox(
  inbox: InboxEventRepository | undefined,
): InboxEventRepository {
  if (!inbox) {
    validation(
      "Connector inbox application requires a store with inbox support.",
    );
  }
  return inbox;
}

function defaultRetryDelayMs(attemptCount: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attemptCount - 1));
}

function serializeConnectorError(error: unknown): Record<string, unknown> {
  return {
    code: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}
