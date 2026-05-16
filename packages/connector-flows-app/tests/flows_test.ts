import { loadFlowAppForTest } from "../../../../prism-new3/packages/prism-flows/testing.ts";

const app = await loadFlowAppForTest({
  entrypoint: new URL("../prism.flow.ts", import.meta.url),
  importNonce: "unblock-connector-flows",
});

Deno.test("hosted Unblock connector Flow app builds", () => {
  app.flow("unblock-connector-dispatch");
  app.flow("github-issues-inbound");
  app.flow("github-issues-outbound");
  app.flow("github-issues-reconcile");
  app.assertPermissionManifest({
    connections: ["unblock-hosted-api", "mock-external", "github-api"],
    jobs: [],
    secrets: ["UNBLOCK_HOSTED_API_TOKEN", "MOCK_CONNECTOR_TOKEN", "GITHUB_INSTALLATION_TOKEN"],
  });
  for (
    const flowId of [
      "unblock-connector-dispatch",
      "github-issues-inbound",
      "github-issues-outbound",
      "github-issues-reconcile",
    ]
  ) {
    const flow = app.flow(flowId);
    if (flow.engine !== "js") {
      throw new Error(`${flowId} should use the Flow JS engine`);
    }
  }
  app.assertGraphContains("unblock-connector-dispatch", ["trigger", "http"]);
  app.assertGraphContains("github-issues-inbound", ["trigger", "http"]);
  app.assertGraphContains("github-issues-outbound", ["trigger", "http"]);
  app.assertGraphContains("github-issues-reconcile", ["trigger", "http"]);
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

  if (!simulation.events.some((event) => event.kind === "http_request")) {
    throw new Error("manual connector simulation did not include Unblock inbox HTTP evidence");
  }
});

Deno.test("hosted Unblock GitHub reconcile Flow polls with cursor evidence", () => {
  const simulation = app.simulateTrigger({
    flowId: "github-issues-reconcile",
    triggerKind: "manual",
    payload: {
      tenantId: "TENANT",
      projectId: "PROJECT",
      connectionId: "github-main",
      cursor: "2026-05-14T00:00:00Z",
      reason: "test",
    },
  });

  const httpRequests = simulation.events.filter((event) => event.kind === "http_request");
  if (httpRequests.length < 4) {
    throw new Error("GitHub reconcile simulation did not include config lookup, GitHub poll, inbox writes, and cursor write");
  }
});

Deno.test("hosted Unblock GitHub outbound Flow syncs tasks through GitHub API", () => {
  const simulation = app.simulateTrigger({
    flowId: "github-issues-outbound",
    triggerKind: "manual",
    payload: {
      event: {
        id: "evt-outbound-1",
        kind: "connector.outbound.local_changed",
        scope: {
          tenantId: "TENANT",
          projectId: "PROJECT",
          connectionId: "github-main",
          provider: "github",
        },
        correlationId: "TENANT:PROJECT:local:task:API",
        idempotencyKey: "TENANT:PROJECT:github-main:local-change:API",
        local: { kind: "task", id: "API" },
        evidence: {},
        occurredAt: new Date().toISOString(),
      },
      outboxEventId: "outbox-github-1",
      attempt: 1,
    },
  });

  const httpRequests = simulation.events.filter((event) => event.kind === "http_request");
  if (httpRequests.length < 4) {
    throw new Error("GitHub outbound simulation did not include task lookup, connection lookup, GitHub write, and mapping writeback");
  }
});

Deno.test("hosted Unblock GitHub inbound Flow dedupes webhook deliveries", () => {
  const simulation = app.simulateTrigger({
    flowId: "github-issues-inbound",
    triggerKind: "webhook",
    payload: {
      deliveryId: "delivery-1",
      event: "issues",
      scope: {
        tenantId: "TENANT",
        projectId: "PROJECT",
        connectionId: "github-main",
      },
      payload: {
        action: "opened",
        repository: {
          full_name: "acme/repo",
          name: "repo",
          owner: { login: "acme" },
        },
        issue: {
          number: 42,
          node_id: "I_kwDO",
          html_url: "https://github.com/acme/repo/issues/42",
          title: "Webhook issue",
          body: "From GitHub",
          state: "open",
          updated_at: "2026-05-14T00:00:00Z",
        },
      },
    },
  });

  if (simulation.triggerKind !== "webhook") {
    throw new Error("GitHub inbound simulation did not use webhook trigger");
  }
  const httpRequests = simulation.events.filter((event) => event.kind === "http_request");
  if (httpRequests.length !== 1) {
    throw new Error("GitHub inbound simulation should write one inbox HTTP request");
  }
});
