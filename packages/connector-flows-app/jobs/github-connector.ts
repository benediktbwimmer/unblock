import { job, schemas } from "../../../../prism-new3/packages/prism-flows/mod.ts";

export const githubWebhookInputSchema = schemas.object({
  deliveryId: schemas.string(),
  event: schemas.string(),
  scope: schemas.object({
    tenantId: schemas.string(),
    projectId: schemas.string(),
    connectionId: schemas.string(),
  }),
  payload: schemas.record(schemas.unknown()),
});

export const githubInboundResultSchema = schemas.object({
  event: schemas.record(schemas.unknown()),
  mapping: schemas.record(schemas.unknown()).optional(),
});

export const githubOutboundInputSchema = schemas.object({
  trigger: schemas.record(schemas.unknown()),
  task: schemas.record(schemas.unknown()),
  connections: schemas.array(schemas.record(schemas.unknown())),
});

export const githubOutboundPreparedSchema = schemas.object({
  request: schemas.record(schemas.unknown()),
  connection: schemas.record(schemas.unknown()),
  task: schemas.record(schemas.unknown()),
  idempotencyKey: schemas.string(),
});

export const githubOutboundFinalizeInputSchema = schemas.object({
  prepared: githubOutboundPreparedSchema,
  response: schemas.record(schemas.unknown()),
});

export const githubOutboundFinalizeResultSchema = schemas.object({
  mapping: schemas.record(schemas.unknown()),
});

job("normalizeGitHubIssueWebhook", {
  runtime: "deno",
  batch: { mode: "scalar" },
  input: githubWebhookInputSchema,
  output: githubInboundResultSchema,
  permissions: { net: [], secrets: [], imports: [] },
  run: ({ input }: { input: any }) => {
    const issue = input.payload.issue;
    const repository = input.payload.repository;
    if (!issue || !repository) {
      return deadLetter(input, "missing_issue_payload", "GitHub webhook payload did not include issue and repository.");
    }

    const owner = repository.owner?.login ?? repository.full_name?.split("/")[0];
    const repo = repository.name ?? repository.full_name?.split("/")[1];
    const issueNumber = Number(issue.number);
    if (!owner || !repo || !Number.isFinite(issueNumber)) {
      return deadLetter(input, "invalid_issue_identity", "GitHub webhook payload did not include a stable issue identity.");
    }

    const taskId = `GH-${issueNumber}`;
    const scope = { ...input.scope, provider: "github" };
    const external = {
      system: "github",
      kind: "issue",
      id: `${owner}/${repo}#${issueNumber}`,
      url: issue.html_url,
    };
    const action = input.payload.action ?? "unknown";
    const base = {
      id: `github:${input.deliveryId}`,
      scope,
      correlationId: `${input.scope.tenantId}:${input.scope.projectId}:external:github:issue:${external.id}`,
      idempotencyKey: `${input.scope.tenantId}:${input.scope.projectId}:${input.scope.connectionId}:github-delivery:${input.deliveryId}`,
      external,
      evidence: {
        githubDeliveryId: input.deliveryId,
        githubEvent: input.event,
        githubAction: action,
      },
      occurredAt: new Date().toISOString(),
    };

    if (action === "deleted" || action === "closed") {
      return {
        event: {
          ...base,
          kind: "connector.inbound.task_archived",
          local: { kind: "task", id: taskId },
          task: taskPayload(issue, taskId),
        },
        mapping: issueMapping(input, owner, repo, issue, taskId, "active"),
      };
    }

    return {
      event: {
        ...base,
        kind: "connector.inbound.task_upserted",
        local: { kind: "task", id: taskId },
        task: taskPayload(issue, taskId),
      },
      mapping: issueMapping(input, owner, repo, issue, taskId, "active"),
    };
  },
});

job("prepareGitHubIssueOutbound", {
  runtime: "deno",
  batch: { mode: "scalar" },
  input: githubOutboundInputSchema,
  output: githubOutboundPreparedSchema,
  permissions: { net: [], secrets: [], imports: [] },
  run: ({ input }: { input: any }) => {
    const event = input.trigger.event;
    const task = input.task;
    const connection = input.connections.find((item: any) => item.id === event.scope.connectionId) ?? input.connections[0];
    if (!connection?.metadata) {
      throw new Error(`No GitHub connection metadata available for ${event.scope.connectionId}`);
    }
    const metadata = connection.metadata;
    const owner = metadata.repositoryOwner;
    const repo = metadata.repositoryName;
    const existingIssue = parseIssueNumber(event.external?.id) ?? parseIssueNumber(task.sourceAnchor);
    const title = task.title ?? event.task?.title ?? event.local?.id;
    const body = task.description ?? event.task?.description ?? "";
    const request = existingIssue
      ? {
        method: "PATCH",
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${existingIssue}`,
        body: {
          title,
          body,
          state: task.lifecycle === "finished" ? "closed" : "open",
        },
      }
      : {
        method: "POST",
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
        body: {
          title,
          body,
        },
      };
    return {
      request,
      connection,
      task,
      idempotencyKey: `${event.idempotencyKey}:github:${existingIssue ?? "create"}`,
    };
  },
});

job("finalizeGitHubIssueOutbound", {
  runtime: "deno",
  batch: { mode: "scalar" },
  input: githubOutboundFinalizeInputSchema,
  output: githubOutboundFinalizeResultSchema,
  permissions: { net: [], secrets: [], imports: [] },
  run: ({ input }: { input: any }) => {
    const issue = input.response;
    const metadata = input.prepared.connection.metadata;
    const task = input.prepared.task;
    return {
      mapping: {
        projectId: task.projectId,
        connectionId: input.prepared.connection.id,
        repositoryOwner: metadata.repositoryOwner,
        repositoryName: metadata.repositoryName,
        issueNumber: Number(issue.number),
        issueNodeId: issue.node_id ?? undefined,
        issueUrl: issue.html_url,
        taskId: task.id,
        externalVersion: issue.updated_at ?? null,
        localVersion: String(task.version ?? ""),
        syncDirection: metadata.syncDirection ?? "bidirectional",
        conflictPolicy: metadata.conflictPolicy ?? "operator_review",
        status: "active",
        metadata: {
          outbound: true,
          githubState: issue.state ?? null,
        },
      },
    };
  },
});

function taskPayload(issue: any, taskId: string) {
  return {
    id: taskId,
    title: issue.title ?? taskId,
    description: issue.body ?? "",
    lifecycle: issue.state === "closed" ? "finished" : "open",
    priority: 2,
    sourceUrl: issue.html_url,
  };
}

function issueMapping(input: any, owner: string, repo: string, issue: any, taskId: string, status: string) {
  return {
    projectId: input.scope.projectId,
    connectionId: input.scope.connectionId,
    repositoryOwner: owner,
    repositoryName: repo,
    issueNumber: Number(issue.number),
    issueNodeId: issue.node_id ?? undefined,
    issueUrl: issue.html_url,
    taskId,
    externalVersion: issue.updated_at ?? null,
    localVersion: null,
    syncDirection: "bidirectional",
    conflictPolicy: "operator_review",
    status,
    metadata: {
      githubDeliveryId: input.deliveryId,
      githubAction: input.payload.action ?? "unknown",
    },
  };
}

function parseIssueNumber(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.match(/#(\d+)$/);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function deadLetter(input: any, code: string, message: string) {
  return {
    event: {
      id: `github:${input.deliveryId}:dead-letter`,
      kind: "connector.dead_letter.created",
      scope: { ...input.scope, provider: "github" },
      correlationId: `${input.scope.tenantId}:${input.scope.projectId}:connection:${input.scope.connectionId}`,
      idempotencyKey: `${input.scope.tenantId}:${input.scope.projectId}:${input.scope.connectionId}:github-delivery:${input.deliveryId}:dead-letter`,
      error: { code, message, retryable: false, details: { githubEvent: input.event } },
      evidence: { githubDeliveryId: input.deliveryId },
      occurredAt: new Date().toISOString(),
    },
  };
}
