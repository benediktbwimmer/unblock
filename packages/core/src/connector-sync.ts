import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { validation } from "./errors.js";
import { matchMatcherQuery } from "./matcher-query.js";
import type { AppStore, ConnectorRepository } from "./store.js";
import {
  nowIso,
  type ConnectorExternalMapping,
  type ConnectorFieldConflictPolicy,
  type ConnectorFieldDiff,
  type ConnectorFieldPolicy,
  type ConnectorFieldSyncMode,
  type ConnectorSyncDecision,
  type ConnectorSyncPolicy,
  type ConnectorSyncPolicyRecord,
  type ConnectorSyncPreset,
  type ConnectorSyncQueueItem,
  type ConnectorSyncQueueItemStatus,
  type Dependency,
  type TaskView,
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

export const connectorSyncPolicyRecordInputSchema = z.object({
  projectId: z.string().min(1),
  id: z.string().min(1).optional(),
  connectionId: z.string().min(1),
  name: z.string().min(1),
  scopeQuery: z.string().min(1).nullable().optional(),
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true),
  policy: connectorSyncPolicySchema,
});
export type ConnectorSyncPolicyRecordInput = z.infer<
  typeof connectorSyncPolicyRecordInputSchema
>;

export const connectorSyncQueueItemStatusSchema = z.enum([
  "pending",
  "auto_applying",
  "blocked",
  "manual_review",
  "ignored",
  "resolved",
  "failed",
]);

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

export type ConnectorSyncPolicyResolutionSkipReason =
  | "disabled"
  | "archived"
  | "provider_mismatch"
  | "object_kind_mismatch"
  | "scope_not_evaluated"
  | "scope_not_matched";

export interface ConnectorSyncPolicyResolutionRef {
  id: string | null;
  name: string;
  scopeQuery: string | null;
  priority: number;
  fields: string[];
  reason: string;
}

export interface ConnectorSyncPolicyResolutionSkippedRef
  extends ConnectorSyncPolicyResolutionRef {
  skipReason: ConnectorSyncPolicyResolutionSkipReason;
}

export interface ConnectorSyncPolicyResolution {
  policy: ConnectorSyncPolicy;
  basePolicy: ConnectorSyncPolicy;
  appliedPolicies: ConnectorSyncPolicyResolutionRef[];
  skippedPolicies: ConnectorSyncPolicyResolutionSkippedRef[];
  fieldSources: Record<string, ConnectorSyncPolicyResolutionRef>;
  explanation: string[];
}

export interface ConnectorSyncPolicyResolutionInput {
  provider: string;
  objectKind?: string | undefined;
  preset?: ConnectorSyncPreset | undefined;
  defaultPolicy?: ConnectorSyncPolicy | undefined;
  policies?: ConnectorSyncPolicyRecord[] | undefined;
  task?: TaskView | undefined;
  tasks?: TaskView[] | undefined;
  dependencies?: Dependency[] | undefined;
}

export interface ConnectorSyncQueuePlanInput {
  resolution: ConnectorSyncPolicyResolution;
  diffs: ConnectorFieldDiff[];
  mapping?: ConnectorExternalMapping | null | undefined;
  externalSnapshot?: Record<string, unknown> | undefined;
  localSnapshot?: Record<string, unknown> | undefined;
  now?: string | undefined;
  autoApply?:
    | boolean
    | ((decision: ConnectorSyncDecision) => boolean)
    | undefined;
}

export interface ConnectorSyncQueuePlan {
  items: ConnectorSyncQueueItem[];
  autoApplyItems: ConnectorSyncQueueItem[];
  pendingItems: ConnectorSyncQueueItem[];
  manualReviewItems: ConnectorSyncQueueItem[];
  blockedItems: ConnectorSyncQueueItem[];
  resolvedItems: ConnectorSyncQueueItem[];
  ignoredItems: ConnectorSyncQueueItem[];
}

export function createConnectorSyncPolicyRecord(
  input: ConnectorSyncPolicyRecordInput,
  now = nowIso(),
): ConnectorSyncPolicyRecord {
  const parsed = connectorSyncPolicyRecordInputSchema.parse(input);
  return {
    projectId: parsed.projectId,
    id: parsed.id ?? randomUUID(),
    connectionId: parsed.connectionId,
    name: parsed.name,
    scopeQuery: parsed.scopeQuery ?? null,
    priority: parsed.priority,
    enabled: parsed.enabled,
    policy: parsed.policy,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}

export async function upsertConnectorSyncPolicy(
  store: AppStore,
  input: ConnectorSyncPolicyRecordInput,
): Promise<ConnectorSyncPolicyRecord> {
  const connectors = requireConnectorSyncPolicyRepository(store.connectors);
  const now = nowIso();
  const existing = input.id
    ? await connectors.getSyncPolicy(input.projectId, input.connectionId, input.id)
    : null;
  const record = {
    ...createConnectorSyncPolicyRecord(input, now),
    createdAt: existing?.createdAt ?? now,
    archivedAt: existing?.archivedAt ?? null,
  };
  await connectors.upsertSyncPolicy(record);
  return record;
}

export async function listConnectorSyncPolicies(
  store: AppStore,
  options: {
    projectId?: string | undefined;
    connectionId?: string | undefined;
    includeArchived?: boolean | undefined;
    limit?: number | undefined;
  },
): Promise<ConnectorSyncPolicyRecord[]> {
  const connectors = requireConnectorSyncPolicyRepository(store.connectors);
  return connectors.listSyncPolicies(options);
}

export async function listConnectorSyncQueueItems(
  store: AppStore,
  options: {
    projectId?: string | undefined;
    connectionId?: string | undefined;
    status?: ConnectorSyncQueueItemStatus | undefined;
    limit?: number | undefined;
  },
): Promise<ConnectorSyncQueueItem[]> {
  const connectors = requireConnectorSyncQueueRepository(store.connectors);
  return connectors.listSyncQueueItems(options);
}

export async function updateConnectorSyncQueueItemStatus(
  store: AppStore,
  input: {
    projectId: string;
    id: string;
    status: ConnectorSyncQueueItemStatus;
    resolvedAt?: string | null | undefined;
    error?: Record<string, unknown> | null | undefined;
  },
): Promise<ConnectorSyncQueueItem> {
  const connectors = requireConnectorSyncQueueRepository(store.connectors);
  const item = await connectors.updateSyncQueueItemStatus(
    input.projectId,
    input.id,
    input.status,
    {
      resolvedAt: input.resolvedAt,
      error: input.error,
    },
  );
  if (!item) {
    validation("Connector sync queue item not found.", {
      projectId: input.projectId,
      id: input.id,
    });
  }
  return item;
}

export async function upsertConnectorSyncQueueItems(
  store: AppStore,
  items: ConnectorSyncQueueItem[],
): Promise<ConnectorSyncQueueItem[]> {
  const connectors = requireConnectorSyncQueueRepository(store.connectors);
  for (const item of items) {
    await connectors.upsertSyncQueueItem(item);
  }
  return items;
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

export function resolveConnectorSyncPolicy(
  input: ConnectorSyncPolicyResolutionInput,
): ConnectorSyncPolicyResolution {
  const objectKind = input.objectKind ?? input.defaultPolicy?.objectKind ?? "issue";
  const basePolicy = connectorSyncPolicySchema.parse(
    input.defaultPolicy ?? connectorSyncPolicyPreset(input.provider, input.preset ?? "execution_layer", objectKind),
  );
  const activePolicies = [...(input.policies ?? [])].sort(comparePolicyRecordForApplication);
  const appliedPolicies: ConnectorSyncPolicyResolutionRef[] = [{
    id: null,
    name: `${basePolicy.provider}:${basePolicy.preset}`,
    scopeQuery: null,
    priority: Number.NEGATIVE_INFINITY,
    fields: Object.keys(basePolicy.fields).sort(),
    reason: "Default connector preset.",
  }];
  const skippedPolicies: ConnectorSyncPolicyResolutionSkippedRef[] = [];
  const fieldSources: Record<string, ConnectorSyncPolicyResolutionRef> = {};
  for (const fieldName of Object.keys(basePolicy.fields)) {
    fieldSources[fieldName] = appliedPolicies[0]!;
  }
  let policy = basePolicy;

  for (const record of activePolicies) {
    const ref = policyResolutionRef(record);
    const skipReason = skipPolicyResolution(record, basePolicy, input);
    if (skipReason) {
      skippedPolicies.push({
        ...ref,
        skipReason,
        reason: policySkipReasonText(skipReason),
      });
      continue;
    }
    const appliedRef = {
      ...ref,
      reason: record.scopeQuery
        ? `Matcher scope matched: ${record.scopeQuery}`
        : "Connector-level default policy.",
    };
    policy = mergeConnectorSyncPolicies(policy, record.policy);
    appliedPolicies.push(appliedRef);
    for (const fieldName of ref.fields) {
      fieldSources[fieldName] = appliedRef;
    }
  }

  return {
    policy,
    basePolicy,
    appliedPolicies,
    skippedPolicies,
    fieldSources,
    explanation: [
      `Started from ${basePolicy.provider} ${basePolicy.preset} ${basePolicy.objectKind} policy.`,
      ...appliedPolicies.slice(1).map((item) =>
        `Applied ${item.name} (${item.id ?? "default"})${item.scopeQuery ? ` for ${item.scopeQuery}` : ""}.`
      ),
      ...skippedPolicies.map((item) =>
        `Skipped ${item.name} (${item.id ?? "default"}): ${item.reason}`
      ),
    ],
  };
}

export function decideResolvedConnectorFieldSync(
  input: Omit<ConnectorSyncDecisionInput, "policy"> & {
    resolution: ConnectorSyncPolicyResolution;
  },
): ConnectorSyncDecision {
  const decisionValue = decideConnectorFieldSync({
    diff: input.diff,
    policy: input.resolution.policy,
  });
  const source = input.resolution.fieldSources[input.diff.field];
  if (!source) {
    return decisionValue;
  }
  return {
    ...decisionValue,
    reason: `${decisionValue.reason} Policy source: ${source.name}${source.scopeQuery ? ` (${source.scopeQuery})` : ""}.`,
  };
}

export function planConnectorSyncQueue(
  input: ConnectorSyncQueuePlanInput,
): ConnectorSyncQueuePlan {
  const items = input.diffs.map((diff) => {
    const decisionValue = decideResolvedConnectorFieldSync({
      resolution: input.resolution,
      diff,
      mapping: input.mapping,
      externalSnapshot: input.externalSnapshot,
      localSnapshot: input.localSnapshot,
      now: input.now,
    });
    const source = input.resolution.fieldSources[diff.field] ?? null;
    const autoApply = typeof input.autoApply === "function"
      ? input.autoApply(decisionValue)
      : input.autoApply === true;
    return buildConnectorSyncQueueItemFromDecision({
      decision: decisionValue,
      policy: input.resolution.policy,
      policyId: source?.id ?? null,
      scopeQuery: source?.scopeQuery ?? null,
      mapping: input.mapping,
      externalSnapshot: input.externalSnapshot,
      localSnapshot: input.localSnapshot,
      now: input.now,
      autoApply,
    });
  });
  return {
    items,
    autoApplyItems: items.filter((item) => item.status === "auto_applying"),
    pendingItems: items.filter((item) => item.status === "pending"),
    manualReviewItems: items.filter((item) => item.status === "manual_review"),
    blockedItems: items.filter((item) => item.status === "blocked"),
    resolvedItems: items.filter((item) => item.status === "resolved"),
    ignoredItems: items.filter((item) => item.status === "ignored"),
  };
}

export function buildConnectorSyncQueueItemFromDecision(
  input: Omit<ConnectorSyncDecisionInput, "diff"> & {
    decision: ConnectorSyncDecision;
    policy: ConnectorSyncPolicy;
    autoApply?: boolean | undefined;
  },
): ConnectorSyncQueueItem {
  const mapping = input.mapping ?? null;
  const status = queueStatusForDecision(input.decision, input.autoApply === true);
  const now = input.now ?? nowIso();
  return {
    projectId: mapping?.projectId ?? "unknown",
    id: connectorSyncQueueItemId({
      mapping,
      decision: input.decision,
      policyId: input.policyId,
      scopeQuery: input.scopeQuery,
    }),
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
    detectedAt: now,
    resolvedAt: status === "ignored" || status === "resolved" ? now : null,
    decision: input.decision,
    externalSnapshot: input.externalSnapshot ?? {},
    localSnapshot: input.localSnapshot ?? {},
    diff: input.decision.diff ?? {
      field: input.decision.field,
      externalValue: undefined,
      localValue: undefined,
    },
    policyRef: {
      preset: input.policy.preset,
      policyId: input.policyId ?? null,
      scopeQuery: input.scopeQuery ?? null,
    },
    error: null,
  };
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
  return buildConnectorSyncQueueItemFromDecision({
    ...input,
    decision,
  });
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

function comparePolicyRecordForApplication(
  left: ConnectorSyncPolicyRecord,
  right: ConnectorSyncPolicyRecord,
): number {
  return left.priority - right.priority ||
    left.updatedAt.localeCompare(right.updatedAt) ||
    left.id.localeCompare(right.id);
}

function policyResolutionRef(
  record: ConnectorSyncPolicyRecord,
): ConnectorSyncPolicyResolutionRef {
  return {
    id: record.id,
    name: record.name,
    scopeQuery: record.scopeQuery,
    priority: record.priority,
    fields: Object.keys(record.policy.fields).sort(),
    reason: "",
  };
}

function skipPolicyResolution(
  record: ConnectorSyncPolicyRecord,
  basePolicy: ConnectorSyncPolicy,
  input: ConnectorSyncPolicyResolutionInput,
): ConnectorSyncPolicyResolutionSkipReason | null {
  if (!record.enabled) return "disabled";
  if (record.archivedAt) return "archived";
  if (record.policy.provider !== basePolicy.provider) return "provider_mismatch";
  if (record.policy.objectKind !== basePolicy.objectKind) return "object_kind_mismatch";
  if (!record.scopeQuery) return null;
  if (!input.task || !input.tasks || !input.dependencies) {
    return "scope_not_evaluated";
  }
  const matches = matchMatcherQuery(record.scopeQuery, input.tasks, input.dependencies)
    .some((match) => match.task.id === input.task?.id);
  return matches ? null : "scope_not_matched";
}

function policySkipReasonText(
  reason: ConnectorSyncPolicyResolutionSkipReason,
): string {
  switch (reason) {
    case "disabled":
      return "policy is disabled";
    case "archived":
      return "policy is archived";
    case "provider_mismatch":
      return "provider does not match the connector";
    case "object_kind_mismatch":
      return "object kind does not match the connector object";
    case "scope_not_evaluated":
      return "matcher scope needs task and dependency context";
    case "scope_not_matched":
      return "matcher scope did not match the local task";
  }
}

function queueStatusForDecision(
  decisionValue: ConnectorSyncDecision,
  autoApply = false,
): ConnectorSyncQueueItem["status"] {
  switch (decisionValue.kind) {
    case "apply_inbound":
    case "apply_outbound":
      return autoApply ? "auto_applying" : "pending";
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

function connectorSyncQueueItemId(input: {
  mapping: ConnectorExternalMapping | null;
  decision: ConnectorSyncDecision;
  policyId?: string | null | undefined;
  scopeQuery?: string | null | undefined;
}): string {
  const diff = input.decision.diff;
  const identity = {
    connectionId: input.mapping?.connectionId ?? "unknown",
    externalKind: input.mapping?.externalKind ?? "unknown",
    externalId: input.mapping?.externalId ?? "unknown",
    localKind: input.mapping?.localKind ?? "task",
    localId: input.mapping?.localId ?? "unknown",
    field: input.decision.field,
    externalVersion: diff?.externalVersion ?? null,
    localVersion: diff?.localVersion ?? null,
    externalUpdatedAt: diff?.externalUpdatedAt ?? null,
    localUpdatedAt: diff?.localUpdatedAt ?? null,
    policyId: input.policyId ?? null,
    scopeQuery: input.scopeQuery ?? null,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 24);
  return `syncq_${digest}`;
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

function requireConnectorSyncPolicyRepository(
  connectors: ConnectorRepository | undefined,
): Required<
  Pick<
    ConnectorRepository,
    "upsertSyncPolicy" | "getSyncPolicy" | "listSyncPolicies"
  >
> {
  if (
    !connectors?.upsertSyncPolicy || !connectors.getSyncPolicy ||
    !connectors.listSyncPolicies
  ) {
    validation(
      "Connector sync policies require a store with connector sync policy support.",
    );
  }
  return connectors as Required<
    Pick<
      ConnectorRepository,
      "upsertSyncPolicy" | "getSyncPolicy" | "listSyncPolicies"
    >
  >;
}

function requireConnectorSyncQueueRepository(
  connectors: ConnectorRepository | undefined,
): Required<
  Pick<
    ConnectorRepository,
    "upsertSyncQueueItem" | "listSyncQueueItems" | "updateSyncQueueItemStatus"
  >
> {
  if (!connectors?.upsertSyncQueueItem || !connectors.listSyncQueueItems || !connectors.updateSyncQueueItemStatus) {
    validation(
      "Connector sync queue requires a store with connector sync queue support.",
    );
  }
  return connectors as Required<
    Pick<
      ConnectorRepository,
      "upsertSyncQueueItem" | "listSyncQueueItems" | "updateSyncQueueItemStatus"
    >
  >;
}
