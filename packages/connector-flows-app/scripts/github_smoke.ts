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

export interface GithubE2EResult extends GithubSmokeResult {
  issues: Array<{
    number: number;
    url: string;
    taskId: string;
    phase: string;
  }>;
}

export interface SmokeStep {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

const REQUIRED_ENV = [
  "UNBLOCK_HOSTED_API_URL",
  "UNBLOCK_TENANT_ID",
  "UNBLOCK_PROJECT_ID",
  "PRISM_RUNTIME_ENDPOINT",
  "GITHUB_REPOSITORY",
  "GITHUB_TOKEN",
  "GITHUB_INSTALLATION_TOKEN",
];

export function missingGithubSmokeEnv(env: Env): string[] {
  const missing = REQUIRED_ENV.filter((key) => !env[key]?.trim());
  if (usesRealGitHubWebhook(env)) {
    for (
      const key of [
        "UNBLOCK_SMOKE_GITHUB_WEBHOOK_URL",
        "UNBLOCK_SMOKE_GITHUB_WEBHOOK_SECRET",
      ]
    ) {
      if (!env[key]?.trim()) missing.push(key);
    }
  }
  if (usesTrustedHeaders(env)) {
    for (
      const key of [
        "UNBLOCK_TRUSTED_PRINCIPAL_ID",
        "UNBLOCK_TRUSTED_ORGANIZATION_ID",
      ]
    ) {
      if (!env[key]?.trim()) missing.push(key);
    }
  } else if (!env.UNBLOCK_HOSTED_API_TOKEN?.trim()) {
    missing.push("UNBLOCK_HOSTED_API_TOKEN");
  }
  return missing;
}

export async function runGithubSmoke(
  env: Env,
  options: GithubSmokeOptions = {},
): Promise<GithubSmokeResult> {
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
  const unblockAuth = unblockAuthHeaders(env);
  const prismRuntimeEndpoint = required(env, "PRISM_RUNTIME_ENDPOINT");
  const tenantId = required(env, "UNBLOCK_TENANT_ID");
  const projectId = required(env, "UNBLOCK_PROJECT_ID");
  const prismProjectId = env.PRISM_FLOWS_PROJECT_ID?.trim() || "unblock-flows";
  const connectionId = env.UNBLOCK_GITHUB_CONNECTION_ID?.trim() ||
    "github-main";
  const githubToken = required(env, "GITHUB_TOKEN");
  const githubApiBaseUrl = githubBaseUrl(env);
  const [owner, repo] = parseRepository(required(env, "GITHUB_REPOSITORY"));
  const runId = now().toISOString().replace(/[:.]/g, "-");
  const title = `[unblock-smoke] ${runId}`;
  const realWebhook = usesRealGitHubWebhook(env);
  const steps: SmokeStep[] = [];
  let issue: any | null = null;
  let hook: any | null = null;
  let taskId = "";

  try {
    if (realWebhook) {
      hook = await timed(
        steps,
        "github.webhook.create",
        () =>
          createGitHubIssueWebhook(
            fetchImpl,
            githubToken,
            githubApiBaseUrl,
            owner,
            repo,
            required(env, "UNBLOCK_SMOKE_GITHUB_WEBHOOK_URL"),
            required(env, "UNBLOCK_SMOKE_GITHUB_WEBHOOK_SECRET"),
          ),
      );
    }

    issue = await timed(
      steps,
      "github.issue.create",
      () =>
        githubJson(
          fetchImpl,
          githubToken,
          githubApiBaseUrl,
          `/repos/${encodeURIComponent(owner)}/${
            encodeURIComponent(repo)
          }/issues`,
          {
            method: "POST",
            body: {
              title,
              body: [
                "Created by the hosted Unblock GitHub connector smoke runner.",
                `Run: ${runId}`,
              ].join("\n\n"),
            },
          },
        ),
    );
    taskId = `GH-${Number(issue.number)}`;

    if (!realWebhook) {
      await timed(
        steps,
        "prism.github.inbound_flow",
        () =>
          startPrismFlow(env, prismRuntimeEndpoint, {
            flowId: "github-issues-inbound",
            prismProjectId,
            tenantId,
            projectId,
            correlationId:
              `${tenantId}:${projectId}:external:github:issue:${owner}/${repo}#${
                Number(issue.number)
              }`,
            idempotencyKey:
              `${tenantId}:${projectId}:${connectionId}:github-smoke-inbound:${runId}:${
                Number(issue.number)
              }`,
            payload: githubWebhookPayload({
              tenantId,
              projectId,
              connectionId,
              owner,
              repo,
              issue,
              runId,
            }),
          }),
      );
    }

    const task: any = await timed(
      steps,
      "unblock.task.read",
      () =>
        waitForJson(() =>
          unblockJson(
            fetchImpl,
            baseUrl,
            unblockAuth,
            `/api/tasks/${encodeURIComponent(taskId)}?projectId=${
              encodeURIComponent(projectId)
            }`,
          ), {
          validate: (candidate: any) =>
            candidate?.id === taskId && candidate?.title === issue.title,
          timeoutMs: Number(env.UNBLOCK_SMOKE_TIMEOUT_MS ?? 30_000),
          label: `task ${taskId}`,
        }),
    );

    const outboundTitle = `${title} outbound`;
    const updatedTask: any = await timed(
      steps,
      "unblock.task.update",
      () =>
        unblockJson(
          fetchImpl,
          baseUrl,
          unblockAuth,
          `/api/tasks/${encodeURIComponent(taskId)}?projectId=${
            encodeURIComponent(projectId)
          }`,
          {
            method: "PATCH",
            body: {
              title: outboundTitle,
              description: `${
                issue.body ?? ""
              }\n\nOutbound smoke update: ${runId}`.trim(),
            },
          },
        ),
    );

    await timed(
      steps,
      "prism.github.outbound_flow",
      () =>
        startPrismFlow(env, prismRuntimeEndpoint, {
          flowId: "github-issues-outbound",
          prismProjectId,
          tenantId,
          projectId,
          correlationId: `${tenantId}:${projectId}:local:task:${taskId}`,
          idempotencyKey:
            `${tenantId}:${projectId}:${connectionId}:github-smoke-outbound:${runId}:${taskId}`,
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
        }),
    );

    const updatedIssue: any = await timed(
      steps,
      "github.issue.read_after_outbound",
      () =>
        waitForJson(() =>
          githubJson(
            fetchImpl,
            githubToken,
            githubApiBaseUrl,
            `/repos/${encodeURIComponent(owner)}/${
              encodeURIComponent(repo)
            }/issues/${Number(issue.number)}`,
          ), {
          validate: (candidate: any) => candidate?.title === outboundTitle,
          timeoutMs: Number(env.UNBLOCK_SMOKE_TIMEOUT_MS ?? 30_000),
          label: `GitHub issue ${issue.number}`,
        }),
    );

    await timed(steps, "unblock.github.mapping.read", async () => {
      const mappings: any[] = await waitForJson(() =>
        unblockJson(
          fetchImpl,
          baseUrl,
          unblockAuth,
          `/api/connectors/github/mappings?projectId=${
            encodeURIComponent(projectId)
          }&connectionId=${encodeURIComponent(connectionId)}&limit=100`,
        ), {
        validate: (candidate: any[]) => {
          const mappingMatchesIssue = (item: any) =>
            (item.taskId ?? item.localId) === taskId &&
            Number(item.issueNumber ?? item.metadata?.issueNumber) ===
              Number(issue.number);
          const mappingMatchesVersion = (item: any) =>
            (item.taskId ?? item.localId) === taskId &&
            (updatedTask.version == null ||
              item.localVersion === String(updatedTask.version));
          return Array.isArray(candidate) &&
            candidate.some(mappingMatchesIssue) &&
            candidate.some(mappingMatchesVersion);
        },
        timeoutMs: Number(env.UNBLOCK_SMOKE_TIMEOUT_MS ?? 30_000),
        label: `GitHub mapping for ${taskId}`,
      });
      const mappingMatchesIssue = (item: any) =>
        (item.taskId ?? item.localId) === taskId &&
        Number(item.issueNumber ?? item.metadata?.issueNumber) ===
          Number(issue.number);
      if (!mappings.some(mappingMatchesIssue)) {
        throw new Error(
          `No GitHub mapping found for task ${taskId} and issue ${issue.number}.`,
        );
      }
      if (
        updatedTask.version != null &&
        !mappings.some((item) =>
          (item.taskId ?? item.localId) === taskId &&
          item.localVersion === String(updatedTask.version)
        )
      ) {
        throw new Error(
          `GitHub mapping for ${taskId} was not refreshed to local version ${updatedTask.version}.`,
        );
      }
      return mappings;
    });

    await timed(steps, "unblock.task.confirm_outbound_title", async () => {
      const confirmed: any = await unblockJson(
        fetchImpl,
        baseUrl,
        unblockAuth,
        `/api/tasks/${encodeURIComponent(taskId)}?projectId=${
          encodeURIComponent(projectId)
        }`,
      );
      if (confirmed.title !== outboundTitle) {
        throw new Error(
          `Task ${taskId} did not retain outbound title ${outboundTitle}.`,
        );
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
    if (hook?.id) {
      await timed(
        steps,
        "github.webhook.cleanup",
        () =>
          deleteGitHubWebhook(
            fetchImpl,
            githubToken,
            githubApiBaseUrl,
            owner,
            repo,
            Number(hook.id),
          ),
      ).catch((error) => {
        steps.push({
          name: "github.webhook.cleanup_error",
          ok: false,
          ms: 0,
          detail: error instanceof Error ? error.message : String(error),
        });
      });
    }
    if (cleanup && issue?.number) {
      await timed(
        steps,
        "github.issue.cleanup",
        () =>
          githubJson(
            fetchImpl,
            githubToken,
            githubApiBaseUrl,
            `/repos/${encodeURIComponent(owner)}/${
              encodeURIComponent(repo)
            }/issues/${Number(issue.number)}`,
            {
              method: "PATCH",
              body: {
                state: "closed",
                state_reason: "not_planned",
              },
            },
          ),
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

export async function runGithubE2E(
  env: Env,
  options: GithubSmokeOptions = {},
): Promise<GithubE2EResult> {
  const missing = missingGithubSmokeEnv({
    ...env,
    UNBLOCK_SMOKE_GITHUB_WEBHOOK: "1",
  });
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
      issues: [],
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const cleanup = options.cleanup !== false;
  const now = options.now ?? (() => new Date());
  const baseUrl = trimTrailingSlash(required(env, "UNBLOCK_HOSTED_API_URL"));
  const unblockAuth = unblockAuthHeaders(env);
  const prismRuntimeEndpoint = required(env, "PRISM_RUNTIME_ENDPOINT");
  const prismProjectId = env.PRISM_FLOWS_PROJECT_ID?.trim() || "unblock-flows";
  const tenantId = required(env, "UNBLOCK_TENANT_ID");
  const projectId = required(env, "UNBLOCK_PROJECT_ID");
  const connectionId = env.UNBLOCK_GITHUB_CONNECTION_ID?.trim() ||
    "github-main";
  const githubToken = required(env, "GITHUB_TOKEN");
  const githubApiBaseUrl = githubBaseUrl(env);
  const [owner, repo] = parseRepository(required(env, "GITHUB_REPOSITORY"));
  const webhookUrl = required(env, "UNBLOCK_SMOKE_GITHUB_WEBHOOK_URL");
  const webhookSecret = required(env, "UNBLOCK_SMOKE_GITHUB_WEBHOOK_SECRET");
  const timeoutMs = Number(env.UNBLOCK_SMOKE_TIMEOUT_MS ?? 30_000);
  const runId = now().toISOString().replace(/[:.]/g, "-");
  const steps: SmokeStep[] = [];
  const issues: GithubE2EResult["issues"] = [];
  const cleanupIssues: number[] = [];

  try {
    await timed(steps, "github.e2e.invalid_signature_rejected", async () => {
      const response = await postSignedGitHubWebhook(fetchImpl, webhookUrl, {
        secret: "wrong-secret",
        deliveryId: `invalid-${runId}`,
        event: "issues",
        body: { action: "opened" },
      });
      if (response.status !== 401) {
        throw new Error(
          `Expected invalid signature to return 401, got ${response.status}.`,
        );
      }
    });

    const smoke = await runGithubSmoke({
      ...env,
      UNBLOCK_SMOKE_GITHUB_WEBHOOK: "1",
    }, options);
    steps.push(
      ...smoke.steps.map((step) => ({ ...step, name: `smoke.${step.name}` })),
    );
    if (!smoke.ok || !smoke.issue) {
      return { ...smoke, steps, issues, ok: false };
    }
    issues.push({ ...smoke.issue, phase: "webhook-outbound" });

    const replayIssue = await timed(
      steps,
      "github.e2e.replay_issue.create",
      () =>
        createSmokeIssue(
          fetchImpl,
          githubToken,
          githubApiBaseUrl,
          owner,
          repo,
          `[unblock-e2e-replay] ${runId}`,
          runId,
        ),
    );
    cleanupIssues.push(Number(replayIssue.number));
    issues.push({
      number: Number(replayIssue.number),
      url: String(replayIssue.html_url),
      taskId: `GH-${Number(replayIssue.number)}`,
      phase: "idempotent-replay",
    });
    await timed(steps, "github.e2e.idempotent_replay", async () => {
      const payload = githubWebhookPayload({
        tenantId,
        projectId,
        connectionId,
        owner,
        repo,
        issue: replayIssue,
        runId,
      });
      const deliveryId = `e2e-replay-${runId}-${replayIssue.number}`;
      const first = await postSignedGitHubWebhook(fetchImpl, webhookUrl, {
        secret: webhookSecret,
        deliveryId,
        event: "issues",
        body: payload.payload,
      });
      const second = await postSignedGitHubWebhook(fetchImpl, webhookUrl, {
        secret: webhookSecret,
        deliveryId,
        event: "issues",
        body: payload.payload,
      });
      const firstBody = await first.json();
      const secondBody = await second.json();
      if (!first.ok || !second.ok) {
        throw new Error(
          `Replay webhook failed: ${first.status}/${second.status}`,
        );
      }
      if (firstBody.created !== true || secondBody.created !== false) {
        throw new Error(
          `Expected replay to attach on second delivery: ${
            JSON.stringify({ firstBody, secondBody })
          }`,
        );
      }
    });
    await waitForTask(
      fetchImpl,
      baseUrl,
      unblockAuth,
      projectId,
      `GH-${Number(replayIssue.number)}`,
      replayIssue.title,
      timeoutMs,
    );

    const manualCursor = new Date(Date.now() - 60_000).toISOString();
    const manualIssue = await timed(
      steps,
      "github.e2e.manual_reconcile_issue.create",
      () =>
        createSmokeIssue(
          fetchImpl,
          githubToken,
          githubApiBaseUrl,
          owner,
          repo,
          `[unblock-e2e-manual] ${runId}`,
          runId,
        ),
    );
    cleanupIssues.push(Number(manualIssue.number));
    await timed(
      steps,
      "github.e2e.manual_reconcile_issue.visible",
      () =>
        waitForGitHubIssueListVisibility(
          fetchImpl,
          githubToken,
          githubApiBaseUrl,
          owner,
          repo,
          Number(manualIssue.number),
          manualCursor,
          timeoutMs,
        ),
    );
    issues.push({
      number: Number(manualIssue.number),
      url: String(manualIssue.html_url),
      taskId: `GH-${Number(manualIssue.number)}`,
      phase: "manual-reconcile",
    });
    await timed(
      steps,
      "prism.github.manual_reconcile_flow",
      () =>
        startPrismFlow(env, prismRuntimeEndpoint, {
          flowId: "github-issues-reconcile",
          prismProjectId,
          tenantId,
          projectId,
          correlationId:
            `${tenantId}:${projectId}:${connectionId}:manual-reconcile:${runId}`,
          idempotencyKey:
            `${tenantId}:${projectId}:${connectionId}:manual-reconcile:${runId}`,
          payload: {
            tenantId,
            projectId,
            connectionId,
            cursor: manualCursor,
            reason: "manual-e2e",
          },
        }),
    );
    await waitForTask(
      fetchImpl,
      baseUrl,
      unblockAuth,
      projectId,
      `GH-${Number(manualIssue.number)}`,
      manualIssue.title,
      timeoutMs,
    );

    const scheduledCursor = new Date(Date.now() - 60_000).toISOString();
    const scheduledIssue = await timed(
      steps,
      "github.e2e.scheduled_reconcile_issue.create",
      () =>
        createSmokeIssue(
          fetchImpl,
          githubToken,
          githubApiBaseUrl,
          owner,
          repo,
          `[unblock-e2e-scheduled] ${runId}`,
          runId,
        ),
    );
    cleanupIssues.push(Number(scheduledIssue.number));
    await timed(
      steps,
      "github.e2e.scheduled_reconcile_issue.visible",
      () =>
        waitForGitHubIssueListVisibility(
          fetchImpl,
          githubToken,
          githubApiBaseUrl,
          owner,
          repo,
          Number(scheduledIssue.number),
          scheduledCursor,
          timeoutMs,
        ),
    );
    issues.push({
      number: Number(scheduledIssue.number),
      url: String(scheduledIssue.html_url),
      taskId: `GH-${Number(scheduledIssue.number)}`,
      phase: "scheduled-reconcile",
    });
    await timed(
      steps,
      "prism.github.scheduled_reconcile_observed",
      () =>
        waitForTask(
          fetchImpl,
          baseUrl,
          unblockAuth,
          projectId,
          `GH-${Number(scheduledIssue.number)}`,
          scheduledIssue.title,
          timeoutMs,
        ),
    );
    await timed(steps, "unblock.github.cursor.confirm", async () => {
      const status = await waitForJson(() =>
        unblockJson(
          fetchImpl,
          baseUrl,
          unblockAuth,
          `/api/connectors/status?projectId=${
            encodeURIComponent(projectId)
          }&limit=20`,
        ), {
        validate: (candidate: any) =>
          candidate?.connections?.some((connection: any) =>
            connection.id === connectionId &&
            connection.cursors?.some((cursor: any) =>
              cursor.name === "issues.updated_at"
            )
          ),
        timeoutMs,
        label: "GitHub reconciliation cursor",
      });
      return status;
    });

    return { ok: true, steps, issue: smoke.issue, issues };
  } finally {
    if (cleanup) {
      for (const issueNumber of cleanupIssues) {
        await timed(
          steps,
          `github.e2e.issue_${issueNumber}.cleanup`,
          () =>
            closeGitHubIssue(
              fetchImpl,
              githubToken,
              githubApiBaseUrl,
              owner,
              repo,
              issueNumber,
            ),
        ).catch((error) => {
          steps.push({
            name: `github.e2e.issue_${issueNumber}.cleanup_error`,
            ok: false,
            ms: 0,
            detail: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
  }
}

async function timed<T>(
  steps: SmokeStep[],
  name: string,
  run: () => Promise<T>,
): Promise<T> {
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
  const externalId = `${input.owner}/${input.repo}#${
    Number(input.issue.number)
  }`;
  return {
    id: `github:smoke:outbound:${input.runId}:${input.taskId}`,
    kind: "connector.outbound.local_changed",
    scope: {
      tenantId: input.tenantId,
      projectId: input.projectId,
      connectionId: input.connectionId,
      provider: "github",
    },
    correlationId:
      `${input.tenantId}:${input.projectId}:local:task:${input.taskId}`,
    idempotencyKey:
      `${input.tenantId}:${input.projectId}:${input.connectionId}:github-smoke-outbound:${input.runId}:${input.taskId}`,
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

async function startPrismFlow(env: Env, endpoint: string, input: {
  flowId: string;
  prismProjectId: string;
  tenantId: string;
  projectId: string;
  correlationId: string;
  idempotencyKey: string;
  payload: unknown;
}) {
  const client = await prismFlowClient(env, endpoint, input.prismProjectId);
  try {
    return await client.startFlow({
      projectId: input.prismProjectId,
      appId: "flows",
      flowId: input.flowId,
      workflowId: input.flowId,
      triggerId: input.flowId === "github-issues-inbound"
        ? "github.issues"
        : "manual",
      flowKey: input.idempotencyKey,
      idempotencyKey: input.idempotencyKey,
      tenantId: input.tenantId,
      unblockProjectId: input.projectId,
      correlationId: input.correlationId,
      payload: input.payload,
      metadata: {
        tenantId: input.tenantId,
        projectId: input.projectId,
        correlationId: input.correlationId,
        idempotencyKey: input.idempotencyKey,
        source: "github_smoke",
      },
      mode: "attach_or_start",
    });
  } finally {
    await client.close?.();
  }
}

async function prismFlowClient(
  env: Env,
  endpoint: string,
  defaultProjectId: string,
) {
  const timeoutMs = Number(env.UNBLOCK_SMOKE_TIMEOUT_MS ?? 30_000);
  if (typeof Deno !== "undefined") {
    const { IsolatedDenoGrpcPrismFlowClient } = await import(
      "../../../../prism-new3/packages/prism-flows/execution-deno.ts"
    );
    return new IsolatedDenoGrpcPrismFlowClient({
      endpoint,
      protoPath: env.PRISM_RUNTIME_PROTO?.trim(),
      defaultProjectId,
      timeoutMs,
    });
  }
  const { GrpcPrismFlowClient } = await import(
    "../../../../prism-new3/packages/prism-flows/execution-node.ts"
  );
  return new GrpcPrismFlowClient({
    endpoint,
    protoPath: env.PRISM_RUNTIME_PROTO?.trim(),
    defaultProjectId,
    timeoutMs,
  });
}

async function unblockJson(
  fetchImpl: typeof fetch,
  baseUrl: string,
  authHeaders: Record<string, string>,
  path: string,
  init: JsonRequest = {},
) {
  return await requestJson(fetchImpl, `${baseUrl}${path}`, undefined, {
    ...init,
    headers: {
      ...authHeaders,
      ...init.headers,
    },
  });
}

async function githubJson(
  fetchImpl: typeof fetch,
  token: string,
  baseUrl: string,
  path: string,
  init: JsonRequest = {},
) {
  return await requestJson(fetchImpl, `${baseUrl}${path}`, token, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });
}

async function createSmokeIssue(
  fetchImpl: typeof fetch,
  token: string,
  baseUrl: string,
  owner: string,
  repo: string,
  title: string,
  runId: string,
) {
  return await githubJson(
    fetchImpl,
    token,
    baseUrl,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
    {
      method: "POST",
      body: {
        title,
        body: [
          "Created by the hosted Unblock GitHub connector e2e runner.",
          `Run: ${runId}`,
        ].join("\n\n"),
      },
    },
  );
}

async function waitForGitHubIssueListVisibility(
  fetchImpl: typeof fetch,
  token: string,
  baseUrl: string,
  owner: string,
  repo: string,
  issueNumber: number,
  since: string,
  timeoutMs: number,
) {
  return await waitForJson(() =>
    githubJson(
      fetchImpl,
      token,
      baseUrl,
      `/repos/${encodeURIComponent(owner)}/${
        encodeURIComponent(repo)
      }/issues?state=all&per_page=100&since=${encodeURIComponent(since)}`,
    ), {
    validate: (candidate: any) =>
      Array.isArray(candidate) &&
      candidate.some((issue) => Number(issue?.number) === issueNumber),
    timeoutMs,
    label: `GitHub issue list visibility for #${issueNumber}`,
  });
}

async function closeGitHubIssue(
  fetchImpl: typeof fetch,
  token: string,
  baseUrl: string,
  owner: string,
  repo: string,
  issueNumber: number,
) {
  return await githubJson(
    fetchImpl,
    token,
    baseUrl,
    `/repos/${encodeURIComponent(owner)}/${
      encodeURIComponent(repo)
    }/issues/${issueNumber}`,
    {
      method: "PATCH",
      body: {
        state: "closed",
        state_reason: "not_planned",
      },
    },
  );
}

async function waitForTask(
  fetchImpl: typeof fetch,
  baseUrl: string,
  unblockAuth: Record<string, string>,
  projectId: string,
  taskId: string,
  title: string,
  timeoutMs: number,
) {
  return await waitForJson(() =>
    unblockJson(
      fetchImpl,
      baseUrl,
      unblockAuth,
      `/api/tasks/${encodeURIComponent(taskId)}?projectId=${
        encodeURIComponent(projectId)
      }`,
    ), {
    validate: (candidate: any) =>
      candidate?.id === taskId && candidate?.title === title,
    timeoutMs,
    label: `task ${taskId}`,
  });
}

async function postSignedGitHubWebhook(
  fetchImpl: typeof fetch,
  url: string,
  input: {
    secret: string;
    deliveryId: string;
    event: string;
    body: unknown;
  },
): Promise<Response> {
  const raw = JSON.stringify(input.body);
  const signature = await hmacSha256Hex(input.secret, raw);
  return await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": input.deliveryId,
      "x-github-event": input.event,
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body: raw,
  });
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

async function createGitHubIssueWebhook(
  fetchImpl: typeof fetch,
  token: string,
  baseUrl: string,
  owner: string,
  repo: string,
  url: string,
  secret: string,
) {
  return await githubJson(
    fetchImpl,
    token,
    baseUrl,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
    {
      method: "POST",
      body: {
        name: "web",
        active: true,
        events: ["issues"],
        config: {
          url,
          content_type: "json",
          secret,
          insecure_ssl: "0",
        },
      },
    },
  );
}

async function deleteGitHubWebhook(
  fetchImpl: typeof fetch,
  token: string,
  baseUrl: string,
  owner: string,
  repo: string,
  hookId: number,
) {
  return await githubJson(
    fetchImpl,
    token,
    baseUrl,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks/${
      encodeURIComponent(String(hookId))
    }`,
    { method: "DELETE" },
  );
}

interface JsonRequest {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function waitForJson<T>(
  load: () => Promise<T>,
  options: {
    validate: (candidate: T) => boolean;
    timeoutMs: number;
    label: string;
  },
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
  const suffix = lastError instanceof Error
    ? ` Last error: ${lastError.message}`
    : "";
  throw new Error(`Timed out waiting for ${options.label}.${suffix}`);
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  token: string | undefined,
  init: JsonRequest,
) {
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
    throw new Error(
      `${response.status} ${response.statusText}: ${
        JSON.stringify(redactBody(body))
      }`,
    );
  }
  return body;
}

function redactBody(body: unknown) {
  if (!body || typeof body !== "object") return body;
  const copy = { ...(body as Record<string, unknown>) };
  for (const key of Object.keys(copy)) {
    if (
      key.toLowerCase().includes("token") ||
      key.toLowerCase().includes("secret")
    ) {
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

function unblockAuthHeaders(env: Env): Record<string, string> {
  if (usesTrustedHeaders(env)) {
    return {
      "x-unblock-principal-id": required(env, "UNBLOCK_TRUSTED_PRINCIPAL_ID"),
      "x-unblock-workos-organization-id": required(
        env,
        "UNBLOCK_TRUSTED_ORGANIZATION_ID",
      ),
      "x-unblock-roles": env.UNBLOCK_TRUSTED_ROLES?.trim() || "owner",
      ...(env.UNBLOCK_TRUSTED_PERMISSIONS?.trim()
        ? { "x-unblock-permissions": env.UNBLOCK_TRUSTED_PERMISSIONS.trim() }
        : {}),
      ...(env.UNBLOCK_TRUSTED_SESSION_ID?.trim()
        ? { "x-unblock-session-id": env.UNBLOCK_TRUSTED_SESSION_ID.trim() }
        : {}),
    };
  }
  return {
    Authorization: `Bearer ${required(env, "UNBLOCK_HOSTED_API_TOKEN")}`,
  };
}

function usesTrustedHeaders(env: Env): boolean {
  return env.UNBLOCK_HOSTED_AUTH_MODE?.trim() === "trusted-headers" ||
    env.UNBLOCK_SMOKE_AUTH_MODE?.trim() === "trusted-headers";
}

function usesRealGitHubWebhook(env: Env): boolean {
  return env.UNBLOCK_SMOKE_GITHUB_WEBHOOK?.trim() === "1" ||
    !!env.UNBLOCK_SMOKE_GITHUB_WEBHOOK_URL?.trim();
}

function githubBaseUrl(env: Env): string {
  return trimTrailingSlash(
    env.GITHUB_API_BASE_URL?.trim() || "https://api.github.com",
  );
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
  const fullE2E = Deno.args.includes("--full-e2e");
  const result = fullE2E
    ? await runGithubE2E(Deno.env.toObject(), {
      allowMissingEnv,
      cleanup,
    })
    : await runGithubSmoke(Deno.env.toObject(), {
      allowMissingEnv,
      cleanup,
    });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok && !(result.skipped && allowMissingEnv)) {
    Deno.exit(result.skipped ? 2 : 1);
  }
}
