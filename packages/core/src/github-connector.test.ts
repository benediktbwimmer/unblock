import { describe, expect, it } from "vitest";
import {
  githubConnectorAuthModel,
  getGitHubIssueMappingByExternal,
  getGitHubIssueMappingByTask,
  listGitHubConnections,
  listGitHubIssueMappings,
  upsertGitHubIssueMapping,
  upsertGitHubConnection
} from "./github-connector.js";
import { createMemoryStore } from "./memory-store.js";
import type { ConnectorRepository, HostedSecretRepository } from "./store.js";
import type { ConnectorConnection, ConnectorCursorRecord, ConnectorExternalMapping, ConnectorSyncRun, HostedSecret } from "./types.js";

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

  it("maps GitHub issues to Unblock tasks with conflict policy metadata", async () => {
    const store = createMemoryStore() as any;
    store.connectors = new FakeConnectors();

    const mapping = await upsertGitHubIssueMapping(store, {
      projectId: "PROJECT",
      connectionId: "github-main",
      repositoryOwner: "acme",
      repositoryName: "repo",
      issueNumber: 42,
      issueUrl: "https://github.com/acme/repo/issues/42",
      taskId: "GH-42",
      externalVersion: "etag-1",
      localVersion: "1",
      conflictPolicy: "operator_review"
    });

    expect(mapping).toMatchObject({
      provider: "github",
      externalKind: "issue",
      externalId: "acme/repo#42",
      localKind: "task",
      localId: "GH-42",
      conflictPolicy: "operator_review",
      status: "active"
    });
    await expect(getGitHubIssueMappingByExternal(store, "PROJECT", "github-main", {
      repositoryOwner: "acme",
      repositoryName: "repo",
      issueNumber: 42
    })).resolves.toMatchObject({ localId: "GH-42" });
    await expect(getGitHubIssueMappingByTask(store, "PROJECT", "github-main", "GH-42")).resolves.toMatchObject({ externalId: "acme/repo#42" });
    await expect(listGitHubIssueMappings(store, { projectId: "PROJECT", connectionId: "github-main" })).resolves.toHaveLength(1);
  });

  it("updates GitHub mappings idempotently for conflict review", async () => {
    const store = createMemoryStore() as any;
    store.connectors = new FakeConnectors();
    const input = {
      projectId: "PROJECT",
      connectionId: "github-main",
      repositoryOwner: "acme",
      repositoryName: "repo",
      issueNumber: 42,
      issueUrl: "https://github.com/acme/repo/issues/42",
      taskId: "GH-42",
      externalVersion: "etag-1",
      localVersion: "1"
    };

    const first = await upsertGitHubIssueMapping(store, input);
    const second = await upsertGitHubIssueMapping(store, {
      ...input,
      externalVersion: "etag-2",
      status: "operator_review",
      metadata: { reason: "version_conflict" }
    });

    expect(store.connectors.mappings).toHaveLength(1);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second).toMatchObject({
      externalVersion: "etag-2",
      status: "operator_review",
      metadata: { reason: "version_conflict" }
    });
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
  mappings: ConnectorExternalMapping[] = [];

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

  async upsertMapping(mapping: ConnectorExternalMapping) {
    const index = this.mappings.findIndex((item) =>
      item.projectId === mapping.projectId
        && item.connectionId === mapping.connectionId
        && item.externalKind === mapping.externalKind
        && item.externalId === mapping.externalId
    );
    if (index >= 0) this.mappings[index] = mapping;
    else this.mappings.push(mapping);
  }

  async getMappingByExternal(projectId: string, connectionId: string, externalKind: string, externalId: string) {
    return this.mappings.find((mapping) =>
      mapping.projectId === projectId
        && mapping.connectionId === connectionId
        && mapping.externalKind === externalKind
        && mapping.externalId === externalId
    ) ?? null;
  }

  async getMappingByLocal(projectId: string, connectionId: string, localKind: string, localId: string) {
    return this.mappings.find((mapping) =>
      mapping.projectId === projectId
        && mapping.connectionId === connectionId
        && mapping.localKind === localKind
        && mapping.localId === localId
        && !mapping.archivedAt
    ) ?? null;
  }

  async listMappings(options: { projectId?: string | undefined; connectionId?: string | undefined; provider?: string | undefined; limit?: number | undefined }) {
    return this.mappings
      .filter((mapping) => !options.projectId || mapping.projectId === options.projectId)
      .filter((mapping) => !options.connectionId || mapping.connectionId === options.connectionId)
      .filter((mapping) => !options.provider || mapping.provider === options.provider)
      .slice(0, options.limit ?? 100);
  }
}
