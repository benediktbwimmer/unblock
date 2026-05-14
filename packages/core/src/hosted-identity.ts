import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { validation } from "./errors.js";
import { nowIso, type HostedIdentity, type HostedPermission, type HostedRole, type HostedSecret } from "./types.js";

export const hostedRoles = ["owner", "admin", "security_admin", "connector_admin", "member", "viewer"] as const;

export const hostedPermissions = [
  "tenant:admin",
  "tenant:audit:read",
  "tenant:secrets:manage",
  "project:admin",
  "project:write",
  "project:read",
  "connector:admin",
  "connector:sync",
  "operator:read"
] as const;

const permissionByRole: Record<HostedRole, HostedPermission[]> = {
  owner: [...hostedPermissions],
  admin: ["project:admin", "project:write", "project:read", "connector:admin", "connector:sync", "operator:read"],
  security_admin: ["tenant:audit:read", "tenant:secrets:manage", "project:read", "operator:read"],
  connector_admin: ["project:read", "connector:admin", "connector:sync"],
  member: ["project:write", "project:read"],
  viewer: ["project:read"]
};

export interface WorkosAccessTokenClaims {
  sub?: unknown;
  sid?: unknown;
  org_id?: unknown;
  role?: unknown;
  roles?: unknown;
  permissions?: unknown;
  iss?: unknown;
  exp?: unknown;
  [key: string]: unknown;
}

export interface TrustedHeaderIdentityInput {
  principalId: string;
  organizationId: string;
  sessionId?: string | null | undefined;
  roles?: string[] | string | null | undefined;
  permissions?: string[] | string | null | undefined;
}

export function identityFromWorkosClaims(claims: WorkosAccessTokenClaims): HostedIdentity {
  const principalId = stringClaim(claims.sub, "sub");
  const organizationId = stringClaim(claims.org_id, "org_id");
  const roles = normalizeRoles([...stringListClaim(claims.roles), ...stringListClaim(claims.role)]);
  const permissions = normalizePermissions(stringListClaim(claims.permissions), roles);
  return {
    tenantId: tenantIdForWorkosOrganization(organizationId),
    principalId,
    organizationId,
    sessionId: optionalStringClaim(claims.sid),
    roles,
    permissions,
    issuedBy: "workos",
    rawClaims: { ...claims }
  };
}

export function identityFromTrustedHeaders(input: TrustedHeaderIdentityInput): HostedIdentity {
  const principalId = input.principalId.trim();
  const organizationId = input.organizationId.trim();
  if (!principalId) validation("Hosted identity requires a principal id.");
  if (!organizationId) validation("Hosted identity requires a WorkOS organization id.");
  const roles = normalizeRoles(parseListInput(input.roles));
  const permissions = normalizePermissions(parseListInput(input.permissions), roles);
  return {
    tenantId: tenantIdForWorkosOrganization(organizationId),
    principalId,
    organizationId,
    sessionId: input.sessionId?.trim() || null,
    roles,
    permissions,
    issuedBy: "trusted_headers"
  };
}

export function tenantIdForWorkosOrganization(organizationId: string): string {
  const value = organizationId.trim();
  if (!value) validation("WorkOS organization id is required.");
  return value.toUpperCase().replace(/[^A-Z0-9_-]/g, "_");
}

export function normalizeRoles(values: string[]): HostedRole[] {
  const roles = values.map((value) => value.trim().toLowerCase()).filter(Boolean);
  const normalized = roles.filter((role): role is HostedRole => (hostedRoles as readonly string[]).includes(role));
  const fallback: HostedRole[] = ["member"];
  return [...new Set(normalized.length > 0 ? normalized : fallback)];
}

export function normalizePermissions(values: string[], roles: HostedRole[]): HostedPermission[] {
  const explicit = values.map((value) => value.trim().toLowerCase()).filter((permission): permission is HostedPermission =>
    (hostedPermissions as readonly string[]).includes(permission)
  );
  const rolePermissions = permissionsForHostedRoles(roles);
  return [...new Set([...rolePermissions, ...explicit])];
}

export function permissionsForHostedRoles(roles: HostedRole[]): HostedPermission[] {
  return [...new Set(roles.flatMap((role) => permissionByRole[role]))];
}

export function withAdditionalHostedRoles(identity: HostedIdentity, roleValues: string[]): HostedIdentity {
  const roles = normalizeRoles([...identity.roles, ...roleValues]);
  return {
    ...identity,
    roles,
    permissions: [...new Set([...identity.permissions, ...permissionsForHostedRoles(roles)])]
  };
}

export function hasHostedPermission(identity: HostedIdentity, permission: HostedPermission): boolean {
  return identity.permissions.includes(permission) || identity.roles.includes("owner");
}

export function requireHostedPermission(identity: HostedIdentity, permission: HostedPermission): void {
  if (!hasHostedPermission(identity, permission)) {
    validation("Hosted identity does not have the required permission.", {
      principalId: identity.principalId,
      tenantId: identity.tenantId,
      permission
    });
  }
}

export function hostedPermissionForRequest(method: string, path: string): HostedPermission {
  if (path.startsWith("/api/audit")) return "tenant:audit:read";
  if (path.startsWith("/api/secrets")) return "tenant:secrets:manage";
  if (path.startsWith("/api/connectors")) return "connector:admin";
  if (path === "/api/projects" && method !== "GET") return "project:admin";
  if (path.includes("/archive") || path.includes("/restore") || method === "DELETE") return "project:admin";
  if (method === "GET") return "project:read";
  return "project:write";
}

export interface HostedSecretPlaintextInput {
  tenantId: string;
  projectId?: string | null | undefined;
  name: string;
  purpose: string;
  plaintext: string;
  key: Buffer;
  keyId?: string | undefined;
}

export function createHostedSecret(input: HostedSecretPlaintextInput): HostedSecret {
  const name = input.name.trim();
  const purpose = input.purpose.trim();
  if (!name) validation("Secret name is required.");
  if (!purpose) validation("Secret purpose is required.");
  const now = nowIso();
  return {
    tenantId: input.tenantId,
    projectId: input.projectId ?? null,
    id: randomUUID(),
    name,
    purpose,
    ciphertext: encryptSecret(input.plaintext, input.key),
    keyId: input.keyId ?? "default",
    algorithm: "aes-256-gcm",
    createdAt: now,
    updatedAt: now,
    rotatedAt: null,
    archivedAt: null
  };
}

export function rotateHostedSecret(secret: HostedSecret, plaintext: string, key: Buffer, keyId = secret.keyId): HostedSecret {
  const now = nowIso();
  return {
    ...secret,
    ciphertext: encryptSecret(plaintext, key),
    keyId,
    updatedAt: now,
    rotatedAt: now
  };
}

export function decryptHostedSecret(secret: HostedSecret, key: Buffer): string {
  if (secret.algorithm !== "aes-256-gcm") validation(`Unsupported secret algorithm: ${secret.algorithm}`);
  return decryptSecret(secret.ciphertext, key);
}

export function parseHostedSecretKey(value: string | undefined): Buffer {
  const raw = value?.trim();
  if (!raw) validation("UNBLOCK_HOSTED_SECRET_KEY is required for hosted secret encryption.");
  const key = raw.startsWith("base64:") ? Buffer.from(raw.slice("base64:".length), "base64") : Buffer.from(raw, "hex");
  if (key.length !== 32) validation("UNBLOCK_HOSTED_SECRET_KEY must decode to 32 bytes.");
  return key;
}

function encryptSecret(plaintext: string, key: Buffer): string {
  if (key.length !== 32) validation("Secret encryption key must be 32 bytes.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

function decryptSecret(encoded: string, key: Buffer): string {
  if (key.length !== 32) validation("Secret encryption key must be 32 bytes.");
  const [version, ivRaw, tagRaw, ciphertextRaw] = encoded.split(":");
  if (version !== "v1" || !ivRaw || !tagRaw || !ciphertextRaw) validation("Invalid hosted secret ciphertext.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, "base64")), decipher.final()]).toString("utf8");
}

function stringClaim(value: unknown, name: string): string {
  const normalized = optionalStringClaim(value);
  if (!normalized) validation(`WorkOS access token missing ${name} claim.`);
  return normalized;
}

function optionalStringClaim(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringListClaim(value: unknown): string[] {
  if (typeof value === "string") return parseListInput(value);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function parseListInput(value: string[] | string | null | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
