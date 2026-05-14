import { loadFlowAppForTest } from "../../../../prism-new3/packages/prism-flows/testing.ts";

const app = await loadFlowAppForTest({
  entrypoint: new URL("../prism.flow.ts", import.meta.url),
  importNonce: "unblock-github-connector-contract",
});

Deno.test("GitHub webhook trigger declares signature dedupe and correlation", () => {
  const flow = app.flow("github-issues-inbound");
  const webhook = flow.triggers.find((trigger) => trigger.kind === "webhook");
  if (!webhook || webhook.kind !== "webhook") {
    throw new Error("GitHub inbound flow does not declare a webhook trigger");
  }
  if (webhook.signature !== "github") {
    throw new Error("GitHub inbound webhook does not declare GitHub signature verification");
  }
  if (!webhook.dedupeKey) {
    throw new Error("GitHub inbound webhook does not declare delivery dedupe");
  }
  if (webhook.correlationKeys.length === 0) {
    throw new Error("GitHub inbound webhook does not declare correlation keys");
  }
});

Deno.test("GitHub API connection is rate-limited and redacts auth", () => {
  const connection = app.ir.connections.find((item) => item.id === "github-api");
  if (!connection) {
    throw new Error("github-api connection is missing");
  }
  if (connection.rateLimit?.concurrency !== 8 || connection.rateLimit.requestsPerSecond !== 4) {
    throw new Error("github-api connection rate limit changed unexpectedly");
  }
  if (!connection.redaction?.request?.includes("authorization")) {
    throw new Error("github-api connection does not redact authorization");
  }
  if (!connection.network?.allowDomains?.includes("api.github.com")) {
    throw new Error("github-api connection does not constrain network egress");
  }
});

Deno.test("GitHub flows retain idempotency and retry policy in source", async () => {
  const source = [
    await Deno.readTextFile(new URL("../flows/github-issues.ts", import.meta.url)),
    await Deno.readTextFile(new URL("../jobs/github-connector.ts", import.meta.url)),
  ].join("\n");
  for (const expected of [
    "idempotencyKey",
    "retryOn: [\"429\", \"5xx\", \"network\"]",
    "outcomeRecovery: \"reconcile_by_external_id\"",
    "connector.cursor.updated",
  ]) {
    if (!source.includes(expected)) {
      throw new Error(`GitHub flow source is missing ${expected}`);
    }
  }
});
