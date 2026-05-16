import { describe, expect, it } from "vitest";
import {
  getJiraIssueMappingByExternal,
  jiraConnectorAuthModel,
  jiraIssueExternalId,
  upsertJiraConnection,
  upsertJiraIssueMapping,
} from "./jira-connector.js";
import { createMemoryStore } from "./memory-store.js";
import type { ConnectorRepository, HostedSecretRepository } from "./store.js";
import type {
  ConnectorConnection,
  ConnectorCursorRecord,
  ConnectorExternalMapping,
  ConnectorSyncRun,
  HostedSecret,
} from "./types.js";

describe("Jira connector scaffold", () => {
  it("declares Jira auth and sync scopes", () => {
    expect(jiraConnectorAuthModel).toMatchObject({
      mode: "jira_cloud_oauth_or_api_token",
      scopes: expect.arrayContaining([
        "read:jira-work",
        "write:jira-work",
        "read:jira-user",
      ]),
    });
  });

  it("stores Jira connection metadata with execution-layer field policies", async () => {
    const store = createMemoryStore() as any;
    store.connectors = new FakeConnectors();
    store.hostedSecrets = new FakeSecrets([
      secret("jira-token", "jira.token"),
      secret("jira-webhook", "jira.webhook_secret"),
    ]);

    const connection = await upsertJiraConnection(store, {
      projectId: "PROJECT",
      connectionId: "jira-main",
      siteUrl: "https://acme.atlassian.net",
      projectKey: "ENG",
      accountEmail: "sync@acme.test",
      tokenSecretId: "jira-token",
      webhookSecretId: "jira-webhook",
    });

    expect(connection).toMatchObject({
      provider: "jira",
      metadata: {
        authModel: "jira_cloud_oauth_or_api_token",
        siteUrl: "https://acme.atlassian.net",
        projectKey: "ENG",
        syncPreset: "execution_layer",
        fieldPolicies: {
          title: { mode: "inbound_only" },
          execution_assignment: { mode: "unblock_owned" },
        },
      },
    });
  });

  it("maps Jira issues to Unblock tasks with Jira-specific metadata", async () => {
    const store = createMemoryStore() as any;
    store.connectors = new FakeConnectors();

    const mapping = await upsertJiraIssueMapping(store, {
      projectId: "PROJECT",
      connectionId: "jira-main",
      siteUrl: "https://acme.atlassian.net",
      projectKey: "ENG",
      issueKey: "ENG-42",
      issueId: "10042",
      issueUrl: "https://acme.atlassian.net/browse/ENG-42",
      taskId: "JIRA-ENG-42",
      issueType: "Story",
      statusName: "In Progress",
      assigneeAccountId: "abc123",
      externalVersion: "updated-1",
      localVersion: "3",
    });

    expect(jiraIssueExternalId({ projectKey: "ENG", issueKey: "ENG-42" }))
      .toBe("ENG:ENG-42");
    expect(mapping).toMatchObject({
      provider: "jira",
      externalKind: "issue",
      externalId: "ENG:ENG-42",
      localKind: "task",
      localId: "JIRA-ENG-42",
      metadata: {
        issueKey: "ENG-42",
        issueId: "10042",
        statusName: "In Progress",
        assigneeAccountId: "abc123",
      },
    });
    await expect(
      getJiraIssueMappingByExternal(store, "PROJECT", "jira-main", {
        projectKey: "ENG",
        issueKey: "ENG-42",
      }),
    ).resolves.toMatchObject({ localId: "JIRA-ENG-42" });
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
    archivedAt: null,
  };
}

class FakeSecrets implements HostedSecretRepository {
  constructor(private readonly secrets: HostedSecret[]) {}

  async create(secretValue: HostedSecret) {
    this.secrets.push(secretValue);
  }

  async get(id: string) {
    return this.secrets.find((secretValue) => secretValue.id === id) ?? null;
  }

  async list(projectId?: string | null | undefined) {
    return this.secrets.filter((secretValue) =>
      projectId === undefined || secretValue.projectId === projectId
    );
  }

  async findByName(projectId: string | null, name: string) {
    return this.secrets.find((secretValue) =>
      secretValue.projectId === projectId && secretValue.name === name
    ) ?? null;
  }

  async update(secretValue: HostedSecret) {
    const index = this.secrets.findIndex((item) => item.id === secretValue.id);
    this.secrets[index] = secretValue;
  }

  async archive(id: string, archivedAt: string) {
    const secretValue = this.secrets.find((item) => item.id === id);
    if (secretValue) secretValue.archivedAt = archivedAt;
  }
}

class FakeConnectors implements ConnectorRepository {
  connections: ConnectorConnection[] = [];
  cursors: ConnectorCursorRecord[] = [];
  runs: ConnectorSyncRun[] = [];
  mappings: ConnectorExternalMapping[] = [];

  async upsertConnection(connection: ConnectorConnection) {
    const index = this.connections.findIndex((item) =>
      item.projectId === connection.projectId && item.id === connection.id
    );
    if (index >= 0) this.connections[index] = connection;
    else this.connections.push(connection);
  }

  async getConnection(projectId: string, id: string) {
    return this.connections.find((connection) =>
      connection.projectId === projectId && connection.id === id
    ) ?? null;
  }

  async listConnections(projectId?: string) {
    return this.connections.filter((connection) =>
      !projectId || connection.projectId === projectId
    );
  }

  async upsertCursor(cursor: ConnectorCursorRecord) {
    this.cursors.push(cursor);
  }

  async listCursors(projectId: string, connectionId: string) {
    return this.cursors.filter((cursor) =>
      cursor.projectId === projectId && cursor.connectionId === connectionId
    );
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
      item.projectId === mapping.projectId &&
      item.connectionId === mapping.connectionId &&
      item.externalKind === mapping.externalKind &&
      item.externalId === mapping.externalId
    );
    if (index >= 0) this.mappings[index] = mapping;
    else this.mappings.push(mapping);
  }

  async getMappingByExternal(
    projectId: string,
    connectionId: string,
    externalKind: string,
    externalId: string,
  ) {
    return this.mappings.find((mapping) =>
      mapping.projectId === projectId &&
      mapping.connectionId === connectionId &&
      mapping.externalKind === externalKind &&
      mapping.externalId === externalId
    ) ?? null;
  }

  async getMappingByLocal(
    projectId: string,
    connectionId: string,
    localKind: string,
    localId: string,
  ) {
    return this.mappings.find((mapping) =>
      mapping.projectId === projectId &&
      mapping.connectionId === connectionId &&
      mapping.localKind === localKind &&
      mapping.localId === localId &&
      !mapping.archivedAt
    ) ?? null;
  }

  async listMappings(
    options: {
      projectId?: string | undefined;
      connectionId?: string | undefined;
      provider?: string | undefined;
      limit?: number | undefined;
    },
  ) {
    return this.mappings
      .filter((mapping) =>
        !options.projectId || mapping.projectId === options.projectId
      )
      .filter((mapping) =>
        !options.connectionId || mapping.connectionId === options.connectionId
      )
      .filter((mapping) =>
        !options.provider || mapping.provider === options.provider
      )
      .slice(0, options.limit ?? 100);
  }
}
