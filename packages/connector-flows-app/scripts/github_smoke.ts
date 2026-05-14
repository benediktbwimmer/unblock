type Env = Record<string, string | undefined>;

export interface GithubSmokeOptions {
  allowMissingEnv?: boolean;
  cleanup?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface GithubSmokeResult {
  ok: boolean;
  skipped?: boolean;
  missing?: string[];
  steps: SmokeStep[];
  issue?: {
    number: number;
    url: string;
    taskId: string;
  };
}

export interface SmokeStep {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

const REQUIRED_ENV = [
  "UNBLOCK_HOSTED_API_URL",
  "UNBLOCK_HOSTED_API_TOKEN",
  "UNBLOCK_TENANT_ID",
  "UNBLOCK_PROJECT_ID",
  "PRISM_FLOWS_API_URL",
  "GITHUB_REPOSITORY",
  "GITHUB_TOKEN",
];

export function missingGithubSmokeEnv(env: Env): string[] {
  return REQUIRED_ENV.filter((key) => !env[key]?.trim());
}

export async function runGithubSmoke(env: Env, options: GithubSmokeOptions = {}): Promise<GithubSmokeResult> {
  const missing = missingGithubSmokeEnv(env);
  if (missing.length > 0) {
    return {
      ok: false,
      skipped: true,
      missing,
      steps: [{
        name: "preflight",
        ok: false,
        ms: 0,
        detail: `Missing required environment: ${missing.join(", ")}`,
      }],
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const cleanup = options.cleanup !== false;
  const now = options.now ?? (() => new Date());
  const baseUrl = trimTrailingSlash(required(env, "UNBLOCK_HOSTED_API_URL"));
  const unblockToken = required(env, "UNBLOCK_HOSTED_API_TOKEN");
  const prismFlowsUrl = trimTrailingSlash(required(env, "PRISM_FLOWS_API_URL"));
  const prismFlowsToken = env.PRISM_FLOWS_API_TOKEN?.trim();
  const tenantId = required(env, "UNBLOCK_TENANT_ID");
  const projectId = required(env, "UNBLOCK_PROJECT_ID");
  const connectionId = env.UNBLOCK_GITHUB_CONNECTION_ID?.trim() || "github-main";
  const githubToken = required(env, "GITHUB_TOKEN");
  const [owner, repo] = parseRepository(required(env, "GITHUB_REPOSITORY"));
  const runId = now().toISOString().replace(/[:.]/g, "-");
  const title = `[unblock-smoke] ${runId}`;
  const steps: SmokeStep[] = [];
  let issue: any | null = null;
  let taskId = "";

  try {
    issue = await timed(steps, "github.issue.create", () =>
      githubJson(fetchImpl, githubToken, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
        method: "POST",
        body: {
          title,
          body: [
            "Created by the hosted Unblock GitHub connector smoke runner.",
            `Run: ${runId}`,
          ].join("\n\n"),
        },
      })
    );
    taskId = `GH-${Number(issue.number)}`;

    await timed(steps, "prism.github.inbound_flow", () =>
      startPrismFlow(fetchImpl, prismFlowsUrl, prismFlowsToken, {
        flowId: "github-issues-inbound",
        tenantId,
        projectId,
        correlationId: `${tenantId}:${projectId}:external:github:issue:${owner}/${repo}#${Number(issue.number)}`,
        idempotencyKey: `${tenantId}:${projectId}:${connectionId}:github-smoke-inbound:${runId}:${Number(issue.number)}`,
        payload: githubWebhookPayload({
          tenantId,
          projectId,
          connectionId,
          owner,
          repo,
          issue,
          runId,
        }),
      })
    );

    const task: any = await timed(steps, "unblock.task.read", () =>
      waitForJson(() =>
        unblockJson(fetchImpl, baseUrl, unblockToken, `/api/tasks/${encodeURIComponent(taskId)}?projectId=${encodeURIComponent(projectId)}`), {
          validate: (candidate: any) => candidate?.id === taskId && candidate?.title === issue.title,
          timeoutMs: Number(env.UNBLOCK_SMOKE_TIMEOUT_MS ?? 30_000),
          label: `task ${taskId}`,
        }
      )
    );

    const outboundTitle = `${title} outbound`;
    const updatedTask: any = await timed(steps, "unblock.task.update", () =>
      unblockJson(fetchImpl, baseUrl, unblockToken, `/api/tasks/${encodeURIComponent(taskId)}?projectId=${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        body: {
          title: outboundTitle,
          description: `${issue.body ?? ""}\n\nOutbound smoke update: ${runId}`.trim(),
        },
      })
    );

    await timed(steps, "prism.github.outbound_flow", () =>
      startPrismFlow(fetchImpl, prismFlowsUrl, prismFlowsToken, {
        flowId: "github-issues-outbound",
        tenantId,
        projectId,
        correlationId: `${tenantId}:${projectId}:local:task:${taskId}`,
        idempotencyKey: `${tenantId}:${projectId}:${connectionId}:github-smoke-outbound:${runId}:${taskId}`,
        payload: {
          event: githubOutboundEvent({
            tenantId,
            projectId,
            connectionId,
            owner,
            repo,
            issue,
            taskId,
            runId,
          }),
          outboxEventId: `smoke-outbox-${runId}`,
          attempt: 1,
        },
      })
    );

    const updatedIssue: any = await timed(steps, "github.issue.read_after_outbound", () =>
      waitForJson(() =>
        githubJson(fetchImpl, githubToken, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${Number(issue.number)}`), {
          validate: (candidate: any) => candidate?.title === outboundTitle,
          timeoutMs: Number(env.UNBLOCK_SMOKE_TIMEOUT_MS ?? 30_000),
          label: `GitHub issue ${issue.number}`,
        }
      )
    );

    await timed(steps, "unblock.github.mapping.read", async () => {
      const mappings: any[] = await unblockJson(
        fetchImpl,
        baseUrl,
        unblockToken,
        `/api/connectors/github/mappings?projectId=${encodeURIComponent(projectId)}&connectionId=${encodeURIComponent(connectionId)}&limit=100`
      );
      if (!mappings.some((item) => item.taskId === taskId && Number(item.issueNumber) === Number(issue.number))) {
        throw new Error(`No GitHub mapping found for task ${taskId} and issue ${issue.number}.`);
      }
      if (updatedTask.version != null && !mappings.some((item) => item.taskId === taskId && item.localVersion === String(updatedTask.version))) {
        throw new Error(`GitHub mapping for ${taskId} was not refreshed to local version ${updatedTask.version}.`);
      }
      return mappings;
    });

    await timed(steps, "unblock.task.confirm_outbound_title", async () => {
      const confirmed: any = await unblockJson(
        fetchImpl,
        baseUrl,
        unblockToken,
        `/api/tasks/${encodeURIComponent(taskId)}?projectId=${encodeURIComponent(projectId)}`
      );
      if (confirmed.title !== outboundTitle) {
        throw new Error(`Task ${taskId} did not retain outbound title ${outboundTitle}.`);
      }
      return confirmed;
    });

    return {
      ok: true,
      steps,
      issue: {
        number: Number(issue.number),
        url: String(updatedIssue.html_url ?? issue.html_url),
        taskId,
      },
    };
  } finally {
    if (cleanup && issue?.number) {
      await timed(steps, "github.issue.cleanup", () =>
        githubJson(fetchImpl, githubToken, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${Number(issue.number)}`, {
          method: "PATCH",
          body: {
            state: "closed",
            state_reason: "not_planned",
          },
        })
      ).catch((error) => {
        steps.push({
          name: "github.issue.cleanup_error",
          ok: false,
          ms: 0,
          detail: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }
}

async function timed<T>(steps: SmokeStep[], name: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    const result = await run();
    steps.push({ name, ok: true, ms: Math.round(performance.now() - started) });
    return result;
  } catch (error) {
    steps.push({
      name,
      ok: false,
      ms: Math.round(performance.now() - started),
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function githubWebhookPayload(input: {
  tenantId: string;
  projectId: string;
  connectionId: string;
  owner: string;
  repo: string;
  issue: any;
  runId: string;
}) {
  return {
    deliveryId: `smoke-${input.runId}-${input.issue.number}`,
    event: "issues",
    scope: {
      tenantId: input.tenantId,
      projectId: input.projectId,
      connectionId: input.connectionId,
    },
    payload: {
      action: "opened",
      repository: {
        full_name: `${input.owner}/${input.repo}`,
        name: input.repo,
        owner: { login: input.owner },
      },
      issue: input.issue,
    },
  };
}

function githubOutboundEvent(input: {
  tenantId: string;
  projectId: string;
  connectionId: string;
  owner: string;
  repo: string;
  issue: any;
  taskId: string;
  runId: string;
}) {
  const externalId = `${input.owner}/${input.repo}#${Number(input.issue.number)}`;
  return {
    id: `github:smoke:outbound:${input.runId}:${input.taskId}`,
    kind: "connector.outbound.local_changed",
    scope: {
      tenantId: input.tenantId,
      projectId: input.projectId,
      connectionId: input.connectionId,
      provider: "github",
    },
    correlationId: `${input.tenantId}:${input.projectId}:local:task:${input.taskId}`,
    idempotencyKey: `${input.tenantId}:${input.projectId}:${input.connectionId}:github-smoke-outbound:${input.runId}:${input.taskId}`,
    local: { kind: "task", id: input.taskId },
    external: {
      system: "github",
      kind: "issue",
      id: externalId,
      url: input.issue.html_url,
    },
    evidence: {
      source: "github-smoke",
      runId: input.runId,
      githubIssueNumber: Number(input.issue.number),
    },
    occurredAt: new Date().toISOString(),
  };
}

async function startPrismFlow(fetchImpl: typeof fetch, baseUrl: string, token: string | undefined, input: {
  flowId: string;
  tenantId: string;
  projectId: string;
  correlationId: string;
  idempotencyKey: string;
  payload: unknown;
}) {
  return await requestJson(fetchImpl, `${baseUrl}/api/flows/${encodeURIComponent(input.flowId)}/runs`, token, {
    method: "POST",
    headers: {
      "idempotency-key": input.idempotencyKey,
    },
    body: input,
  });
}

async function unblockJson(fetchImpl: typeof fetch, baseUrl: string, token: string, path: string, init: JsonRequest = {}) {
  return await requestJson(fetchImpl, `${baseUrl}${path}`, token, init);
}

async function githubJson(fetchImpl: typeof fetch, token: string, path: string, init: JsonRequest = {}) {
  return await requestJson(fetchImpl, `https://api.github.com${path}`, token, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });
}

interface JsonRequest {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function waitForJson<T>(
  load: () => Promise<T>,
  options: { validate: (candidate: T) => boolean; timeoutMs: number; label: string }
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      const candidate = await load();
      if (options.validate(candidate)) return candidate;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${options.label}.${suffix}`);
}

async function requestJson(fetchImpl: typeof fetch, url: string, token: string | undefined, init: JsonRequest) {
  const response = await fetchImpl(url, {
    method: init.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(redactBody(body))}`);
  }
  return body;
}

function redactBody(body: unknown) {
  if (!body || typeof body !== "object") return body;
  const copy = { ...(body as Record<string, unknown>) };
  for (const key of Object.keys(copy)) {
    if (key.toLowerCase().includes("token") || key.toLowerCase().includes("secret")) {
      copy[key] = "[redacted]";
    }
  }
  return copy;
}

function parseRepository(value: string): [string, string] {
  const [owner, repo] = value.split("/");
  if (!owner || !repo || value.split("/").length !== 2) {
    throw new Error("GITHUB_REPOSITORY must use owner/repo format.");
  }
  return [owner, repo];
}

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

if (import.meta.main) {
  const allowMissingEnv = Deno.args.includes("--allow-missing-env");
  const cleanup = !Deno.args.includes("--no-cleanup");
  const result = await runGithubSmoke(Deno.env.toObject(), { allowMissingEnv, cleanup });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok && !(result.skipped && allowMissingEnv)) {
    Deno.exit(result.skipped ? 2 : 1);
  }
}
