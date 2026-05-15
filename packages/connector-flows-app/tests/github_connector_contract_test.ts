import { loadFlowAppForTest } from "../../../../prism-new3/packages/prism-flows/testing.ts";
import {
  normalizeGitHubIssueBackfill,
  prepareGitHubIssueBackfill,
} from "../jobs/github-connector.ts";

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
    throw new Error(
      "GitHub inbound webhook does not declare GitHub signature verification",
    );
  }
  if (!webhook.dedupeKey) {
    throw new Error("GitHub inbound webhook does not declare delivery dedupe");
  }
  if (webhook.correlationKeys.length === 0) {
    throw new Error("GitHub inbound webhook does not declare correlation keys");
  }
});

Deno.test("GitHub API connection is rate-limited and redacts auth", () => {
  const connection = app.ir.connections.find((item) =>
    item.id === "github-api"
  );
  if (!connection) {
    throw new Error("github-api connection is missing");
  }
  if (
    connection.rateLimit?.concurrency !== 8 ||
    connection.rateLimit.requestsPerSecond !== 4
  ) {
    throw new Error("github-api connection rate limit changed unexpectedly");
  }
  if (!connection.redaction?.request?.includes("authorization")) {
    throw new Error("github-api connection does not redact authorization");
  }
  if (connection.baseUrlEnv !== "GITHUB_API_BASE_URL") {
    throw new Error(
      "github-api connection cannot be redirected to the simulator",
    );
  }
  if (!connection.network?.allowDomains?.includes("api.github.com")) {
    throw new Error("github-api connection does not constrain network egress");
  }
  if (!connection.network?.allowDomains?.includes("127.0.0.1")) {
    throw new Error("github-api connection does not allow the local simulator");
  }
});

Deno.test("GitHub flows retain idempotency and retry policy in source", async () => {
  const source = [
    await Deno.readTextFile(
      new URL("../flows/github-issues.ts", import.meta.url),
    ),
    await Deno.readTextFile(
      new URL("../jobs/github-connector.ts", import.meta.url),
    ),
  ].join("\n");
  for (
    const expected of [
      "idempotencyKey",
      'retryOn: ["429", "5xx", "network"]',
      'outcomeRecovery: "reconcile_by_external_id"',
      "connector.cursor.updated",
    ]
  ) {
    if (!source.includes(expected)) {
      throw new Error(`GitHub flow source is missing ${expected}`);
    }
  }
});

Deno.test("GitHub reconcile uses stored cursors with a bounded replay window", () => {
  const prepared = prepareGitHubIssueBackfill({
    input: {
      tenantId: "TENANT",
      projectId: "PROJECT",
      connectionId: "github-main",
      replayWindowSeconds: 120,
    },
    connections: [{
      id: "github-main",
      metadata: {
        repositoryOwner: "acme",
        repositoryName: "repo",
      },
      cursors: [{
        name: "issues.updated_at",
        value: "2026-05-14T10:00:00.000Z",
      }],
    }],
  });
  if (
    !String(prepared.request.path).includes(
      "since=2026-05-14T09%3A58%3A00.000Z",
    )
  ) {
    throw new Error(
      `GitHub reconcile did not apply replay cursor: ${prepared.request.path}`,
    );
  }
  if (prepared.effectiveCursor !== "2026-05-14T10:00:00.000Z") {
    throw new Error(
      "GitHub reconcile did not retain the stored effective cursor",
    );
  }
});

Deno.test("GitHub reconcile cursor never moves backward for replayed pages", () => {
  const normalized = normalizeGitHubIssueBackfill({
    prepared: {
      connection: {
        id: "github-main",
        metadata: {
          repositoryOwner: "acme",
          repositoryName: "repo",
        },
      },
      scope: {
        tenantId: "TENANT",
        projectId: "PROJECT",
        connectionId: "github-main",
        provider: "github",
      },
      cursorName: "issues.updated_at",
      effectiveCursor: "2026-05-14T10:00:00.000Z",
      requestStartedAt: "2026-05-14T10:05:00.000Z",
      replayWindowSeconds: 300,
    },
    response: [{
      number: 42,
      title: "Replay",
      body: "",
      state: "open",
      html_url: "https://github.com/acme/repo/issues/42",
      updated_at: "2026-05-14T09:59:00.000Z",
    }],
  });
  if (normalized.cursorEvent.cursor.value !== "2026-05-14T10:05:00.000Z") {
    throw new Error(`Cursor moved to ${normalized.cursorEvent.cursor.value}`);
  }
});
