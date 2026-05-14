import { describe, expect, it } from "vitest";
import {
  githubConnectorAuthModel,
  listGitHubConnections,
  upsertGitHubConnection
} from "./github-connector.js";
import { createMemoryStore } from "./memory-store.js";
import type { ConnectorRepository, HostedSecretRepository } from "./store.js";
import type { ConnectorConnection, ConnectorCursorRecord, ConnectorSyncRun, HostedSecret } from "./types.js";

describe("GitHub connector auth model", () => {
  it("uses GitHub App installation auth with narrow repository permissions", () => {
    expect(githubConnectorAuthModel).toMatchObject({
      mode: "github_app_installation",
      repositoryPermissions: {
        metadata: "read",
        issues: "write"
      },
      subscribeEvents: ["issues", "issue_comment"]
    });
  });

  it("stores installation-scoped connection metadata with secret references", async () => {
    const store = createMemoryStore() as any;
    store.connectors = new FakeConnectors();
    store.hostedSecrets = new FakeSecrets([
      secret("private-key", "github.private_key"),
      secret("webhook-secret", "github.webhook_secret")
    ]);

    const connection = await upsertGitHubConnection(store, {
      projectId: "PROJECT",
      connectionId: "github-main",
      appId: "123",
      installationId: "456",
      repositoryOwner: "acme",
      repositoryName: "repo",
      privateKeySecretId: "private-key",
      webhookSecretId: "webhook-secret"
    });

    expect(connection).toMatchObject({
      provider: "github",
      metadata: {
        authModel: "github_app_installation",
        installationId: "456",
        repositoryOwner: "acme",
        repositoryName: "repo",
        conflictPolicy: "operator_review"
      }
    });
    await expect(listGitHubConnections(store, "PROJECT")).resolves.toHaveLength(1);
  });
});

function secret(id: string, purpose: string): HostedSecret {
  return {
    tenantId: "TENANT",
    projectId: "PROJECT",
    id,
    name: id,
    purpose,
    ciphertext: "redacted",
    keyId: "test",
    algorithm: "aes-256-gcm",
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
    rotatedAt: null,
    archivedAt: null
  };
}

class FakeSecrets implements HostedSecretRepository {
  constructor(private readonly secrets: HostedSecret[]) {}

  async create(secret: HostedSecret) {
    this.secrets.push(secret);
  }

  async get(id: string) {
    return this.secrets.find((secret) => secret.id === id) ?? null;
  }

  async list(projectId?: string | null | undefined) {
    return this.secrets.filter((secret) => projectId === undefined || secret.projectId === projectId);
  }

  async findByName(projectId: string | null, name: string) {
    return this.secrets.find((secret) => secret.projectId === projectId && secret.name === name) ?? null;
  }

  async update(secret: HostedSecret) {
    const index = this.secrets.findIndex((item) => item.id === secret.id);
    this.secrets[index] = secret;
  }

  async archive(id: string, archivedAt: string) {
    const secret = this.secrets.find((item) => item.id === id);
    if (secret) secret.archivedAt = archivedAt;
  }
}

class FakeConnectors implements ConnectorRepository {
  connections: ConnectorConnection[] = [];
  cursors: ConnectorCursorRecord[] = [];
  runs: ConnectorSyncRun[] = [];

  async upsertConnection(connection: ConnectorConnection) {
    const index = this.connections.findIndex((item) => item.projectId === connection.projectId && item.id === connection.id);
    if (index >= 0) this.connections[index] = connection;
    else this.connections.push(connection);
  }

  async getConnection(projectId: string, id: string) {
    return this.connections.find((connection) => connection.projectId === projectId && connection.id === id) ?? null;
  }

  async listConnections(projectId?: string) {
    return this.connections.filter((connection) => !projectId || connection.projectId === projectId);
  }

  async upsertCursor(cursor: ConnectorCursorRecord) {
    this.cursors.push(cursor);
  }

  async listCursors(projectId: string, connectionId: string) {
    return this.cursors.filter((cursor) => cursor.projectId === projectId && cursor.connectionId === connectionId);
  }

  async recordSyncRun(run: ConnectorSyncRun) {
    this.runs.push(run);
  }

  async updateSyncRun(run: ConnectorSyncRun) {
    this.runs.push(run);
  }

  async listSyncRuns() {
    return this.runs;
  }
}
