import {
  type GithubE2EResult,
  runGithubE2E,
  type SmokeStep,
} from "./github_smoke.ts";
import { startGitHubSimulator } from "./github_simulator.ts";
import {
  startLocalPrismFlowsRuntime,
  stopLocalPrismFlowsRuntime,
} from "../../../../prism-new3/packages/prism-flows/local-runtime.ts";
import { normalizeGitHubIssueWebhook } from "../helpers/github-connector.ts";

type Env = Record<string, string | undefined>;

export type HarnessMode =
  | "e2e"
  | "benchmark-reconcile"
  | "benchmark-webhook"
  | "benchmark-direct-inbox"
  | "benchmark-direct-webhook";

export interface HarnessOptions {
  mode: HarnessMode;
  unblockServerMode: "dist" | "dev";
  directWebhookClient: "node" | "deno";
  issueCount: number;
  cleanup: boolean;
  timeoutMs: number;
  tenantId: string;
  projectId: string;
  connectionId: string;
  repository: string;
  prismProjectId: string;
  flowExecutorProcesses: number;
  flowExecutorConcurrency: number;
  schedulerIntervalMs: number;
  issueCreateConcurrency: number;
}

export interface HarnessResult {
  ok: boolean;
  mode: HarnessMode;
  steps: SmokeStep[];
  e2e?: GithubE2EResult;
  benchmark?: {
    issueCount: number;
    elapsedMs: number;
    throughputPerSecond: number;
    webhookSubmitMs?: number;
    taskVisibleElapsedMs?: number;
    taskVisibleThroughputPerSecond?: number;
    effectCompleteElapsedMs?: number;
    effectCompleteThroughputPerSecond?: number;
    workflowCompleteElapsedMs?: number;
    workflowCompleteThroughputPerSecond?: number;
    diagnosticsMs?: number;
    taskCount: number;
    taskCreatedSpanMs?: number | null;
    taskCreatedOffsetP50Ms?: number | null;
    taskCreatedOffsetP95Ms?: number | null;
    inboxCreatedSpanMs?: number | null;
    inboxAppliedSpanMs?: number | null;
    inboxApplyLagP50Ms?: number | null;
    inboxApplyLagP95Ms?: number | null;
    inboxEventCount?: number;
    inboxEventsWithMapping?: number;
    connectorMappingCount?: number;
    connectorMappingCreatedSpanMs?: number | null;
    connectorMappingUpdatedSpanMs?: number | null;
    activityCount?: number;
    activityCreatedSpanMs?: number | null;
    hostedAuditCount?: number;
    prismWorkflowCount?: number;
    prismWorkflowCompletedCount?: number;
    prismWorkflowStartSpanMs?: number | null;
    prismWorkflowIntentSpanMs?: number | null;
    prismWorkflowLeaseSpanMs?: number | null;
    prismWorkflowResultSpanMs?: number | null;
    prismWorkflowTerminalSpanMs?: number | null;
    prismWorkflowRuntimeSpanMs?: number | null;
    prismWorkflowStartToIntentP50Ms?: number | null;
    prismWorkflowStartToIntentP95Ms?: number | null;
    prismWorkflowResultToTerminalP50Ms?: number | null;
    prismWorkflowResultToTerminalP95Ms?: number | null;
    prismWorkflowStartToTerminalP50Ms?: number | null;
    prismWorkflowStartToTerminalP95Ms?: number | null;
    prismWorkflowShardCount?: number;
    prismWorkflowStatusCounts?: Record<string, number>;
    prismEffectCount?: number;
    prismEffectCompletedCount?: number;
    prismEffectSpanMs?: number | null;
    prismEffectQueueP50Ms?: number | null;
    prismEffectQueueP95Ms?: number | null;
    prismEffectRunP50Ms?: number | null;
    prismEffectRunP95Ms?: number | null;
    prismEffectTotalP50Ms?: number | null;
    prismEffectTotalP95Ms?: number | null;
    prismEffectStatusCounts?: Record<string, number>;
    prismEffectKindCounts?: Record<string, number>;
    webhookDeliveries?: {
      total: number;
      ok: number;
      failed: number;
      submitWallMs?: number;
      latencyP50Ms?: number;
      latencyP95Ms?: number;
      latencyP99Ms?: number;
      latencyMaxMs?: number;
    };
  };
  diagnostics?: string[];
}

const DEFAULT_TIMEOUT_MS = 120_000;
const WEBHOOK_SECRET = "github-simulator-webhook-secret";
const HOSTED_SECRET_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

export function parseHarnessOptions(
  args: string[] = [],
  env: Env = Deno.env.toObject(),
): HarnessOptions {
  const flags = parseFlags(args);
  const mode = flagValue(flags, "mode") ??
    (flags.has("benchmark") ? "benchmark-reconcile" : "e2e");
  if (!isHarnessMode(mode)) {
    throw new Error(
      `Unsupported mode ${mode}. Expected e2e, benchmark-reconcile, benchmark-webhook, benchmark-direct-inbox, or benchmark-direct-webhook.`,
    );
  }
  return {
    mode,
    unblockServerMode: parseUnblockServerMode(
      flagValue(flags, "unblock-server") ?? env.UNBLOCK_SIM_SERVER_MODE,
    ),
    directWebhookClient: parseDirectWebhookClient(
      flagValue(flags, "direct-webhook-client") ??
        env.UNBLOCK_SIM_DIRECT_WEBHOOK_CLIENT,
    ),
    issueCount: positiveInteger(
      flagValue(flags, "issues") ?? env.UNBLOCK_SIM_ISSUES,
      1_000,
    ),
    cleanup: !flags.has("no-cleanup"),
    timeoutMs: positiveInteger(
      flagValue(flags, "timeout-ms") ?? env.UNBLOCK_SIM_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    ),
    tenantId: flagValue(flags, "tenant") ?? env.UNBLOCK_TENANT_ID ??
      "ORG_UNBLOCK_SIM",
    projectId: flagValue(flags, "project") ?? env.UNBLOCK_PROJECT_ID ??
      `SIM_${Date.now()}`,
    connectionId: flagValue(flags, "connection") ??
      env.UNBLOCK_GITHUB_CONNECTION_ID ?? "github-main",
    repository: flagValue(flags, "repo") ?? env.GITHUB_REPOSITORY ??
      "simulated/unblock",
    prismProjectId: flagValue(flags, "prism-project") ??
      env.PRISM_FLOWS_PROJECT_ID ?? "unblock-flows",
    flowExecutorProcesses: positiveInteger(
      flagValue(flags, "flow-executor-processes") ??
        env.PRISM_FLOWS_EXECUTOR_PROCESSES,
      1,
    ),
    flowExecutorConcurrency: positiveInteger(
      flagValue(flags, "flow-executor-concurrency") ??
        env.PRISM_FLOWS_EXECUTOR_CONCURRENCY,
      256,
    ),
    schedulerIntervalMs: positiveInteger(
      flagValue(flags, "scheduler-interval-ms") ??
        env.PRISM_FLOWS_SCHEDULER_INTERVAL_MS,
      1_000,
    ),
    issueCreateConcurrency: positiveInteger(
      flagValue(flags, "issue-create-concurrency") ??
        env.UNBLOCK_SIM_ISSUE_CREATE_CONCURRENCY,
      32,
    ),
  };
}

export function missingHarnessEnv(env: Env = Deno.env.toObject()): string[] {
  const missing = [];
  if (!postgresUrlForUnblock(env)) {
    missing.push("UNBLOCK_E2E_POSTGRES_URL or UNBLOCK_POSTGRES_URL");
  }
  if (!postgresUrlForPrism(env)) {
    missing.push("PRISM_POSTGRES_URL or UNBLOCK_E2E_POSTGRES_URL");
  }
  return missing;
}

export async function runGithubSimulatorHarness(
  env: Env = Deno.env.toObject(),
  options: HarnessOptions = parseHarnessOptions([], env),
): Promise<HarnessResult> {
  const missing = missingHarnessEnv(env);
  if (missing.length > 0) {
    return {
      ok: false,
      mode: options.mode,
      steps: [{
        name: "preflight",
        ok: false,
        ms: 0,
        detail: `Missing required environment: ${missing.join(", ")}`,
      }],
      diagnostics: missing,
    };
  }

  const steps: SmokeStep[] = [];
  const runtimeDir = await Deno.makeTempDir({
    prefix: "unblock-github-sim-",
  });
  const configPath = `${runtimeDir}/unblock.config.json`;
  const unblockPort = await freePort();
  const prismPort = await freePort();
  const ingressPort = await freePort();
  const simulatorPort = await freePort();
  const unblockUrl = `http://127.0.0.1:${unblockPort}`;
  const prismEndpoint = `http://127.0.0.1:${prismPort}`;
  const ingressUrl = `http://127.0.0.1:${ingressPort}`;
  const [owner, repo] = parseRepository(options.repository);
  const simulator = await startGitHubSimulator({
    port: simulatorPort,
    rateLimit: {
      primaryLimit: 1_000_000,
      secondaryLimit: 1_000_000,
      contentLimit: 1_000_000,
    },
  });
  let unblock: ManagedProcess | undefined;
  let prismStopped = false;

  const originalEnv = snapshotEnv([
    "UNBLOCK_HOSTED_API_URL",
    "UNBLOCK_HOSTED_API_TOKEN",
    "UNBLOCK_HOSTED_AUTH_MODE",
    "UNBLOCK_HOSTED_SECRET_KEY",
    "UNBLOCK_HOSTED_SECRET_KEY_ID",
    "UNBLOCK_TRUSTED_PRINCIPAL_ID",
    "UNBLOCK_TRUSTED_ORGANIZATION_ID",
    "UNBLOCK_TRUSTED_ROLES",
    "UNBLOCK_TRUSTED_PERMISSIONS",
    "UNBLOCK_TRUSTED_SESSION_ID",
    "UNBLOCK_POSTGRES_URL",
    "UNBLOCK_BACKEND",
    "UNBLOCK_CONFIG",
    "UNBLOCK_STRUCTURED_LOGS",
    "GITHUB_API_BASE_URL",
    "GITHUB_INSTALLATION_TOKEN",
    "PRISM_WEBHOOK_SECRET",
  ]);

  try {
    await Deno.writeTextFile(
      configPath,
      `${
        JSON.stringify(
          {
            identity: { machine: "sim-harness", actor: "codex-e" },
            storage: {
              mode: "hosted",
              postgresUrl: postgresUrlForUnblock(env),
            },
          },
          null,
          2,
        )
      }\n`,
    );

    const commonEnv = {
      UNBLOCK_BACKEND: "hosted",
      UNBLOCK_POSTGRES_URL: postgresUrlForUnblock(env)!,
      UNBLOCK_HOSTED_API_URL: unblockUrl,
      UNBLOCK_HOSTED_API_TOKEN: "sim-unblock-token",
      UNBLOCK_HOSTED_AUTH_MODE: "trusted-headers",
      UNBLOCK_HOSTED_SECRET_KEY: HOSTED_SECRET_KEY,
      UNBLOCK_HOSTED_SECRET_KEY_ID: "sim",
      UNBLOCK_TRUSTED_PRINCIPAL_ID: "codex-e",
      UNBLOCK_TRUSTED_ORGANIZATION_ID: options.tenantId,
      UNBLOCK_TRUSTED_ROLES: "owner",
      UNBLOCK_TRUSTED_PERMISSIONS: "",
      UNBLOCK_TRUSTED_SESSION_ID: "sim-harness",
      UNBLOCK_CONFIG: configPath,
      UNBLOCK_STRUCTURED_LOGS: "false",
      UNBLOCK_RATE_LIMIT_MAX: "1000000",
      GITHUB_API_BASE_URL: simulator.url,
      GITHUB_INSTALLATION_TOKEN: "sim-installation-token",
      PRISM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    };
    setEnv(commonEnv);

    unblock = await timed(steps, "unblock.start", async () => {
      if (options.unblockServerMode === "dist") {
        await timed(
          steps,
          "unblock.build",
          () =>
            runCommand("npm", ["run", "build", "-w", "@unblock/server"], {
              cwd: repoRoot(),
              env: commonEnv,
            }),
        );
      }
      const serverCommand = options.unblockServerMode === "dist"
        ? {
          command: "node",
          args: ["packages/server/dist/index.js"],
        }
        : {
          command: "npm",
          args: ["run", "dev", "-w", "@unblock/server"],
        };
      const child = startManagedProcess({
        command: serverCommand.command,
        args: serverCommand.args,
        cwd: repoRoot(),
        env: {
          ...commonEnv,
          PORT: String(unblockPort),
          UNBLOCK_API_PORT: String(unblockPort),
        },
      });
      await waitForHttp(`${unblockUrl}/api/health`, options.timeoutMs, child);
      return child;
    });

    await timed(steps, "unblock.configure", () =>
      configureUnblock({
        baseUrl: unblockUrl,
        tenantId: options.tenantId,
        projectId: options.projectId,
        connectionId: options.connectionId,
        owner,
        repo,
      }));

    const metadataJson = JSON.stringify({
      tenantId: options.tenantId,
      projectId: options.projectId,
      connectionId: options.connectionId,
      webhookScope: {
        tenantId: options.tenantId,
        projectId: options.projectId,
        connectionId: options.connectionId,
      },
      schedulePayload: {
        tenantId: options.tenantId,
        projectId: options.projectId,
        connectionId: options.connectionId,
        reason: "simulator-scheduled-reconciliation",
      },
      scheduleOverrides: {
        "github-issues-reconcile": {
          schedule: "* * * * *",
          payload: { reason: "simulator-scheduled-reconciliation" },
        },
      },
    });

    const runtime = await timed(steps, "prism.start", async () => {
      const result = await startLocalPrismFlowsRuntime({
        storageBackend: "postgres",
        postgresUrl: postgresUrlForPrism(env)!,
        bind: `127.0.0.1:${prismPort}`,
        outDir: runtimeDir,
        entrypoint: new URL("../prism.flow.ts", import.meta.url),
        projectId: options.prismProjectId,
        prismBin: prismBinary("prism"),
        executorBin: prismBinary("prism-runtime-v2-executor"),
        executorProcesses: options.flowExecutorProcesses,
        executorConcurrency: options.flowExecutorConcurrency,
        webhookBind: `127.0.0.1:${ingressPort}`,
        disableScheduler: options.mode !== "e2e",
        schedulerIntervalMs: options.schedulerIntervalMs,
        metadataJson,
      });
      if (!result.ok || !result.runtimePlan) {
        throw new Error(
          `Prism Flow runtime failed to start: ${
            result.diagnostics.join("\n")
          }`,
        );
      }
      await waitForTcp("127.0.0.1", prismPort, options.timeoutMs);
      return result;
    });

    await timed(steps, "prism.ingress.start", async () => {
      await waitForHttp(`${ingressUrl}/healthz`, options.timeoutMs);
    });

    const smokeEnv: Env = {
      UNBLOCK_HOSTED_API_URL: unblockUrl,
      UNBLOCK_HOSTED_AUTH_MODE: "trusted-headers",
      UNBLOCK_E2E_POSTGRES_URL: postgresUrlForUnblock(env)!,
      PRISM_POSTGRES_URL: postgresUrlForPrism(env)!,
      UNBLOCK_TRUSTED_PRINCIPAL_ID: "codex-e",
      UNBLOCK_TRUSTED_ORGANIZATION_ID: options.tenantId,
      UNBLOCK_TRUSTED_ROLES: "owner",
      UNBLOCK_TENANT_ID: options.tenantId,
      UNBLOCK_PROJECT_ID: options.projectId,
      UNBLOCK_GITHUB_CONNECTION_ID: options.connectionId,
      PRISM_RUNTIME_ENDPOINT: prismEndpoint,
      PRISM_FLOWS_PROJECT_ID: options.prismProjectId,
      GITHUB_REPOSITORY: options.repository,
      GITHUB_TOKEN: "sim-runner-token",
      GITHUB_INSTALLATION_TOKEN: "sim-installation-token",
      GITHUB_API_BASE_URL: simulator.url,
      UNBLOCK_SMOKE_GITHUB_WEBHOOK: "1",
      UNBLOCK_SMOKE_GITHUB_WEBHOOK_URL: `${ingressUrl}/webhooks/github/issues`,
      UNBLOCK_SMOKE_GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      UNBLOCK_SMOKE_TIMEOUT_MS: String(options.timeoutMs),
    };

    if (options.mode === "e2e") {
      const e2e = await timed(
        steps,
        "github.simulator.e2e",
        () => runGithubE2E(smokeEnv, { cleanup: options.cleanup }),
      );
      steps.push(...e2e.steps.map((step) => ({
        ...step,
        name: `github.e2e.${step.name}`,
      })));
      return { ok: e2e.ok, mode: options.mode, steps, e2e };
    }

    const benchmark = options.mode === "benchmark-reconcile"
      ? await runReconcileBenchmark({
        env: smokeEnv,
        steps,
        issueCount: options.issueCount,
        owner,
        repo,
        simulatorUrl: simulator.url,
        timeoutMs: options.timeoutMs,
      })
      : options.mode === "benchmark-webhook"
      ? await runWebhookBenchmark({
        env: smokeEnv,
        steps,
        issueCount: options.issueCount,
        owner,
        repo,
        simulator,
        timeoutMs: options.timeoutMs,
        issueCreateConcurrency: options.issueCreateConcurrency,
      })
      : options.mode === "benchmark-direct-inbox"
      ? await runDirectInboxBenchmark({
        env: smokeEnv,
        steps,
        issueCount: options.issueCount,
        owner,
        repo,
        timeoutMs: options.timeoutMs,
        concurrency: options.issueCreateConcurrency,
      })
      : await runDirectWebhookBenchmark({
        env: smokeEnv,
        steps,
        issueCount: options.issueCount,
        owner,
        repo,
        timeoutMs: options.timeoutMs,
        webhookConcurrency: options.issueCreateConcurrency,
        client: options.directWebhookClient,
      });
    await timed(steps, "prism.stop.before_diagnostics", async () => {
      await stopLocalPrismFlowsRuntime({ outDir: runtimeDir });
      prismStopped = true;
    });
    const diagnosticsStarted = performance.now();
    const diagnostics = await collectBenchmarkDiagnostics(smokeEnv).catch(() =>
      undefined
    );
    const enrichedBenchmark = {
      ...benchmark,
      diagnosticsMs: Math.round(performance.now() - diagnosticsStarted),
      ...diagnostics,
    };
    return {
      ok: true,
      mode: options.mode,
      steps,
      benchmark: enrichedBenchmark,
    };
  } finally {
    if (!prismStopped) {
      await stopLocalPrismFlowsRuntime({ outDir: runtimeDir }).catch(() => {});
    }
    await unblock?.stop();
    await simulator.close();
    restoreEnv(originalEnv);
    if (options.cleanup) {
      await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
    }
  }
}

async function runReconcileBenchmark(input: {
  env: Env;
  steps: SmokeStep[];
  issueCount: number;
  owner: string;
  repo: string;
  simulatorUrl: string;
  timeoutMs: number;
}) {
  await timed(
    input.steps,
    "github.simulator.seed",
    () =>
      simulatorJson(input.simulatorUrl, "/_sim/seed", {
        method: "POST",
        body: {
          repository: `${input.owner}/${input.repo}`,
          count: input.issueCount,
          titlePrefix: "[sim-reconcile]",
          body: "Seeded by the Unblock GitHub simulator harness.",
        },
      }),
  );
  const started = performance.now();
  await timed(
    input.steps,
    "prism.github.reconcile_flow",
    () =>
      startReconcileFlow(input.env, {
        cursor: "1970-01-01T00:00:00.000Z",
        reason: "simulator-benchmark-reconcile",
      }),
  );
  const taskCount = await timed(
    input.steps,
    "unblock.tasks.wait",
    () => waitForTaskCount(input.env, input.issueCount, input.timeoutMs),
  );
  const elapsedMs = Math.round(performance.now() - started);
  return {
    issueCount: input.issueCount,
    elapsedMs,
    throughputPerSecond: perSecond(taskCount, elapsedMs),
    taskCount,
  };
}

async function runWebhookBenchmark(input: {
  env: Env;
  steps: SmokeStep[];
  issueCount: number;
  owner: string;
  repo: string;
  simulator: Awaited<ReturnType<typeof startGitHubSimulator>>;
  timeoutMs: number;
  issueCreateConcurrency: number;
}) {
  await timed(input.steps, "github.webhook.create", () =>
    simulatorJson(
      input.simulator.url,
      `/repos/${encodeURIComponent(input.owner)}/${
        encodeURIComponent(input.repo)
      }/hooks`,
      {
        method: "POST",
        body: {
          name: "web",
          active: true,
          events: ["issues"],
          config: {
            url: input.env.UNBLOCK_SMOKE_GITHUB_WEBHOOK_URL,
            content_type: "json",
            secret: WEBHOOK_SECRET,
          },
        },
      },
    ));
  const started = performance.now();
  await timed(input.steps, "github.issues.create_many", async () => {
    await mapConcurrent(
      Array.from({ length: input.issueCount }, (_, index) => index),
      input.issueCreateConcurrency,
      async (index) => {
        await simulatorJson(
          input.simulator.url,
          `/repos/${encodeURIComponent(input.owner)}/${
            encodeURIComponent(input.repo)
          }/issues`,
          {
            method: "POST",
            body: {
              title: `[sim-webhook] ${index + 1}`,
              body: "Created by the Unblock GitHub simulator harness.",
            },
          },
        );
      },
    );
  });
  const webhookDeliveries = await timed(
    input.steps,
    "github.webhooks.drain",
    async () => {
      await input.simulator.drainWebhooks();
      const deliveries = input.simulator.state.deliveries;
      const failed = deliveries.filter((delivery) => !delivery.ok);
      if (failed.length > 0) {
        throw new Error(
          `${failed.length}/${deliveries.length} webhook deliveries failed: ${
            failed
              .slice(0, 3)
              .map((delivery) =>
                `${delivery.status ?? "no-status"} ${
                  delivery.error ?? delivery.url
                }`
              )
              .join("; ")
          }`,
        );
      }
      return {
        total: deliveries.length,
        ok: deliveries.filter((delivery) => delivery.ok).length,
        failed: failed.length,
      };
    },
  );
  const taskCount = await timed(
    input.steps,
    "unblock.tasks.wait",
    () => waitForTaskCount(input.env, input.issueCount, input.timeoutMs),
  );
  await timed(
    input.steps,
    "prism.effects.wait",
    () =>
      waitForPrismEffectResults(input.env, input.issueCount, input.timeoutMs),
  );
  await timed(
    input.steps,
    "prism.workflows.wait",
    () =>
      waitForPrismWorkflowCompletions(
        input.env,
        input.issueCount,
        input.timeoutMs,
      ),
  );
  const elapsedMs = Math.round(performance.now() - started);
  return {
    issueCount: input.issueCount,
    elapsedMs,
    throughputPerSecond: perSecond(taskCount, elapsedMs),
    taskCount,
    webhookDeliveries,
  };
}

async function runDirectInboxBenchmark(input: {
  env: Env;
  steps: SmokeStep[];
  issueCount: number;
  owner: string;
  repo: string;
  timeoutMs: number;
  concurrency: number;
}) {
  const baseUrl = required(input.env, "UNBLOCK_HOSTED_API_URL");
  const tenantId = required(input.env, "UNBLOCK_TENANT_ID");
  const projectId = required(input.env, "UNBLOCK_PROJECT_ID");
  const connectionId = required(input.env, "UNBLOCK_GITHUB_CONNECTION_ID");
  const headers = trustedHeaders(tenantId);
  const started = performance.now();
  const deliveries = await timed(
    input.steps,
    "unblock.inbox.post_direct",
    async () => {
      const results: Array<{ ok: boolean; status?: number; error?: string }> =
        Array.from({ length: input.issueCount }, () => ({ ok: false }));
      const latencies: number[] = [];
      const postStarted = performance.now();
      await mapConcurrent(
        Array.from({ length: input.issueCount }, (_, index) => index),
        input.concurrency,
        async (index) => {
          const issueNumber = index + 1;
          try {
            const normalized: any = normalizeGitHubIssueWebhook({
              deliveryId: `direct-inbox-${projectId}-${issueNumber}`,
              event: "issues",
              scope: {
                tenantId,
                projectId,
                connectionId,
                provider: "github",
              },
              payload: directGitHubIssueWebhookPayload({
                owner: input.owner,
                repo: input.repo,
                issueNumber,
              }),
            });
            const requestStarted = performance.now();
            const response = await fetch(`${baseUrl}/api/connectors/inbox`, {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify({
                ...normalized.event,
                mapping: normalized.mapping,
              }),
            });
            await response.body?.cancel();
            latencies.push(performance.now() - requestStarted);
            results[index] = { ok: response.ok, status: response.status };
          } catch (error) {
            results[index] = {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      );
      const failed = results.filter((result) => !result.ok);
      if (failed.length > 0) {
        throw new Error(
          `${failed.length}/${results.length} direct inbox posts failed: ${
            failed
              .slice(0, 3)
              .map((result) => result.error ?? `HTTP ${result.status}`)
              .join("; ")
          }`,
        );
      }
      return {
        total: results.length,
        ok: results.filter((result) => result.ok).length,
        failed: failed.length,
        submitWallMs: Math.round(performance.now() - postStarted),
        latencyP50Ms: percentileMs(latencies, 0.50),
        latencyP95Ms: percentileMs(latencies, 0.95),
        latencyP99Ms: percentileMs(latencies, 0.99),
        latencyMaxMs: Math.round(Math.max(0, ...latencies)),
      };
    },
  );
  const taskCount = await timed(
    input.steps,
    "unblock.tasks.wait",
    () => waitForTaskCount(input.env, input.issueCount, input.timeoutMs),
  );
  const elapsedMs = Math.round(performance.now() - started);
  return {
    issueCount: input.issueCount,
    elapsedMs,
    throughputPerSecond: perSecond(taskCount, elapsedMs),
    taskCount,
    webhookDeliveries: deliveries,
    webhookSubmitMs: deliveries.submitWallMs,
    taskVisibleElapsedMs: elapsedMs,
    taskVisibleThroughputPerSecond: perSecond(taskCount, elapsedMs),
  };
}

async function runDirectWebhookBenchmark(input: {
  env: Env;
  steps: SmokeStep[];
  issueCount: number;
  owner: string;
  repo: string;
  timeoutMs: number;
  webhookConcurrency: number;
  client: "node" | "deno";
}) {
  const webhookUrl = required(input.env, "UNBLOCK_SMOKE_GITHUB_WEBHOOK_URL");
  if (input.client === "node") {
    const postResult = await timed(
      input.steps,
      "github.webhooks.post_direct.node",
      () =>
        postDirectWebhooksWithNode({
          webhookUrl,
          secret: WEBHOOK_SECRET,
          projectId: required(input.env, "UNBLOCK_PROJECT_ID"),
          owner: input.owner,
          repo: input.repo,
          issueCount: input.issueCount,
          concurrency: input.webhookConcurrency,
        }),
    );
    const waitStarted = performance.now();
    const taskCount = await timed(
      input.steps,
      "unblock.tasks.wait",
      () => waitForTaskCount(input.env, input.issueCount, input.timeoutMs),
    );
    const taskVisibleElapsedMs = Math.round(
      postResult.submitWallMs + (performance.now() - waitStarted),
    );
    await timed(
      input.steps,
      "prism.effects.wait",
      () =>
        waitForPrismEffectResults(input.env, input.issueCount, input.timeoutMs),
    );
    const effectCompleteElapsedMs = Math.round(
      postResult.submitWallMs + (performance.now() - waitStarted),
    );
    await timed(
      input.steps,
      "prism.workflows.wait",
      () =>
        waitForPrismWorkflowCompletions(
          input.env,
          input.issueCount,
          input.timeoutMs,
        ),
    );
    const elapsedMs = Math.round(
      postResult.submitWallMs + (performance.now() - waitStarted),
    );
    return {
      issueCount: input.issueCount,
      elapsedMs,
      throughputPerSecond: perSecond(taskCount, elapsedMs),
      taskCount,
      webhookDeliveries: {
        total: postResult.total,
        ok: postResult.ok,
        failed: postResult.failed,
        submitWallMs: postResult.submitWallMs,
        latencyP50Ms: postResult.latencyP50Ms,
        latencyP95Ms: postResult.latencyP95Ms,
        latencyP99Ms: postResult.latencyP99Ms,
        latencyMaxMs: postResult.latencyMaxMs,
      },
      webhookSubmitMs: postResult.submitWallMs,
      taskVisibleElapsedMs,
      taskVisibleThroughputPerSecond: perSecond(
        taskCount,
        taskVisibleElapsedMs,
      ),
      effectCompleteElapsedMs,
      effectCompleteThroughputPerSecond: perSecond(
        taskCount,
        effectCompleteElapsedMs,
      ),
      workflowCompleteElapsedMs: elapsedMs,
      workflowCompleteThroughputPerSecond: perSecond(taskCount, elapsedMs),
    };
  }
  const requests = await Promise.all(
    Array.from({ length: input.issueCount }, async (_item, index) => {
      const issueNumber = index + 1;
      return await signedGitHubWebhookRequest({
        secret: WEBHOOK_SECRET,
        deliveryId: `direct-${input.env.UNBLOCK_PROJECT_ID}-${issueNumber}`,
        event: "issues",
        body: directGitHubIssueWebhookPayload({
          owner: input.owner,
          repo: input.repo,
          issueNumber,
        }),
      });
    }),
  );
  const started = performance.now();
  const deliveryResults = await timed(
    input.steps,
    "github.webhooks.post_direct",
    async () => {
      const results: Array<{ ok: boolean; status?: number; error?: string }> =
        Array.from({ length: input.issueCount }, () => ({ ok: false }));
      const latencies: number[] = [];
      const postStarted = performance.now();
      await mapConcurrent(
        Array.from({ length: input.issueCount }, (_, index) => index),
        input.webhookConcurrency,
        async (index) => {
          try {
            const request = requests[index];
            const requestStarted = performance.now();
            const response = await fetch(webhookUrl, {
              method: "POST",
              headers: request.headers,
              body: request.body,
            });
            await response.body?.cancel();
            latencies.push(performance.now() - requestStarted);
            results[index] = { ok: response.ok, status: response.status };
          } catch (error) {
            results[index] = {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      );
      const failed = results.filter((result) => !result.ok);
      if (failed.length > 0) {
        throw new Error(
          `${failed.length}/${results.length} direct webhook posts failed: ${
            failed
              .slice(0, 3)
              .map((result) => result.error ?? `HTTP ${result.status}`)
              .join("; ")
          }`,
        );
      }
      return {
        total: results.length,
        ok: results.filter((result) => result.ok).length,
        failed: failed.length,
        submitWallMs: Math.round(performance.now() - postStarted),
        latencyP50Ms: percentileMs(latencies, 0.50),
        latencyP95Ms: percentileMs(latencies, 0.95),
        latencyP99Ms: percentileMs(latencies, 0.99),
        latencyMaxMs: Math.round(Math.max(0, ...latencies)),
      };
    },
  );
  const taskCount = await timed(
    input.steps,
    "unblock.tasks.wait",
    () => waitForTaskCount(input.env, input.issueCount, input.timeoutMs),
  );
  const taskVisibleElapsedMs = Math.round(performance.now() - started);
  await timed(
    input.steps,
    "prism.effects.wait",
    () =>
      waitForPrismEffectResults(input.env, input.issueCount, input.timeoutMs),
  );
  const effectCompleteElapsedMs = Math.round(performance.now() - started);
  await timed(
    input.steps,
    "prism.workflows.wait",
    () =>
      waitForPrismWorkflowCompletions(
        input.env,
        input.issueCount,
        input.timeoutMs,
      ),
  );
  const elapsedMs = Math.round(performance.now() - started);
  return {
    issueCount: input.issueCount,
    elapsedMs,
    throughputPerSecond: perSecond(taskCount, elapsedMs),
    taskCount,
    webhookDeliveries: deliveryResults,
    webhookSubmitMs: input.steps.find((step) =>
      step.name === "github.webhooks.post_direct"
    )?.ms,
    taskVisibleElapsedMs,
    taskVisibleThroughputPerSecond: perSecond(taskCount, taskVisibleElapsedMs),
    effectCompleteElapsedMs,
    effectCompleteThroughputPerSecond: perSecond(
      taskCount,
      effectCompleteElapsedMs,
    ),
    workflowCompleteElapsedMs: elapsedMs,
    workflowCompleteThroughputPerSecond: perSecond(taskCount, elapsedMs),
  };
}

async function configureUnblock(input: {
  baseUrl: string;
  tenantId: string;
  projectId: string;
  connectionId: string;
  owner: string;
  repo: string;
}) {
  const headers = trustedHeaders(input.tenantId);
  await unblockJson(input.baseUrl, headers, "/api/projects", {
    method: "POST",
    body: { id: input.projectId, name: input.projectId },
  });
  const privateKey = await unblockJson(
    input.baseUrl,
    headers,
    `/api/secrets?projectId=${encodeURIComponent(input.projectId)}`,
    {
      method: "POST",
      body: {
        name: `github-private-key-${input.projectId}`,
        purpose: "github.private_key",
        plaintext: "sim-private-key",
      },
    },
  );
  const webhookSecret = await unblockJson(
    input.baseUrl,
    headers,
    `/api/secrets?projectId=${encodeURIComponent(input.projectId)}`,
    {
      method: "POST",
      body: {
        name: `github-webhook-secret-${input.projectId}`,
        purpose: "github.webhook_secret",
        plaintext: WEBHOOK_SECRET,
      },
    },
  );
  await unblockJson(
    input.baseUrl,
    headers,
    "/api/connectors/github/connections",
    {
      method: "POST",
      body: {
        projectId: input.projectId,
        connectionId: input.connectionId,
        displayName: `GitHub ${input.owner}/${input.repo}`,
        appId: "sim-app",
        installationId: "sim-installation",
        repositoryOwner: input.owner,
        repositoryName: input.repo,
        privateKeySecretId: privateKey.id,
        webhookSecretId: webhookSecret.id,
        syncDirection: "bidirectional",
        conflictPolicy: "operator_review",
      },
    },
  );
}

async function postDirectWebhooksWithNode(input: {
  webhookUrl: string;
  secret: string;
  projectId: string;
  owner: string;
  repo: string;
  issueCount: number;
  concurrency: number;
}): Promise<{
  total: number;
  ok: number;
  failed: number;
  submitWallMs: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  latencyMaxMs: number;
}> {
  const script = String.raw`
import { createHmac } from "node:crypto";
const input = JSON.parse(process.argv[1]);
function stableNumericId(value) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}
function payload(issueNumber) {
  const now = new Date().toISOString();
  const fullName = input.owner + "/" + input.repo;
  return {
    action: "opened",
    repository: {
      id: stableNumericId(fullName),
      name: input.repo,
      full_name: fullName,
      owner: { login: input.owner },
      html_url: "https://github.example.test/" + fullName,
    },
    issue: {
      id: stableNumericId(fullName + "#" + issueNumber),
      node_id: "I_sim_" + issueNumber,
      number: issueNumber,
      title: "[direct-webhook] " + issueNumber,
      body: "Created by the Unblock direct webhook benchmark.",
      state: "open",
      state_reason: null,
      html_url: "https://github.example.test/" + fullName + "/issues/" + issueNumber,
      url: "https://api.github.example.test/repos/" + fullName + "/issues/" + issueNumber,
      repository_url: "https://api.github.example.test/repos/" + fullName,
      user: { login: "direct-benchmark", id: 1, type: "User" },
      labels: [],
      assignees: [],
      milestone: null,
      created_at: now,
      updated_at: now,
      closed_at: null,
    },
  };
}
function signedRequest(issueNumber) {
  const body = JSON.stringify(payload(issueNumber));
  const signature = createHmac("sha256", input.secret).update(body).digest("hex");
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "direct-" + input.projectId + "-" + issueNumber,
      "x-github-event": "issues",
      "x-hub-signature-256": "sha256=" + signature,
      "user-agent": "GitHub-Hookshot/direct-webhook-benchmark-node",
    },
  };
}
const requests = Array.from({ length: input.issueCount }, (_item, index) => signedRequest(index + 1));
let next = 0;
let ok = 0;
let failed = 0;
const latencies = [];
const started = performance.now();
async function worker() {
  while (true) {
    const index = next++;
    if (index >= requests.length) return;
    const request = requests[index];
    try {
      const requestStarted = performance.now();
      const response = await fetch(input.webhookUrl, {
        method: "POST",
        headers: request.headers,
        body: request.body,
      });
      await response.body?.cancel();
      latencies.push(performance.now() - requestStarted);
      if (response.ok) ok += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
}
await Promise.all(Array.from({ length: Math.min(input.concurrency, input.issueCount) }, () => worker()));
latencies.sort((left, right) => left - right);
function percentile(fraction) {
  if (latencies.length === 0) return 0;
  const index = Math.min(latencies.length - 1, Math.max(0, Math.ceil(latencies.length * fraction) - 1));
  return Math.round(latencies[index]);
}
console.log(JSON.stringify({
  total: input.issueCount,
  ok,
  failed,
  submitWallMs: Math.round(performance.now() - started),
  latencyP50Ms: percentile(0.50),
  latencyP95Ms: percentile(0.95),
  latencyP99Ms: percentile(0.99),
  latencyMaxMs: Math.round(latencies.at(-1) ?? 0),
}));
`;
  const output = await new Deno.Command("node", {
    args: [
      "--input-type=module",
      "--eval",
      script,
      JSON.stringify(input),
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(output.stdout).trim();
  if (!output.success) {
    throw new Error(
      `Node direct webhook client failed with exit code ${output.code}: ${
        new TextDecoder().decode(output.stderr)
      }`,
    );
  }
  const parsed = JSON.parse(stdout) as {
    total: number;
    ok: number;
    failed: number;
    submitWallMs: number;
    latencyP50Ms: number;
    latencyP95Ms: number;
    latencyP99Ms: number;
    latencyMaxMs: number;
  };
  if (parsed.failed > 0 || parsed.ok !== parsed.total) {
    throw new Error(`Node direct webhook client failures: ${stdout}`);
  }
  return parsed;
}

function directGitHubIssueWebhookPayload(input: {
  owner: string;
  repo: string;
  issueNumber: number;
}) {
  const now = new Date().toISOString();
  const fullName = `${input.owner}/${input.repo}`;
  return {
    action: "opened",
    repository: {
      id: stableNumericId(fullName),
      name: input.repo,
      full_name: fullName,
      owner: { login: input.owner },
      html_url: `https://github.example.test/${fullName}`,
    },
    issue: {
      id: stableNumericId(`${fullName}#${input.issueNumber}`),
      node_id: `I_sim_${input.issueNumber}`,
      number: input.issueNumber,
      title: `[direct-webhook] ${input.issueNumber}`,
      body: "Created by the Unblock direct webhook benchmark.",
      state: "open",
      state_reason: null,
      html_url:
        `https://github.example.test/${fullName}/issues/${input.issueNumber}`,
      url:
        `https://api.github.example.test/repos/${fullName}/issues/${input.issueNumber}`,
      repository_url: `https://api.github.example.test/repos/${fullName}`,
      user: { login: "direct-benchmark", id: 1, type: "User" },
      labels: [],
      assignees: [],
      milestone: null,
      created_at: now,
      updated_at: now,
      closed_at: null,
    },
  };
}

async function signedGitHubWebhookRequest(
  input: {
    secret: string;
    deliveryId: string;
    event: string;
    body: unknown;
  },
): Promise<{ body: string; headers: Record<string, string> }> {
  const raw = JSON.stringify(input.body);
  const signature = await hmacSha256Hex(input.secret, raw);
  return {
    body: raw,
    headers: {
      "content-type": "application/json",
      "x-github-delivery": input.deliveryId,
      "x-github-event": input.event,
      "x-hub-signature-256": `sha256=${signature}`,
      "user-agent": "GitHub-Hookshot/direct-webhook-benchmark",
    },
  };
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

function stableNumericId(value: string): number {
  let hash = 2_166_136_261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return Math.abs(hash);
}

async function startReconcileFlow(
  env: Env,
  input: { cursor: string; reason: string },
) {
  const { DenoGrpcPrismFlowClient } = await import(
    "../../../../prism-new3/packages/prism-flows/execution-deno.ts"
  );
  const tenantId = required(env, "UNBLOCK_TENANT_ID");
  const projectId = required(env, "UNBLOCK_PROJECT_ID");
  const connectionId = required(env, "UNBLOCK_GITHUB_CONNECTION_ID");
  const client = new DenoGrpcPrismFlowClient({
    endpoint: required(env, "PRISM_RUNTIME_ENDPOINT"),
    defaultProjectId: required(env, "PRISM_FLOWS_PROJECT_ID"),
    timeoutMs: Number(env.UNBLOCK_SMOKE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
  });
  try {
    return await client.startFlow({
      projectId: required(env, "PRISM_FLOWS_PROJECT_ID"),
      appId: "flows",
      flowId: "github-issues-reconcile",
      workflowId: "github-issues-reconcile",
      triggerId: "manual",
      flowKey: `${tenantId}:${projectId}:${connectionId}:${input.reason}`,
      idempotencyKey:
        `${tenantId}:${projectId}:${connectionId}:${input.reason}`,
      tenantId,
      unblockProjectId: projectId,
      correlationId: `${tenantId}:${projectId}:${connectionId}:${input.reason}`,
      payload: {
        tenantId,
        projectId,
        connectionId,
        cursor: input.cursor,
        reason: input.reason,
      },
      metadata: {
        tenantId,
        projectId,
        correlationId:
          `${tenantId}:${projectId}:${connectionId}:${input.reason}`,
        idempotencyKey:
          `${tenantId}:${projectId}:${connectionId}:${input.reason}`,
        source: "github_simulator_harness",
      },
      mode: "attach_or_start",
    });
  } finally {
    await client.close?.();
  }
}

async function waitForTaskCount(env: Env, expected: number, timeoutMs: number) {
  const postgresUrl = postgresUrlForUnblock(env);
  if (postgresUrl) {
    return await waitForTaskCountPostgres(env, postgresUrl, expected, timeoutMs)
      .catch(() => waitForTaskCountHttp(env, expected, timeoutMs));
  }
  return await waitForTaskCountHttp(env, expected, timeoutMs);
}

async function waitForTaskCountPostgres(
  env: Env,
  postgresUrl: string,
  expected: number,
  timeoutMs: number,
) {
  const projectId = required(env, "UNBLOCK_PROJECT_ID");
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;
  const projectLiteral = sqlLiteral(projectId);
  while (Date.now() <= deadline) {
    lastCount = await psqlInt(
      postgresUrl,
      `select count(*)::int from tasks where project_id = ${projectLiteral} and id like 'GH-%'`,
    );
    if (lastCount >= expected) return lastCount;
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for ${expected} GitHub tasks; observed ${lastCount}.`,
  );
}

async function waitForTaskCountHttp(
  env: Env,
  expected: number,
  timeoutMs: number,
) {
  const baseUrl = required(env, "UNBLOCK_HOSTED_API_URL");
  const projectId = required(env, "UNBLOCK_PROJECT_ID");
  const tenantId = required(env, "UNBLOCK_TENANT_ID");
  const headers = trustedHeaders(tenantId);
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;
  while (Date.now() <= deadline) {
    const tasks = await unblockJson(
      baseUrl,
      headers,
      `/api/tasks?projectId=${
        encodeURIComponent(projectId)
      }&includeFinished=true&includeArchived=true`,
    );
    lastCount = Array.isArray(tasks)
      ? tasks.filter((task) => String(task.id ?? "").startsWith("GH-")).length
      : 0;
    if (lastCount >= expected) return lastCount;
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for ${expected} GitHub tasks; observed ${lastCount}.`,
  );
}

async function waitForPrismEffectResults(
  env: Env,
  expected: number,
  timeoutMs: number,
) {
  const postgresUrl = postgresUrlForPrism(env);
  if (!postgresUrl) return 0;
  const projectId = required(env, "PRISM_FLOWS_PROJECT_ID");
  const projectLiteral = sqlLiteral(projectId);
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;
  while (Date.now() <= deadline) {
    lastCount = await psqlInt(
      postgresUrl,
      `
        select count(*)::int
        from prism_flows_v2_log
        where project_id = ${projectLiteral}
          and record_kind = 'effect.result'
          and causation_id like 'workflow:github-issues-%'
      `,
    );
    if (lastCount >= expected) return lastCount;
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for ${expected} Prism effect results; observed ${lastCount}.`,
  );
}

async function waitForPrismWorkflowCompletions(
  env: Env,
  expected: number,
  timeoutMs: number,
) {
  const postgresUrl = postgresUrlForPrism(env);
  if (!postgresUrl) return 0;
  const projectId = required(env, "PRISM_FLOWS_PROJECT_ID");
  const projectLiteral = sqlLiteral(projectId);
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;
  while (Date.now() <= deadline) {
    lastCount = await psqlInt(
      postgresUrl,
      `
        with latest as (
          select distinct on (payload_json::jsonb #>> '{WorkflowState,operations,0,workflow_key}')
            payload_json::jsonb #>> '{WorkflowState,operations,0,workflow_key}' as workflow_key,
            payload_json::jsonb #>> '{WorkflowState,operations,0,status}' as status,
            sequence
          from prism_flows_v2_log
          where project_id = ${projectLiteral}
            and record_kind = 'workflow.state'
            and correlation_id like 'github-issues-%'
          order by payload_json::jsonb #>> '{WorkflowState,operations,0,workflow_key}', sequence desc
        )
        select count(*)::int
        from latest
        where workflow_key is not null
          and status = 'succeeded'
      `,
    );
    if (lastCount >= expected) return lastCount;
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for ${expected} Prism workflow completions; observed ${lastCount}.`,
  );
}

async function collectBenchmarkDiagnostics(env: Env) {
  const postgresUrl = postgresUrlForUnblock(env);
  const unblock = postgresUrl
    ? await collectUnblockBenchmarkDiagnostics(env, postgresUrl)
    : undefined;
  const prismUrl = postgresUrlForPrism(env);
  const prism = prismUrl
    ? await collectPrismBenchmarkDiagnostics(env, prismUrl).catch(() =>
      undefined
    )
    : undefined;
  return { ...unblock, ...prism };
}

async function collectUnblockBenchmarkDiagnostics(
  env: Env,
  postgresUrl: string,
) {
  const projectLiteral = sqlLiteral(required(env, "UNBLOCK_PROJECT_ID"));
  const rows = await psqlRows(
    postgresUrl,
    `
      with task_rows as (
        select *
        from tasks
        where project_id = ${projectLiteral} and id like 'GH-%'
      ),
      inbox_rows as (
        select *
        from inbox_events
        where project_id = ${projectLiteral}
      ),
      mapping_rows as (
        select *
        from connector_external_mappings
        where project_id = ${projectLiteral}
      ),
      activity_rows as (
        select *
        from activity
        where project_id = ${projectLiteral}
          and subject_type = 'task'
          and subject_id like 'GH-%'
      )
      select 'task_count', count(*)::text from task_rows
      union all
      select 'task_span_ms', coalesce(round(extract(epoch from max(created_at)-min(created_at))*1000)::bigint, 0)::text from task_rows
      union all
      select 'task_created_offset_p50_ms', coalesce(round(percentile_cont(0.50) within group (order by extract(epoch from created_at - (select min(created_at) from task_rows))*1000))::bigint, 0)::text from task_rows
      union all
      select 'task_created_offset_p95_ms', coalesce(round(percentile_cont(0.95) within group (order by extract(epoch from created_at - (select min(created_at) from task_rows))*1000))::bigint, 0)::text from task_rows
      union all
      select 'inbox_event_count', count(*)::text from inbox_rows
      union all
      select 'inbox_created_span_ms', coalesce(round(extract(epoch from max(created_at)-min(created_at))*1000)::bigint, 0)::text from inbox_rows
      union all
      select 'inbox_applied_span_ms', coalesce(round(extract(epoch from max(applied_at)-min(applied_at))*1000)::bigint, 0)::text from inbox_rows where applied_at is not null
      union all
      select 'inbox_apply_lag_p50_ms', coalesce(round(percentile_cont(0.50) within group (order by extract(epoch from applied_at-created_at)*1000))::bigint, 0)::text from inbox_rows where applied_at is not null
      union all
      select 'inbox_apply_lag_p95_ms', coalesce(round(percentile_cont(0.95) within group (order by extract(epoch from applied_at-created_at)*1000))::bigint, 0)::text from inbox_rows where applied_at is not null
      union all
      select 'inbox_events_with_mapping', (count(*) filter (where payload_json ? 'mapping'))::text from inbox_rows
      union all
      select 'connector_mapping_count', count(*)::text from mapping_rows
      union all
      select 'connector_mapping_created_span_ms', coalesce(round(extract(epoch from max(created_at)-min(created_at))*1000)::bigint, 0)::text from mapping_rows
      union all
      select 'connector_mapping_updated_span_ms', coalesce(round(extract(epoch from max(updated_at)-min(updated_at))*1000)::bigint, 0)::text from mapping_rows
      union all
      select 'activity_count', count(*)::text from activity_rows
      union all
      select 'activity_created_span_ms', coalesce(round(extract(epoch from max(created_at)-min(created_at))*1000)::bigint, 0)::text from activity_rows
      union all
      select 'hosted_audit_count', count(*)::text from hosted_audit_events where project_id = ${projectLiteral}
    `,
  );
  const values = new Map(rows.map((row) => {
    const [key, value] = row.split("|", 2);
    return [key, Number(value)];
  }));
  return {
    taskCreatedSpanMs: values.get("task_span_ms") ?? null,
    taskCreatedOffsetP50Ms: values.get("task_created_offset_p50_ms") ?? null,
    taskCreatedOffsetP95Ms: values.get("task_created_offset_p95_ms") ?? null,
    inboxCreatedSpanMs: values.get("inbox_created_span_ms") ?? null,
    inboxAppliedSpanMs: values.get("inbox_applied_span_ms") ?? null,
    inboxApplyLagP50Ms: values.get("inbox_apply_lag_p50_ms") ?? null,
    inboxApplyLagP95Ms: values.get("inbox_apply_lag_p95_ms") ?? null,
    inboxEventCount: values.get("inbox_event_count") ?? 0,
    inboxEventsWithMapping: values.get("inbox_events_with_mapping") ?? 0,
    connectorMappingCount: values.get("connector_mapping_count") ?? 0,
    connectorMappingCreatedSpanMs: values.get(
      "connector_mapping_created_span_ms",
    ) ?? null,
    connectorMappingUpdatedSpanMs: values.get(
      "connector_mapping_updated_span_ms",
    ) ?? null,
    activityCount: values.get("activity_count") ?? 0,
    activityCreatedSpanMs: values.get("activity_created_span_ms") ?? null,
    hostedAuditCount: values.get("hosted_audit_count") ?? 0,
  };
}

async function collectPrismBenchmarkDiagnostics(
  env: Env,
  postgresUrl: string,
) {
  const projectLiteral = sqlLiteral(required(env, "PRISM_FLOWS_PROJECT_ID"));
  const rows = await psqlRows(
    postgresUrl,
    `
      with flow_log as (
        select
          record_kind,
          causation_id,
          correlation_id,
          payload_schema,
          payload_json::jsonb as payload,
          occurred_at_ms,
          shard_group_id
        from prism_flows_v2_log
        where project_id = ${projectLiteral}
          and (
            (record_kind = 'workflow.state' and correlation_id like 'github-issues-%')
            or (record_kind like 'effect.%' and causation_id like 'workflow:github-issues-%')
          )
      ),
      workflow_starts as (
        select workflow_key, min(occurred_at_ms) as started_at_ms
        from (
          select correlation_id as workflow_key, occurred_at_ms
          from flow_log
          where record_kind = 'workflow.state' and correlation_id like 'github-issues-%'
          union all
          select substring(causation_id from '^workflow:(.*):effect:flow-js:') as workflow_key, occurred_at_ms
          from flow_log
          where record_kind = 'effect.intent' and causation_id like 'workflow:github-issues-%:effect:%'
        ) keyed
        where workflow_key is not null
        group by workflow_key
      ),
      workflow_first_states as (
        select
          payload #>> '{WorkflowState,operations,0,workflow_key}' as workflow_key,
          min(occurred_at_ms) as first_state_at_ms
        from flow_log
        where record_kind = 'workflow.state'
        group by payload #>> '{WorkflowState,operations,0,workflow_key}'
      ),
      workflow_latest_states as (
        select distinct on (workflow_key)
          workflow_key,
          status,
          occurred_at_ms
        from (
          select
            payload #>> '{WorkflowState,operations,0,workflow_key}' as workflow_key,
            payload #>> '{WorkflowState,operations,0,status}' as status,
            occurred_at_ms
          from flow_log
          where record_kind = 'workflow.state'
        ) states
        where workflow_key is not null
        order by workflow_key, occurred_at_ms desc
      ),
      workflow_terminals as (
        select workflow_key, occurred_at_ms as terminal_at_ms
        from workflow_latest_states
        where status = 'succeeded'
      ),
      effect_intents as (
        select
          causation_id,
          substring(causation_id from '^workflow:(.*):effect:flow-js:') as workflow_key,
          payload_schema,
          occurred_at_ms
        from flow_log
        where record_kind = 'effect.intent'
      ),
      effect_leases as (
        select causation_id, occurred_at_ms
        from flow_log
        where record_kind = 'effect.lease.granted'
      ),
      effect_results as (
        select causation_id, occurred_at_ms
        from flow_log
        where record_kind = 'effect.result'
      ),
      completed_workflows as (
        select workflow_key
        from workflow_latest_states
        where status = 'succeeded'
      ),
      effect_timings as (
        select
          intents.causation_id,
          starts.started_at_ms,
          intents.occurred_at_ms as intent_at_ms,
          leases.occurred_at_ms as lease_at_ms,
          results.occurred_at_ms as result_at_ms,
          terminals.terminal_at_ms,
          intents.occurred_at_ms - starts.started_at_ms as start_to_intent_ms,
          leases.occurred_at_ms - intents.occurred_at_ms as queue_ms,
          results.occurred_at_ms - leases.occurred_at_ms as run_ms,
          results.occurred_at_ms - intents.occurred_at_ms as total_ms,
          terminals.terminal_at_ms - results.occurred_at_ms as result_to_terminal_ms,
          terminals.terminal_at_ms - starts.started_at_ms as start_to_terminal_ms
        from effect_intents intents
        join workflow_starts starts on starts.workflow_key = intents.workflow_key
        join effect_leases leases using (causation_id)
        join effect_results results using (causation_id)
        left join workflow_terminals terminals on terminals.workflow_key = intents.workflow_key
      )
      select 'prism_workflow_count', count(*)::text from workflow_starts
      union all
      select 'prism_workflow_completed_count', count(*)::text from completed_workflows
      union all
      select 'prism_workflow_start_span_ms', coalesce(max(started_at_ms)-min(started_at_ms), 0)::text from workflow_starts
      union all
      select 'prism_workflow_intent_span_ms', coalesce(max(occurred_at_ms)-min(occurred_at_ms), 0)::text from effect_intents
      union all
      select 'prism_workflow_lease_span_ms', coalesce(max(occurred_at_ms)-min(occurred_at_ms), 0)::text from effect_leases
      union all
      select 'prism_workflow_result_span_ms', coalesce(max(occurred_at_ms)-min(occurred_at_ms), 0)::text from effect_results
      union all
      select 'prism_workflow_terminal_span_ms', coalesce(max(terminal_at_ms)-min(terminal_at_ms), 0)::text from workflow_terminals
      union all
      select 'prism_workflow_runtime_span_ms', coalesce((select max(occurred_at_ms) from effect_results) - (select min(started_at_ms) from workflow_starts), 0)::text
      union all
      select 'prism_workflow_shard_count', count(distinct shard_group_id)::text from flow_log
      union all
      select 'prism_effect_count', count(*)::text from effect_intents
      union all
      select 'prism_effect_completed_count', count(*)::text from effect_results
      union all
      select 'prism_effect_span_ms', coalesce(max(occurred_at_ms)-min(occurred_at_ms), 0)::text from flow_log where record_kind like 'effect.%'
      union all
      select 'prism_workflow_start_to_intent_p50_ms', coalesce(round(percentile_cont(0.50) within group (order by start_to_intent_ms))::bigint, 0)::text from effect_timings
      union all
      select 'prism_workflow_start_to_intent_p95_ms', coalesce(round(percentile_cont(0.95) within group (order by start_to_intent_ms))::bigint, 0)::text from effect_timings
      union all
      select 'prism_effect_queue_p50_ms', coalesce(round(percentile_cont(0.50) within group (order by queue_ms))::bigint, 0)::text from effect_timings
      union all
      select 'prism_effect_queue_p95_ms', coalesce(round(percentile_cont(0.95) within group (order by queue_ms))::bigint, 0)::text from effect_timings
      union all
      select 'prism_effect_run_p50_ms', coalesce(round(percentile_cont(0.50) within group (order by run_ms))::bigint, 0)::text from effect_timings
      union all
      select 'prism_effect_run_p95_ms', coalesce(round(percentile_cont(0.95) within group (order by run_ms))::bigint, 0)::text from effect_timings
      union all
      select 'prism_effect_total_p50_ms', coalesce(round(percentile_cont(0.50) within group (order by total_ms))::bigint, 0)::text from effect_timings
      union all
      select 'prism_effect_total_p95_ms', coalesce(round(percentile_cont(0.95) within group (order by total_ms))::bigint, 0)::text from effect_timings
      union all
      select 'prism_workflow_result_to_terminal_p50_ms', coalesce(round(percentile_cont(0.50) within group (order by result_to_terminal_ms))::bigint, 0)::text from effect_timings where result_to_terminal_ms is not null
      union all
      select 'prism_workflow_result_to_terminal_p95_ms', coalesce(round(percentile_cont(0.95) within group (order by result_to_terminal_ms))::bigint, 0)::text from effect_timings where result_to_terminal_ms is not null
      union all
      select 'prism_workflow_start_to_terminal_p50_ms', coalesce(round(percentile_cont(0.50) within group (order by start_to_terminal_ms))::bigint, 0)::text from effect_timings where start_to_terminal_ms is not null
      union all
      select 'prism_workflow_start_to_terminal_p95_ms', coalesce(round(percentile_cont(0.95) within group (order by start_to_terminal_ms))::bigint, 0)::text from effect_timings where start_to_terminal_ms is not null
    `,
  );
  const values = new Map(rows.map((row) => {
    const [key, value] = row.split("|", 2);
    return [key, Number(value)];
  }));
  const workflowCount = values.get("prism_workflow_count") ?? 0;
  const workflowCompleted = values.get("prism_workflow_completed_count") ?? 0;
  const effectCount = values.get("prism_effect_count") ?? 0;
  const effectCompleted = values.get("prism_effect_completed_count") ?? 0;
  return {
    prismWorkflowCount: workflowCount,
    prismWorkflowCompletedCount: workflowCompleted,
    prismWorkflowStartSpanMs: values.get("prism_workflow_start_span_ms") ??
      null,
    prismWorkflowIntentSpanMs: values.get("prism_workflow_intent_span_ms") ??
      null,
    prismWorkflowLeaseSpanMs: values.get("prism_workflow_lease_span_ms") ??
      null,
    prismWorkflowResultSpanMs: values.get("prism_workflow_result_span_ms") ??
      null,
    prismWorkflowTerminalSpanMs: values.get(
      "prism_workflow_terminal_span_ms",
    ) ?? null,
    prismWorkflowRuntimeSpanMs: values.get("prism_workflow_runtime_span_ms") ??
      null,
    prismWorkflowStartToIntentP50Ms: values.get(
      "prism_workflow_start_to_intent_p50_ms",
    ) ?? null,
    prismWorkflowStartToIntentP95Ms: values.get(
      "prism_workflow_start_to_intent_p95_ms",
    ) ?? null,
    prismWorkflowResultToTerminalP50Ms: values.get(
      "prism_workflow_result_to_terminal_p50_ms",
    ) ?? null,
    prismWorkflowResultToTerminalP95Ms: values.get(
      "prism_workflow_result_to_terminal_p95_ms",
    ) ?? null,
    prismWorkflowStartToTerminalP50Ms: values.get(
      "prism_workflow_start_to_terminal_p50_ms",
    ) ?? null,
    prismWorkflowStartToTerminalP95Ms: values.get(
      "prism_workflow_start_to_terminal_p95_ms",
    ) ?? null,
    prismWorkflowShardCount: values.get("prism_workflow_shard_count") ?? 0,
    prismWorkflowStatusCounts: countStatusMap(workflowCount, workflowCompleted),
    prismEffectCount: effectCount,
    prismEffectCompletedCount: effectCompleted,
    prismEffectSpanMs: values.get("prism_effect_span_ms") ?? null,
    prismEffectQueueP50Ms: values.get("prism_effect_queue_p50_ms") ?? null,
    prismEffectQueueP95Ms: values.get("prism_effect_queue_p95_ms") ?? null,
    prismEffectRunP50Ms: values.get("prism_effect_run_p50_ms") ?? null,
    prismEffectRunP95Ms: values.get("prism_effect_run_p95_ms") ?? null,
    prismEffectTotalP50Ms: values.get("prism_effect_total_p50_ms") ?? null,
    prismEffectTotalP95Ms: values.get("prism_effect_total_p95_ms") ?? null,
    prismEffectStatusCounts: countStatusMap(effectCount, effectCompleted),
    prismEffectKindCounts: await psqlCountMap(
      postgresUrl,
      `
        select replace(payload_schema, 'effect.intent.', ''), count(*)::int
        from prism_flows_v2_log
        where project_id = ${projectLiteral}
          and record_kind = 'effect.intent'
          and causation_id like 'workflow:github-issues-%'
        group by payload_schema
      `,
    ),
  };
}

function countStatusMap(
  total: number,
  completed: number,
): Record<string, number> {
  return {
    succeeded: completed,
    pending: Math.max(0, total - completed),
  };
}

async function psqlCountMap(
  postgresUrl: string,
  sql: string,
): Promise<Record<string, number>> {
  const rows = await psqlRows(postgresUrl, sql);
  return Object.fromEntries(rows.map((row) => {
    const [key, value] = row.split("|", 2);
    return [key, Number(value)];
  }));
}

async function psqlInt(
  postgresUrl: string,
  sql: string,
): Promise<number> {
  const rows = await psqlRows(postgresUrl, sql);
  const value = Number(rows[0]?.trim() ?? "NaN");
  if (!Number.isFinite(value)) {
    throw new Error(`psql did not return a numeric value: ${rows.join("\n")}`);
  }
  return value;
}

async function psqlRows(
  postgresUrl: string,
  sql: string,
): Promise<string[]> {
  const command = new Deno.Command("psql", {
    args: [
      "-X",
      "-q",
      "-A",
      "-t",
      postgresUrl,
      "-c",
      sql,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr).trim());
  }
  return new TextDecoder()
    .decode(output.stdout)
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean);
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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

async function unblockJson(
  baseUrl: string,
  headers: Record<string, string>,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  return await requestJson(`${baseUrl}${path}`, {
    ...init,
    headers,
  });
}

async function simulatorJson(
  baseUrl: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  return await requestJson(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: "Bearer sim-runner-token" },
  });
}

async function requestJson(
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> },
) {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  const body = text.trim() ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return body;
}

function trustedHeaders(tenantId: string): Record<string, string> {
  return {
    "x-unblock-principal-id": "codex-e",
    "x-unblock-workos-organization-id": tenantId,
    "x-unblock-roles": "owner",
  };
}

type ManagedProcess = {
  stop: () => Promise<void>;
  tail: () => string;
};

async function runCommand(
  command: string,
  args: string[],
  input: { cwd: string; env: Record<string, string> },
) {
  const output = await new Deno.Command(command, {
    args,
    cwd: input.cwd,
    env: input.env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    const decoder = new TextDecoder();
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${output.code}\n${
        decoder.decode(output.stdout)
      }${decoder.decode(output.stderr)}`,
    );
  }
}

function startManagedProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}): ManagedProcess {
  const child = new Deno.Command(input.command, {
    args: input.args,
    cwd: input.cwd,
    env: input.env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const lines: string[] = [];
  drain(child.stdout, lines);
  drain(child.stderr, lines);
  return {
    stop: async () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already exited.
      }
      await child.status.catch(() => ({ success: false }));
    },
    tail: () => lines.slice(-40).join("\n"),
  };
}

async function drain(stream: ReadableStream<Uint8Array>, lines: string[]) {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = decoder.decode(chunk);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      lines.push(line);
      if (lines.length > 200) lines.splice(0, lines.length - 200);
    }
  }
}

async function waitForHttp(
  url: string,
  timeoutMs: number,
  process?: ManagedProcess,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      const response = await fetch(url);
      await response.body?.cancel();
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  const suffix = process ? `\n${process.tail()}` : "";
  throw new Error(
    `Timed out waiting for ${url}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }${suffix}`,
  );
}

async function waitForTcp(host: string, port: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      const conn = await Deno.connect({ hostname: host, port });
      conn.close();
      return;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for TCP ${host}:${port}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function freePort(): Promise<number> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

function setEnv(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    Deno.env.set(key, value);
  }
}

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of keys) snapshot[key] = Deno.env.get(key);
  return snapshot;
}

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
}

function postgresUrlForUnblock(env: Env): string | undefined {
  return env.UNBLOCK_E2E_POSTGRES_URL?.trim() ||
    env.UNBLOCK_POSTGRES_URL?.trim() ||
    env.UNBLOCK_TEST_POSTGRES_URL?.trim();
}

function postgresUrlForPrism(env: Env): string | undefined {
  return env.PRISM_POSTGRES_URL?.trim() ||
    env.UNBLOCK_E2E_PRISM_POSTGRES_URL?.trim() ||
    postgresUrlForUnblock(env);
}

function parseRepository(value: string): [string, string] {
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`repository must use owner/repo format: ${value}`);
  }
  return [parts[0], parts[1]];
}

function parseFlags(args: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const [key, inlineValue] = arg.slice(2).split("=", 2);
    const value = inlineValue ??
      (args[index + 1] && !args[index + 1].startsWith("--")
        ? args[++index]
        : true);
    flags.set(key, value ?? true);
  }
  return flags;
}

function flagValue(
  flags: Map<string, string | true>,
  key: string,
): string | undefined {
  const value = flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isHarnessMode(value: string): value is HarnessMode {
  return value === "e2e" || value === "benchmark-reconcile" ||
    value === "benchmark-webhook" || value === "benchmark-direct-inbox" ||
    value === "benchmark-direct-webhook";
}

function parseUnblockServerMode(
  value: string | undefined,
): HarnessOptions["unblockServerMode"] {
  if (!value) return "dist";
  if (value === "dist" || value === "dev") return value;
  throw new Error(
    `Unsupported unblock server mode ${value}. Expected dist or dev.`,
  );
}

function parseDirectWebhookClient(
  value: string | undefined,
): HarnessOptions["directWebhookClient"] {
  if (!value) return "node";
  if (value === "node" || value === "deno") return value;
  throw new Error(
    `Unsupported direct webhook client ${value}. Expected node or deno.`,
  );
}

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function perSecond(count: number, elapsedMs: number): number {
  return Math.round((count / Math.max(1, elapsedMs)) * 1_000 * 100) / 100;
}

function percentileMs(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return Math.round(sorted[index]);
}

async function mapConcurrent<T>(
  items: T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await run(items[index], index);
    }
  }));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function repoRoot(): string {
  return new URL("../../../", import.meta.url).pathname;
}

function prismBinary(name: string): string | undefined {
  const envName = `${name.replaceAll("-", "_").toUpperCase()}_BIN`;
  const explicit = Deno.env.get(envName);
  if (explicit?.trim()) return explicit;
  for (
    const candidate of [
      new URL(
        `../../target/release/${name}`,
        import.meta.resolve(
          "../../../../prism-new3/packages/prism-flows/mod.ts",
        ),
      ).pathname,
      new URL(
        `../../target/debug/${name}`,
        import.meta.resolve(
          "../../../../prism-new3/packages/prism-flows/mod.ts",
        ),
      ).pathname,
    ]
  ) {
    try {
      if (Deno.statSync(candidate).isFile) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

if (import.meta.main) {
  const options = parseHarnessOptions(Deno.args);
  const result = await runGithubSimulatorHarness(Deno.env.toObject(), options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) Deno.exit(1);
}
