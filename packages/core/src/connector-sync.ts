import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  nowIso,
  type ConnectorExternalMapping,
  type ConnectorFieldConflictPolicy,
  type ConnectorFieldDiff,
  type ConnectorFieldPolicy,
  type ConnectorFieldSyncMode,
  type ConnectorSyncDecision,
  type ConnectorSyncPolicy,
  type ConnectorSyncPreset,
  type ConnectorSyncQueueItem,
} from "./types.js";

export const connectorSyncPresetSchema = z.enum([
  "mirror_external_work",
  "execution_layer",
  "bidirectional_project_sync",
]);

export const connectorFieldSyncModeSchema = z.enum([
  "disabled",
  "manual",
  "inbound_only",
  "outbound_only",
  "bidirectional",
  "append_only",
  "unblock_owned",
  "external_owned",
]);

export const connectorFieldConflictPolicySchema = z.enum([
  "external_wins",
  "unblock_wins",
  "last_writer_wins",
  "manual_review",
  "blocked",
]);

export const connectorFieldPolicySchema: z.ZodType<ConnectorFieldPolicy> = z.object({
  field: z.string().min(1),
  mode: connectorFieldSyncModeSchema,
  conflictPolicy: connectorFieldConflictPolicySchema.optional(),
  outboundAction: z.string().min(1).nullable().optional(),
  requiredExternalDefaults: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().optional(),
});

export const connectorFieldPolicyRecordSchema = z.record(
  z.string(),
  connectorFieldPolicySchema,
);

export const connectorSyncPolicySchema: z.ZodType<ConnectorSyncPolicy> = z.object({
  preset: connectorSyncPresetSchema,
  provider: z.string().min(1),
  objectKind: z.string().min(1),
  fields: connectorFieldPolicyRecordSchema,
});

export interface ConnectorSyncDecisionInput {
  diff: ConnectorFieldDiff;
  policy: ConnectorSyncPolicy;
  policyId?: string | null | undefined;
  scopeQuery?: string | null | undefined;
  externalSnapshot?: Record<string, unknown> | undefined;
  localSnapshot?: Record<string, unknown> | undefined;
  mapping?: ConnectorExternalMapping | null | undefined;
  now?: string | undefined;
}

export function connectorSyncPolicyPreset(
  provider: string,
  preset: ConnectorSyncPreset = "execution_layer",
  objectKind = "issue",
): ConnectorSyncPolicy {
  if (preset === "mirror_external_work") {
    return {
      provider,
      preset,
      objectKind,
      fields: {
        title: field("title", "inbound_only"),
        description: field("description", "inbound_only"),
        external_state: field("external_state", "inbound_only"),
        labels: field("labels", "inbound_only"),
        comments: field("comments", "inbound_only"),
        responsibility: field("responsibility", "inbound_only"),
        execution_assignment: field("execution_assignment", "disabled"),
        dependencies: field("dependencies", "disabled"),
        instructions: field("instructions", "disabled"),
      },
    };
  }
  if (preset === "bidirectional_project_sync") {
    return {
      provider,
      preset,
      objectKind,
      fields: {
        title: field("title", "bidirectional", "manual_review"),
        description: field("description", "bidirectional", "manual_review"),
        external_state: field("external_state", "bidirectional", "manual_review"),
        labels: field("labels", "bidirectional", "manual_review"),
        comments: field("comments", "append_only"),
        responsibility: field("responsibility", "bidirectional", "manual_review"),
        execution_assignment: field("execution_assignment", "unblock_owned"),
        dependencies: field("dependencies", "unblock_owned"),
        instructions: field("instructions", "unblock_owned"),
      },
    };
  }
  return {
    provider,
    preset: "execution_layer",
    objectKind,
    fields: {
      title: field("title", "inbound_only"),
      description: field("description", "inbound_only"),
      external_state: field("external_state", "inbound_only"),
      labels: field("labels", "inbound_only"),
      comments: field("comments", "append_only"),
      responsibility: field("responsibility", "inbound_only"),
      execution_assignment: field("execution_assignment", "unblock_owned"),
      dependencies: field("dependencies", "unblock_owned"),
      instructions: field("instructions", "unblock_owned"),
      review_gates: field("review_gates", "unblock_owned"),
      progress_comments: field("progress_comments", "outbound_only"),
    },
  };
}

export function mergeConnectorSyncPolicies(
  base: ConnectorSyncPolicy,
  override: Partial<ConnectorSyncPolicy> & { fields?: Record<string, ConnectorFieldPolicy> },
): ConnectorSyncPolicy {
  return connectorSyncPolicySchema.parse({
    provider: override.provider ?? base.provider,
    preset: override.preset ?? base.preset,
    objectKind: override.objectKind ?? base.objectKind,
    fields: {
      ...base.fields,
      ...(override.fields ?? {}),
    },
  });
}

export function connectorFieldPolicy(
  policy: ConnectorSyncPolicy,
  fieldName: string,
): ConnectorFieldPolicy {
  return policy.fields[fieldName] ?? field(fieldName, "manual", "manual_review");
}

export function decideConnectorFieldSync(
  input: Pick<ConnectorSyncDecisionInput, "diff" | "policy">,
): ConnectorSyncDecision {
  const policy = connectorFieldPolicy(input.policy, input.diff.field);
  if (Object.is(input.diff.externalValue, input.diff.localValue)) {
    return decision("noop", input.diff, policy, "External and Unblock values already match.", "high");
  }
  switch (policy.mode) {
    case "disabled":
      return decision("ignore", input.diff, policy, "Field sync is disabled by policy.", "high");
    case "manual":
      return decision("manual_review", input.diff, policy, "Policy requires manual review.", "high");
    case "inbound_only":
    case "external_owned":
      return decision("apply_inbound", input.diff, policy, "External field is authoritative.", "high", input.diff.externalValue);
    case "outbound_only":
    case "unblock_owned":
      return decision("apply_outbound", input.diff, policy, "Unblock field is authoritative.", "high", input.diff.localValue);
    case "append_only":
      return decision("manual_review", input.diff, policy, "Append-only divergence must be represented as additive operations.", "medium");
    case "bidirectional":
      return decideBidirectional(input.diff, policy);
  }
}

export function buildConnectorSyncQueueItem(
  input: ConnectorSyncDecisionInput,
): ConnectorSyncQueueItem {
  const decision = decideConnectorFieldSync(input);
  const mapping = input.mapping ?? null;
  const status = queueStatusForDecision(decision);
  return {
    projectId: mapping?.projectId ?? "unknown",
    id: randomUUID(),
    connectionId: mapping?.connectionId ?? "unknown",
    mappingId: mapping
      ? `${mapping.provider}:${mapping.externalKind}:${mapping.externalId}`
      : null,
    externalKind: mapping?.externalKind ?? input.policy.objectKind,
    externalId: mapping?.externalId ?? "unknown",
    localKind: mapping?.localKind ?? "task",
    localId: mapping?.localId ?? "unknown",
    status,
    severity: status === "blocked" || status === "failed" ? "error" : status === "manual_review" ? "warning" : "info",
    detectedAt: input.now ?? nowIso(),
    resolvedAt: status === "ignored" || status === "resolved" ? (input.now ?? nowIso()) : null,
    decision,
    externalSnapshot: input.externalSnapshot ?? {},
    localSnapshot: input.localSnapshot ?? {},
    diff: input.diff,
    policyRef: {
      preset: input.policy.preset,
      policyId: input.policyId ?? null,
      scopeQuery: input.scopeQuery ?? null,
    },
    error: null,
  };
}

function decideBidirectional(
  diff: ConnectorFieldDiff,
  policy: ConnectorFieldPolicy,
): ConnectorSyncDecision {
  switch (policy.conflictPolicy ?? "manual_review") {
    case "external_wins":
      return decision("apply_inbound", diff, policy, "Bidirectional conflict policy lets external win.", "medium", diff.externalValue);
    case "unblock_wins":
      return decision("apply_outbound", diff, policy, "Bidirectional conflict policy lets Unblock win.", "medium", diff.localValue);
    case "last_writer_wins": {
      const externalTime = diff.externalUpdatedAt ? Date.parse(diff.externalUpdatedAt) : NaN;
      const localTime = diff.localUpdatedAt ? Date.parse(diff.localUpdatedAt) : NaN;
      if (Number.isFinite(externalTime) && Number.isFinite(localTime)) {
        return externalTime >= localTime
          ? decision("apply_inbound", diff, policy, "External value is the latest writer.", "medium", diff.externalValue)
          : decision("apply_outbound", diff, policy, "Unblock value is the latest writer.", "medium", diff.localValue);
      }
      return decision("manual_review", diff, policy, "Last-writer-wins needs comparable timestamps.", "low");
    }
    case "blocked":
      return decision("blocked", diff, policy, "Policy blocks automatic bidirectional conflict resolution.", "high");
    case "manual_review":
      return decision("manual_review", diff, policy, "Bidirectional divergence needs manual review.", "high");
  }
}

function queueStatusForDecision(
  decisionValue: ConnectorSyncDecision,
): ConnectorSyncQueueItem["status"] {
  switch (decisionValue.kind) {
    case "apply_inbound":
    case "apply_outbound":
      return "pending";
    case "blocked":
      return "blocked";
    case "manual_review":
      return "manual_review";
    case "ignore":
      return "ignored";
    case "noop":
      return "resolved";
  }
}

function field(
  fieldName: string,
  mode: ConnectorFieldSyncMode,
  conflictPolicy?: ConnectorFieldConflictPolicy,
): ConnectorFieldPolicy {
  return {
    field: fieldName,
    mode,
    ...(conflictPolicy ? { conflictPolicy } : {}),
  };
}

function decision(
  kind: ConnectorSyncDecision["kind"],
  diff: ConnectorFieldDiff,
  policy: ConnectorFieldPolicy,
  reason: string,
  confidence: ConnectorSyncDecision["confidence"],
  proposedValue?: unknown,
): ConnectorSyncDecision {
  return {
    kind,
    field: diff.field,
    policy,
    reason,
    confidence,
    diff,
    ...(proposedValue !== undefined ? { proposedValue } : {}),
  };
}
