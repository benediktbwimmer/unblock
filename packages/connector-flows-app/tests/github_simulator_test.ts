import { startGitHubSimulator } from "../scripts/github_simulator.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("GitHub simulator supports issue CRUD, polling, hooks, and signed delivery", async () => {
  const received: Array<{ headers: Headers; body: string }> = [];
  const webhookAbort = new AbortController();
  const webhookServer = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: webhookAbort.signal,
    onListen: () => {},
  }, async (request) => {
    received.push({ headers: request.headers, body: await request.text() });
    return Response.json({ ok: true });
  });
  const webhookUrl = serverUrl(webhookServer);
  const simulator = await startGitHubSimulator({
    rateLimit: { primaryLimit: 100, secondaryLimit: 100, contentLimit: 100 },
  });

  try {
    const hook = await githubJson(
      simulator.url,
      "/repos/acme/roadmap/hooks",
      {
        method: "POST",
        body: {
          name: "web",
          active: true,
          events: ["issues"],
          config: {
            url: webhookUrl,
            content_type: "json",
            secret: "sim-secret",
          },
        },
      },
    );
    assert(hook.id === 1, "hook id should start at 1");

    const issue = await githubJson(
      simulator.url,
      "/repos/acme/roadmap/issues",
      {
        method: "POST",
        body: { title: "First issue", body: "from simulator" },
      },
    );
    assert(issue.number === 1, "issue number should start at 1");
    assert(issue.state === "open", "new issue should be open");

    await simulator.drainWebhooks();
    assert(received.length === 1, "issue create should deliver one webhook");
    assert(
      received[0].headers.get("x-github-event") === "issues",
      "webhook event header should be issues",
    );
    assert(
      received[0].headers.get("x-hub-signature-256") ===
        `sha256=${await hmacSha256Hex("sim-secret", received[0].body)}`,
      "webhook signature should match payload",
    );

    const updated = await githubJson(
      simulator.url,
      "/repos/acme/roadmap/issues/1",
      {
        method: "PATCH",
        body: { title: "Renamed issue", state: "closed" },
      },
    );
    assert(updated.title === "Renamed issue", "patch should update title");
    assert(updated.state === "closed", "patch should close issue");

    const listed = await githubJson(
      simulator.url,
      `/repos/acme/roadmap/issues?state=all&since=${
        encodeURIComponent(issue.created_at)
      }`,
    );
    assert(Array.isArray(listed), "issue list should be an array");
    assert(
      listed.some((item) => item.number === 1),
      "list should include issue",
    );

    const deleted = await fetch(
      `${simulator.url}/repos/acme/roadmap/hooks/${hook.id}`,
      {
        method: "DELETE",
        headers: { authorization: "Bearer test-token" },
      },
    );
    await deleted.body?.cancel();
    assert(deleted.status === 204, "hook delete should return 204");

    const seeded = await githubJson(simulator.url, "/_sim/seed", {
      method: "POST",
      body: {
        repository: "acme/roadmap",
        count: 3,
        titlePrefix: "Seeded",
      },
    });
    assert(seeded.created === 3, "admin seed should create issues in bulk");
    const seededList = await githubJson(
      simulator.url,
      "/repos/acme/roadmap/issues?state=all&per_page=100",
    );
    assert(
      seededList.length === 4,
      "seeded issues should be visible to polling",
    );
  } finally {
    await simulator.close();
    webhookAbort.abort();
    await webhookServer.finished.catch(() => {});
  }
});

Deno.test("GitHub simulator can force primary and secondary rate limits", async () => {
  const primaryLimited = await startGitHubSimulator({
    rateLimit: {
      primaryLimit: 1,
      primaryWindowMs: 60_000,
      secondaryLimit: 100,
      contentLimit: 100,
    },
  });
  try {
    await githubJson(primaryLimited.url, "/repos/acme/limits/issues");
    const limited = await fetch(
      `${primaryLimited.url}/repos/acme/limits/issues`,
      {
        headers: { authorization: "Bearer test-token" },
      },
    );
    await limited.body?.cancel();
    assert(limited.status === 403, "primary limit should return 403");
    assert(
      limited.headers.get("x-ratelimit-remaining") === "0",
      "primary limit should expose exhausted headers",
    );
  } finally {
    await primaryLimited.close();
  }

  const secondaryLimited = await startGitHubSimulator({
    rateLimit: {
      primaryLimit: 100,
      secondaryLimit: 1,
      secondaryWindowMs: 60_000,
      contentLimit: 100,
      retryAfterSeconds: 3,
    },
  });
  try {
    await githubJson(secondaryLimited.url, "/repos/acme/limits/issues");
    const limited = await fetch(
      `${secondaryLimited.url}/repos/acme/limits/issues`,
      {
        headers: { authorization: "Bearer test-token" },
      },
    );
    await limited.body?.cancel();
    assert(limited.status === 429, "secondary limit should return 429");
    assert(
      limited.headers.get("retry-after") === "3",
      "secondary limit should expose retry-after",
    );
  } finally {
    await secondaryLimited.close();
  }
});

async function githubJson(
  baseUrl: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function serverUrl(server: Deno.HttpServer): string {
  const addr = server.addr;
  if (addr.transport !== "tcp") throw new Error("expected tcp server");
  return `http://${addr.hostname}:${addr.port}`;
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
