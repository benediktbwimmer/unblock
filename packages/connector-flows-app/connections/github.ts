import { connection } from "../../../../prism-new3/packages/prism-flows/mod.ts";

connection("github-api", {
  auth: { kind: "bearer_token", secret: "GITHUB_INSTALLATION_TOKEN" },
  baseUrl: "https://api.github.com",
  baseUrlEnv: "GITHUB_API_BASE_URL",
  defaultHeaders: {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  },
  network: { allowDomains: ["api.github.com", "127.0.0.1", "localhost"] },
  rateLimit: { concurrency: 8, requestsPerSecond: 4 },
  redaction: {
    request: ["authorization"],
    response: [],
  },
  labels: { provider: "github", purpose: "issues-sync" },
});
