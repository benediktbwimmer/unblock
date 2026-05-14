import { describe, expect, it } from "vitest";
import { createMemoryStore, createServices, type AppStore } from "@unblock/core";
import { createApp } from "./index.js";

const hostedAuth = {
  authMode: "trusted-headers" as const,
  workosClientId: "",
  workosIssuer: "https://api.workos.com",
  workosJwksUrl: "",
  rateLimitWindowMs: 60_000,
  rateLimitMax: 100
};

describe("hosted authorization", () => {
  it("allows project reads for viewers and denies writes without write permission", async () => {
    const store = await seededStore();
    const app = createApp({ backend: "hosted", storeFactory: () => store, hostedAuth });

    const read = await app.request("/api/tasks?projectId=HOSTED", { headers: hostedHeaders("viewer") });
    expect(read.status).toBe(200);

    const write = await app.request("/api/tasks?projectId=HOSTED", {
      method: "POST",
      headers: { ...hostedHeaders("viewer"), "content-type": "application/json" },
      body: JSON.stringify({ id: "DENIED", title: "Denied" })
    });
    expect(write.status).toBe(400);
    await expect(write.json()).resolves.toMatchObject({
      error: { code: "validation" }
    });
  });

  it("uses project membership roles as effective permissions", async () => {
    const store = await seededStore();
    installProjectRole(store, "member");
    const app = createApp({ backend: "hosted", storeFactory: () => store, hostedAuth });

    const write = await app.request("/api/tasks?projectId=HOSTED", {
      method: "POST",
      headers: { ...hostedHeaders("viewer"), "content-type": "application/json" },
      body: JSON.stringify({ id: "ALLOWED", title: "Allowed" })
    });

    expect(write.status).toBe(201);
    await expect(write.json()).resolves.toMatchObject({ id: "ALLOWED" });
  });
});

async function seededStore(): Promise<AppStore> {
  const store = createMemoryStore();
  const services = createServices(store, { machine: "test", actor: "codex-e" });
  await services.projects.add({ id: "HOSTED", name: "Hosted" });
  return store;
}

function installProjectRole(store: AppStore, role: string): void {
  store.hostedIdentity = {
    async sync() {},
    async tenantRole() {
      return "viewer";
    },
    async projectRole() {
      return role;
    }
  };
}

function hostedHeaders(role: string): Record<string, string> {
  return {
    "x-unblock-principal-id": "user_123",
    "x-unblock-workos-organization-id": "org_hosted",
    "x-unblock-roles": role
  };
}
