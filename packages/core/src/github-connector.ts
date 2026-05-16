import { z } from "zod";
import {
  connectorFieldPolicyRecordSchema,
  connectorSyncPolicyPreset,
  connectorSyncPresetSchema,
} from "./connector-sync.js";
import { validation } from "./errors.js";
import { upsertConnectorConnection } from "./connector-reconciliation.js";
import type { AppStore } from "./store.js";
import {
  type ConnectorConnection,
  type ConnectorExternalMapping,
  nowIso,
} from "./types.js";

export const githubConnectorAuthModel = {
  mode: "github_app_installation",
  repositoryPermissions: {
    metadata: "read",
    issues: "write",
  },
  subscribeEvents: ["issues", "issue_comment"],
  notes: [
    "Use installation access tokens scoped to the selected repository set.",
    "Store GitHub App private keys and webhook secrets in hosted secret storage.",
    "Do not use user PATs or broad OAuth tokens for hosted connector sync.",
  ],
} as const;

export const githubConnectionInputSchema = z.object({
  projectId: z.string().min(1),
  connectionId: z.string().min(1).default("github-main"),
  displayName: z.string().min(1).optional(),
  appId: z.string().min(1),
  installationId: z.string().min(1),
  repositoryOwner: z.string().min(1),
  repositoryName: z.string().min(1),
  repositoryId: z.string().min(1).optional(),
  privateKeySecretId: z.string().min(1),
  webhookSecretId: z.string().min(1),
  syncDirection: z.enum([
    "github_to_unblock",
    "unblock_to_github",
    "bidirectional",
  ]).default("bidirectional"),
  syncPreset: connectorSyncPresetSchema.default("execution_layer"),
  fieldPolicies: connectorFieldPolicyRecordSchema.default({}),
  conflictPolicy: z.enum([
    "github_wins",
    "unblock_wins",
    "last_writer_wins",
    "operator_review",
  ]).default("operator_review"),
});
export type GitHubConnectionInput = z.infer<typeof githubConnectionInputSchema>;

export const githubConnectionMetadataSchema = z.object({
  authModel: z.literal("github_app_installation"),
  appId: z.string().min(1),
  installationId: z.string().min(1),
  repositoryOwner: z.string().min(1),
  repositoryName: z.string().min(1),
  repositoryId: z.string().min(1).nullable(),
  privateKeySecretId: z.string().min(1),
  webhookSecretId: z.string().min(1),
  syncDirection: z.enum([
    "github_to_unblock",
    "unblock_to_github",
    "bidirectional",
  ]),
  syncPreset: connectorSyncPresetSchema.default("execution_layer"),
  fieldPolicies: connectorFieldPolicyRecordSchema.default({}),
  conflictPolicy: z.enum([
    "github_wins",
    "unblock_wins",
    "last_writer_wins",
    "operator_review",
  ]),
  requiredPermissions: z.record(z.string(), z.string()),
  subscribeEvents: z.array(z.string()),
});
export type GitHubConnectionMetadata = z.infer<
  typeof githubConnectionMetadataSchema
>;

export const githubIssueMappingInputSchema = z.object({
  projectId: z.string().min(1),
  connectionId: z.string().min(1),
  repositoryOwner: z.string().min(1),
  repositoryName: z.string().min(1),
  issueNumber: z.number().int().positive(),
  issueNodeId: z.string().min(1).optional(),
  issueUrl: z.string().url(),
  taskId: z.string().min(1),
  externalVersion: z.string().min(1).nullable().optional(),
  localVersion: z.string().min(1).nullable().optional(),
  syncDirection: z.enum([
    "github_to_unblock",
    "unblock_to_github",
    "bidirectional",
  ]).default("bidirectional"),
  conflictPolicy: z.enum([
    "github_wins",
    "unblock_wins",
    "last_writer_wins",
    "operator_review",
  ]).default("operator_review"),
  status: z.enum(["active", "conflict", "operator_review", "archived"]).default(
    "active",
  ),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type GitHubIssueMappingInput = z.infer<
  typeof githubIssueMappingInputSchema
>;

export interface GitHubConnectorConnection extends ConnectorConnection {
  metadata: GitHubConnectionMetadata;
}

export interface GitHubIssueMapping extends ConnectorExternalMapping {
  provider: "github";
  externalKind: "issue";
  localKind: "task";
  metadata: {
    repositoryOwner: string;
    repositoryName: string;
    issueNumber: number;
    issueNodeId: string | null;
    [key: string]: unknown;
  };
}

export async function upsertGitHubConnection(
  store: AppStore,
  input: GitHubConnectionInput,
): Promise<GitHubConnectorConnection> {
  const parsed = githubConnectionInputSchema.parse(input);
  await ensureSecretExists(
    store,
    parsed.privateKeySecretId,
    parsed.projectId,
    "privateKeySecretId",
  );
  await ensureSecretExists(
    store,
    parsed.webhookSecretId,
    parsed.projectId,
    "webhookSecretId",
  );
  const metadata: GitHubConnectionMetadata = {
    authModel: "github_app_installation",
    appId: parsed.appId,
    installationId: parsed.installationId,
    repositoryOwner: parsed.repositoryOwner,
    repositoryName: parsed.repositoryName,
    repositoryId: parsed.repositoryId ?? null,
    privateKeySecretId: parsed.privateKeySecretId,
    webhookSecretId: parsed.webhookSecretId,
    syncDirection: parsed.syncDirection,
    syncPreset: parsed.syncPreset,
    fieldPolicies: {
      ...connectorSyncPolicyPreset("github", parsed.syncPreset, "issue").fields,
      ...parsed.fieldPolicies,
    },
    conflictPolicy: parsed.conflictPolicy,
    requiredPermissions: githubConnectorAuthModel.repositoryPermissions,
    subscribeEvents: [...githubConnectorAuthModel.subscribeEvents],
  };
  const connection = await upsertConnectorConnection(store, {
    projectId: parsed.projectId,
    connectionId: parsed.connectionId,
    provider: "github",
    displayName: parsed.displayName ??
      `GitHub ${parsed.repositoryOwner}/${parsed.repositoryName}`,
    status: "active",
    metadata,
  });
  return parseGitHubConnection(connection);
}

export function parseGitHubConnection(
  connection: ConnectorConnection,
): GitHubConnectorConnection {
  if (connection.provider !== "github") {
    validation("Connector connection is not a GitHub connection.", {
      connectionId: connection.id,
      provider: connection.provider,
    });
  }
  return {
    ...connection,
    metadata: githubConnectionMetadataSchema.parse(connection.metadata),
  };
}

export async function listGitHubConnections(
  store: AppStore,
  projectId?: string | undefined,
): Promise<GitHubConnectorConnection[]> {
  const connections = await store.connectors?.listConnections(projectId) ?? [];
  return connections
    .filter((connection) => connection.provider === "github")
    .map(parseGitHubConnection);
}

export async function upsertGitHubIssueMapping(
  store: AppStore,
  input: GitHubIssueMappingInput,
): Promise<GitHubIssueMapping> {
  const repo = requireMappingRepository(store);
  const parsed = githubIssueMappingInputSchema.parse(input);
  const existing = await repo.getMappingByExternal(
    parsed.projectId,
    parsed.connectionId,
    "issue",
    githubIssueExternalId(parsed),
  );
  const now = nowIso();
  const mapping: GitHubIssueMapping = {
    projectId: parsed.projectId,
    connectionId: parsed.connectionId,
    provider: "github",
    externalKind: "issue",
    externalId: githubIssueExternalId(parsed),
    externalUrl: parsed.issueUrl,
    externalVersion: parsed.externalVersion ?? null,
    localKind: "task",
    localId: parsed.taskId,
    localVersion: parsed.localVersion ?? existing?.localVersion ?? null,
    syncDirection: parsed.syncDirection,
    conflictPolicy: parsed.conflictPolicy,
    status: parsed.status,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    archivedAt: parsed.status === "archived"
      ? (existing?.archivedAt ?? now)
      : null,
    metadata: {
      ...parsed.metadata,
      repositoryOwner: parsed.repositoryOwner,
      repositoryName: parsed.repositoryName,
      issueNumber: parsed.issueNumber,
      issueNodeId: parsed.issueNodeId ?? null,
    },
  };
  await repo.upsertMapping(mapping);
  return mapping;
}

export async function getGitHubIssueMappingByExternal(
  store: AppStore,
  projectId: string,
  connectionId: string,
  input: {
    repositoryOwner: string;
    repositoryName: string;
    issueNumber: number;
  },
): Promise<GitHubIssueMapping | null> {
  const repo = requireMappingRepository(store);
  const mapping = await repo.getMappingByExternal(
    projectId,
    connectionId,
    "issue",
    githubIssueExternalId(input),
  );
  return mapping ? parseGitHubIssueMapping(mapping) : null;
}

export async function getGitHubIssueMappingByTask(
  store: AppStore,
  projectId: string,
  connectionId: string,
  taskId: string,
): Promise<GitHubIssueMapping | null> {
  const repo = requireMappingRepository(store);
  const mapping = await repo.getMappingByLocal(
    projectId,
    connectionId,
    "task",
    taskId,
  );
  return mapping ? parseGitHubIssueMapping(mapping) : null;
}

export async function listGitHubIssueMappings(
  store: AppStore,
  options: {
    projectId?: string | undefined;
    connectionId?: string | undefined;
    limit?: number | undefined;
  },
): Promise<GitHubIssueMapping[]> {
  const repo = requireMappingRepository(store);
  const mappings = await repo.listMappings({ ...options, provider: "github" });
  return mappings.filter((mapping) =>
    mapping.externalKind === "issue" && mapping.localKind === "task"
  ).map(parseGitHubIssueMapping);
}

export function githubIssueExternalId(
  input: {
    repositoryOwner: string;
    repositoryName: string;
    issueNumber: number;
  },
): string {
  return `${input.repositoryOwner}/${input.repositoryName}#${input.issueNumber}`;
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
      `GitHub connection ${field} does not reference an existing hosted secret.`,
      { secretId },
    );
  }
  if (secret.projectId !== null && secret.projectId !== projectId) {
    validation(
      `GitHub connection ${field} references a secret from another project.`,
      { secretId, projectId: secret.projectId },
    );
  }
  if (secret.archivedAt) {
    validation(`GitHub connection ${field} references an archived secret.`, {
      secretId,
    });
  }
}

function parseGitHubIssueMapping(
  mapping: ConnectorExternalMapping,
): GitHubIssueMapping {
  if (
    mapping.provider !== "github" || mapping.externalKind !== "issue" ||
    mapping.localKind !== "task"
  ) {
    validation("Connector mapping is not a GitHub issue-to-task mapping.", {
      provider: mapping.provider,
      externalKind: mapping.externalKind,
      localKind: mapping.localKind,
    });
  }
  return {
    ...mapping,
    provider: "github",
    externalKind: "issue",
    localKind: "task",
    metadata: mapping.metadata as GitHubIssueMapping["metadata"],
  };
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
      "GitHub issue mappings require a store with connector mapping support.",
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
