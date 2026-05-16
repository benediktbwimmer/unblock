export function normalizeGitHubIssueWebhook(input: any) {
  const issue = input.payload.issue;
  const repository = input.payload.repository;
  if (!issue || !repository) {
    return deadLetter(
      input,
      "missing_issue_payload",
      "GitHub webhook payload did not include issue and repository.",
    );
  }

  const owner = repository.owner?.login ?? repository.full_name?.split("/")[0];
  const repo = repository.name ?? repository.full_name?.split("/")[1];
  const issueNumber = Number(issue.number);
  if (!owner || !repo || !Number.isFinite(issueNumber)) {
    return deadLetter(
      input,
      "invalid_issue_identity",
      "GitHub webhook payload did not include a stable issue identity.",
    );
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
    correlationId:
      `${input.scope.tenantId}:${input.scope.projectId}:external:github:issue:${external.id}`,
    idempotencyKey:
      `${input.scope.tenantId}:${input.scope.projectId}:${input.scope.connectionId}:github-delivery:${input.deliveryId}`,
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
}

export function prepareGitHubIssueBackfill(input: any) {
  const connection =
    input.connections.find((item: any) =>
      item.id === input.input.connectionId
    ) ?? input.connections[0];
  if (!connection?.metadata) {
    throw new Error(
      `No GitHub connection metadata available for ${input.input.connectionId}`,
    );
  }
  const metadata = connection.metadata;
  const cursorName = "issues.updated_at";
  const storedCursor = Array.isArray(connection.cursors)
    ? connection.cursors.find((cursor: any) => cursor.name === cursorName)
      ?.value
    : undefined;
  const effectiveCursor = input.input.cursor ?? storedCursor;
  const replayWindowSeconds = Math.max(
    0,
    Number(input.input.replayWindowSeconds ?? 300),
  );
  const requestStartedAt = new Date().toISOString();
  const query = new URLSearchParams({ state: "all", per_page: "100" });
  if (effectiveCursor) {
    query.set("since", replayCursor(effectiveCursor, replayWindowSeconds));
  }
  return {
    request: {
      method: "GET",
      path: `/repos/${encodeURIComponent(metadata.repositoryOwner)}/${
        encodeURIComponent(metadata.repositoryName)
      }/issues?${query.toString()}`,
    },
    connection,
    scope: {
      tenantId: input.input.tenantId,
      projectId: input.input.projectId,
      connectionId: input.input.connectionId,
      provider: "github",
    },
    cursorName,
    effectiveCursor,
    requestStartedAt,
    replayWindowSeconds,
  };
}

export function normalizeGitHubIssueBackfill(input: any) {
  const connection = input.prepared.connection;
  const metadata = connection.metadata;
  const issues = input.response.filter((issue: any) => !issue.pull_request);
  const items = issues.map((issue: any) => {
    const taskId = `GH-${issue.number}`;
    const external = {
      system: "github",
      kind: "issue",
      id:
        `${metadata.repositoryOwner}/${metadata.repositoryName}#${issue.number}`,
      url: issue.html_url,
    };
    const event = {
      id: `github:backfill:${external.id}:${issue.updated_at}`,
      kind: issue.state === "closed"
        ? "connector.inbound.task_archived"
        : "connector.inbound.task_upserted",
      scope: input.prepared.scope,
      correlationId:
        `${input.prepared.scope.tenantId}:${input.prepared.scope.projectId}:external:github:issue:${external.id}`,
      idempotencyKey:
        `${input.prepared.scope.tenantId}:${input.prepared.scope.projectId}:${input.prepared.scope.connectionId}:github-backfill:${external.id}:${issue.updated_at}`,
      local: { kind: "task", id: taskId },
      external,
      task: taskPayload(issue, taskId),
      evidence: {
        source: "github-backfill",
        githubUpdatedAt: issue.updated_at,
      },
      occurredAt: new Date().toISOString(),
    };
    return {
      event,
      mapping: issueMappingFromConnection(
        input.prepared.scope.projectId,
        connection,
        issue,
        taskId,
        {
          source: "github-backfill",
        },
      ),
    };
  });
  const observedAt = nextCursorValue(
    input.prepared.effectiveCursor,
    newestUpdatedAt(issues),
    input.prepared.requestStartedAt,
  );
  return {
    items,
    mappings: items.map((item: any) => item.mapping),
    events: items.map((item: any) => item.event),
    cursorEvent: {
      id: `github:cursor:${input.prepared.scope.connectionId}:${observedAt}`,
      kind: "connector.cursor.updated",
      scope: input.prepared.scope,
      correlationId:
        `${input.prepared.scope.tenantId}:${input.prepared.scope.projectId}:connection:${input.prepared.scope.connectionId}`,
      idempotencyKey:
        `${input.prepared.scope.tenantId}:${input.prepared.scope.projectId}:${input.prepared.scope.connectionId}:github-cursor:${observedAt}`,
      cursor: {
        name: input.prepared.cursorName,
        value: observedAt,
        observedAt,
      },
      evidence: {
        source: "github-backfill",
        itemCount: issues.length,
        replayWindowSeconds: input.prepared.replayWindowSeconds,
      },
      occurredAt: new Date().toISOString(),
    },
  };
}

export function prepareGitHubIssueOutbound(input: any) {
  const event = input.trigger.event;
  const task = input.task;
  const connection =
    input.connections.find((item: any) =>
      item.id === event.scope.connectionId
    ) ?? input.connections[0];
  if (!connection?.metadata) {
    throw new Error(
      `No GitHub connection metadata available for ${event.scope.connectionId}`,
    );
  }
  const metadata = connection.metadata;
  const owner = metadata.repositoryOwner;
  const repo = metadata.repositoryName;
  const existingIssue = parseIssueNumber(event.external?.id) ??
    parseIssueNumber(task.sourceAnchor);
  const title = task.title ?? event.task?.title ?? event.local?.id;
  const body = task.description ?? event.task?.description ?? "";
  const request = existingIssue
    ? {
      method: "PATCH",
      path: `/repos/${encodeURIComponent(owner)}/${
        encodeURIComponent(repo)
      }/issues/${existingIssue}`,
      body: {
        title,
        body,
        state: task.lifecycle === "finished" ? "closed" : "open",
      },
    }
    : {
      method: "POST",
      path: `/repos/${encodeURIComponent(owner)}/${
        encodeURIComponent(repo)
      }/issues`,
      body: {
        title,
        body,
      },
    };
  return {
    request,
    connection,
    task,
    idempotencyKey: `${event.idempotencyKey}:github:${
      existingIssue ?? "create"
    }`,
  };
}

export function finalizeGitHubIssueOutbound(input: any) {
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
}

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

function issueMapping(
  input: any,
  owner: string,
  repo: string,
  issue: any,
  taskId: string,
  status: string,
) {
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

function issueMappingFromConnection(
  projectId: string,
  connection: any,
  issue: any,
  taskId: string,
  metadata: Record<string, unknown>,
) {
  return {
    projectId,
    connectionId: connection.id,
    repositoryOwner: connection.metadata.repositoryOwner,
    repositoryName: connection.metadata.repositoryName,
    issueNumber: Number(issue.number),
    issueNodeId: issue.node_id ?? undefined,
    issueUrl: issue.html_url,
    taskId,
    externalVersion: issue.updated_at ?? null,
    localVersion: null,
    syncDirection: connection.metadata.syncDirection ?? "bidirectional",
    conflictPolicy: connection.metadata.conflictPolicy ?? "operator_review",
    status: "active",
    metadata,
  };
}

function newestUpdatedAt(issues: any[]): string | null {
  return issues
    .map((issue) => issue.updated_at)
    .filter((value): value is string =>
      typeof value === "string" && value.length > 0
    )
    .sort()
    .at(-1) ?? null;
}

function replayCursor(cursor: string, replayWindowSeconds: number): string {
  const parsed = Date.parse(cursor);
  if (!Number.isFinite(parsed)) return cursor;
  return new Date(parsed - replayWindowSeconds * 1000).toISOString();
}

function nextCursorValue(
  currentCursor: string | undefined,
  newestIssueUpdatedAt: string | null,
  requestStartedAt: string,
): string {
  const candidates = [currentCursor, newestIssueUpdatedAt, requestStartedAt]
    .filter((value): value is string =>
      typeof value === "string" && value.length > 0
    )
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort();
  return candidates.at(-1) ?? new Date().toISOString();
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
      correlationId:
        `${input.scope.tenantId}:${input.scope.projectId}:connection:${input.scope.connectionId}`,
      idempotencyKey:
        `${input.scope.tenantId}:${input.scope.projectId}:${input.scope.connectionId}:github-delivery:${input.deliveryId}:dead-letter`,
      error: {
        code,
        message,
        retryable: false,
        details: { githubEvent: input.event },
      },
      evidence: { githubDeliveryId: input.deliveryId },
      occurredAt: new Date().toISOString(),
    },
  };
}
