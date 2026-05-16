import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { AppStore } from "./store.js";
import { connectorEvent, inboxEventForConnector, outboxEventForConnector } from "./connector-events.js";
import { requestConnectorReconciliation, upsertConnectorConnection } from "./connector-reconciliation.js";
import {
  buildConnectorSyncQueueItem,
  connectorSyncPolicyPreset,
  createConnectorSyncPolicyRecord,
} from "./connector-sync.js";
import type {
  AddTaskInput,
  ConnectorExternalMapping,
  HostedAuditEvent,
  JsonExport,
  TaskSize,
} from "./types.js";
import { nowIso } from "./types.js";
import { createServices } from "./services.js";

export interface StorageCrudBenchmarkOptions {
  projectId?: string | undefined;
  machine?: string | undefined;
  actor?: string | undefined;
  tasks?: number | undefined;
  updates?: number | undefined;
  dependencies?: number | undefined;
  dependencyMutations?: number | undefined;
  tags?: number | undefined;
  taskTags?: number | undefined;
  instructions?: number | undefined;
  comments?: number | undefined;
  activity?: number | undefined;
  audit?: number | undefined;
  minOpsPerSecond?: number | undefined;
}

export interface StorageCrudBenchmarkPhase {
  name: string;
  count: number;
  elapsedMs: number;
  opsPerSecond: number;
}

export interface StorageCrudBenchmarkReport {
  ok: boolean;
  storage: {
    dialect: string;
    transactionalWrites: boolean;
    matcherQuery: string;
    outboxInbox: boolean;
  };
  projectId: string;
  counts: {
    tasks: number;
    updates: number;
    dependencies: number;
    dependencyMutations: number;
    tags: number;
    taskTags: number;
    instructions: number;
    comments: number;
    activity: number;
    audit: number;
  };
  phases: StorageCrudBenchmarkPhase[];
  totals: {
    operations: number;
    elapsedMs: number;
    opsPerSecond: number;
  };
}

export interface MatcherReadBenchmarkOptions {
  projectId?: string | undefined;
  machine?: string | undefined;
  actor?: string | undefined;
  tasks?: number | undefined;
  tags?: number | undefined;
  tracks?: number | undefined;
  instructions?: number | undefined;
  comments?: number | undefined;
  iterations?: number | undefined;
  pollers?: number | undefined;
  minOpsPerSecond?: number | undefined;
}

export interface MatcherReadBenchmarkPhase {
  name: string;
  count: number;
  elapsedMs: number;
  opsPerSecond: number;
  avgMs: number;
  resultCount: number;
}

export interface MatcherReadBenchmarkReport {
  ok: boolean;
  storage: {
    dialect: string;
    matcherQuery: string;
  };
  projectId: string;
  counts: {
    tasks: number;
    tags: number;
    tracks: number;
    instructions: number;
    comments: number;
    iterations: number;
    pollers: number;
  };
  phases: MatcherReadBenchmarkPhase[];
  totals: {
    reads: number;
    elapsedMs: number;
    opsPerSecond: number;
  };
}

export interface ConnectorWorkloadBenchmarkOptions {
  projectId?: string | undefined;
  tenantId?: string | undefined;
  connectionId?: string | undefined;
  machine?: string | undefined;
  actor?: string | undefined;
  tasks?: number | undefined;
  mappings?: number | undefined;
  policies?: number | undefined;
  inboundEvents?: number | undefined;
  outboundEvents?: number | undefined;
  retryEvents?: number | undefined;
  reconciliationRequests?: number | undefined;
  queueItems?: number | undefined;
  queueResolutions?: number | undefined;
  reads?: number | undefined;
  minOpsPerSecond?: number | undefined;
}

export interface ConnectorWorkloadBenchmarkPhase {
  name: string;
  count: number;
  elapsedMs: number;
  opsPerSecond: number;
}

export interface ConnectorWorkloadBenchmarkReport {
  ok: boolean;
  supported: boolean;
  unsupportedReason?: string | undefined;
  storage: {
    dialect: string;
    outboxInbox: boolean;
    connectors: boolean;
    syncQueue: boolean;
  };
  projectId: string;
  counts: {
    tasks: number;
    mappings: number;
    policies: number;
    inboundEvents: number;
    outboundEvents: number;
    retryEvents: number;
    reconciliationRequests: number;
    queueItems: number;
    queueResolutions: number;
    reads: number;
  };
  phases: ConnectorWorkloadBenchmarkPhase[];
  totals: {
    operations: number;
    elapsedMs: number;
    opsPerSecond: number;
  };
}

export async function runStorageCrudBenchmark(store: AppStore, options: StorageCrudBenchmarkOptions = {}): Promise<StorageCrudBenchmarkReport> {
  const projectId = normalizeProjectId(options.projectId ?? `BENCH-${Date.now().toString(36)}`);
  const machine = options.machine?.trim() || "storage-benchmark";
  const actor = options.actor?.trim() || "storage-benchmark";
  const taskCount = positiveInteger(options.tasks, 1000);
  const updateCount = Math.min(positiveInteger(options.updates, taskCount), taskCount);
  const tagCount = positiveInteger(options.tags, Math.min(20, taskCount));
  const dependencyCount = Math.min(positiveInteger(options.dependencies, Math.max(0, taskCount - 1)), Math.max(0, taskCount - 1));
  const dependencyMutationCount = Math.min(positiveInteger(options.dependencyMutations, Math.min(dependencyCount, Math.max(0, taskCount - 2))), Math.max(0, taskCount - 2));
  const taskTagCount = Math.min(positiveInteger(options.taskTags, taskCount), taskCount * Math.max(1, tagCount));
  const instructionCount = positiveInteger(options.instructions, tagCount);
  const commentCount = Math.min(positiveInteger(options.comments, taskCount), taskCount);
  const activityCount = positiveInteger(options.activity, taskCount);
  const auditCount = store.hostedAudit ? positiveInteger(options.audit, taskCount) : 0;
  const phases: StorageCrudBenchmarkPhase[] = [];
  const startedAt = performance.now();

  const global = createServices(store, { machine, actor });
  await measure(phases, "project.create", 1, async () => {
    await global.projects.add({ id: projectId, name: `Storage benchmark ${projectId}` });
  });

  const services = createServices(store, { projectId, machine, actor });
  const tags = Array.from({ length: tagCount }, (_item, index) => ({
    id: `TAG-${index.toString().padStart(3, "0")}`,
    name: `bench-tag-${index.toString().padStart(3, "0")}`
  }));
  await measure(phases, "tags.create", tags.length, async () => {
    await services.tags.addMany(tags);
  });

  const sizes: TaskSize[] = ["XS", "S", "M", "L", "XL"];
  const tasks = Array.from({ length: taskCount }, (_item, index): AddTaskInput => ({
    id: taskId(index),
    title: `Benchmark task ${index}`,
    description: `Synthetic storage benchmark task ${index}.`,
    priority: (index % 5) as 0 | 1 | 2 | 3 | 4,
    size: sizes[index % sizes.length] ?? null
  }));
  await measure(phases, "tasks.create", tasks.length, async () => {
    await services.tasks.addMany(tasks);
  });

  await measure(phases, "tasks.update", updateCount, async () => {
    for (let index = 0; index < updateCount; index += 1) {
      await services.tasks.edit(taskId(index), {
        title: `Benchmark task ${index} updated`,
        description: `Synthetic storage benchmark task ${index}; updated during CRUD benchmark.`,
        priority: ((index + 1) % 5) as 0 | 1 | 2 | 3 | 4
      });
    }
  });

  const dependencies = Array.from({ length: dependencyCount }, (_item, index) => ({
    taskId: taskId(index + 1),
    dependsOnTaskId: taskId(index)
  }));
  await measure(phases, "dependencies.create", dependencies.length, async () => {
    await services.dependencies.addMany(dependencies);
  });

  await measure(phases, "dependencies.mutate", dependencyMutationCount, async () => {
    for (let index = 0; index < dependencyMutationCount; index += 1) {
      await services.dependencies.set(taskId(index + 2), [taskId(0)]);
    }
  });

  const taskTags = Array.from({ length: taskTagCount }, (_item, index) => ({
    taskId: taskId(index % taskCount),
    tagIdsOrNames: [tags[index % tags.length]?.id ?? "TAG-000"]
  }));
  await measure(phases, "task_tags.assign", taskTags.length, async () => {
    await services.tags.assignMany(taskTags);
  });

  const instructions = Array.from({ length: instructionCount }, (_item, index) => ({
    id: `INST-${index.toString().padStart(3, "0")}`,
    name: `Benchmark instruction ${index}`,
    query: `tag = ${tags[index % tags.length]?.name ?? "bench-tag-000"}`,
    body: `Synthetic instruction ${index}.`
  }));
  await measure(phases, "instructions.create", instructions.length, async () => {
    await services.instructions.addMany(instructions);
  });

  await measure(phases, "comments.create", commentCount, async () => {
    await services.comments.addMany(Array.from({ length: commentCount }, (_item, index) => ({
      taskId: taskId(index),
      body: `Benchmark comment ${index}.`
    })));
  });

  await measure(phases, "activity.append", activityCount, async () => {
    await services.activity.recordMany(Array.from({ length: activityCount }, (_item, index) => ({
      type: "benchmark.activity",
      subjectType: "project",
      subjectId: projectId,
      message: `Benchmark activity ${index}`,
      data: { index }
    })));
  });

  if (store.hostedAudit && auditCount > 0) {
    await measure(phases, "audit.append", auditCount, async () => {
      for (let index = 0; index < auditCount; index += 1) {
        await store.hostedAudit?.append(hostedAuditEvent(projectId, actor, index));
      }
    });
  }

  const elapsedMs = roundMs(performance.now() - startedAt);
  const operations = phases.reduce((sum, phase) => sum + phase.count, 0);
  const opsPerSecond = rate(operations, elapsedMs);
  return {
    ok: options.minOpsPerSecond === undefined || opsPerSecond >= options.minOpsPerSecond,
    storage: {
      dialect: store.capabilities?.dialect ?? "unknown",
      transactionalWrites: store.capabilities?.transactionalWrites ?? false,
      matcherQuery: store.capabilities?.matcherQuery ?? "unknown",
      outboxInbox: store.capabilities?.outboxInbox ?? false
    },
    projectId,
    counts: {
      tasks: taskCount,
      updates: updateCount,
      dependencies: dependencyCount,
      dependencyMutations: dependencyMutationCount,
      tags: tagCount,
      taskTags: taskTagCount,
      instructions: instructionCount,
      comments: commentCount,
      activity: activityCount,
      audit: auditCount
    },
    phases,
    totals: {
      operations,
      elapsedMs,
      opsPerSecond
    }
  };
}

export async function runConnectorWorkloadBenchmark(store: AppStore, options: ConnectorWorkloadBenchmarkOptions = {}): Promise<ConnectorWorkloadBenchmarkReport> {
  const projectId = normalizeProjectId(options.projectId ?? `CONNECTOR-BENCH-${Date.now().toString(36)}`);
  const tenantId = options.tenantId?.trim() || "benchmark-tenant";
  const connectionId = options.connectionId?.trim() || "github-main";
  const machine = options.machine?.trim() || "connector-benchmark";
  const actor = options.actor?.trim() || "connector-benchmark";
  const taskCount = positiveInteger(options.tasks, 1000);
  const mappingCount = Math.min(positiveInteger(options.mappings, taskCount), taskCount);
  const policyCount = positiveInteger(options.policies, 3);
  const inboundEventCount = positiveInteger(options.inboundEvents, taskCount);
  const outboundEventCount = positiveInteger(options.outboundEvents, Math.floor(taskCount / 2));
  const retryEventCount = Math.min(positiveInteger(options.retryEvents, Math.min(100, outboundEventCount)), outboundEventCount);
  const reconciliationRequestCount = positiveInteger(options.reconciliationRequests, 10);
  const queueItemCount = positiveInteger(options.queueItems, taskCount);
  const queueResolutionCount = Math.min(positiveInteger(options.queueResolutions, Math.floor(queueItemCount / 2)), queueItemCount);
  const readCount = positiveInteger(options.reads, 50);
  const phases: ConnectorWorkloadBenchmarkPhase[] = [];
  const supported = connectorBenchmarkSupport(store);
  const counts = {
    tasks: taskCount,
    mappings: mappingCount,
    policies: policyCount,
    inboundEvents: inboundEventCount,
    outboundEvents: outboundEventCount,
    retryEvents: retryEventCount,
    reconciliationRequests: reconciliationRequestCount,
    queueItems: queueItemCount,
    queueResolutions: queueResolutionCount,
    reads: readCount
  };

  if (!supported.ok) {
    return {
      ok: false,
      supported: false,
      unsupportedReason: supported.reason,
      storage: connectorBenchmarkStorage(store),
      projectId,
      counts,
      phases,
      totals: { operations: 0, elapsedMs: 0, opsPerSecond: 0 }
    };
  }

  const connectors = store.connectors!;
  const outbox = store.outbox!;
  const inbox = store.inbox!;
  const startedAt = performance.now();
  const global = createServices(store, { machine, actor });
  await measure(phases, "project.create", 1, async () => {
    await global.projects.add({ id: projectId, name: `Connector benchmark ${projectId}` });
  });

  const services = createServices(store, { projectId, machine, actor });
  await measure(phases, "connection.upsert", 1, async () => {
    await upsertConnectorConnection(store, {
      projectId,
      connectionId,
      provider: "github",
      displayName: "GitHub benchmark",
      metadata: { repositoryOwner: "benchmark", repositoryName: "unblock" }
    });
  });

  const sizes: TaskSize[] = ["XS", "S", "M", "L", "XL"];
  await measure(phases, "tasks.create", taskCount, async () => {
    await services.tasks.addMany(Array.from({ length: taskCount }, (_item, index): AddTaskInput => ({
      id: taskId(index),
      title: `Connector benchmark task ${index}`,
      description: `Synthetic connector workload task ${index}.`,
      priority: (index % 5) as 0 | 1 | 2 | 3 | 4,
      size: sizes[index % sizes.length] ?? null,
      sourceDoc: "github:benchmark/unblock",
      sourceSection: `issue-${index + 1}`,
      sourceAnchor: `issue-${index + 1}`,
      sourceText: `benchmark/unblock#${index + 1}`
    })));
  });

  const now = nowIso();
  const mappings = Array.from({ length: mappingCount }, (_item, index) =>
    connectorMapping(projectId, connectionId, index, now)
  );
  await measure(phases, "mappings.upsert", mappings.length, async () => {
    for (const mapping of mappings) {
      await connectors.upsertMapping!(mapping);
    }
  });

  const basePolicy = connectorSyncPolicyPreset("github", "execution_layer", "issue");
  const policies = Array.from({ length: policyCount }, (_item, index) =>
    createConnectorSyncPolicyRecord({
      projectId,
      id: `POLICY-${index.toString().padStart(3, "0")}`,
      connectionId,
      name: `Connector benchmark policy ${index}`,
      scopeQuery: index === 0 ? null : `source section = issue-${index + 1}`,
      priority: policyCount - index,
      enabled: true,
      policy: basePolicy
    }, now)
  );
  await measure(phases, "sync_policies.upsert", policies.length, async () => {
    for (const policy of policies) {
      await connectors.upsertSyncPolicy!(policy);
    }
  });

  const inboundEvents = Array.from({ length: inboundEventCount }, (_item, index) =>
    connectorIssueEvent({
      tenantId,
      projectId,
      connectionId,
      index,
      kind: "connector.inbound.external_changed",
      occurredAt: now
    })
  );
  await measure(phases, "inbox.receive", inboundEvents.length, async () => {
    for (const event of inboundEvents) {
      await inbox.receive(inboxEventForConnector(event, "benchmark-webhook"));
    }
  });

  await measure(phases, "inbox.apply", inboundEvents.length, async () => {
    for (const event of inboundEvents) {
      const existing = await inbox.findBySource("benchmark-webhook", event.idempotencyKey);
      if (!existing) continue;
      await inbox.markApplying(existing.id);
      await inbox.markApplied(existing.id, now, { benchmark: true });
    }
  });

  const outboundEvents = Array.from({ length: outboundEventCount }, (_item, index) =>
    connectorIssueEvent({
      tenantId,
      projectId,
      connectionId,
      index,
      kind: "connector.outbound.local_changed",
      occurredAt: now
    })
  );
  await measure(phases, "outbox.enqueue", outboundEvents.length, async () => {
    for (const event of outboundEvents) {
      await outbox.enqueue(outboxEventForConnector(event, {
        projectId,
        subjectType: "task",
        subjectId: taskId(indexFromExternalId(event.external?.id ?? "1")),
        availableAt: now
      }));
    }
  });

  await measure(phases, "outbox.retry_cycle", retryEventCount, async () => {
    const ready = await outbox.listReady(retryEventCount, now);
    for (const event of ready.slice(0, retryEventCount)) {
      const claimed = await outbox.claim(event.id, now);
      if (!claimed) continue;
      const failed = await outbox.markFailed(claimed.id, { code: "benchmark_retry", retryable: true }, now, { benchmark: true });
      if (failed) {
        const retry = await outbox.claim(failed.id, now);
        if (retry) await outbox.markProcessed(retry.id, now, { benchmark: true, retry: true });
      }
    }
  });

  await measure(phases, "reconciliation.request", reconciliationRequestCount, async () => {
    for (let index = 0; index < reconciliationRequestCount; index += 1) {
      await requestConnectorReconciliation(store, {
        tenantId,
        projectId,
        connectionId,
        provider: "github",
        reason: `benchmark-${index}`,
        runId: randomUUID(),
        now
      });
    }
  });

  const queueItems = Array.from({ length: queueItemCount }, (_item, index) => {
    const mapping = mappings[index % Math.max(1, mappings.length)] ?? connectorMapping(projectId, connectionId, index, now);
    return buildConnectorSyncQueueItem({
      policy: basePolicy,
      policyId: policies[index % Math.max(1, policies.length)]?.id ?? null,
      scopeQuery: policies[index % Math.max(1, policies.length)]?.scopeQuery ?? null,
      mapping,
      now,
      diff: {
        field: index % 3 === 0 ? "title" : index % 3 === 1 ? "description" : "labels",
        externalValue: `external-${index}`,
        localValue: `local-${index}`,
        externalVersion: `e-${index}`,
        localVersion: `l-${index}`,
        externalUpdatedAt: now,
        localUpdatedAt: now,
        reason: "benchmark divergence"
      },
      externalSnapshot: { title: `External issue ${index}`, number: index + 1 },
      localSnapshot: { title: `Connector benchmark task ${index}` }
    });
  });
  await measure(phases, "sync_queue.upsert", queueItems.length, async () => {
    for (const item of queueItems) {
      await connectors.upsertSyncQueueItem!(item);
    }
  });

  await measure(phases, "sync_queue.resolve", queueResolutionCount, async () => {
    for (const item of queueItems.slice(0, queueResolutionCount)) {
      await connectors.updateSyncQueueItemStatus!(projectId, item.id, "resolved", {
        resolvedAt: now
      });
    }
  });

  await measure(phases, "connector.read_mix", readCount * 6, async () => {
    for (let index = 0; index < readCount; index += 1) {
      await Promise.all([
        connectors.listConnections(projectId),
        connectors.listCursors(projectId, connectionId),
        connectors.listSyncRuns({ projectId, connectionId, limit: 20 }),
        connectors.listMappings!({ projectId, connectionId, limit: 100 }),
        connectors.listSyncPolicies!({ projectId, connectionId, limit: 20 }),
        connectors.listSyncQueueItems!({ projectId, connectionId, status: index % 2 === 0 ? "pending" : "resolved", limit: 100 })
      ]);
    }
  });

  await analyzeBenchmarkTables(store);
  const elapsedMs = roundMs(performance.now() - startedAt);
  const operations = phases.reduce((sum, phase) => sum + phase.count, 0);
  const opsPerSecond = rate(operations, elapsedMs);
  return {
    ok: options.minOpsPerSecond === undefined || opsPerSecond >= options.minOpsPerSecond,
    supported: true,
    storage: connectorBenchmarkStorage(store),
    projectId,
    counts,
    phases,
    totals: {
      operations,
      elapsedMs,
      opsPerSecond
    }
  };
}

export async function runMatcherReadBenchmark(store: AppStore, options: MatcherReadBenchmarkOptions = {}): Promise<MatcherReadBenchmarkReport> {
  const projectId = normalizeProjectId(options.projectId ?? `MATCHER-BENCH-${Date.now().toString(36)}`);
  const machine = options.machine?.trim() || "matcher-benchmark";
  const actor = options.actor?.trim() || "matcher-benchmark";
  const taskCount = positiveInteger(options.tasks, 2000);
  const tagCount = positiveInteger(options.tags, Math.min(20, taskCount));
  const trackCount = positiveInteger(options.tracks, 8);
  const instructionCount = positiveInteger(options.instructions, tagCount);
  const commentCount = Math.min(positiveInteger(options.comments, Math.floor(taskCount / 2)), taskCount);
  const iterations = positiveInteger(options.iterations, 50);
  const pollers = positiveInteger(options.pollers, 20);
  const phases: MatcherReadBenchmarkPhase[] = [];

  const global = createServices(store, { machine, actor });
  await global.projects.add({ id: projectId, name: `Matcher benchmark ${projectId}` });
  const services = createServices(store, { projectId, machine, actor });
  await services.imports.json("matcher-benchmark.json", matcherBenchmarkData({
    taskCount,
    tagCount,
    trackCount,
    instructionCount,
    commentCount,
    machine
  }));
  await analyzeBenchmarkTables(store);

  const rootId = taskId(0);
  const dependencyTarget = taskId(Math.min(taskCount - 1, 1));
  const unblockTarget = taskId(Math.min(taskCount - 1, Math.max(2, Math.floor(taskCount / 2))));
  const contextTarget = taskId(Math.min(taskCount - 1, Math.max(2, Math.floor(taskCount / 3))));
  const commonQueries = [
    `tag = bench-tag-000`,
    `assigned = ${machine}:bench-actor-0`,
    `depends on ${dependencyTarget}`,
    `unblocks ${unblockTarget}`,
    `descendant of ${rootId}`,
    `comments > 0`,
    `status = blocked`,
    `source doc = bench.md and source section = section-0`
  ];

  for (const query of commonQueries) {
    await services.query.match(query, 100, { includeFinished: true, sort: "id" });
  }
  await services.query.list({ status: "ready", sort: "priority" });
  await services.query.match("tag = bench-tag-000 and status = ready", 100, { sort: "priority" });
  await services.exports.markdown({ where: `depends on ${dependencyTarget}`, limit: 50 });
  await services.query.matchingInstructionIds();
  await services.query.explain(contextTarget);
  const startedAt = performance.now();
  for (const query of commonQueries) {
    await measureRead(phases, `matcher.${query}`, iterations, async () =>
      (await services.query.match(query, 100, { includeFinished: true, sort: "id" })).length
    );
  }

  await measureRead(phases, "dashboard.ready", iterations, async () =>
    (await services.query.list({ status: "ready", sort: "priority" })).length
  );
  await measureRead(phases, "dashboard.blocked", iterations, async () =>
    (await services.query.list({ status: "blocked", sort: "dependency" })).length
  );
  await measureRead(phases, "dashboard.started", iterations, async () =>
    (await services.query.list({ lifecycle: "started", sort: "updated" })).length
  );
  await measureRead(phases, "queue.backend_ready", iterations, async () =>
    (await services.query.match("tag = bench-tag-000 and status = ready", 100, { sort: "priority" })).length
  );
  await measureRead(phases, "context.dependency_slice", iterations, async () =>
    (await services.exports.markdown({ where: `depends on ${dependencyTarget}`, limit: 50 })).length
  );
  await measureRead(phases, "task_context.explain", iterations, async () => {
    const explanation = await services.query.explain(contextTarget);
    return explanation.dependencies.length + explanation.directDependents.length + explanation.instructions.length;
  });
  await measureRead(phases, "dependency_view.explain_many", iterations, async () => {
    const targets = Array.from({ length: Math.min(10, taskCount) }, (_item, index) => taskId(index));
    const explanations = await Promise.all(targets.map((id) => services.query.explain(id)));
    return explanations.reduce((sum, explanation) => sum + explanation.dependencies.length + explanation.directDependents.length, 0);
  }, Math.min(10, taskCount));
  await measureRead(phases, "instructions.matching_ids", iterations, async () =>
    (await services.query.matchingInstructionIds()).length
  );
  await measureRead(phases, "polling.concurrent_ready", iterations, async () => {
    const results = await Promise.all(Array.from({ length: pollers }, async () =>
      (await services.query.list({ status: "ready", sort: "priority" })).length
    ));
    return results.reduce((sum, count) => sum + count, 0);
  }, pollers);
  await measureRead(phases, "polling.frontend_mix", iterations, async () => {
    const results = await Promise.all(Array.from({ length: pollers }, async (_item, pollerIndex) => {
      const taskIndex = pollerIndex % Math.max(1, taskCount);
      const [ready, blocked, queue, explain, matcher] = await Promise.all([
        services.query.list({ status: "ready", sort: "priority" }),
        services.query.list({ status: "blocked", sort: "dependency" }),
        services.query.match(`assigned = ${machine}:bench-actor-${pollerIndex % trackCount}`, 50, { sort: "dependency" }),
        services.query.explain(taskId(taskIndex)),
        services.query.match(commonQueries[pollerIndex % commonQueries.length] ?? "status = ready", 100, { includeFinished: true, sort: "id" })
      ]);
      return ready.length + blocked.length + queue.length + explain.dependencies.length + matcher.length;
    }));
    return results.reduce((sum, count) => sum + count, 0);
  }, pollers * 5);

  const elapsedMs = roundMs(performance.now() - startedAt);
  const reads = phases.reduce((sum, phase) => sum + phase.count, 0);
  const opsPerSecond = rate(reads, elapsedMs);
  return {
    ok: options.minOpsPerSecond === undefined || opsPerSecond >= options.minOpsPerSecond,
    storage: {
      dialect: store.capabilities?.dialect ?? "unknown",
      matcherQuery: store.capabilities?.matcherQuery ?? "unknown"
    },
    projectId,
    counts: {
      tasks: taskCount,
      tags: tagCount,
      tracks: trackCount,
      instructions: instructionCount,
      comments: commentCount,
      iterations,
      pollers
    },
    phases,
    totals: {
      reads,
      elapsedMs,
      opsPerSecond
    }
  };
}

async function measure(phases: StorageCrudBenchmarkPhase[], name: string, count: number, fn: () => Promise<void>): Promise<void> {
  const startedAt = performance.now();
  await fn();
  const elapsedMs = roundMs(performance.now() - startedAt);
  phases.push({ name, count, elapsedMs, opsPerSecond: rate(count, elapsedMs) });
}

function connectorBenchmarkSupport(store: AppStore): { ok: true } | { ok: false; reason: string } {
  if (!store.connectors) return { ok: false, reason: "Store does not expose connector repositories." };
  if (!store.outbox || !store.inbox) return { ok: false, reason: "Store does not expose durable outbox/inbox repositories." };
  const missing = [
    ["upsertMapping", store.connectors.upsertMapping],
    ["listMappings", store.connectors.listMappings],
    ["upsertSyncPolicy", store.connectors.upsertSyncPolicy],
    ["listSyncPolicies", store.connectors.listSyncPolicies],
    ["upsertSyncQueueItem", store.connectors.upsertSyncQueueItem],
    ["listSyncQueueItems", store.connectors.listSyncQueueItems],
    ["updateSyncQueueItemStatus", store.connectors.updateSyncQueueItemStatus],
  ].filter(([, value]) => typeof value !== "function").map(([name]) => name);
  if (missing.length > 0) {
    return { ok: false, reason: `Connector repository is missing: ${missing.join(", ")}.` };
  }
  return { ok: true };
}

function connectorBenchmarkStorage(store: AppStore): ConnectorWorkloadBenchmarkReport["storage"] {
  return {
    dialect: store.capabilities?.dialect ?? "unknown",
    outboxInbox: store.capabilities?.outboxInbox ?? false,
    connectors: Boolean(store.connectors),
    syncQueue: Boolean(
      store.connectors?.upsertSyncQueueItem &&
      store.connectors.listSyncQueueItems &&
      store.connectors.updateSyncQueueItemStatus
    )
  };
}

function connectorMapping(
  projectId: string,
  connectionId: string,
  index: number,
  now: string,
): ConnectorExternalMapping {
  return {
    projectId,
    connectionId,
    provider: "github",
    externalKind: "issue",
    externalId: String(index + 1),
    externalUrl: `https://github.example.test/benchmark/unblock/issues/${index + 1}`,
    externalVersion: `external-${index}`,
    localKind: "task",
    localId: taskId(index),
    localVersion: `local-${index}`,
    syncDirection: "bidirectional",
    conflictPolicy: "operator_review",
    status: "active",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    metadata: { source: "connector-benchmark" }
  };
}

function connectorIssueEvent(input: {
  tenantId: string;
  projectId: string;
  connectionId: string;
  index: number;
  kind: "connector.inbound.external_changed" | "connector.outbound.local_changed";
  occurredAt: string;
}) {
  const issueNumber = input.index + 1;
  return connectorEvent({
    kind: input.kind,
    scope: {
      tenantId: input.tenantId,
      projectId: input.projectId,
      connectionId: input.connectionId,
      provider: "github",
    },
    local: { kind: "task", id: taskId(input.index) },
    external: {
      system: "github",
      kind: "issue",
      id: String(issueNumber),
      url: `https://github.example.test/benchmark/unblock/issues/${issueNumber}`,
    },
    task: {
      id: taskId(input.index),
      title: `Connector benchmark issue ${issueNumber}`,
      description: `Synthetic connector benchmark issue ${issueNumber}.`,
      lifecycle: "open",
      priority: (input.index % 5) as 0 | 1 | 2 | 3 | 4,
      sourceUrl: `https://github.example.test/benchmark/unblock/issues/${issueNumber}`,
    },
    evidence: { benchmark: true, issueNumber },
    occurredAt: input.occurredAt,
  });
}

function indexFromExternalId(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed - 1 : 0;
}

async function measureRead(phases: MatcherReadBenchmarkPhase[], name: string, iterations: number, fn: () => Promise<number>, operationsPerIteration = 1): Promise<void> {
  const startedAt = performance.now();
  let resultCount = 0;
  for (let index = 0; index < iterations; index += 1) {
    resultCount += await fn();
  }
  const elapsedMs = roundMs(performance.now() - startedAt);
  const count = iterations * operationsPerIteration;
  phases.push({
    name,
    count,
    elapsedMs,
    opsPerSecond: rate(count, elapsedMs),
    avgMs: count > 0 ? roundMs(elapsedMs / count) : 0,
    resultCount
  });
}

function rate(count: number, elapsedMs: number): number {
  if (elapsedMs <= 0) {
    return count;
  }
  return Math.round((count / elapsedMs) * 100000) / 100;
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeProjectId(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || `BENCH-${Date.now().toString(36)}`;
}

function taskId(index: number): string {
  return `T-${index.toString().padStart(6, "0")}`;
}

function hostedAuditEvent(projectId: string, actor: string, index: number): HostedAuditEvent {
  return {
    tenantId: "benchmark-tenant",
    projectId,
    id: randomUUID(),
    eventType: "benchmark.audit",
    principalId: actor,
    subjectType: "task",
    subjectId: taskId(index),
    message: `Benchmark audit ${index}`,
    data: { index },
    requestId: `benchmark-${index}`,
    ipAddress: null,
    userAgent: "unblock-benchmark",
    createdAt: new Date().toISOString()
  };
}

function matcherBenchmarkData(options: {
  taskCount: number;
  tagCount: number;
  trackCount: number;
  instructionCount: number;
  commentCount: number;
  machine: string;
}): JsonExport {
  const now = "2026-05-01T00:00:00.000Z";
  const groupSize = 50;
  const tasks: JsonExport["tasks"] = [];
  const dependencies: JsonExport["dependencies"] = [];
  const taskTags: JsonExport["taskTags"] = [];
  const assignments: JsonExport["assignments"] = [];
  const comments: JsonExport["comments"] = [];

  for (let index = 0; index < options.taskCount; index += 1) {
    const id = taskId(index);
    const groupStart = index - (index % groupSize);
    const isRoot = index % groupSize === 0;
    const lifecycle = !isRoot && index % 17 === 0 ? "finished" : index % 13 === 0 ? "started" : "open";
    tasks.push({
      projectId: "DEFAULT",
      id,
      parentTaskId: isRoot ? null : taskId(groupStart),
      title: `Matcher benchmark task ${index}`,
      description: `Synthetic matcher benchmark task ${index}.`,
      lifecycle,
      priority: (index % 5) as 0 | 1 | 2 | 3 | 4,
      size: null,
      sourceDoc: "bench.md",
      sourceSection: `section-${index % 10}`,
      sourceAnchor: null,
      sourceLine: null,
      sourceText: null,
      completionBar: null,
      createdAt: now,
      updatedAt: now,
      startedAt: lifecycle === "started" ? now : null,
      finishedAt: lifecycle === "finished" ? now : null,
      archivedAt: !isRoot && index % 101 === 0 ? "2026-05-02T00:00:00.000Z" : null,
      version: 1
    });
    taskTags.push({ projectId: "DEFAULT", taskId: id, tagId: tagId(index % options.tagCount), createdAt: now });
    if (index > 0 && index % groupSize !== 1) {
      dependencies.push({ projectId: "DEFAULT", taskId: id, dependsOnTaskId: taskId(index - 1), createdAt: now });
    }
    if (index < options.taskCount / 3) {
      assignments.push({
        projectId: "DEFAULT",
        trackId: `${options.machine}-bench-actor-${index % options.trackCount}`,
        taskId: id,
        position: String(index + 1).padStart(6, "0"),
        assignedAt: now
      });
    }
    if (index < options.commentCount) {
      comments.push({
        projectId: "DEFAULT",
        id: `C-${index.toString().padStart(6, "0")}`,
        taskId: id,
        machine: options.machine,
        actor: `bench-actor-${index % options.trackCount}`,
        body: `Matcher benchmark comment ${index}.`,
        createdAt: now,
        updatedAt: now,
        archivedAt: null
      });
    }
  }

  return {
    tasks,
    dependencies,
    tags: Array.from({ length: options.tagCount }, (_item, index) => ({
      projectId: "DEFAULT",
      id: tagId(index),
      name: `bench-tag-${index.toString().padStart(3, "0")}`,
      color: null,
      description: null,
      sortOrder: index,
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    })),
    taskTags,
    tracks: Array.from({ length: options.trackCount }, (_item, index) => ({
      projectId: "DEFAULT",
      id: `${options.machine}-bench-actor-${index}`,
      machine: options.machine,
      actor: `bench-actor-${index}`,
      name: `Benchmark actor ${index}`,
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    })),
    assignments,
    instructions: Array.from({ length: options.instructionCount }, (_item, index) => ({
      projectId: "DEFAULT",
      id: `INST-${index.toString().padStart(3, "0")}`,
      name: `Matcher benchmark instruction ${index}`,
      query: index % 3 === 0
        ? `tag = ${tagId(index % options.tagCount)} and status = ready`
        : index % 3 === 1
          ? `depends on ${taskId(Math.min(options.taskCount - 1, index + 1))}`
          : `assigned = ${options.machine}:bench-actor-${index % options.trackCount}`,
      body: `Matcher benchmark instruction ${index}.`,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    })),
    comments,
    activity: []
  };
}

function tagId(index: number): string {
  return `TAG-${index.toString().padStart(3, "0")}`;
}

async function analyzeBenchmarkTables(store: AppStore): Promise<void> {
  const maybeExec = (store as { exec?: (sql: string) => Promise<void> }).exec;
  if (!maybeExec || store.capabilities?.dialect !== "postgres") {
    return;
  }
  await maybeExec.call(store, `
    analyze tasks;
    analyze task_dependencies;
    analyze tags;
    analyze task_tags;
    analyze tracks;
    analyze track_assignments;
    analyze comments;
    analyze instructions;
    analyze activity;
    analyze connector_connections;
    analyze connector_cursors;
    analyze connector_sync_runs;
    analyze connector_external_mappings;
    analyze connector_sync_policies;
    analyze sync_queue_items;
    analyze outbox_events;
    analyze inbox_events;
  `);
}
