import { describe, expect, it } from "vitest";
import {
  assignExternalAssigneeResponsibility,
  buildConnectorSyncQueueItem,
  connectorSyncPolicyPreset,
  createPrincipalRecord,
  planJiraIssueSyncQueue,
  upsertGitHubIssueMapping,
  upsertJiraIssueMapping,
} from "./index.js";
import type { AppStore, ConnectorRepository, ResponsibilityRepository } from "./store.js";
import type {
  ConnectorConnection,
  ConnectorCursorRecord,
  ConnectorExternalMapping,
  ConnectorSyncPolicyRecord,
  ConnectorSyncQueueItem,
  ConnectorSyncRun,
  DelegationRule,
  ExternalIdentity,
  Principal,
  TaskResponsibility,
} from "./types.js";

describe("connector product coverage", () => {
  it("covers mixed GitHub/Jira mappings, responsibility mapping, policy queueing, and queue actions", async () => {
    const connectors = new FakeConnectors();
    const responsibilities = new FakeResponsibilities();
    const store = { connectors, responsibilities } as AppStore;
    const now = "2026-05-16T00:00:00.000Z";
    const principal = createPrincipalRecord({
      tenantId: "tenant",
      id: "principal-alice",
      displayName: "Alice",
      email: "alice@example.com",
    }, now);
    await responsibilities.upsertPrincipal(principal);

    const github = await upsertGitHubIssueMapping(store, {
      projectId: "PROJECT",
      connectionId: "github-main",
      repositoryOwner: "acme",
      repositoryName: "app",
      issueNumber: 7,
      issueUrl: "https://github.com/acme/app/issues/7",
      taskId: "GH-7",
    });
    const jira = await upsertJiraIssueMapping(store, {
      projectId: "PROJECT",
      connectionId: "jira-main",
      siteUrl: "https://acme.atlassian.net",
      projectKey: "ENG",
      issueKey: "ENG-42",
      issueUrl: "https://acme.atlassian.net/browse/ENG-42",
      taskId: "JIRA-ENG-42",
      assigneeAccountId: "account-123",
      labels: ["platform"],
      components: ["backend"],
      requiredFields: { resolution: null },
    });

    const responsibility = await assignExternalAssigneeResponsibility(store, {
      tenantId: "tenant",
      projectId: "PROJECT",
      taskId: jira.localId,
      connectionId: "jira-main",
      provider: "jira",
      externalKind: "user",
      externalId: "account-123",
      externalDisplayName: "Alice",
      externalEmail: "alice@example.com",
      principalId: principal.id,
    });
    expect(responsibility.status).toBe("mapped");

    const jiraPlan = planJiraIssueSyncQueue({
      mapping: jira,
      external: {
        title: "Jira title",
        statusName: "In Progress",
        assigneeAccountId: "account-123",
        labels: ["platform"],
        components: ["backend"],
        requiredFields: { resolution: null },
      },
      local: {
        title: "Local title",
        externalState: "To Do",
        responsibility: principal.id,
        labels: [],
        components: [],
      },
      autoApply: false,
      now,
    });
    expect(jiraPlan.items.map((item) => item.diff.field)).toEqual([
      "title",
      "external_state",
      "responsibility",
      "labels",
      "components",
      "required_fields",
    ]);

    const githubItem = buildConnectorSyncQueueItem({
      policy: connectorSyncPolicyPreset("github", "execution_layer"),
      mapping: github,
      now,
      diff: {
        field: "title",
        externalValue: "GitHub title",
        localValue: "Local title",
      },
    });
    for (const item of [githubItem, ...jiraPlan.items]) {
      await connectors.upsertSyncQueueItem(item);
    }
    expect(await connectors.listMappings({ projectId: "PROJECT", provider: "jira" }))
      .toHaveLength(1);
    expect(await connectors.listSyncQueueItems({ projectId: "PROJECT", connectionId: "jira-main" }))
      .toHaveLength(6);
    const resolved = await connectors.updateSyncQueueItemStatus(
      "PROJECT",
      jiraPlan.items[0]!.id,
      "resolved",
      { resolvedAt: now },
    );
    expect(resolved).toMatchObject({ status: "resolved", resolvedAt: now });
  });
});

class FakeConnectors implements ConnectorRepository {
  connections: ConnectorConnection[] = [];
  cursors: ConnectorCursorRecord[] = [];
  runs: ConnectorSyncRun[] = [];
  mappings: ConnectorExternalMapping[] = [];
  policies: ConnectorSyncPolicyRecord[] = [];
  queueItems: ConnectorSyncQueueItem[] = [];

  async upsertConnection(connection: ConnectorConnection) {
    this.connections.push(connection);
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
    this.mappings = upsertBy(this.mappings, mapping, (item) =>
      `${item.projectId}:${item.connectionId}:${item.externalKind}:${item.externalId}`
    );
  }

  async getMappingByExternal(projectId: string, connectionId: string, externalKind: string, externalId: string) {
    return this.mappings.find((mapping) =>
      mapping.projectId === projectId &&
      mapping.connectionId === connectionId &&
      mapping.externalKind === externalKind &&
      mapping.externalId === externalId
    ) ?? null;
  }

  async getMappingByLocal(projectId: string, connectionId: string, localKind: string, localId: string) {
    return this.mappings.find((mapping) =>
      mapping.projectId === projectId &&
      mapping.connectionId === connectionId &&
      mapping.localKind === localKind &&
      mapping.localId === localId &&
      !mapping.archivedAt
    ) ?? null;
  }

  async listMappings(options: { projectId?: string | undefined; connectionId?: string | undefined; provider?: string | undefined; limit?: number | undefined }) {
    return this.mappings
      .filter((mapping) => !options.projectId || mapping.projectId === options.projectId)
      .filter((mapping) => !options.connectionId || mapping.connectionId === options.connectionId)
      .filter((mapping) => !options.provider || mapping.provider === options.provider)
      .slice(0, options.limit ?? 100);
  }

  async recordSyncPolicy(policy: ConnectorSyncPolicyRecord) {
    this.policies.push(policy);
  }

  async upsertSyncPolicy(policy: ConnectorSyncPolicyRecord) {
    this.policies = upsertBy(this.policies, policy, (item) => `${item.projectId}:${item.id}`);
  }

  async getSyncPolicy(projectId: string, connectionId: string, id: string) {
    return this.policies.find((policy) => policy.projectId === projectId && policy.connectionId === connectionId && policy.id === id) ?? null;
  }

  async listSyncPolicies() {
    return this.policies;
  }

  async upsertSyncQueueItem(item: ConnectorSyncQueueItem) {
    this.queueItems = upsertBy(this.queueItems, item, (candidate) => `${candidate.projectId}:${candidate.id}`);
  }

  async getSyncQueueItem(projectId: string, id: string) {
    return this.queueItems.find((item) => item.projectId === projectId && item.id === id) ?? null;
  }

  async listSyncQueueItems(options: { projectId?: string | undefined; connectionId?: string | undefined; status?: ConnectorSyncQueueItem["status"] | undefined; limit?: number | undefined }) {
    return this.queueItems
      .filter((item) => !options.projectId || item.projectId === options.projectId)
      .filter((item) => !options.connectionId || item.connectionId === options.connectionId)
      .filter((item) => !options.status || item.status === options.status)
      .slice(0, options.limit ?? 100);
  }

  async updateSyncQueueItemStatus(
    projectId: string,
    id: string,
    status: ConnectorSyncQueueItem["status"],
    options: { resolvedAt?: string | null | undefined; error?: Record<string, unknown> | null | undefined } = {},
  ) {
    const item = this.queueItems.find((candidate) => candidate.projectId === projectId && candidate.id === id);
    if (!item) return null;
    item.status = status;
    item.resolvedAt = options.resolvedAt ?? null;
    item.error = options.error ?? null;
    return item;
  }
}

class FakeResponsibilities implements ResponsibilityRepository {
  principals: Principal[] = [];
  identities: ExternalIdentity[] = [];
  responsibilities: TaskResponsibility[] = [];
  rules: DelegationRule[] = [];

  async upsertPrincipal(principal: Principal) {
    this.principals = upsertBy(this.principals, principal, (item) => item.id);
  }

  async getPrincipal(id: string) {
    return this.principals.find((principal) => principal.id === id) ?? null;
  }

  async listPrincipals() {
    return this.principals;
  }

  async upsertExternalIdentity(identity: ExternalIdentity) {
    this.identities = upsertBy(this.identities, identity, (item) =>
      `${item.connectionId}:${item.provider}:${item.externalKind}:${item.externalId}`
    );
  }

  async getExternalIdentity(connectionId: string, provider: string, externalKind: ExternalIdentity["externalKind"], externalId: string) {
    return this.identities.find((identity) =>
      identity.connectionId === connectionId &&
      identity.provider === provider &&
      identity.externalKind === externalKind &&
      identity.externalId === externalId
    ) ?? null;
  }

  async listExternalIdentities() {
    return this.identities;
  }

  async upsertTaskResponsibility(responsibility: TaskResponsibility) {
    this.responsibilities = upsertBy(this.responsibilities, responsibility, (item) =>
      `${item.projectId}:${item.taskId}:${item.principalId}:${item.role}`
    );
  }

  async listTaskResponsibilities() {
    return this.responsibilities;
  }

  async archiveTaskResponsibility() {
    return null;
  }

  async upsertDelegationRule(rule: DelegationRule) {
    this.rules = upsertBy(this.rules, rule, (item) => `${item.projectId}:${item.id}`);
  }

  async listDelegationRules() {
    return this.rules;
  }
}

function upsertBy<T>(items: T[], next: T, key: (item: T) => string): T[] {
  const nextKey = key(next);
  const index = items.findIndex((item) => key(item) === nextKey);
  if (index < 0) return [...items, next];
  const copy = [...items];
  copy[index] = next;
  return copy;
}
