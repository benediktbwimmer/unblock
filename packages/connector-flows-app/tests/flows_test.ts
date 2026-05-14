import { loadFlowAppForTest } from "../../../../prism-new3/packages/prism-flows/testing.ts";

const app = await loadFlowAppForTest({
  entrypoint: new URL("../prism.flow.ts", import.meta.url),
  importNonce: "unblock-connector-flows",
});

Deno.test("hosted Unblock connector Flow app builds", () => {
  app.flow("unblock-connector-dispatch");
  app.assertPermissionManifest({
    connections: ["unblock-hosted-api", "mock-external"],
    jobs: ["mockConnectorApply"],
    secrets: ["UNBLOCK_HOSTED_API_TOKEN", "MOCK_CONNECTOR_TOKEN"],
  });
  app.assertGraphContains("unblock-connector-dispatch", ["trigger", "deno", "http"]);
});

Deno.test("hosted Unblock connector Flow app simulates manual dispatch", () => {
  const simulation = app.simulateTrigger({
    flowId: "unblock-connector-dispatch",
    triggerKind: "manual",
    payload: {
      event: {
        id: "evt-1",
        kind: "connector.outbound.local_changed",
        scope: {
          tenantId: "TENANT",
          projectId: "PROJECT",
          connectionId: "mock-main",
          provider: "mock",
        },
        correlationId: "TENANT:PROJECT:local:task:API",
        idempotencyKey: "TENANT:PROJECT:mock-main:local-change:API",
        local: { kind: "task", id: "API" },
        evidence: {},
        occurredAt: new Date().toISOString(),
      },
      outboxEventId: "outbox-1",
      attempt: 1,
    },
  });

  if (!simulation.events.some((event) => event.kind === "deno_job")) {
    throw new Error("manual connector simulation did not include connector job evidence");
  }
  if (!simulation.events.some((event) => event.kind === "http_request")) {
    throw new Error("manual connector simulation did not include Unblock inbox HTTP evidence");
  }
});
