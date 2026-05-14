import { z } from "zod";
import { validation } from "./errors.js";
import { upsertConnectorConnection } from "./connector-reconciliation.js";
import type { AppStore } from "./store.js";
import { type ConnectorConnection } from "./types.js";

export const githubConnectorAuthModel = {
  mode: "github_app_installation",
  repositoryPermissions: {
    metadata: "read",
    issues: "write"
  },
  subscribeEvents: ["issues", "issue_comment"],
  notes: [
    "Use installation access tokens scoped to the selected repository set.",
    "Store GitHub App private keys and webhook secrets in hosted secret storage.",
    "Do not use user PATs or broad OAuth tokens for hosted connector sync."
  ]
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
  syncDirection: z.enum(["github_to_unblock", "unblock_to_github", "bidirectional"]).default("bidirectional"),
  conflictPolicy: z.enum(["github_wins", "unblock_wins", "last_writer_wins", "operator_review"]).default("operator_review")
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
  syncDirection: z.enum(["github_to_unblock", "unblock_to_github", "bidirectional"]),
  conflictPolicy: z.enum(["github_wins", "unblock_wins", "last_writer_wins", "operator_review"]),
  requiredPermissions: z.record(z.string(), z.string()),
  subscribeEvents: z.array(z.string())
});
export type GitHubConnectionMetadata = z.infer<typeof githubConnectionMetadataSchema>;

export interface GitHubConnectorConnection extends ConnectorConnection {
  metadata: GitHubConnectionMetadata;
}

export async function upsertGitHubConnection(store: AppStore, input: GitHubConnectionInput): Promise<GitHubConnectorConnection> {
  const parsed = githubConnectionInputSchema.parse(input);
  await ensureSecretExists(store, parsed.privateKeySecretId, parsed.projectId, "privateKeySecretId");
  await ensureSecretExists(store, parsed.webhookSecretId, parsed.projectId, "webhookSecretId");
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
    conflictPolicy: parsed.conflictPolicy,
    requiredPermissions: githubConnectorAuthModel.repositoryPermissions,
    subscribeEvents: [...githubConnectorAuthModel.subscribeEvents]
  };
  const connection = await upsertConnectorConnection(store, {
    projectId: parsed.projectId,
    connectionId: parsed.connectionId,
    provider: "github",
    displayName: parsed.displayName ?? `GitHub ${parsed.repositoryOwner}/${parsed.repositoryName}`,
    status: "active",
    metadata
  });
  return parseGitHubConnection(connection);
}

export function parseGitHubConnection(connection: ConnectorConnection): GitHubConnectorConnection {
  if (connection.provider !== "github") {
    validation("Connector connection is not a GitHub connection.", { connectionId: connection.id, provider: connection.provider });
  }
  return {
    ...connection,
    metadata: githubConnectionMetadataSchema.parse(connection.metadata)
  };
}

export async function listGitHubConnections(store: AppStore, projectId?: string | undefined): Promise<GitHubConnectorConnection[]> {
  const connections = await store.connectors?.listConnections(projectId) ?? [];
  return connections
    .filter((connection) => connection.provider === "github")
    .map(parseGitHubConnection);
}

async function ensureSecretExists(store: AppStore, secretId: string, projectId: string, field: string): Promise<void> {
  const secret = await store.hostedSecrets?.get(secretId);
  if (!secret) {
    validation(`GitHub connection ${field} does not reference an existing hosted secret.`, { secretId });
  }
  if (secret.projectId !== null && secret.projectId !== projectId) {
    validation(`GitHub connection ${field} references a secret from another project.`, { secretId, projectId: secret.projectId });
  }
  if (secret.archivedAt) {
    validation(`GitHub connection ${field} references an archived secret.`, { secretId });
  }
}
