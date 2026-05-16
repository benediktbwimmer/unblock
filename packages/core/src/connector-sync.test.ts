import { describe, expect, it } from "vitest";
import {
  buildConnectorSyncQueueItem,
  createConnectorSyncPolicyRecord,
  connectorSyncPolicyPreset,
  decideConnectorFieldSync,
  decideResolvedConnectorFieldSync,
  listConnectorSyncPolicies,
  listConnectorSyncQueueItems,
  mergeConnectorSyncPolicies,
  planConnectorSyncQueue,
  resolveConnectorSyncPolicy,
  updateConnectorSyncQueueItemStatus,
  upsertConnectorSyncPolicy,
  upsertConnectorSyncQueueItems,
} from "./connector-sync.js";
import type { ConnectorExternalMapping, ConnectorSyncPolicyRecord, ConnectorSyncQueueItem } from "./types.js";

describe("connector sync policy", () => {
  it("defaults to the execution layer preset", () => {
    const policy = connectorSyncPolicyPreset("github", "execution_layer");

    expect(policy.fields.title).toMatchObject({ mode: "inbound_only" });
    expect(policy.fields.dependencies).toMatchObject({ mode: "unblock_owned" });
    expect(policy.fields.execution_assignment).toMatchObject({
      mode: "unblock_owned",
    });
    expect(policy.fields.comments).toMatchObject({ mode: "append_only" });
  });

  it("turns inbound-owned field divergence into inbound decisions", () => {
    const decision = decideConnectorFieldSync({
      policy: connectorSyncPolicyPreset("github", "execution_layer"),
      diff: {
        field: "title",
        externalValue: "New GitHub title",
        localValue: "Old Unblock title",
      },
    });

    expect(decision).toMatchObject({
      kind: "apply_inbound",
      proposedValue: "New GitHub title",
      reason: "External field is authoritative.",
    });
  });

  it("turns Unblock-owned field divergence into outbound decisions", () => {
    const decision = decideConnectorFieldSync({
      policy: connectorSyncPolicyPreset("jira", "execution_layer"),
      diff: {
        field: "execution_assignment",
        externalValue: "alice",
        localValue: "CODEX-E",
      },
    });

    expect(decision).toMatchObject({
      kind: "apply_outbound",
      proposedValue: "CODEX-E",
      reason: "Unblock field is authoritative.",
    });
  });

  it("keeps bidirectional conflicts in manual review by default", () => {
    const decision = decideConnectorFieldSync({
      policy: connectorSyncPolicyPreset("jira", "bidirectional_project_sync"),
      diff: {
        field: "external_state",
        externalValue: "Done",
        localValue: "In Progress",
      },
    });

    expect(decision).toMatchObject({
      kind: "manual_review",
      reason: "Bidirectional divergence needs manual review.",
    });
  });

  it("supports matcher override policy merges", () => {
    const merged = mergeConnectorSyncPolicies(
      connectorSyncPolicyPreset("github", "execution_layer"),
      {
        fields: {
          responsibility: {
            field: "responsibility",
            mode: "manual",
            conflictPolicy: "manual_review",
          },
        },
      },
    );

    const decision = decideConnectorFieldSync({
      policy: merged,
      diff: {
        field: "responsibility",
        externalValue: "alice",
        localValue: "bob",
      },
    });

    expect(decision).toMatchObject({ kind: "manual_review" });
  });

  it("resolves global and matcher-scoped policies with explanations", () => {
    const base = connectorSyncPolicyPreset("jira", "execution_layer");
    const global = createConnectorSyncPolicyRecord({
      projectId: "PROJECT",
      id: "jira-default",
      connectionId: "jira-main",
      name: "Jira default",
      priority: 0,
      policy: {
        ...base,
        fields: {
          external_state: {
            field: "external_state",
            mode: "manual",
            conflictPolicy: "manual_review",
          },
        },
      },
    }, "2026-05-16T00:00:00.000Z");
    const scoped = createConnectorSyncPolicyRecord({
      projectId: "PROJECT",
      id: "security-owned",
      connectionId: "jira-main",
      name: "Security queue owns labels",
      scopeQuery: "tag = security",
      priority: 10,
      policy: {
        ...base,
        fields: {
          labels: {
            field: "labels",
            mode: "unblock_owned",
          },
        },
      },
    }, "2026-05-16T00:00:01.000Z");
    const unmatched = createConnectorSyncPolicyRecord({
      projectId: "PROJECT",
      id: "backend-owned",
      connectionId: "jira-main",
      name: "Backend queue owns labels",
      scopeQuery: "tag = backend",
      priority: 20,
      policy: {
        ...base,
        fields: {
          labels: {
            field: "labels",
            mode: "manual",
          },
        },
      },
    }, "2026-05-16T00:00:02.000Z");

    const resolution = resolveConnectorSyncPolicy({
      provider: "jira",
      objectKind: "issue",
      defaultPolicy: base,
      policies: [unmatched, scoped, global],
      task: taskView("TASK-1", ["security"]),
      tasks: [taskView("TASK-1", ["security"])],
      dependencies: [],
    });

    expect(resolution.policy.fields.external_state).toMatchObject({
      mode: "manual",
    });
    expect(resolution.policy.fields.labels).toMatchObject({
      mode: "unblock_owned",
    });
    expect(resolution.fieldSources.labels?.id).toBe("security-owned");
    expect(resolution.appliedPolicies.map((policy) => policy.id)).toEqual([
      null,
      "jira-default",
      "security-owned",
    ]);
    expect(resolution.skippedPolicies).toEqual([
      expect.objectContaining({
        id: "backend-owned",
        skipReason: "scope_not_matched",
      }),
    ]);
    expect(resolution.explanation.join("\n")).toContain("Applied Security queue owns labels");
  });

  it("attaches resolved policy source evidence to field decisions", () => {
    const base = connectorSyncPolicyPreset("github", "execution_layer");
    const scoped = createConnectorSyncPolicyRecord({
      projectId: "PROJECT",
      id: "manual-title",
      connectionId: "github-main",
      name: "Manual titles",
      scopeQuery: "tag = needs-review",
      priority: 10,
      policy: {
        ...base,
        fields: {
          title: {
            field: "title",
            mode: "manual",
          },
        },
      },
    });
    const task = taskView("GH-1", ["needs-review"]);
    const resolution = resolveConnectorSyncPolicy({
      provider: "github",
      defaultPolicy: base,
      policies: [scoped],
      task,
      tasks: [task],
      dependencies: [],
    });

    const decision = decideResolvedConnectorFieldSync({
      resolution,
      diff: {
        field: "title",
        externalValue: "External title",
        localValue: "Local title",
      },
    });

    expect(decision).toMatchObject({
      kind: "manual_review",
      reason: expect.stringContaining("Policy source: Manual titles"),
    });
  });
});

describe("connector sync queue items", () => {
  it("captures field-level divergence, policy evidence, and action status", () => {
    const mapping: ConnectorExternalMapping = {
      projectId: "PROJECT",
      connectionId: "jira-main",
      provider: "jira",
      externalKind: "issue",
      externalId: "ENG:ENG-42",
      externalUrl: "https://acme.atlassian.net/browse/ENG-42",
      externalVersion: "e-1",
      localKind: "task",
      localId: "JIRA-ENG-42",
      localVersion: "7",
      syncDirection: "bidirectional",
      conflictPolicy: "operator_review",
      status: "active",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
      archivedAt: null,
      metadata: {},
    };

    const item = buildConnectorSyncQueueItem({
      mapping,
      policy: connectorSyncPolicyPreset("jira", "execution_layer"),
      policyId: "jira-default",
      scopeQuery: null,
      now: "2026-05-16T00:00:01.000Z",
      externalSnapshot: { title: "External" },
      localSnapshot: { title: "Local" },
      diff: {
        field: "title",
        externalValue: "External",
        localValue: "Local",
        externalVersion: "e-2",
        localVersion: "7",
      },
    });

    expect(item).toMatchObject({
      projectId: "PROJECT",
      connectionId: "jira-main",
      externalId: "ENG:ENG-42",
      localId: "JIRA-ENG-42",
      status: "pending",
      decision: { kind: "apply_inbound", proposedValue: "External" },
      policyRef: {
        preset: "execution_layer",
        policyId: "jira-default",
      },
    });
  });

  it("plans idempotent queue items from resolved field decisions", async () => {
    const base = connectorSyncPolicyPreset("github", "execution_layer");
    const task = taskView("GH-1", ["backend"]);
    const resolution = resolveConnectorSyncPolicy({
      provider: "github",
      defaultPolicy: base,
      task,
      tasks: [task],
      dependencies: [],
    });
    const mapping: ConnectorExternalMapping = {
      projectId: "PROJECT",
      connectionId: "github-main",
      provider: "github",
      externalKind: "issue",
      externalId: "acme/repo#1",
      externalUrl: "https://github.com/acme/repo/issues/1",
      externalVersion: "e-1",
      localKind: "task",
      localId: "GH-1",
      localVersion: "l-1",
      syncDirection: "bidirectional",
      conflictPolicy: "operator_review",
      status: "active",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
      archivedAt: null,
      metadata: {},
    };

    const input = {
      resolution,
      mapping,
      now: "2026-05-16T00:00:01.000Z",
      autoApply: true,
      externalSnapshot: { title: "External", labels: ["bug"] },
      localSnapshot: { title: "Local", labels: ["backend"] },
      diffs: [
        {
          field: "title",
          externalValue: "External",
          localValue: "Local",
          externalVersion: "e-2",
          localVersion: "l-1",
        },
        {
          field: "labels",
          externalValue: ["bug"],
          localValue: ["backend"],
          externalVersion: "e-2",
          localVersion: "l-1",
        },
      ],
    };

    const first = planConnectorSyncQueue(input);
    const second = planConnectorSyncQueue(input);

    expect(first.items.map((item) => item.id)).toEqual(
      second.items.map((item) => item.id),
    );
    expect(first.autoApplyItems).toHaveLength(2);
    expect(first.items).toEqual([
      expect.objectContaining({
        status: "auto_applying",
        decision: expect.objectContaining({ kind: "apply_inbound" }),
        policyRef: expect.objectContaining({ preset: "execution_layer" }),
      }),
      expect.objectContaining({
        status: "auto_applying",
        decision: expect.objectContaining({ kind: "apply_inbound" }),
      }),
    ]);

    const connectors = new FakeConnectors();
    await upsertConnectorSyncQueueItems({ connectors } as any, first.items);
    await upsertConnectorSyncQueueItems({ connectors } as any, second.items);
    expect(await connectors.listSyncQueueItems({ projectId: "PROJECT" }))
      .toHaveLength(2);
  });

  it("preserves manual review decisions when auto-apply is enabled", () => {
    const base = connectorSyncPolicyPreset("jira", "bidirectional_project_sync");
    const task = taskView("JIRA-1", []);
    const resolution = resolveConnectorSyncPolicy({
      provider: "jira",
      defaultPolicy: base,
      task,
      tasks: [task],
      dependencies: [],
    });

    const plan = planConnectorSyncQueue({
      resolution,
      autoApply: true,
      diffs: [{
        field: "external_state",
        externalValue: "Done",
        localValue: "In Progress",
      }],
    });

    expect(plan.autoApplyItems).toHaveLength(0);
    expect(plan.manualReviewItems).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      status: "manual_review",
      decision: { kind: "manual_review" },
    });
  });
});

describe("connector sync persistence helpers", () => {
  it("creates policy records with stable defaults", () => {
    const record = createConnectorSyncPolicyRecord({
      projectId: "PROJECT",
      id: "default",
      connectionId: "github-main",
      name: "Default",
      policy: connectorSyncPolicyPreset("github", "execution_layer"),
    }, "2026-05-16T00:00:00.000Z");

    expect(record).toMatchObject({
      id: "default",
      scopeQuery: null,
      priority: 0,
      enabled: true,
      createdAt: "2026-05-16T00:00:00.000Z",
    });
  });

  it("uses connector repositories for policy and queue persistence", async () => {
    const connectors = new FakeConnectors();
    const store = { connectors } as any;
    const policy = await upsertConnectorSyncPolicy(store, {
      projectId: "PROJECT",
      id: "default",
      connectionId: "github-main",
      name: "Default",
      policy: connectorSyncPolicyPreset("github", "execution_layer"),
    });
    const queueItem = buildConnectorSyncQueueItem({
      policy: policy.policy,
      mapping: {
        projectId: "PROJECT",
        connectionId: "github-main",
        provider: "github",
        externalKind: "issue",
        externalId: "acme/repo#1",
        externalUrl: "https://github.com/acme/repo/issues/1",
        externalVersion: "1",
        localKind: "task",
        localId: "GH-1",
        localVersion: "1",
        syncDirection: "bidirectional",
        conflictPolicy: "operator_review",
        status: "active",
        createdAt: "2026-05-16T00:00:00.000Z",
        updatedAt: "2026-05-16T00:00:00.000Z",
        archivedAt: null,
        metadata: {},
      },
      diff: {
        field: "title",
        externalValue: "External",
        localValue: "Local",
      },
    });
    await connectors.upsertSyncQueueItem(queueItem);

    await expect(listConnectorSyncPolicies(store, { projectId: "PROJECT" }))
      .resolves.toHaveLength(1);
    await expect(listConnectorSyncQueueItems(store, { projectId: "PROJECT" }))
      .resolves.toHaveLength(1);
    await expect(updateConnectorSyncQueueItemStatus(store, {
      projectId: "PROJECT",
      id: queueItem.id,
      status: "resolved",
      resolvedAt: "2026-05-16T00:00:01.000Z",
    })).resolves.toMatchObject({
      status: "resolved",
      resolvedAt: "2026-05-16T00:00:01.000Z",
    });
  });
});

class FakeConnectors {
  policies: ConnectorSyncPolicyRecord[] = [];
  queueItems: ConnectorSyncQueueItem[] = [];

  async upsertSyncPolicy(policy: ConnectorSyncPolicyRecord) {
    const index = this.policies.findIndex((item) =>
      item.projectId === policy.projectId && item.id === policy.id
    );
    if (index >= 0) this.policies[index] = policy;
    else this.policies.push(policy);
  }

  async getSyncPolicy(projectId: string, connectionId: string, id: string) {
    return this.policies.find((policy) =>
      policy.projectId === projectId &&
      policy.connectionId === connectionId &&
      policy.id === id
    ) ?? null;
  }

  async listSyncPolicies(options: { projectId?: string }) {
    return this.policies.filter((policy) =>
      !options.projectId || policy.projectId === options.projectId
    );
  }

  async upsertSyncQueueItem(item: ConnectorSyncQueueItem) {
    const index = this.queueItems.findIndex((existing) =>
      existing.projectId === item.projectId && existing.id === item.id
    );
    if (index >= 0) this.queueItems[index] = item;
    else this.queueItems.push(item);
  }

  async listSyncQueueItems(options: { projectId?: string }) {
    return this.queueItems.filter((item) =>
      !options.projectId || item.projectId === options.projectId
    );
  }

  async updateSyncQueueItemStatus(
    projectId: string,
    id: string,
    status: ConnectorSyncQueueItem["status"],
    options: { resolvedAt?: string | null },
  ) {
    const item = this.queueItems.find((candidate) =>
      candidate.projectId === projectId && candidate.id === id
    );
    if (!item) return null;
    item.status = status;
    item.resolvedAt = options.resolvedAt ?? null;
    return item;
  }
}

function taskView(id: string, tagNames: string[]) {
  return {
    projectId: "PROJECT",
    id,
    parentTaskId: null,
    title: id,
    description: "",
    lifecycle: "open",
    priority: 2,
    size: null,
    sourceDoc: null,
    sourceSection: null,
    sourceAnchor: null,
    sourceLine: null,
    sourceText: null,
    completionBar: null,
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    archivedAt: null,
    version: 1,
    computedStatus: "ready",
    ready: true,
    blocked: false,
    unfinishedDependenciesCount: 0,
    finishedDependenciesCount: 0,
    dependencyDepth: 0,
    dependentsCount: 0,
    transitiveDependentsCount: 0,
    parent: null,
    childrenCount: 0,
    descendantsCount: 0,
    leafDescendantsCount: 0,
    finishedLeafDescendantsCount: 0,
    subtreeProgress: 0,
    subtreeOpenCount: 0,
    subtreeReadyCount: 0,
    subtreeBlockedCount: 0,
    subtreeStartedCount: 0,
    subtreeFinishedCount: 0,
    hierarchyDepth: 0,
    rollupStatus: "leaf",
    unfinishedDescendantsCount: 0,
    criticalChildPath: [],
    assignedTrack: null,
    tags: tagNames.map((name) => ({
      projectId: "PROJECT",
      id: name.toUpperCase(),
      name,
      color: null,
      description: null,
      sortOrder: 0,
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
      archivedAt: null,
    })),
    commentCount: 0,
    recentCommentCount: 0,
    lastCommentAt: null,
    commentAuthors: [],
  } as any;
}
