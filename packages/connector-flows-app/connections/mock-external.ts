import { connection } from "../../../../prism-new3/packages/prism-flows/mod.ts";

connection("mock-external", {
  auth: { kind: "api_key", header: "x-mock-api-key", secret: "MOCK_CONNECTOR_TOKEN" },
  baseUrl: "https://mock-connector.internal",
  network: { allowDomains: ["mock-connector.internal"] },
  rateLimit: { concurrency: 8, requestsPerSecond: 20 },
  labels: { provider: "mock", purpose: "connector-contract-review" }
});
