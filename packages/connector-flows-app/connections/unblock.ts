import { connection } from "../../../../prism-new3/packages/prism-flows/mod.ts";

connection("unblock-hosted-api", {
  auth: { kind: "bearer_token", secret: "UNBLOCK_HOSTED_API_TOKEN" },
  baseUrl: "https://unblock-hosted.internal",
  defaultHeaders: { "content-type": "application/json" },
  network: { allowDomains: ["unblock-hosted.internal"] },
  rateLimit: { concurrency: 32, requestsPerSecond: 100 },
  redaction: {
    request: ["authorization", "plaintext", "ciphertext"],
    response: ["ciphertext"]
  },
  labels: { product: "unblock", boundary: "core-api" }
});
