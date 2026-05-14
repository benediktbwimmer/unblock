import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMemoryStore, createServices, type AppStore, type HostedSecret } from "@unblock/core";
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

  it("exposes hosted admin identity and exportable audit events", async () => {
    const store = await seededStore();
    const auditEvents: unknown[] = [];
    store.hostedAudit = {
      async append(event) {
        auditEvents.push(event);
      },
      async list() {
        return auditEvents as never[];
      }
    };
    const app = createApp({ backend: "hosted", storeFactory: () => store, hostedAuth });

    const me = await app.request("/api/admin/me", { headers: hostedHeaders("admin") });
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({
      tenantId: "ORG_HOSTED",
      principalId: "user_123",
      roles: ["admin"]
    });

    const audit = await app.request("/api/audit", { headers: hostedHeaders("security_admin") });
    expect(audit.status).toBe(200);
    const body = await audit.json() as unknown[];
    expect(body.some((event: any) => event.eventType === "hosted.request.allowed")).toBe(true);
  });

  it("stores hosted connector secrets without returning plaintext", async () => {
    const previousKey = process.env.UNBLOCK_HOSTED_SECRET_KEY;
    process.env.UNBLOCK_HOSTED_SECRET_KEY = randomBytes(32).toString("hex");
    const store = await seededStore();
    const secrets: HostedSecret[] = [];
    store.hostedSecrets = {
      async create(secret) {
        secrets.push(secret);
      },
      async get(id) {
        return secrets.find((secret) => secret.id === id) ?? null;
      },
      async list() {
        return secrets;
      },
      async findByName(projectId, name) {
        return secrets.find((secret) => secret.projectId === projectId && secret.name === name && !secret.archivedAt) ?? null;
      },
      async update(secret) {
        const index = secrets.findIndex((item) => item.id === secret.id);
        secrets[index] = secret;
      },
      async archive(id, archivedAt) {
        const secret = secrets.find((item) => item.id === id);
        if (secret) secret.archivedAt = archivedAt;
      }
    };
    const app = createApp({ backend: "hosted", storeFactory: () => store, hostedAuth });

    try {
      const created = await app.request("/api/secrets?projectId=HOSTED", {
        method: "POST",
        headers: { ...hostedHeaders("security_admin"), "content-type": "application/json" },
        body: JSON.stringify({ name: "github-token", purpose: "github.connector", plaintext: "ghs_secret" })
      });
      expect(created.status).toBe(201);
      const body = await created.json() as any;
      expect(body.redacted).toBe(true);
      expect(JSON.stringify(body)).not.toContain("ghs_secret");
      expect(secrets[0]?.ciphertext).not.toContain("ghs_secret");

      const listed = await app.request("/api/secrets?projectId=HOSTED", { headers: hostedHeaders("security_admin") });
      expect(listed.status).toBe(200);
      expect(JSON.stringify(await listed.json())).not.toContain("ghs_secret");
    } finally {
      if (previousKey === undefined) {
        delete process.env.UNBLOCK_HOSTED_SECRET_KEY;
      } else {
        process.env.UNBLOCK_HOSTED_SECRET_KEY = previousKey;
      }
    }
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
