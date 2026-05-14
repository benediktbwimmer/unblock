import { flow, manual, schedule } from "../../../../prism-new3/packages/prism-flows/mod.ts";
import { connectorDispatchInputSchema } from "../jobs/mock-connector.ts";

flow("unblock-connector-dispatch", {
  trigger: [
    manual(connectorDispatchInputSchema),
    schedule("*/5 * * * *", {
      timezone: "UTC",
      catchUp: "latest",
      payload: { reason: "scheduled-reconciliation" },
    }),
  ],
  concurrency: {
    key: (input: any) => input.event?.correlationId ?? "scheduled-reconciliation",
    policy: "queue",
  },
  permissions: {
    connections: ["unblock-hosted-api", "mock-external"],
    jobs: ["mockConnectorApply"],
  },
  retention: { runs: "30d", logs: "30d", payload: "30d" },
  labels: {
    product: "unblock",
    boundary: "connector-orchestration",
    connector: "mock",
  },
  run: async (ctx, input: any) => {
    if (!input.event) {
      return await ctx.http("unblock-hosted-api", {
        method: "POST",
        path: "/api/connectors/reconcile",
        body: input,
        idempotencyKey: `unblock-reconcile:${new Date().toISOString().slice(0, 10)}`,
        retry: { maxAttempts: 8, backoff: "exponential", retryOn: ["429", "5xx", "network"] },
      });
    }

    const inbound: any = await ctx.deno("mockConnectorApply", input);
    return await ctx.http("unblock-hosted-api", {
      method: "POST",
      path: "/api/connectors/inbox",
      body: inbound,
      idempotencyKey: inbound.idempotencyKey,
      outcomeRecovery: "reconcile_by_external_id",
      retry: { maxAttempts: 8, backoff: "exponential", retryOn: ["429", "5xx", "network"] },
    });
  },
});
