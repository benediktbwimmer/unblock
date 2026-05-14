import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createHostedSecret,
  decryptHostedSecret,
  hasHostedPermission,
  identityFromTrustedHeaders,
  identityFromWorkosClaims,
  parseHostedSecretKey,
  rotateHostedSecret
} from "./hosted-identity.js";

describe("hosted identity", () => {
  it("maps WorkOS organization sessions to hosted tenants and permissions", () => {
    const identity = identityFromWorkosClaims({
      sub: "user_123",
      sid: "session_123",
      org_id: "org_01abc",
      role: "admin",
      permissions: ["tenant:audit:read"]
    });

    expect(identity).toMatchObject({
      tenantId: "ORG_01ABC",
      principalId: "user_123",
      organizationId: "org_01abc",
      sessionId: "session_123",
      roles: ["admin"]
    });
    expect(hasHostedPermission(identity, "project:write")).toBe(true);
    expect(hasHostedPermission(identity, "tenant:audit:read")).toBe(true);
    expect(hasHostedPermission(identity, "tenant:secrets:manage")).toBe(false);
  });

  it("normalizes trusted-header identities for hosted gateways", () => {
    const identity = identityFromTrustedHeaders({
      principalId: "user_456",
      organizationId: "org-test",
      roles: "viewer,unknown",
      permissions: "connector:sync"
    });

    expect(identity.roles).toEqual(["viewer"]);
    expect(identity.permissions).toContain("project:read");
    expect(identity.permissions).toContain("connector:sync");
    expect(identity.permissions).not.toContain("project:write");
  });
});

describe("hosted secrets", () => {
  it("encrypts and rotates hosted secret envelopes", () => {
    const key = randomBytes(32);
    const secret = createHostedSecret({
      tenantId: "TENANT",
      projectId: "PROJECT",
      name: "github-token",
      purpose: "github.connector",
      plaintext: "ghs_secret",
      key
    });

    expect(secret.ciphertext).not.toContain("ghs_secret");
    expect(decryptHostedSecret(secret, key)).toBe("ghs_secret");

    const nextKey = randomBytes(32);
    const rotated = rotateHostedSecret(secret, "ghs_next", nextKey, "v2");
    expect(rotated.keyId).toBe("v2");
    expect(rotated.rotatedAt).not.toBeNull();
    expect(decryptHostedSecret(rotated, nextKey)).toBe("ghs_next");
  });

  it("parses explicit hosted secret keys", () => {
    const key = randomBytes(32);
    expect(parseHostedSecretKey(key.toString("hex"))).toEqual(key);
    expect(parseHostedSecretKey(`base64:${key.toString("base64")}`)).toEqual(key);
  });
});
