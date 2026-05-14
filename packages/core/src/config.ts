import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { validation } from "./errors.js";
import { defaultUnblockConfigPath, defaultUnblockDbPath } from "./types.js";

export const unblockStorageModeSchema = z.enum(["sqlite", "postgres", "hosted"]);
export type UnblockStorageMode = z.infer<typeof unblockStorageModeSchema>;

export const unblockConfigSchema = z.object({
  identity: z.object({
    machine: z.string().trim().max(80).optional(),
    actor: z.string().trim().max(80).optional()
  }).optional(),
  storage: z.object({
    mode: unblockStorageModeSchema.optional(),
    sqlitePath: z.string().trim().optional(),
    postgresUrl: z.string().trim().optional()
  }).optional(),
  ui: z.object({
    refreshIntervalMs: z.number().int().min(1000).max(600000).optional(),
    persistState: z.boolean().optional()
  }).optional()
}).transform((config) => ({
  identity: {
    machine: config.identity?.machine ?? "",
    actor: config.identity?.actor ?? ""
  },
  storage: {
    mode: config.storage?.mode ?? "sqlite",
    sqlitePath: config.storage?.sqlitePath ?? "",
    postgresUrl: config.storage?.postgresUrl ?? ""
  },
  ui: {
    refreshIntervalMs: config.ui?.refreshIntervalMs ?? 5000,
    persistState: config.ui?.persistState ?? true
  }
}));

export type UnblockConfig = z.infer<typeof unblockConfigSchema>;
export type PublicUnblockConfig = Pick<UnblockConfig, "identity" | "storage" | "ui">;

export interface EffectiveUnblockStorageConfig {
  mode: UnblockStorageMode;
  sqlitePath: string;
  postgresUrl: string;
}

export interface UnblockConfigReadResult {
  path: string;
  exists: boolean;
  config: UnblockConfig;
  issues: string[];
}

export function defaultUnblockConfig(): UnblockConfig {
  return unblockConfigSchema.parse({});
}

export function publicUnblockConfig(config: UnblockConfig): PublicUnblockConfig {
  return { identity: config.identity, storage: config.storage, ui: config.ui };
}

export function resolveUnblockStorageConfig(
  config: UnblockConfig,
  env: NodeJS.ProcessEnv = process.env,
  overrides: { mode?: string | undefined; sqlitePath?: string | undefined; postgresUrl?: string | undefined } = {}
): EffectiveUnblockStorageConfig {
  const mode = normalizeStorageMode(overrides.mode ?? env.UNBLOCK_STORAGE_MODE ?? env.UNBLOCK_BACKEND ?? config.storage.mode);
  return {
    mode,
    sqlitePath: overrides.sqlitePath?.trim() || env.UNBLOCK_DB?.trim() || config.storage.sqlitePath || defaultUnblockDbPath(),
    postgresUrl: overrides.postgresUrl?.trim() || env.UNBLOCK_POSTGRES_URL?.trim() || config.storage.postgresUrl
  };
}

export function normalizeStorageMode(value: string | undefined): UnblockStorageMode {
  const normalized = (value ?? "sqlite").trim().toLowerCase();
  if (normalized === "sqlite" || normalized === "local") {
    return "sqlite";
  }
  if (normalized === "postgres" || normalized === "pg") {
    return "postgres";
  }
  if (normalized === "hosted") {
    return "hosted";
  }
  validation(`Unsupported unblock storage mode: ${value}`);
}

export async function writeUnblockConfig(config: UnblockConfig, configPath = defaultUnblockConfigPath()): Promise<UnblockConfigReadResult> {
  const parsed = unblockConfigSchema.parse(config);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return { path: configPath, exists: true, config: parsed, issues: [] };
}

export async function updateUnblockConfig(patch: Partial<UnblockConfig>, configPath = defaultUnblockConfigPath()): Promise<UnblockConfigReadResult> {
  const current = await readUnblockConfig(configPath);
  return writeUnblockConfig({
    ...current.config,
    ...patch,
    identity: {
      ...current.config.identity,
      ...patch.identity
    },
    storage: {
      ...current.config.storage,
      ...patch.storage
    },
    ui: {
      ...current.config.ui,
      ...patch.ui
    }
  }, configPath);
}

export async function readUnblockConfig(configPath = defaultUnblockConfigPath()): Promise<UnblockConfigReadResult> {
  const fallback = defaultUnblockConfig();
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const result = unblockConfigSchema.safeParse(parsed);
    if (!result.success) {
      return {
        path: configPath,
        exists: true,
        config: fallback,
        issues: result.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      };
    }
    return { path: configPath, exists: true, config: result.data, issues: [] };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { path: configPath, exists: false, config: fallback, issues: [] };
    }
    return {
      path: configPath,
      exists: false,
      config: fallback,
      issues: [error instanceof Error ? error.message : String(error)]
    };
  }
}

export function readUnblockConfigSync(configPath = defaultUnblockConfigPath()): UnblockConfigReadResult {
  const fallback = defaultUnblockConfig();
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const result = unblockConfigSchema.safeParse(parsed);
    if (!result.success) {
      return {
        path: configPath,
        exists: true,
        config: fallback,
        issues: result.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      };
    }
    return { path: configPath, exists: true, config: result.data, issues: [] };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { path: configPath, exists: false, config: fallback, issues: [] };
    }
    return {
      path: configPath,
      exists: false,
      config: fallback,
      issues: [error instanceof Error ? error.message : String(error)]
    };
  }
}

export async function ensureUnblockConfig(configPath = defaultUnblockConfigPath()): Promise<UnblockConfigReadResult> {
  const result = await readUnblockConfig(configPath);
  if (result.exists) {
    return result;
  }
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(defaultUnblockConfig(), null, 2)}\n`, "utf8");
  return { ...result, exists: true };
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
