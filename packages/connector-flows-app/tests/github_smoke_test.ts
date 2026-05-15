import {
  missingGithubSmokeEnv,
  runGithubE2E,
  runGithubSmoke,
} from "../scripts/github_smoke.ts";

Deno.test("GitHub smoke runner reports missing environment without network", async () => {
  const result = await runGithubSmoke({}, { allowMissingEnv: true });
  if (result.ok || !result.skipped) {
    throw new Error(
      "smoke runner should skip when required environment is absent",
    );
  }
  for (
    const expected of [
      "UNBLOCK_HOSTED_API_URL",
      "UNBLOCK_TENANT_ID",
      "UNBLOCK_PROJECT_ID",
      "PRISM_RUNTIME_ENDPOINT",
      "GITHUB_REPOSITORY",
      "GITHUB_TOKEN",
      "GITHUB_INSTALLATION_TOKEN",
      "UNBLOCK_HOSTED_API_TOKEN",
    ]
  ) {
    if (!result.missing?.includes(expected)) {
      throw new Error(`missing environment did not include ${expected}`);
    }
  }
});

Deno.test("GitHub smoke runner preflight accepts a complete environment", () => {
  const missing = missingGithubSmokeEnv({
    UNBLOCK_HOSTED_API_URL: "https://unblock.example.test",
    UNBLOCK_HOSTED_API_TOKEN: "unblock-token",
    UNBLOCK_TENANT_ID: "tenant",
    UNBLOCK_PROJECT_ID: "project",
    PRISM_RUNTIME_ENDPOINT: "http://127.0.0.1:50051",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_TOKEN: "github-token",
    GITHUB_INSTALLATION_TOKEN: "github-token",
  });
  if (missing.length !== 0) {
    throw new Error(
      `complete smoke environment still reported missing keys: ${
        missing.join(", ")
      }`,
    );
  }
});

Deno.test("GitHub smoke runner preflight accepts trusted-header auth", () => {
  const missing = missingGithubSmokeEnv({
    UNBLOCK_HOSTED_API_URL: "http://127.0.0.1:39217",
    UNBLOCK_HOSTED_AUTH_MODE: "trusted-headers",
    UNBLOCK_TRUSTED_PRINCIPAL_ID: "codex-e",
    UNBLOCK_TRUSTED_ORGANIZATION_ID: "org_unblock_smoke",
    UNBLOCK_TENANT_ID: "ORG_UNBLOCK_SMOKE",
    UNBLOCK_PROJECT_ID: "SMOKE",
    PRISM_RUNTIME_ENDPOINT: "http://127.0.0.1:50051",
    GITHUB_REPOSITORY: "benediktbwimmer/unblock",
    GITHUB_TOKEN: "github-token",
    GITHUB_INSTALLATION_TOKEN: "github-token",
  });
  if (missing.length !== 0) {
    throw new Error(
      `trusted-header smoke environment still reported missing keys: ${
        missing.join(", ")
      }`,
    );
  }
});

Deno.test("GitHub smoke runner requires webhook URL and secret in real webhook mode", () => {
  const missing = missingGithubSmokeEnv({
    UNBLOCK_HOSTED_API_URL: "http://127.0.0.1:39217",
    UNBLOCK_HOSTED_API_TOKEN: "unblock-token",
    UNBLOCK_TENANT_ID: "ORG_UNBLOCK_SMOKE",
    UNBLOCK_PROJECT_ID: "SMOKE",
    PRISM_RUNTIME_ENDPOINT: "http://127.0.0.1:50051",
    GITHUB_REPOSITORY: "benediktbwimmer/unblock",
    GITHUB_TOKEN: "github-token",
    GITHUB_INSTALLATION_TOKEN: "github-token",
    UNBLOCK_SMOKE_GITHUB_WEBHOOK: "1",
  });
  for (
    const expected of [
      "UNBLOCK_SMOKE_GITHUB_WEBHOOK_URL",
      "UNBLOCK_SMOKE_GITHUB_WEBHOOK_SECRET",
    ]
  ) {
    if (!missing.includes(expected)) {
      throw new Error(`real webhook preflight did not require ${expected}`);
    }
  }
});

Deno.test("GitHub e2e runner requires real webhook environment without runtime plan", async () => {
  const result = await runGithubE2E({
    UNBLOCK_HOSTED_API_URL: "http://127.0.0.1:39217",
    UNBLOCK_HOSTED_API_TOKEN: "unblock-token",
    UNBLOCK_TENANT_ID: "ORG_UNBLOCK_SMOKE",
    UNBLOCK_PROJECT_ID: "SMOKE",
    PRISM_RUNTIME_ENDPOINT: "http://127.0.0.1:50051",
    GITHUB_REPOSITORY: "benediktbwimmer/unblock",
    GITHUB_TOKEN: "github-token",
    GITHUB_INSTALLATION_TOKEN: "github-token",
  }, { allowMissingEnv: true });
  if (
    !result.skipped ||
    !result.missing?.includes("UNBLOCK_SMOKE_GITHUB_WEBHOOK_URL") ||
    result.missing?.includes("PRISM_FLOWS_RUNTIME_PLAN")
  ) {
    throw new Error("e2e preflight did not require only real webhook inputs");
  }
});
