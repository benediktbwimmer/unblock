import pg from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "./memory-store.js";
import { createPostgresStore } from "./postgres-store.js";
import { createServices } from "./services.js";
import { createSqliteStore } from "./sqlite-store.js";
import type { AppStore } from "./store.js";
import type { JsonExport } from "./types.js";

interface StoreHandle {
  store: AppStore;
  cleanup(): Promise<void>;
}

interface StoreCase {
  name: string;
  create(): Promise<StoreHandle>;
}

const postgresUrl = process.env.UNBLOCK_TEST_POSTGRES_URL;
const handles: StoreHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    await handles.pop()?.cleanup();
  }
});

const storeCases: StoreCase[] = [
  {
    name: "memory",
    async create() {
      const store = createMemoryStore();
      return trackHandle({ store, cleanup: async () => { await store.close?.(); } });
    }
  },
  {
    name: "sqlite",
    async create() {
      const dir = await mkdtemp(join(tmpdir(), "unblock-matcher-corpus-sqlite-"));
      const store = createSqliteStore({ databasePath: join(dir, "unblock.sqlite") });
      return trackHandle({ store, cleanup: async () => { await store.close?.(); } });
    }
  }
];

if (postgresUrl) {
  storeCases.push({
    name: "postgres",
    async create() {
      return trackHandle(await createTemporaryPostgresStore(postgresUrl));
    }
  });
}

describe.each(storeCases)("matcher corpus: $name", ({ create }) => {
  it("matches the dialect-independent corpus", async () => {
    const { store } = await create();
    const projectId = `M${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    await createServices(store, { machine: "lab", actor: "codex-e" }).projects.add({ id: projectId, name: "Matcher corpus" });
    const services = createServices(store, { projectId, machine: "lab", actor: "codex-e" });
    await seedMatcherCorpus(services);
    expect((await services.query.explain("API")).task.parentTaskId).toBe("EPIC");

    const cases: Array<[query: string, expectedIds: string[]]> = [
      ["tag = backend", ["API", "DB"]],
      ["tag in (frontend, backend) and not assigned = lab:codex-b", ["API", "DB"]],
      ["(tag = backend or tag = frontend) and priority >= 3", ["API", "DB"]],
      ["assigned = codex-a", ["API"]],
      ["assigned = lab:codex-b", ["WEB"]],
      ["machine = lab and actor = codex-b", ["WEB"]],
      ["parent = API", ["API-CHILD"]],
      ["parent = root", ["DB", "DONE", "EPIC", "LATER", "OPS", "WEB"]],
      ["descendant of EPIC", ["API", "API-CHILD"]],
      ["depends on DB", ["API", "API-CHILD", "EPIC", "WEB"]],
      ["depends on DB depth = 1", ["API-CHILD"]],
      ["unblocks API", ["API-CHILD", "DB"]],
      ["unblocks > 1", ["API-CHILD", "DB"]],
      ["comments > 0", ["API", "WEB"]],
      ["commented by lab:codex-a", ["API"]],
      ["commented since 2026-05-09", ["API", "WEB"]],
      ["status = blocked", ["API-CHILD", "WEB"]],
      ["status not in (finished, archived)", ["API", "API-CHILD", "DB", "EPIC", "LATER", "OPS", "WEB"]],
      ["lifecycle = started", ["OPS"]],
      ["source doc = design.md and source section = API", ["API"]],
      ["created = 2026-05-10", ["API"]],
      ["started is not empty", ["OPS"]],
      ["id prefix = API", ["API", "API-CHILD"]]
    ];

    for (const [query, expectedIds] of cases) {
      expect(await matchIds(services, query), query).toEqual(expectedIds);
    }

    expect((await services.views.tasks("DB-CLOSURE", 50)).map((task) => task.id).sort()).toEqual(["API", "API-CHILD", "EPIC", "WEB"]);
    expect((await services.feeds.tasks("BACKEND-READY", 50)).map((task) => task.id).sort()).toEqual(["API", "DB"]);
    expect((await services.instructions.matchesForTask("API")).map((match) => match.instruction.id).sort()).toEqual(["BACKEND-READY", "DB-CLOSURE"]);
    expect((await services.query.matchingInstructionIds()).sort(compareInstructionMatchIds)).toEqual([
      { instructionId: "BACKEND-READY", taskId: "API" },
      { instructionId: "BACKEND-READY", taskId: "DB" },
      { instructionId: "BLOCKED-WORK", taskId: "API-CHILD" },
      { instructionId: "BLOCKED-WORK", taskId: "WEB" },
      { instructionId: "DB-CLOSURE", taskId: "API" },
      { instructionId: "DB-CLOSURE", taskId: "API-CHILD" },
      { instructionId: "DB-CLOSURE", taskId: "EPIC" },
      { instructionId: "DB-CLOSURE", taskId: "WEB" }
    ]);
  });
});

if (!postgresUrl) {
  describe("matcher corpus: postgres", () => {
    it.skip("set UNBLOCK_TEST_POSTGRES_URL to run the Postgres matcher corpus", () => {});
  });
}

async function seedMatcherCorpus(services: ReturnType<typeof createServices>): Promise<void> {
  const createdAt = "2026-05-01T00:00:00.000Z";
  const corpus: JsonExport = {
    tasks: [
      task("EPIC", "Epic work", { priority: 2 }),
      task("API", "API work", { parentTaskId: "EPIC", priority: 3, createdAt: "2026-05-10T10:00:00.000Z", sourceDoc: "design.md", sourceSection: "API" }),
      task("API-CHILD", "API child", { parentTaskId: "API", priority: 2 }),
      task("DB", "Database work", { priority: 4 }),
      task("WEB", "Web work", { priority: 1 }),
      task("OPS", "Operations work", { lifecycle: "started", startedAt: "2026-05-11T09:00:00.000Z" }),
      task("DONE", "Finished work", { lifecycle: "finished", finishedAt: "2026-05-08T12:00:00.000Z" }),
      task("ARCH", "Archived work", { archivedAt: "2026-05-12T12:00:00.000Z" }),
      task("LATER", "Later work", { priority: 4 })
    ],
    dependencies: [
      { projectId: "DEFAULT", taskId: "API-CHILD", dependsOnTaskId: "DB", createdAt },
      { projectId: "DEFAULT", taskId: "WEB", dependsOnTaskId: "API-CHILD", createdAt },
      { projectId: "DEFAULT", taskId: "LATER", dependsOnTaskId: "DONE", createdAt }
    ],
    tags: [
      tag("BACKEND", "backend"),
      tag("FRONTEND", "frontend"),
      tag("OPS", "ops")
    ],
    taskTags: [
      taskTag("API", "BACKEND"),
      taskTag("DB", "BACKEND"),
      taskTag("WEB", "FRONTEND"),
      taskTag("OPS", "OPS"),
      taskTag("ARCH", "BACKEND")
    ],
    tracks: [
      actorTrack("lab-codex-a", "codex-a"),
      actorTrack("lab-codex-b", "codex-b")
    ],
    assignments: [
      assignment("lab-codex-a", "API", "000001"),
      assignment("lab-codex-b", "WEB", "000001")
    ],
    comments: [
      comment("C-API", "API", "codex-a", "API note", "2026-05-10T12:00:00.000Z"),
      comment("C-WEB", "WEB", "codex-b", "WEB note", "2026-05-09T12:00:00.000Z"),
      comment("C-ARCHIVED", "DB", "codex-a", "Archived note", "2026-05-10T12:30:00.000Z", "2026-05-10T13:00:00.000Z")
    ]
  };

  await services.imports.json("matcher-corpus.json", corpus);
  await services.instructions.addMany([
    { id: "BACKEND-READY", name: "Backend ready", query: "tag = backend and status = ready", body: "Backend ready work." },
    { id: "BLOCKED-WORK", name: "Blocked work", query: "status = blocked", body: "Blocked work." },
    { id: "DB-CLOSURE", name: "DB closure", query: "depends on DB", body: "DB dependency closure." }
  ]);
  await services.views.add({ id: "DB-CLOSURE", name: "DB closure", query: "depends on DB" });
  await services.feeds.add({ id: "BACKEND-READY", name: "Backend ready", query: "tag = backend" });
}

async function matchIds(services: ReturnType<typeof createServices>, query: string): Promise<string[]> {
  return (await services.query.match(query, 100, { includeFinished: true, includeArchived: true, sort: "id" })).map((task) => task.id);
}

function task(id: string, title: string, input: Partial<JsonExport["tasks"][number]> = {}): JsonExport["tasks"][number] {
  const now = input.createdAt ?? "2026-05-01T00:00:00.000Z";
  return {
    projectId: "DEFAULT",
    id,
    parentTaskId: input.parentTaskId ?? null,
    title,
    description: "",
    lifecycle: input.lifecycle ?? "open",
    priority: input.priority ?? 2,
    size: null,
    sourceDoc: input.sourceDoc ?? null,
    sourceSection: input.sourceSection ?? null,
    sourceAnchor: null,
    sourceLine: null,
    sourceText: null,
    completionBar: null,
    createdAt: now,
    updatedAt: input.updatedAt ?? now,
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
    archivedAt: input.archivedAt ?? null,
    version: 1
  };
}

function tag(id: string, name: string): JsonExport["tags"][number] {
  const now = "2026-05-01T00:00:00.000Z";
  return { projectId: "DEFAULT", id, name, color: null, description: null, sortOrder: 0, createdAt: now, updatedAt: now, archivedAt: null };
}

function taskTag(taskId: string, tagId: string): JsonExport["taskTags"][number] {
  return { projectId: "DEFAULT", taskId, tagId, createdAt: "2026-05-01T00:00:00.000Z" };
}

function actorTrack(id: string, actor: string): JsonExport["tracks"][number] {
  const now = "2026-05-01T00:00:00.000Z";
  return { projectId: "DEFAULT", id, machine: "lab", actor, name: actor, createdAt: now, updatedAt: now, archivedAt: null };
}

function assignment(trackId: string, taskId: string, position: string): JsonExport["assignments"][number] {
  return { projectId: "DEFAULT", trackId, taskId, position, assignedAt: "2026-05-01T00:00:00.000Z" };
}

function comment(id: string, taskId: string, actor: string, body: string, createdAt: string, archivedAt: string | null = null): JsonExport["comments"][number] {
  return { projectId: "DEFAULT", id, taskId, machine: "lab", actor, body, createdAt, updatedAt: createdAt, archivedAt };
}

function compareInstructionMatchIds(left: { instructionId: string; taskId: string }, right: { instructionId: string; taskId: string }): number {
  return left.instructionId.localeCompare(right.instructionId) || left.taskId.localeCompare(right.taskId);
}

function trackHandle(handle: StoreHandle): StoreHandle {
  handles.push(handle);
  return handle;
}

async function createTemporaryPostgresStore(baseConnectionString: string): Promise<StoreHandle> {
  const databaseName = `unblock_matcher_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(baseConnectionString);
  adminUrl.pathname = "/postgres";
  const databaseUrl = new URL(baseConnectionString);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`create database ${databaseName}`);
  await admin.end();

  const store = await createPostgresStore({ connectionString: databaseUrl.toString(), autoMigrate: true });
  return {
    store,
    async cleanup() {
      await store.close?.();
      const cleanup = new pg.Client({ connectionString: adminUrl.toString() });
      await cleanup.connect();
      await cleanup.query(`drop database if exists ${databaseName} with (force)`);
      await cleanup.end();
    }
  };
}
