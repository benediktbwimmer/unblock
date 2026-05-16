import { z } from "zod";
import {
  connectorFieldPolicyRecordSchema,
  planConnectorSyncQueue,
  resolveConnectorSyncPolicy,
  connectorSyncPolicyPreset,
  connectorSyncPresetSchema,
  type ConnectorSyncPolicyResolutionInput,
  type ConnectorSyncQueuePlan,
} from "./connector-sync.js";
import { upsertConnectorConnection } from "./connector-reconciliation.js";
import { validation } from "./errors.js";
import type { AppStore } from "./store.js";
import {
  nowIso,
  type ConnectorConnection,
  type ConnectorExternalMapping,
  type ConnectorFieldDiff,
  type ConnectorSyncPolicyRecord,
  type ConnectorSyncPreset,
  type Dependency,
  type TaskView,
} from "./types.js";

export const jiraConnectorAuthModel = {
  mode: "jira_cloud_oauth_or_api_token",
  scopes: [
    "read:jira-work",
    "write:jira-work",
    "read:jira-user",
    "manage:jira-webhook",
  ],
  notes: [
    "Use OAuth for hosted enterprise installs where possible.",
    "Allow API-token secrets only for controlled self-managed trials.",
    "Store webhook secrets and tokens in hosted secret storage.",
  ],
} as const;

export const jiraConnectionInputSchema = z.object({
  projectId: z.string().min(1),
  connectionId: z.string().min(1).default("jira-main"),
  displayName: z.string().min(1).optional(),
  siteUrl: z.string().url(),
  cloudId: z.string().min(1).nullable().optional(),
  projectKey: z.string().min(1),
  accountEmail: z.string().email().optional(),
  tokenSecretId: z.string().min(1),
  webhookSecretId: z.string().min(1),
  syncPreset: connectorSyncPresetSchema.default("execution_layer"),
  fieldPolicies: connectorFieldPolicyRecordSchema.default({}),
});
export type JiraConnectionInput = z.infer<typeof jiraConnectionInputSchema>;

export const jiraConnectionMetadataSchema = z.object({
  authModel: z.literal("jira_cloud_oauth_or_api_token"),
  siteUrl: z.string().url(),
  cloudId: z.string().min(1).nullable(),
  projectKey: z.string().min(1),
  accountEmail: z.string().email().nullable(),
  tokenSecretId: z.string().min(1),
  webhookSecretId: z.string().min(1),
  syncPreset: connectorSyncPresetSchema,
  fieldPolicies: connectorFieldPolicyRecordSchema,
  scopes: z.array(z.string()),
});
export type JiraConnectionMetadata = z.infer<
  typeof jiraConnectionMetadataSchema
>;

export const jiraIssueMappingInputSchema = z.object({
  projectId: z.string().min(1),
  connectionId: z.string().min(1),
  siteUrl: z.string().url(),
  projectKey: z.string().min(1),
  issueKey: z.string().min(1),
  issueId: z.string().min(1).nullable().optional(),
  issueUrl: z.string().url(),
  taskId: z.string().min(1),
  issueType: z.string().min(1).nullable().optional(),
  statusName: z.string().min(1).nullable().optional(),
  statusCategory: z.string().min(1).nullable().optional(),
  assigneeAccountId: z.string().min(1).nullable().optional(),
  assigneeDisplayName: z.string().min(1).nullable().optional(),
  assigneeEmail: z.string().email().nullable().optional(),
  labels: z.array(z.string().min(1)).default([]),
  components: z.array(z.string().min(1)).default([]),
  requiredFields: z.record(z.string(), z.unknown()).default({}),
  externalVersion: z.string().min(1).nullable().optional(),
  localVersion: z.string().min(1).nullable().optional(),
  status: z.enum(["active", "conflict", "operator_review", "archived"]).default(
    "active",
  ),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type JiraIssueMappingInput = z.infer<
  typeof jiraIssueMappingInputSchema
>;

export interface JiraConnectorConnection extends ConnectorConnection {
  metadata: JiraConnectionMetadata;
}

export interface JiraIssueMapping extends ConnectorExternalMapping {
  provider: "jira";
  externalKind: "issue";
  localKind: "task";
  metadata: {
    siteUrl: string;
    projectKey: string;
    issueKey: string;
    issueId: string | null;
    issueType: string | null;
    statusName: string | null;
    statusCategory: string | null;
    assigneeAccountId: string | null;
    assigneeDisplayName: string | null;
    assigneeEmail: string | null;
    labels: string[];
    components: string[];
    requiredFields: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface JiraIssueExternalSnapshot {
  title?: string | undefined;
  description?: string | undefined;
  statusName?: string | null | undefined;
  statusCategory?: string | null | undefined;
  assigneeAccountId?: string | null | undefined;
  labels?: string[] | undefined;
  components?: string[] | undefined;
  requiredFields?: Record<string, unknown> | undefined;
  updatedAt?: string | null | undefined;
}

export interface JiraIssueLocalSnapshot {
  title?: string | undefined;
  description?: string | undefined;
  externalState?: string | null | undefined;
  responsibility?: string | null | undefined;
  labels?: string[] | undefined;
  components?: string[] | undefined;
  updatedAt?: string | null | undefined;
}

export interface JiraIssueSyncQueuePlanInput {
  mapping: JiraIssueMapping;
  external: JiraIssueExternalSnapshot;
  local: JiraIssueLocalSnapshot;
  preset?: ConnectorSyncPreset | undefined;
  policies?: ConnectorSyncPolicyRecord[] | undefined;
  task?: TaskView | undefined;
  tasks?: TaskView[] | undefined;
  dependencies?: Dependency[] | undefined;
  now?: string | undefined;
  autoApply?: boolean | undefined;
}

export async function upsertJiraConnection(
  store: AppStore,
  input: JiraConnectionInput,
): Promise<JiraConnectorConnection> {
  const parsed = jiraConnectionInputSchema.parse(input);
  await ensureSecretExists(store, parsed.tokenSecretId, parsed.projectId, "tokenSecretId");
  await ensureSecretExists(
    store,
    parsed.webhookSecretId,
    parsed.projectId,
    "webhookSecretId",
  );
  const metadata: JiraConnectionMetadata = {
    authModel: "jira_cloud_oauth_or_api_token",
    siteUrl: parsed.siteUrl,
    cloudId: parsed.cloudId ?? null,
    projectKey: parsed.projectKey,
    accountEmail: parsed.accountEmail ?? null,
    tokenSecretId: parsed.tokenSecretId,
    webhookSecretId: parsed.webhookSecretId,
    syncPreset: parsed.syncPreset,
    fieldPolicies: {
      ...connectorSyncPolicyPreset("jira", parsed.syncPreset, "issue").fields,
      ...parsed.fieldPolicies,
    },
    scopes: [...jiraConnectorAuthModel.scopes],
  };
  const connection = await upsertConnectorConnection(store, {
    projectId: parsed.projectId,
    connectionId: parsed.connectionId,
    provider: "jira",
    displayName: parsed.displayName ?? `Jira ${parsed.projectKey}`,
    status: "active",
    metadata,
  });
  return parseJiraConnection(connection);
}

export function parseJiraConnection(
  connection: ConnectorConnection,
): JiraConnectorConnection {
  if (connection.provider !== "jira") {
    validation("Connector connection is not a Jira connection.", {
      connectionId: connection.id,
      provider: connection.provider,
    });
  }
  return {
    ...connection,
    metadata: jiraConnectionMetadataSchema.parse(connection.metadata),
  };
}

export async function upsertJiraIssueMapping(
  store: AppStore,
  input: JiraIssueMappingInput,
): Promise<JiraIssueMapping> {
  const repo = requireMappingRepository(store);
  const parsed = jiraIssueMappingInputSchema.parse(input);
  const existing = await repo.getMappingByExternal(
    parsed.projectId,
    parsed.connectionId,
    "issue",
    jiraIssueExternalId(parsed),
  );
  const now = nowIso();
  const mapping: JiraIssueMapping = {
    projectId: parsed.projectId,
    connectionId: parsed.connectionId,
    provider: "jira",
    externalKind: "issue",
    externalId: jiraIssueExternalId(parsed),
    externalUrl: parsed.issueUrl,
    externalVersion: parsed.externalVersion ?? null,
    localKind: "task",
    localId: parsed.taskId,
    localVersion: parsed.localVersion ?? existing?.localVersion ?? null,
    syncDirection: "bidirectional",
    conflictPolicy: "operator_review",
    status: parsed.status,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    archivedAt: parsed.status === "archived"
      ? (existing?.archivedAt ?? now)
      : null,
    metadata: {
      ...parsed.metadata,
      siteUrl: parsed.siteUrl,
      projectKey: parsed.projectKey,
      issueKey: parsed.issueKey,
      issueId: parsed.issueId ?? null,
      issueType: parsed.issueType ?? null,
      statusName: parsed.statusName ?? null,
      statusCategory: parsed.statusCategory ?? null,
      assigneeAccountId: parsed.assigneeAccountId ?? null,
      assigneeDisplayName: parsed.assigneeDisplayName ?? null,
      assigneeEmail: parsed.assigneeEmail ?? null,
      labels: normalizedStringList(parsed.labels),
      components: normalizedStringList(parsed.components),
      requiredFields: parsed.requiredFields,
    },
  };
  await repo.upsertMapping(mapping);
  return mapping;
}

export async function listJiraConnections(
  store: AppStore,
  projectId?: string | undefined,
): Promise<JiraConnectorConnection[]> {
  const connections = await (store.connectors?.listConnections(projectId) ?? []);
  return connections
    .filter((connection) => connection.provider === "jira")
    .map(parseJiraConnection);
}

export async function listJiraIssueMappings(
  store: AppStore,
  options: {
    projectId?: string | undefined;
    connectionId?: string | undefined;
    limit?: number | undefined;
  } = {},
): Promise<JiraIssueMapping[]> {
  const repo = requireMappingRepository(store);
  const mappings = await repo.listMappings({
    ...options,
    provider: "jira",
  });
  return mappings
    .filter((mapping) => mapping.externalKind === "issue" && mapping.localKind === "task")
    .map(parseJiraIssueMapping);
}

export function planJiraIssueSyncQueue(
  input: JiraIssueSyncQueuePlanInput,
): ConnectorSyncQueuePlan {
  const resolutionInput: ConnectorSyncPolicyResolutionInput = {
    provider: "jira",
    objectKind: "issue",
    preset: input.preset,
    policies: input.policies,
    task: input.task,
    tasks: input.tasks,
    dependencies: input.dependencies,
  };
  const resolution = resolveConnectorSyncPolicy(resolutionInput);
  return planConnectorSyncQueue({
    resolution,
    mapping: input.mapping,
    diffs: jiraIssueFieldDiffs(input.external, input.local),
    externalSnapshot: {
      ...input.external,
      provider: "jira",
      issueKey: input.mapping.metadata.issueKey,
    },
    localSnapshot: input.local as Record<string, unknown>,
    now: input.now,
    autoApply: input.autoApply,
  });
}

export function jiraIssueFieldDiffs(
  external: JiraIssueExternalSnapshot,
  local: JiraIssueLocalSnapshot,
): ConnectorFieldDiff[] {
  const diffs: ConnectorFieldDiff[] = [];
  pushDiff(diffs, "title", external.title, local.title, external.updatedAt, local.updatedAt);
  pushDiff(diffs, "description", external.description, local.description, external.updatedAt, local.updatedAt);
  pushDiff(diffs, "external_state", external.statusName ?? null, local.externalState ?? null, external.updatedAt, local.updatedAt);
  pushDiff(
    diffs,
    "responsibility",
    external.assigneeAccountId ?? null,
    local.responsibility ?? null,
    external.updatedAt,
    local.updatedAt,
  );
  pushDiff(
    diffs,
    "labels",
    normalizedStringList(external.labels ?? []),
    normalizedStringList(local.labels ?? []),
    external.updatedAt,
    local.updatedAt,
  );
  pushDiff(
    diffs,
    "components",
    normalizedStringList(external.components ?? []),
    normalizedStringList(local.components ?? []),
    external.updatedAt,
    local.updatedAt,
  );
  const missingRequiredFields = Object.entries(external.requiredFields ?? {})
    .filter(([, value]) => value === null || value === undefined || value === "")
    .map(([fieldName]) => fieldName);
  if (missingRequiredFields.length > 0) {
    diffs.push({
      field: "required_fields",
      externalValue: external.requiredFields ?? {},
      localValue: { missing: missingRequiredFields },
      externalUpdatedAt: external.updatedAt ?? null,
      localUpdatedAt: local.updatedAt ?? null,
      reason: "Jira requires additional transition fields before outbound sync can apply.",
    });
  }
  return diffs;
}

export function jiraIssueExternalId(input: { projectKey: string; issueKey: string }): string {
  return `${input.projectKey}:${input.issueKey}`;
}

function parseJiraIssueMapping(
  mapping: ConnectorExternalMapping,
): JiraIssueMapping {
  if (
    mapping.provider !== "jira" || mapping.externalKind !== "issue" ||
    mapping.localKind !== "task"
  ) {
    validation("Connector mapping is not a Jira issue-to-task mapping.", {
      provider: mapping.provider,
      externalKind: mapping.externalKind,
      localKind: mapping.localKind,
    });
  }
  return {
    ...mapping,
    provider: "jira",
    externalKind: "issue",
    localKind: "task",
    metadata: mapping.metadata as JiraIssueMapping["metadata"],
  };
}

export async function getJiraIssueMappingByExternal(
  store: AppStore,
  projectId: string,
  connectionId: string,
  input: { projectKey: string; issueKey: string },
): Promise<JiraIssueMapping | null> {
  const repo = requireMappingRepository(store);
  const mapping = await repo.getMappingByExternal(
    projectId,
    connectionId,
    "issue",
    jiraIssueExternalId(input),
  );
  return mapping ? parseJiraIssueMapping(mapping) : null;
}

function pushDiff(
  diffs: ConnectorFieldDiff[],
  fieldName: string,
  externalValue: unknown,
  localValue: unknown,
  externalUpdatedAt?: string | null | undefined,
  localUpdatedAt?: string | null | undefined,
): void {
  if (normalizedComparable(externalValue) === normalizedComparable(localValue)) {
    return;
  }
  diffs.push({
    field: fieldName,
    externalValue,
    localValue,
    externalUpdatedAt,
    localUpdatedAt,
  });
}

function normalizedComparable(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(normalizedStringList(value));
  return JSON.stringify(value ?? null);
}

function normalizedStringList(values: readonly unknown[]): string[] {
  return [...new Set(values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim()))].sort((left, right) => left.localeCompare(right));
}

async function ensureSecretExists(
  store: AppStore,
  secretId: string,
  projectId: string,
  field: string,
): Promise<void> {
  const secret = await store.hostedSecrets?.get(secretId);
  if (!secret) {
    validation(
      `Jira connection ${field} does not reference an existing hosted secret.`,
      { secretId },
    );
  }
  if (secret.projectId !== null && secret.projectId !== projectId) {
    validation(
      `Jira connection ${field} references a secret from another project.`,
      { secretId, projectId: secret.projectId },
    );
  }
  if (secret.archivedAt) {
    validation(`Jira connection ${field} references an archived secret.`, {
      secretId,
    });
  }
}

function requireMappingRepository(
  store: AppStore,
): Required<
  Pick<
    NonNullable<AppStore["connectors"]>,
    | "upsertMapping"
    | "getMappingByExternal"
    | "getMappingByLocal"
    | "listMappings"
  >
> {
  const connectors = store.connectors;
  if (
    !connectors?.upsertMapping || !connectors.getMappingByExternal ||
    !connectors.getMappingByLocal || !connectors.listMappings
  ) {
    validation(
      "Jira issue mappings require a store with connector mapping support.",
    );
  }
  return connectors as Required<
    Pick<
      NonNullable<AppStore["connectors"]>,
      | "upsertMapping"
      | "getMappingByExternal"
      | "getMappingByLocal"
      | "listMappings"
    >
  >;
}
