import { flow, manual, webhook } from "../../../../prism-new3/packages/prism-flows/mod.ts";
import { connectorDispatchInputSchema } from "../jobs/mock-connector.ts";
import { githubWebhookInputSchema } from "../jobs/github-connector.ts";

flow("github-issues-inbound", {
  trigger: webhook("github.issues", {
    path: "/webhooks/github/issues",
    signature: "github",
    dedupeKey: (input: any) => input.deliveryId,
    correlationKeys: [(input: any) => `${input.scope.projectId}:${input.scope.connectionId}:${input.payload.repository?.full_name ?? "unknown"}`],
    schema: githubWebhookInputSchema,
  }),
  concurrency: {
    key: (input: any) => `${input.scope.projectId}:${input.scope.connectionId}:${input.payload.issue?.number ?? input.deliveryId}`,
    policy: "queue",
  },
  permissions: {
    connections: ["unblock-hosted-api"],
    jobs: ["normalizeGitHubIssueWebhook"],
  },
  retention: { runs: "30d", logs: "30d", payload: "30d" },
  labels: {
    product: "unblock",
    connector: "github",
    direction: "inbound",
  },
  run: async (ctx, input: any) => {
    const normalized: any = await ctx.deno("normalizeGitHubIssueWebhook", input);
    if (normalized.mapping) {
      await ctx.http("unblock-hosted-api", {
        method: "POST",
        path: "/api/connectors/github/mappings",
        body: normalized.mapping,
        idempotencyKey: `${normalized.event.idempotencyKey}:mapping`,
        retry: { maxAttempts: 8, backoff: "exponential", retryOn: ["429", "5xx", "network"] },
      });
    }
    return await ctx.http("unblock-hosted-api", {
      method: "POST",
      path: "/api/connectors/inbox",
      body: normalized.event,
      idempotencyKey: normalized.event.idempotencyKey,
      outcomeRecovery: "reconcile_by_external_id",
      retry: { maxAttempts: 8, backoff: "exponential", retryOn: ["429", "5xx", "network"] },
    });
  },
});

flow("github-issues-outbound", {
  trigger: manual(connectorDispatchInputSchema),
  concurrency: {
    key: (input: any) => input.event?.correlationId ?? input.event?.idempotencyKey ?? "github-outbound",
    policy: "queue",
  },
  permissions: {
    connections: ["unblock-hosted-api", "github-api"],
    jobs: ["prepareGitHubIssueOutbound", "finalizeGitHubIssueOutbound"],
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
    const [task, connections]: any[] = await Promise.all([
      ctx.http("unblock-hosted-api", {
        method: "GET",
        path: `/api/tasks/${encodeURIComponent(taskId)}?projectId=${encodeURIComponent(event.scope.projectId)}`,
        retry: { maxAttempts: 4, backoff: "exponential", retryOn: ["429", "5xx", "network"] },
      }),
      ctx.http("unblock-hosted-api", {
        method: "GET",
        path: `/api/connectors/github/connections?projectId=${encodeURIComponent(event.scope.projectId)}`,
        retry: { maxAttempts: 4, backoff: "exponential", retryOn: ["429", "5xx", "network"] },
      }),
    ]);
    const prepared: any = await ctx.deno("prepareGitHubIssueOutbound", { trigger: input, task, connections });
    const githubIssue: any = await ctx.http("github-api", {
      ...prepared.request,
      idempotencyKey: prepared.idempotencyKey,
      outcomeRecovery: "reconcile_by_external_id",
      retry: { maxAttempts: 8, backoff: "exponential", retryOn: ["429", "5xx", "network"] },
    });
    const finalized: any = await ctx.deno("finalizeGitHubIssueOutbound", { prepared, response: githubIssue });
    return await ctx.http("unblock-hosted-api", {
      method: "POST",
      path: "/api/connectors/github/mappings",
      body: finalized.mapping,
      idempotencyKey: `${prepared.idempotencyKey}:mapping`,
      retry: { maxAttempts: 8, backoff: "exponential", retryOn: ["429", "5xx", "network"] },
    });
  },
});
