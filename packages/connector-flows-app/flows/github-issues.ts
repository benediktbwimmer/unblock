import { flow, webhook } from "../../../../prism-new3/packages/prism-flows/mod.ts";
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
