import {
  flow,
  manual,
  schedule,
} from "../../../../prism-new3/packages/prism-flows/mod.ts";
import { connectorDispatchInputSchema } from "../jobs/mock-connector.ts";
import { mockConnectorApply } from "../helpers/mock-connector.ts";

flow("unblock-connector-dispatch", {
  engine: "js",
  trigger: [
    manual(connectorDispatchInputSchema),
    schedule("*/5 * * * *", {
      timezone: "UTC",
      catchUp: "latest",
      payload: { reason: "scheduled-reconciliation" },
    }),
  ],
  concurrency: {
    key: (input: any) =>
      input.event?.correlationId ?? "scheduled-reconciliation",
    policy: "queue",
  },
  permissions: {
    connections: ["unblock-hosted-api", "mock-external"],
  },
  retention: { runs: "30d", logs: "30d", payload: "30d" },
  labels: {
    product: "unblock",
    boundary: "connector-orchestration",
    connector: "mock",
  },
  run: async (ctx, input: any) => {
    const reconciliationKey = ctx.trigger.scheduledFor ??
      ctx.trigger.scheduledAt ?? ctx.run.key;
    const inbound: any = input.event ? mockConnectorApply(input) : null;
    const request = input.event
      ? {
        method: "POST" as const,
        path: "/api/connectors/inbox",
        body: inbound,
        idempotencyKey: inbound.idempotencyKey,
      }
      : {
        method: "POST" as const,
        path: "/api/connectors/reconcile",
        body: input,
        idempotencyKey: `unblock-reconcile:${reconciliationKey}`,
      };
    return await ctx.http("unblock-hosted-api", {
      ...request,
      outcomeRecovery: "reconcile_by_external_id",
      retry: {
        maxAttempts: 8,
        backoff: "exponential",
        retryOn: ["429", "5xx", "network"],
      },
    });
  },
});
