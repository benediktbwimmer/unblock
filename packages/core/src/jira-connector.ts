import { z } from "zod";
import {
  connectorFieldPolicyRecordSchema,
  connectorSyncPolicyPreset,
  connectorSyncPresetSchema,
} from "./connector-sync.js";
import { upsertConnectorConnection } from "./connector-reconciliation.js";
import { validation } from "./errors.js";
import type { AppStore } from "./store.js";
import {
  nowIso,
  type ConnectorConnection,
  type ConnectorExternalMapping,
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
  assigneeAccountId: z.string().min(1).nullable().optional(),
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
    assigneeAccountId: string | null;
    [key: string]: unknown;
  };
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
      assigneeAccountId: parsed.assigneeAccountId ?? null,
    },
  };
  await repo.upsertMapping(mapping);
  return mapping;
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
