export interface GitHubSimulatorOptions {
  hostname?: string;
  port?: number;
  now?: () => Date;
  deliverWebhooks?: boolean;
  deliveryDelayMs?: number;
  rateLimit?: Partial<GitHubSimulatorRateLimitOptions>;
}

export interface GitHubSimulatorRateLimitOptions {
  primaryLimit: number;
  primaryWindowMs: number;
  secondaryLimit: number;
  secondaryWindowMs: number;
  contentLimit: number;
  contentWindowMs: number;
  retryAfterSeconds: number;
}

export interface GitHubSimulator {
  url: string;
  state: GitHubSimulatorState;
  close: () => Promise<void>;
  reset: () => void;
  drainWebhooks: () => Promise<void>;
}

export interface GitHubSimulatorState {
  repos: Map<string, SimulatedRepository>;
  deliveries: SimulatedWebhookDelivery[];
  requests: SimulatedRequestRecord[];
}

export interface SimulatedRepository {
  owner: string;
  name: string;
  nextIssueNumber: number;
  nextHookId: number;
  issues: Map<number, SimulatedIssue>;
  hooks: Map<number, SimulatedHook>;
}

export interface SimulatedIssue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason?: string | null;
  html_url: string;
  url: string;
  repository_url: string;
  user: { login: string; id: number; type: string };
  labels: unknown[];
  assignees: unknown[];
  milestone: unknown | null;
  pull_request?: unknown;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface SimulatedHook {
  id: number;
  name: string;
  active: boolean;
  events: string[];
  config: {
    url: string;
    content_type: string;
    secret?: string;
    insecure_ssl?: string;
  };
  created_at: string;
  updated_at: string;
}

export interface SimulatedWebhookDelivery {
  id: string;
  hookId: number;
  event: string;
  action: string;
  url: string;
  status?: number;
  ok?: boolean;
  error?: string;
  deliveredAt?: string;
}

export interface SimulatedRequestRecord {
  method: string;
  path: string;
  token: string;
  status: number;
  at: string;
}

const DEFAULT_RATE_LIMIT: GitHubSimulatorRateLimitOptions = {
  primaryLimit: 5_000,
  primaryWindowMs: 60 * 60 * 1_000,
  secondaryLimit: 900,
  secondaryWindowMs: 60 * 1_000,
  contentLimit: 80,
  contentWindowMs: 60 * 1_000,
  retryAfterSeconds: 1,
};

type RateBucket = {
  windowStartedAt: number;
  used: number;
  secondaryWindowStartedAt: number;
  secondaryUsed: number;
  contentWindowStartedAt: number;
  contentUsed: number;
};

export async function startGitHubSimulator(
  options: GitHubSimulatorOptions = {},
): Promise<GitHubSimulator> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 0;
  const now = options.now ?? (() => new Date());
  const rateLimit = { ...DEFAULT_RATE_LIMIT, ...options.rateLimit };
  const state: GitHubSimulatorState = {
    repos: new Map(),
    deliveries: [],
    requests: [],
  };
  const rateBuckets = new Map<string, RateBucket>();
  const pendingDeliveries = new Set<Promise<void>>();
  const abort = new AbortController();

  const server = Deno.serve({
    hostname,
    port,
    signal: abort.signal,
    onListen: () => {},
  }, async (request) => {
    const result = await handleRequest({
      request,
      state,
      now,
      rateLimit,
      rateBuckets,
      pendingDeliveries,
      deliverWebhooks: options.deliverWebhooks !== false,
      deliveryDelayMs: Math.max(0, options.deliveryDelayMs ?? 0),
      baseUrl: simulatorBaseUrl(server),
    });
    return result;
  });

  return {
    url: simulatorBaseUrl(server),
    state,
    reset: () => {
      state.repos.clear();
      state.deliveries.splice(0);
      state.requests.splice(0);
      rateBuckets.clear();
    },
    drainWebhooks: async () => {
      while (pendingDeliveries.size > 0) {
        await Promise.allSettled([...pendingDeliveries]);
      }
    },
    close: async () => {
      abort.abort();
      await server.finished.catch((error) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          throw error;
        }
      });
    },
  };
}

async function handleRequest(input: {
  request: Request;
  state: GitHubSimulatorState;
  now: () => Date;
  rateLimit: GitHubSimulatorRateLimitOptions;
  rateBuckets: Map<string, RateBucket>;
  pendingDeliveries: Set<Promise<void>>;
  deliverWebhooks: boolean;
  deliveryDelayMs: number;
  baseUrl: string;
}): Promise<Response> {
  const url = new URL(input.request.url);
  const method = input.request.method.toUpperCase();
  const token = requestToken(input.request);

  if (url.pathname === "/_sim/state" && method === "GET") {
    return jsonResponse(simulatorSnapshot(input.state));
  }
  if (url.pathname === "/_sim/reset" && method === "POST") {
    input.state.repos.clear();
    input.state.deliveries.splice(0);
    input.state.requests.splice(0);
    input.rateBuckets.clear();
    return jsonResponse({ ok: true });
  }
  if (url.pathname === "/_sim/seed" && method === "POST") {
    const body = await requestJson(input.request);
    return jsonResponse(
      seedSimulator(input.state, body, input.now, input.baseUrl),
      {
        status: 201,
      },
    );
  }
  if (url.pathname === "/_sim/deliveries" && method === "GET") {
    return jsonResponse(input.state.deliveries);
  }

  const rate = checkRateLimit(
    input.rateBuckets,
    token,
    method,
    Date.now(),
    input.rateLimit,
  );
  if (!rate.ok) {
    input.state.requests.push({
      method,
      path: `${url.pathname}${url.search}`,
      token,
      status: rate.status,
      at: input.now().toISOString(),
    });
    return jsonResponse(
      {
        message: rate.message,
        documentation_url:
          "https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api",
      },
      {
        status: rate.status,
        headers: rate.headers,
      },
    );
  }

  const response = await routeGitHubRequest(input, url, method);
  input.state.requests.push({
    method,
    path: `${url.pathname}${url.search}`,
    token,
    status: response.status,
    at: input.now().toISOString(),
  });
  for (const [key, value] of Object.entries(rate.headers)) {
    response.headers.set(key, value);
  }
  return response;
}

async function routeGitHubRequest(
  input: {
    request: Request;
    state: GitHubSimulatorState;
    now: () => Date;
    pendingDeliveries: Set<Promise<void>>;
    deliverWebhooks: boolean;
    deliveryDelayMs: number;
    baseUrl: string;
  },
  url: URL,
  method: string,
): Promise<Response> {
  const match = matchRepoPath(url.pathname);
  if (!match) {
    return jsonResponse({ message: "Not Found" }, { status: 404 });
  }
  const repo = ensureRepo(input.state, match.owner, match.repo);

  if (match.rest.length === 1 && match.rest[0] === "issues") {
    if (method === "GET") {
      return jsonResponse(listIssues(repo, url));
    }
    if (method === "POST") {
      const body = await requestJson(input.request);
      const issue = createIssue(repo, body, input.now, input.baseUrl);
      queueIssueWebhook(input, repo, "opened", issue);
      return jsonResponse(issue, { status: 201 });
    }
  }

  if (
    match.rest.length === 2 && match.rest[0] === "issues" &&
    /^\d+$/.test(match.rest[1])
  ) {
    const issueNumber = Number(match.rest[1]);
    const issue = repo.issues.get(issueNumber);
    if (!issue) return jsonResponse({ message: "Not Found" }, { status: 404 });
    if (method === "GET") return jsonResponse(issue);
    if (method === "PATCH") {
      const beforeState = issue.state;
      const body = await requestJson(input.request);
      updateIssue(issue, body, input.now);
      queueIssueWebhook(input, repo, issueAction(beforeState, issue), issue);
      return jsonResponse(issue);
    }
  }

  if (match.rest.length === 1 && match.rest[0] === "hooks") {
    if (method === "GET") return jsonResponse([...repo.hooks.values()]);
    if (method === "POST") {
      const body = await requestJson(input.request);
      const hook = createHook(repo, body, input.now);
      return jsonResponse(hook, { status: 201 });
    }
  }

  if (
    match.rest.length === 2 && match.rest[0] === "hooks" &&
    /^\d+$/.test(match.rest[1])
  ) {
    const hookId = Number(match.rest[1]);
    if (!repo.hooks.has(hookId)) {
      return jsonResponse({ message: "Not Found" }, { status: 404 });
    }
    if (method === "DELETE") {
      repo.hooks.delete(hookId);
      return new Response(null, { status: 204 });
    }
    if (method === "GET") return jsonResponse(repo.hooks.get(hookId));
  }

  return jsonResponse({ message: "Not Found" }, { status: 404 });
}

function createIssue(
  repo: SimulatedRepository,
  body: Record<string, unknown>,
  now: () => Date,
  baseUrl: string,
): SimulatedIssue {
  const number = repo.nextIssueNumber++;
  const timestamp = now().toISOString();
  const owner = encodeURIComponent(repo.owner);
  const name = encodeURIComponent(repo.name);
  const issue: SimulatedIssue = {
    id: stableNumericId(`${repo.owner}/${repo.name}#${number}`),
    node_id: `SIM_issue_${repo.owner}_${repo.name}_${number}`,
    number,
    title: String(body.title ?? `Issue ${number}`),
    body: body.body == null ? null : String(body.body),
    state: "open",
    state_reason: null,
    html_url: `https://github.example.test/${owner}/${name}/issues/${number}`,
    url: `${baseUrl}/repos/${owner}/${name}/issues/${number}`,
    repository_url: `${baseUrl}/repos/${owner}/${name}`,
    user: { login: "github-simulator", id: 1, type: "Bot" },
    labels: Array.isArray(body.labels) ? body.labels : [],
    assignees: Array.isArray(body.assignees) ? body.assignees : [],
    milestone: body.milestone ?? null,
    created_at: timestamp,
    updated_at: timestamp,
    closed_at: null,
  };
  repo.issues.set(number, issue);
  return issue;
}

function seedSimulator(
  state: GitHubSimulatorState,
  body: Record<string, unknown>,
  now: () => Date,
  baseUrl: string,
) {
  const repository = String(body.repository ?? "");
  const [owner, name] = repository.split("/");
  if (!owner || !name || repository.split("/").length !== 2) {
    return {
      ok: false,
      error: "repository must use owner/repo format",
      created: 0,
      issues: [],
    };
  }
  const repo = ensureRepo(state, owner, name);
  const issueInputs: Record<string, unknown>[] = Array.isArray(body.issues)
    ? body.issues.map(asRecord)
    : Array.from(
      { length: Math.max(0, Math.trunc(Number(body.count ?? 0))) },
      (_, index) => ({
        title: `${String(body.titlePrefix ?? "Seeded issue")} ${index + 1}`,
        body: body.body ?? null,
      }),
    );
  const issues = issueInputs.map((input) => {
    const issue = createIssue(repo, input, now, baseUrl);
    if (input.state === "closed") {
      issue.state = "closed";
      issue.closed_at = issue.updated_at;
    }
    if (typeof input.created_at === "string") {
      issue.created_at = input.created_at;
    }
    if (typeof input.updated_at === "string") {
      issue.updated_at = input.updated_at;
    }
    return issue;
  });
  return {
    ok: true,
    repository,
    created: issues.length,
    issueNumbers: issues.map((issue) => issue.number),
  };
}

function updateIssue(
  issue: SimulatedIssue,
  body: Record<string, unknown>,
  now: () => Date,
) {
  if (body.title !== undefined) issue.title = String(body.title);
  if (body.body !== undefined) {
    issue.body = body.body == null ? null : String(body.body);
  }
  if (body.state === "open" || body.state === "closed") {
    issue.state = body.state;
    issue.closed_at = body.state === "closed" ? now().toISOString() : null;
  }
  if (body.state_reason !== undefined) {
    issue.state_reason = body.state_reason == null
      ? null
      : String(body.state_reason);
  }
  issue.updated_at = now().toISOString();
}

function listIssues(repo: SimulatedRepository, url: URL): SimulatedIssue[] {
  const state = url.searchParams.get("state") ?? "open";
  const since = url.searchParams.get("since");
  const perPage = clampPageSize(Number(url.searchParams.get("per_page") ?? 30));
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const sinceMs = since ? Date.parse(since) : NaN;
  return [...repo.issues.values()]
    .filter((issue) => state === "all" || issue.state === state)
    .filter((issue) =>
      !Number.isFinite(sinceMs) || Date.parse(issue.updated_at) >= sinceMs
    )
    .sort((left, right) =>
      Date.parse(right.updated_at) - Date.parse(left.updated_at) ||
      right.number - left.number
    )
    .slice((page - 1) * perPage, page * perPage);
}

function createHook(
  repo: SimulatedRepository,
  body: Record<string, unknown>,
  now: () => Date,
): SimulatedHook {
  const timestamp = now().toISOString();
  const config = asRecord(body.config);
  const hook: SimulatedHook = {
    id: repo.nextHookId++,
    name: String(body.name ?? "web"),
    active: body.active !== false,
    events: Array.isArray(body.events) ? body.events.map(String) : ["push"],
    config: {
      url: String(config.url ?? ""),
      content_type: String(config.content_type ?? "json"),
      secret: config.secret == null ? undefined : String(config.secret),
      insecure_ssl: config.insecure_ssl == null
        ? undefined
        : String(config.insecure_ssl),
    },
    created_at: timestamp,
    updated_at: timestamp,
  };
  repo.hooks.set(hook.id, hook);
  return hook;
}

function queueIssueWebhook(
  input: {
    state: GitHubSimulatorState;
    now: () => Date;
    pendingDeliveries: Set<Promise<void>>;
    deliverWebhooks: boolean;
    deliveryDelayMs: number;
  },
  repo: SimulatedRepository,
  action: string,
  issue: SimulatedIssue,
) {
  if (!input.deliverWebhooks) return;
  for (const hook of repo.hooks.values()) {
    if (!hook.active || !hook.events.includes("issues") || !hook.config.url) {
      continue;
    }
    const delivery: SimulatedWebhookDelivery = {
      id: `sim-${crypto.randomUUID()}`,
      hookId: hook.id,
      event: "issues",
      action,
      url: hook.config.url,
    };
    input.state.deliveries.push(delivery);
    const promise = deliverWebhook(input, repo, hook, issue, action, delivery)
      .finally(() => input.pendingDeliveries.delete(promise));
    input.pendingDeliveries.add(promise);
  }
}

async function deliverWebhook(
  input: { now: () => Date; deliveryDelayMs: number },
  repo: SimulatedRepository,
  hook: SimulatedHook,
  issue: SimulatedIssue,
  action: string,
  delivery: SimulatedWebhookDelivery,
) {
  if (input.deliveryDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, input.deliveryDelayMs));
  }
  const body = JSON.stringify({
    action,
    repository: {
      id: stableNumericId(`${repo.owner}/${repo.name}`),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner },
      html_url: `https://github.example.test/${repo.owner}/${repo.name}`,
    },
    issue,
  });
  const signature = await hmacSha256Hex(hook.config.secret ?? "", body);
  try {
    const response = await fetch(hook.config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": delivery.id,
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${signature}`,
        "user-agent": "GitHub-Hookshot/github-simulator",
      },
      body,
    });
    await response.body?.cancel();
    delivery.status = response.status;
    delivery.ok = response.ok;
    delivery.deliveredAt = input.now().toISOString();
  } catch (error) {
    delivery.ok = false;
    delivery.error = error instanceof Error ? error.message : String(error);
    delivery.deliveredAt = input.now().toISOString();
  }
}

function issueAction(beforeState: string, issue: SimulatedIssue): string {
  if (beforeState !== issue.state && issue.state === "closed") return "closed";
  if (beforeState !== issue.state && issue.state === "open") return "reopened";
  return "edited";
}

function checkRateLimit(
  buckets: Map<string, RateBucket>,
  token: string,
  method: string,
  nowMs: number,
  options: GitHubSimulatorRateLimitOptions,
): {
  ok: boolean;
  status: number;
  message: string;
  headers: Record<string, string>;
} {
  const bucket = buckets.get(token) ?? {
    windowStartedAt: nowMs,
    used: 0,
    secondaryWindowStartedAt: nowMs,
    secondaryUsed: 0,
    contentWindowStartedAt: nowMs,
    contentUsed: 0,
  };
  buckets.set(token, bucket);
  resetWindow(
    bucket,
    "windowStartedAt",
    "used",
    nowMs,
    options.primaryWindowMs,
  );
  resetWindow(
    bucket,
    "secondaryWindowStartedAt",
    "secondaryUsed",
    nowMs,
    options.secondaryWindowMs,
  );
  resetWindow(
    bucket,
    "contentWindowStartedAt",
    "contentUsed",
    nowMs,
    options.contentWindowMs,
  );

  const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);
  const headers = rateLimitHeaders(bucket, nowMs, options);
  if (bucket.used >= options.primaryLimit) {
    return {
      ok: false,
      status: 403,
      message: "API rate limit exceeded for simulated GitHub token.",
      headers,
    };
  }
  if (bucket.secondaryUsed >= options.secondaryLimit) {
    return secondaryRateLimited(options, headers);
  }
  if (mutating && bucket.contentUsed >= options.contentLimit) {
    return secondaryRateLimited(options, headers);
  }

  bucket.used += 1;
  bucket.secondaryUsed += requestPointCost(method);
  if (mutating) bucket.contentUsed += 1;
  return {
    ok: true,
    status: 200,
    message: "ok",
    headers: rateLimitHeaders(bucket, nowMs, options),
  };
}

function secondaryRateLimited(
  options: GitHubSimulatorRateLimitOptions,
  headers: Record<string, string>,
) {
  return {
    ok: false,
    status: 429,
    message: "You have exceeded a secondary rate limit in the simulator.",
    headers: {
      ...headers,
      "retry-after": String(options.retryAfterSeconds),
    },
  };
}

function requestPointCost(method: string): number {
  return ["GET", "HEAD", "OPTIONS"].includes(method) ? 1 : 5;
}

function rateLimitHeaders(
  bucket: RateBucket,
  nowMs: number,
  options: GitHubSimulatorRateLimitOptions,
): Record<string, string> {
  const resetAt = Math.ceil(
    (bucket.windowStartedAt + options.primaryWindowMs) / 1_000,
  );
  return {
    "x-ratelimit-limit": String(options.primaryLimit),
    "x-ratelimit-remaining": String(
      Math.max(0, options.primaryLimit - bucket.used),
    ),
    "x-ratelimit-used": String(bucket.used),
    "x-ratelimit-reset": String(resetAt),
    "x-ratelimit-resource": "core",
    "date": new Date(nowMs).toUTCString(),
  };
}

function resetWindow<TUsed extends "used" | "secondaryUsed" | "contentUsed">(
  bucket: RateBucket,
  startedKey:
    | "windowStartedAt"
    | "secondaryWindowStartedAt"
    | "contentWindowStartedAt",
  usedKey: TUsed,
  nowMs: number,
  windowMs: number,
) {
  if (nowMs - bucket[startedKey] >= windowMs) {
    bucket[startedKey] = nowMs;
    bucket[usedKey] = 0;
  }
}

function matchRepoPath(pathname: string): {
  owner: string;
  repo: string;
  rest: string[];
} | null {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "repos" || parts.length < 3) return null;
  return {
    owner: parts[1],
    repo: parts[2],
    rest: parts.slice(3),
  };
}

function ensureRepo(
  state: GitHubSimulatorState,
  owner: string,
  name: string,
): SimulatedRepository {
  const key = `${owner}/${name}`;
  const existing = state.repos.get(key);
  if (existing) return existing;
  const created: SimulatedRepository = {
    owner,
    name,
    nextIssueNumber: 1,
    nextHookId: 1,
    issues: new Map(),
    hooks: new Map(),
  };
  state.repos.set(key, created);
  return created;
}

function simulatorSnapshot(state: GitHubSimulatorState) {
  return {
    repos: [...state.repos.values()].map((repo) => ({
      owner: repo.owner,
      name: repo.name,
      issues: [...repo.issues.values()],
      hooks: [...repo.hooks.values()],
    })),
    deliveries: state.deliveries,
    requests: state.requests,
  };
}

async function requestJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  return asRecord(parsed);
}

function jsonResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
  });
}

function requestToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.replace(/^bearer\s+/i, "").trim() || "anonymous";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function clampPageSize(value: number): number {
  if (!Number.isFinite(value)) return 30;
  return Math.min(100, Math.max(1, Math.trunc(value)));
}

function stableNumericId(value: string): number {
  let hash = 2_166_136_261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return Math.abs(hash);
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

function simulatorBaseUrl(server: Deno.HttpServer): string {
  const addr = server.addr;
  if (addr.transport !== "tcp") {
    throw new Error("GitHub simulator requires a TCP listener.");
  }
  const host = addr.hostname.includes(":")
    ? `[${addr.hostname}]`
    : addr.hostname;
  return `http://${host}:${addr.port}`;
}

if (import.meta.main) {
  const portArg = Deno.args.find((arg) => arg.startsWith("--port="));
  const hostArg = Deno.args.find((arg) => arg.startsWith("--host="));
  const simulator = await startGitHubSimulator({
    hostname: hostArg?.slice("--host=".length),
    port: portArg ? Number(portArg.slice("--port=".length)) : undefined,
  });
  console.log(JSON.stringify({ url: simulator.url }));
  await new Promise(() => {});
}
