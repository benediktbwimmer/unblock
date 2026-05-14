import { randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import {
  identityFromTrustedHeaders,
  identityFromWorkosClaims,
  hostedPermissionForRequest,
  nowIso,
  requireHostedPermission,
  type AppStore,
  type HostedAuditEvent,
  type HostedIdentity,
  type HostedPermission,
  type SubjectType
} from "@unblock/core";

export type HostedAuthMode = "workos-jwt" | "trusted-headers";

export interface HostedRuntimeConfig {
  authMode: HostedAuthMode;
  workosClientId: string;
  workosIssuer: string | string[];
  workosJwksUrl: string;
  rateLimitWindowMs: number;
  rateLimitMax: number;
}

export interface HostedRequestContext {
  identity: HostedIdentity;
  requestId: string;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const rateLimitBuckets = new Map<string, { resetAt: number; count: number }>();

export function hostedRuntimeConfig(env: NodeJS.ProcessEnv = process.env): HostedRuntimeConfig {
  const clientId = env.WORKOS_CLIENT_ID?.trim() ?? "";
  const authMode = (env.UNBLOCK_HOSTED_AUTH_MODE?.trim() || "workos-jwt") as HostedAuthMode;
  const issuer = env.WORKOS_ISSUER?.trim();
  return {
    authMode,
    workosClientId: clientId,
    workosIssuer: issuer || ["https://api.workos.com", "https://api.workos.com/"],
    workosJwksUrl: env.WORKOS_JWKS_URL?.trim() || (clientId ? `https://api.workos.com/sso/jwks/${clientId}` : ""),
    rateLimitWindowMs: parsePositiveInteger(env.UNBLOCK_RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitMax: parsePositiveInteger(env.UNBLOCK_RATE_LIMIT_MAX, 600)
  };
}

export async function resolveHostedIdentity(headers: Headers, config: HostedRuntimeConfig): Promise<HostedIdentity> {
  if (config.authMode === "trusted-headers") {
    return identityFromTrustedHeaders({
      principalId: requiredHeader(headers, "x-unblock-principal-id"),
      organizationId: requiredHeader(headers, "x-unblock-workos-organization-id"),
      sessionId: headers.get("x-unblock-session-id"),
      roles: headers.get("x-unblock-roles"),
      permissions: headers.get("x-unblock-permissions")
    });
  }

  if (!config.workosClientId || !config.workosJwksUrl) {
    throw new Error("Hosted WorkOS JWT auth requires WORKOS_CLIENT_ID.");
  }
  const token = bearerToken(headers.get("authorization"));
  const jwks = cachedJwks(config.workosJwksUrl);
  const verified = await jwtVerify(token, jwks, { issuer: config.workosIssuer });
  return identityFromWorkosClaims(verified.payload as JWTPayload);
}

export async function syncHostedIdentity(store: AppStore, identity: HostedIdentity): Promise<void> {
  await store.hostedIdentity?.sync(identity);
}

export async function enforceHostedRequest(
  store: AppStore,
  context: HostedRequestContext,
  method: string,
  path: string,
  projectId: string | null,
  request: Request
): Promise<void> {
  const permission = hostedPermissionForRequest(method, path);
  try {
    requireHostedPermission(context.identity, permission);
    await appendHostedAudit(store, context, {
      projectId,
      eventType: "hosted.request.allowed",
      subjectType: permissionSubject(permission),
      subjectId: projectId,
      message: `Allowed ${method} ${path}`,
      data: { method, path, permission },
      request
    });
  } catch (error) {
    await appendHostedAudit(store, context, {
      projectId,
      eventType: "hosted.request.denied",
      subjectType: permissionSubject(permission),
      subjectId: projectId,
      message: `Denied ${method} ${path}`,
      data: { method, path, permission },
      request
    });
    throw error;
  }
}

export function enforceHostedRateLimit(identity: HostedIdentity, config: HostedRuntimeConfig): { remaining: number; resetAt: number } {
  const now = Date.now();
  const key = `${identity.tenantId}:${identity.principalId}`;
  const existing = rateLimitBuckets.get(key);
  const bucket = existing && existing.resetAt > now ? existing : { resetAt: now + config.rateLimitWindowMs, count: 0 };
  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);
  if (bucket.count > config.rateLimitMax) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    const error = new Error(`Rate limit exceeded. Retry after ${retryAfter}s.`);
    Object.assign(error, { status: 429, retryAfter });
    throw error;
  }
  return { remaining: config.rateLimitMax - bucket.count, resetAt: bucket.resetAt };
}

export async function appendHostedAudit(
  store: AppStore,
  context: HostedRequestContext,
  input: {
    projectId: string | null;
    eventType: string;
    subjectType: SubjectType;
    subjectId: string | null;
    message: string;
    data?: Record<string, unknown> | undefined;
    request: Request;
  }
): Promise<void> {
  const event: HostedAuditEvent = {
    tenantId: context.identity.tenantId,
    projectId: input.projectId,
    id: randomUUID(),
    eventType: input.eventType,
    principalId: context.identity.principalId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    message: input.message,
    data: input.data ?? {},
    requestId: context.requestId,
    ipAddress: clientIp(input.request.headers),
    userAgent: input.request.headers.get("user-agent"),
    createdAt: nowIso()
  };
  await store.hostedAudit?.append(event);
}

export function requestId(headers: Headers): string {
  return headers.get("x-request-id")?.trim() || randomUUID();
}

function cachedJwks(url: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = jwksCache.get(url);
  if (existing) return existing;
  const jwks = createRemoteJWKSet(new URL(url));
  jwksCache.set(url, jwks);
  return jwks;
}

function bearerToken(value: string | null): string {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) throw new Error("Hosted requests require a bearer token.");
  return match[1];
}

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name)?.trim();
  if (!value) throw new Error(`Hosted trusted-header auth requires ${name}.`);
  return value;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function permissionSubject(permission: HostedPermission): SubjectType {
  if (permission.startsWith("tenant:")) return "tenant";
  if (permission.startsWith("connector:")) return "connector";
  return "project";
}

function clientIp(headers: Headers): string | null {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim() || null;
}
