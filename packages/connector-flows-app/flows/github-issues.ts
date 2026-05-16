import {
  flow,
  manual,
  schedule,
  webhook,
} from "../../../../prism-new3/packages/prism-flows/mod.ts";
import { connectorDispatchInputSchema } from "../jobs/mock-connector.ts";
import {
  githubReconcileInputSchema,
  githubWebhookInputSchema,
} from "../jobs/github-connector.ts";
import {
  finalizeGitHubIssueOutbound,
  normalizeGitHubIssueBackfill,
  normalizeGitHubIssueWebhook,
  prepareGitHubIssueBackfill,
  prepareGitHubIssueOutbound,
} from "../helpers/github-connector.ts";

flow("github-issues-inbound", {
  engine: "js",
  trigger: webhook("github.issues", {
    path: "/webhooks/github/issues",
    signature: "github",
    dedupeKey: (input: any) => input.deliveryId,
    correlationKeys: [
      (input: any) =>
        `${input.scope.projectId}:${input.scope.connectionId}:${
          input.payload.repository?.full_name ?? "unknown"
        }`,
    ],
    schema: githubWebhookInputSchema,
  }),
  concurrency: {
    key: (input: any) =>
      `${input.scope.projectId}:${input.scope.connectionId}:${
        input.payload.issue?.number ?? input.deliveryId
      }`,
    policy: "queue",
  },
  permissions: {
    connections: ["unblock-hosted-api"],
  },
  retention: { runs: "30d", logs: "30d", payload: "30d" },
  labels: {
    product: "unblock",
    connector: "github",
    direction: "inbound",
  },
  run: async (ctx, input: any) => {
    const normalized: any = normalizeGitHubIssueWebhook(input);
    return await ctx.http("unblock-hosted-api", {
      method: "POST",
      path: "/api/connectors/inbox",
      body: { ...normalized.event, mapping: normalized.mapping },
      idempotencyKey: normalized.event.idempotencyKey,
      outcomeRecovery: "reconcile_by_external_id",
      retry: {
        maxAttempts: 8,
        backoff: "exponential",
        retryOn: ["429", "5xx", "network"],
      },
    });
  },
});

flow("github-issues-outbound", {
  engine: "js",
  trigger: manual(connectorDispatchInputSchema),
  concurrency: {
    key: (input: any) =>
      input.event?.correlationId ?? input.event?.idempotencyKey ??
        "github-outbound",
    policy: "queue",
  },
  permissions: {
    connections: ["unblock-hosted-api", "github-api"],
  },
  retention: { runs: "30d", logs: "30d", payload: "30d" },
  labels: {
    product: "unblock",
    connector: "github",
    direction: "outbound",
  },
  run: async (ctx, input: any) => {
    const event = input.event;
    const taskId = event.local?.id ?? event.task?.id;
    const [taskResponse, connectionsResponse]: any[] = await Promise.all([
      ctx.http("unblock-hosted-api", {
        method: "GET",
        path: `/api/tasks/${encodeURIComponent(taskId)}?projectId=${
          encodeURIComponent(event.scope.projectId)
        }`,
        retry: {
          maxAttempts: 4,
          backoff: "exponential",
          retryOn: ["429", "5xx", "network"],
        },
      }),
      ctx.http("unblock-hosted-api", {
        method: "GET",
        path: `/api/connectors/github/connections?projectId=${
          encodeURIComponent(event.scope.projectId)
        }`,
        retry: {
          maxAttempts: 4,
          backoff: "exponential",
          retryOn: ["429", "5xx", "network"],
        },
      }),
    ]);
    const task: any = taskResponse?.body ?? taskResponse;
    const connections: any = connectionsResponse?.body ?? connectionsResponse;
    const prepared: any = prepareGitHubIssueOutbound({
      trigger: input,
      task,
      connections,
    });
    const githubIssueResponse: any = await ctx.http("github-api", {
      ...prepared.request,
      idempotencyKey: prepared.idempotencyKey,
      outcomeRecovery: "reconcile_by_external_id",
      retry: {
        maxAttempts: 8,
        backoff: "exponential",
        retryOn: ["429", "5xx", "network"],
      },
    });
    const githubIssue: any = githubIssueResponse?.body ?? githubIssueResponse;
    const finalized: any = finalizeGitHubIssueOutbound({
      prepared,
      response: githubIssue,
    });
    return await ctx.http("unblock-hosted-api", {
      method: "POST",
      path: "/api/connectors/github/mappings",
      body: finalized.mapping,
      idempotencyKey: `${prepared.idempotencyKey}:mapping`,
      retry: {
        maxAttempts: 8,
        backoff: "exponential",
        retryOn: ["429", "5xx", "network"],
      },
    });
  },
});

flow("github-issues-reconcile", {
  engine: "js",
  trigger: [
    manual(githubReconcileInputSchema),
    schedule("*/10 * * * *", {
      timezone: "UTC",
      catchUp: "latest",
      payload: {
        tenantId: "TENANT",
        projectId: "PROJECT",
        connectionId: "github-main",
        reason: "scheduled-reconciliation",
      },
    }),
  ],
  concurrency: {
    key: (input: any) =>
      `${input.projectId}:${input.connectionId}:github-reconcile`,
    policy: "queue",
  },
  permissions: {
    connections: ["unblock-hosted-api", "github-api"],
  },
  retention: { runs: "30d", logs: "30d", payload: "30d" },
  labels: {
    product: "unblock",
    connector: "github",
    direction: "reconciliation",
  },
  run: async (ctx, input: any) => {
    const connectionsResponse: any = await ctx.http("unblock-hosted-api", {
      method: "GET",
      path: `/api/connectors/github/connections?projectId=${
        encodeURIComponent(input.projectId)
      }&includeState=true`,
      retry: {
        maxAttempts: 4,
        backoff: "exponential",
        retryOn: ["429", "5xx", "network"],
      },
    });
    const connections: any = connectionsResponse?.body ?? connectionsResponse;
    const prepared: any = prepareGitHubIssueBackfill({
      input,
      connections,
    });
    const issuesResponse: any = await ctx.http("github-api", {
      ...prepared.request,
      retry: {
        maxAttempts: 8,
        backoff: "exponential",
        retryOn: ["429", "5xx", "network"],
      },
    });
    const issues: any = issuesResponse?.body ?? issuesResponse;
    const normalized: any = normalizeGitHubIssueBackfill({
      prepared,
      response: issues,
    });
    await ctx.http("unblock-hosted-api", {
      method: "POST",
      path: "/api/connectors/github/mappings/batch",
      body: normalized.mappings,
      idempotencyKey:
        `${input.tenantId}:${input.projectId}:${input.connectionId}:github-backfill:${normalized.cursorEvent.cursor.observedAt}:mappings`,
      retry: {
        maxAttempts: 8,
        backoff: "exponential",
        retryOn: ["429", "5xx", "network"],
      },
    });
    await ctx.http("unblock-hosted-api", {
      method: "POST",
      path: "/api/connectors/inbox/batch",
      body: normalized.events,
      idempotencyKey:
        `${input.tenantId}:${input.projectId}:${input.connectionId}:github-backfill:${normalized.cursorEvent.cursor.observedAt}:events`,
      retry: {
        maxAttempts: 8,
        backoff: "exponential",
        retryOn: ["429", "5xx", "network"],
      },
    });
    return await ctx.http("unblock-hosted-api", {
      method: "POST",
      path: "/api/connectors/inbox",
      body: normalized.cursorEvent,
      idempotencyKey: normalized.cursorEvent.idempotencyKey,
      retry: {
        maxAttempts: 8,
        backoff: "exponential",
        retryOn: ["429", "5xx", "network"],
      },
    });
  },
});
