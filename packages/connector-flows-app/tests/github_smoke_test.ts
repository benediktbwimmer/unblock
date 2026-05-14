import { missingGithubSmokeEnv, runGithubSmoke } from "../scripts/github_smoke.ts";

Deno.test("GitHub smoke runner reports missing environment without network", async () => {
  const result = await runGithubSmoke({}, { allowMissingEnv: true });
  if (result.ok || !result.skipped) {
    throw new Error("smoke runner should skip when required environment is absent");
  }
  for (const expected of [
    "UNBLOCK_HOSTED_API_URL",
    "UNBLOCK_HOSTED_API_TOKEN",
    "UNBLOCK_TENANT_ID",
    "UNBLOCK_PROJECT_ID",
    "PRISM_FLOWS_API_URL",
    "GITHUB_REPOSITORY",
    "GITHUB_TOKEN",
  ]) {
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
    PRISM_FLOWS_API_URL: "https://flows.example.test",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_TOKEN: "github-token",
  });
  if (missing.length !== 0) {
    throw new Error(`complete smoke environment still reported missing keys: ${missing.join(", ")}`);
  }
});
