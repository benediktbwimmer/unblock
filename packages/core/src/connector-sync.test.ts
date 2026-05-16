import { describe, expect, it } from "vitest";
import {
  buildConnectorSyncQueueItem,
  createConnectorSyncPolicyRecord,
  connectorSyncPolicyPreset,
  decideConnectorFieldSync,
  listConnectorSyncPolicies,
  listConnectorSyncQueueItems,
  mergeConnectorSyncPolicies,
  updateConnectorSyncQueueItemStatus,
  upsertConnectorSyncPolicy,
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
