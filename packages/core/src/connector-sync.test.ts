import { describe, expect, it } from "vitest";
import {
  buildConnectorSyncQueueItem,
  connectorSyncPolicyPreset,
  decideConnectorFieldSync,
  mergeConnectorSyncPolicies,
} from "./connector-sync.js";
import type { ConnectorExternalMapping } from "./types.js";

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
