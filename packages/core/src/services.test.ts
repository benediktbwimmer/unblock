import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemoryStore, createServices, ensureUnblockConfig, UnblockError, readUnblockConfig } from "./index.js";

describe("unblock core services", () => {
  it("creates and validates the user config file with safe defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "unblock-config-"));
    const configPath = join(dir, "config.json");

    const created = await ensureUnblockConfig(configPath);
    expect(created.exists).toBe(true);
    expect(created.config.ui.refreshIntervalMs).toBe(5000);
    expect(created.config.ui.persistState).toBe(true);

    await writeFile(configPath, JSON.stringify({ ui: { refreshIntervalMs: 2500, persistState: false } }), "utf8");
    const custom = await readUnblockConfig(configPath);
    expect(custom.config.ui.refreshIntervalMs).toBe(2500);
    expect(custom.config.ui.persistState).toBe(false);

    await writeFile(configPath, JSON.stringify({ ui: { refreshIntervalMs: 10 } }), "utf8");
    const invalid = await readUnblockConfig(configPath);
    expect(invalid.config.ui.refreshIntervalMs).toBe(5000);
    expect(invalid.issues.length).toBeGreaterThan(0);
  });

  it("keeps readiness dependency-first while computing hierarchy progress", async () => {
    const store = createMemoryStore();
    const services = createServices(store, { machine: "test-machine", actor: "test-actor" });

    await services.tasks.add({ id: "AUTH", title: "Auth work" });
    await services.tasks.add({ id: "AUTH-001", parentTaskId: "AUTH", title: "Registry" });
    await services.tasks.add({ id: "AUTH-002", parentTaskId: "AUTH", title: "Object surfaces" });
    await services.tasks.add({ id: "AUTH-003", parentTaskId: "AUTH", title: "Behavior capture" });
    await services.dependencies.add("AUTH-003", "AUTH-001");

    await services.tasks.finish("AUTH-001");
    const tasks = await services.query.list({ includeFinished: true });
    const parent = tasks.find((task) => task.id === "AUTH");
    const capture = tasks.find((task) => task.id === "AUTH-003");

    expect(parent?.computedStatus).toBe("ready");
    expect(parent?.rollupStatus).toBe("blocked-by-children");
    expect(parent?.subtreeProgress).toBe(33);
    expect(parent?.unfinishedDescendantsCount).toBe(2);
    expect(parent?.finishedLeafDescendantsCount).toBe(1);
    expect(parent?.leafDescendantsCount).toBe(3);
    expect(parent?.criticalChildPath.map((task) => task.id)).toEqual(["AUTH-002"]);
    expect(capture?.computedStatus).toBe("ready");
  });

  it("sorts ready work by downstream unblock count before priority by default", async () => {
    const store = createMemoryStore();
    const services = createServices(store, { machine: "test-machine", actor: "test-actor" });

    await services.tasks.add({ id: "A", title: "Critical root", priority: 2 });
    await services.tasks.add({ id: "B", title: "High standalone", priority: 4 });
    await services.tasks.add({ id: "C", title: "Downstream 1" });
    await services.tasks.add({ id: "D", title: "Downstream 2" });
    await services.dependencies.add("C", "A");
    await services.dependencies.add("D", "C");

    const ready = await services.query.list({ status: "ready" });
    expect(ready.map((task) => task.id).slice(0, 2)).toEqual(["A", "B"]);
    expect(ready[0]?.transitiveDependentsCount).toBe(2);
  });

  it("searches assignments and tags as task metadata", async () => {
    const store = createMemoryStore();
    const services = createServices(store, { machine: "test-machine", actor: "test-actor" });

    await services.tasks.add({ id: "API", title: "API task" });
    await services.tasks.add({ id: "WEB", title: "Web task" });
    await services.tags.add({ id: "UX", name: "user experience" });
    await services.tags.assign("WEB", ["UX"]);
    await services.tracks.add({ actor: "codex-b", name: "Backend queue" });
    await services.tracks.assign("codex-b", "API");

    const assigned = await services.query.list({ search: "codex-b" });
    const tagged = await services.query.list({ search: "experience" });

    expect(assigned.map((task) => task.id)).toEqual(["API"]);
    expect(tagged.map((task) => task.id)).toEqual(["WEB"]);
  });

  it("keeps task comments flat, chronological, markdown-capable, and provenance-stamped", async () => {
    const store = createMemoryStore();
    const services = createServices(store, { machine: "test-machine", actor: "test-actor" });

    await services.tasks.add({ id: "API", title: "API task" });
    const first = await services.comments.add("API", { body: "**First** handoff note" });
    const second = await services.comments.add("API", { body: "- second\n- note" });

    let comments = await services.comments.list("API");
    expect(new Set(comments.map((comment) => comment.id))).toEqual(new Set([first.id, second.id]));
    expect(comments.map((comment) => comment.createdAt)).toEqual([...comments.map((comment) => comment.createdAt)].sort());
    expect(comments.find((comment) => comment.id === first.id)).toMatchObject({
      taskId: "API",
      machine: "test-machine",
      actor: "test-actor",
      body: "**First** handoff note"
    });

    await services.comments.edit(first.id, { body: "Updated **note**" });
    await services.comments.archive(second.id);
    comments = await services.comments.list("API");
    expect(comments.map((comment) => comment.body)).toEqual(["Updated **note**"]);
    expect((await services.comments.list("API", { includeArchived: true })).map((comment) => comment.id)).toEqual(expect.arrayContaining([first.id, second.id]));

    await services.comments.restore(second.id);
    expect((await services.comments.list("API")).map((comment) => comment.id)).toEqual(expect.arrayContaining([first.id, second.id]));

    expect((await services.query.list({ where: "comments > 0" })).map((task) => task.id)).toEqual(["API"]);
    expect((await services.query.list({ where: "commented by test-machine:test-actor" })).map((task) => task.id)).toEqual(["API"]);
    expect((await services.query.list({ where: "commented since now - 1d" })).map((task) => task.id)).toEqual(["API"]);
  });

  it("rejects parent cycles", async () => {
    const store = createMemoryStore();
    const services = createServices(store, { machine: "test-machine", actor: "test-actor" });

    await services.tasks.add({ id: "A", title: "A" });
    await services.tasks.add({ id: "B", parentTaskId: "A", title: "B" });

    await expect(services.tasks.edit("A", { parentTaskId: "B" })).rejects.toBeInstanceOf(UnblockError);
  });

  it("allows dependencies across sibling and unrelated hierarchy branches", async () => {
    const store = createMemoryStore();
    const services = createServices(store, { machine: "test-machine", actor: "test-actor" });

    await services.tasks.add({ id: "ROOT-A", title: "Root A" });
    await services.tasks.add({ id: "ROOT-B", title: "Root B" });
    await services.tasks.add({ id: "A-1", parentTaskId: "ROOT-A", title: "A child" });
    await services.tasks.add({ id: "A-2", parentTaskId: "ROOT-A", title: "A sibling" });
    await services.tasks.add({ id: "B-1", parentTaskId: "ROOT-B", title: "B child" });

    await expect(services.dependencies.add("A-2", "A-1")).resolves.toMatchObject({ taskId: "A-2", dependsOnTaskId: "A-1" });
    await expect(services.dependencies.add("B-1", "A-1")).resolves.toMatchObject({ taskId: "B-1", dependsOnTaskId: "A-1" });
  });

  it("rejects hierarchy dependency edges in either direction", async () => {
    const store = createMemoryStore();
    const services = createServices(store, { machine: "test-machine", actor: "test-actor" });

    await services.tasks.add({ id: "A", title: "A" });
    await services.tasks.add({ id: "B", parentTaskId: "A", title: "B" });
    await services.tasks.add({ id: "C", parentTaskId: "B", title: "C" });

    await expect(services.dependencies.add("A", "B")).rejects.toBeInstanceOf(UnblockError);
    await expect(services.dependencies.add("C", "A")).rejects.toBeInstanceOf(UnblockError);
    await expect(services.dependencies.set("A", ["C"])).rejects.toBeInstanceOf(UnblockError);
    await expect(services.dependencies.set("C", ["A"])).rejects.toBeInstanceOf(UnblockError);
  });

  it("rejects dependency self-edges and cycles", async () => {
    const store = createMemoryStore();
    const services = createServices(store, { machine: "test-machine", actor: "test-actor" });

    await services.tasks.add({ id: "A", title: "A" });
    await services.tasks.add({ id: "B", title: "B" });
    await services.tasks.add({ id: "C", title: "C" });

    await expect(services.dependencies.add("A", "A")).rejects.toBeInstanceOf(UnblockError);
    await services.dependencies.add("B", "A");
    await services.dependencies.add("C", "B");
    await expect(services.dependencies.add("A", "C")).rejects.toBeInstanceOf(UnblockError);
  });

  it("keeps parents open until descendants are finished without making children dependencies", async () => {
    const store = createMemoryStore();
    const services = createServices(store, { machine: "test-machine", actor: "test-actor" });

    await services.tasks.add({ id: "P", title: "Parent project" });
    await services.tasks.add({ id: "C", parentTaskId: "P", title: "Child task" });

    await expect(services.tasks.finish("P")).rejects.toBeInstanceOf(UnblockError);

    const explanation = await services.query.explain("P");
    expect(explanation.task.computedStatus).toBe("ready");
    expect(explanation.task.rollupStatus).toBe("blocked-by-children");
    expect(explanation.task.criticalChildPath.map((task) => task.id)).toEqual(["C"]);
    expect(explanation.unfinishedDependencies).toHaveLength(0);

    await services.tasks.finish("C");
    const afterChildFinish = await services.query.explain("P");
    expect(afterChildFinish.task.rollupStatus).toBe("complete");
    expect(afterChildFinish.task.subtreeProgress).toBe(100);

    await expect(services.tasks.finish("P")).resolves.toMatchObject({ id: "P", lifecycle: "finished" });
  });

  it("treats archived tasks like deleted tasks in active rollups until restored", async () => {
    const store = createMemoryStore();
    const services = createServices(store, { machine: "test-machine", actor: "test-actor" });

    await services.tasks.add({ id: "P", title: "Parent project" });
    await services.tasks.add({ id: "C", parentTaskId: "P", title: "Child task" });

    await services.tasks.archive("C");
    const afterArchive = await services.query.explain("P");
    expect(afterArchive.task.childrenCount).toBe(0);
    expect(afterArchive.task.descendantsCount).toBe(0);
    expect(afterArchive.task.rollupStatus).toBe("leaf");
    await expect(services.tasks.finish("P")).resolves.toMatchObject({ id: "P", lifecycle: "finished" });

    await expect(services.tasks.restore("C")).rejects.toBeInstanceOf(UnblockError);
    await services.tasks.reopen("P");
    await expect(services.tasks.restore("C")).resolves.toMatchObject({ id: "C", archivedAt: null });

    const afterRestore = await services.query.explain("P");
    expect(afterRestore.task.childrenCount).toBe(1);
    expect(afterRestore.task.rollupStatus).toBe("blocked-by-children");
    expect(afterRestore.task.unfinishedDescendantsCount).toBe(1);
  });

  it("ignores archived tasks in active dependency scheduling until restored", async () => {
    const store = createMemoryStore();
    const services = createServices(store, { machine: "test-machine", actor: "test-actor" });

    await services.tasks.add({ id: "DEP", title: "Dependency" });
    await services.tasks.add({ id: "WORK", title: "Work" });
    await services.dependencies.add("WORK", "DEP");

    expect((await services.query.explain("WORK")).task.computedStatus).toBe("blocked");

    await services.tasks.archive("DEP");
    const afterArchive = await services.query.explain("WORK");
    expect(afterArchive.task.computedStatus).toBe("ready");
    expect(afterArchive.task.unfinishedDependenciesCount).toBe(0);

    await services.tasks.restore("DEP");
    const afterRestore = await services.query.explain("WORK");
    expect(afterRestore.task.computedStatus).toBe("blocked");
    expect(afterRestore.task.unfinishedDependenciesCount).toBe(1);
  });

  it("allows assignment when dependencies are unfinished", async () => {
    const store = createMemoryStore();
    const services = createServices(store, { machine: "test-machine", actor: "test-actor" });

    await services.tasks.add({ id: "A", title: "Dependency" });
    await services.tasks.add({ id: "B", title: "Blocked task" });
    await services.dependencies.add("B", "A");
    await services.tracks.add({ actor: "codex-a" });

    await expect(services.tracks.assign("codex-a", "B")).resolves.toMatchObject({ taskId: "B" });
    const explanation = await services.query.explain("B");
    expect(explanation.assignable).toBe(true);
    expect(explanation.task.blocked).toBe(true);
    expect(explanation.reason).toBe("Task can be assigned, but 1 dependency is unfinished.");
  });

  it("resolves displayed actor queue ids everywhere actor-or-track refs are accepted", async () => {
    const store = createMemoryStore();
    const services = createServices(store, { machine: "bw-mbp", actor: "tester" });

    await services.tasks.add({ id: "A", title: "Assignable task" });
    const track = await services.tracks.add({ actor: "codex-a" });

    expect(track.id).toBe("bw-mbp-codex-a");
    await expect(services.tracks.assign("bw-mbp-codex-a", "A")).resolves.toMatchObject({
      taskId: "A",
      trackId: "bw-mbp-codex-a"
    });
  });

  it("matches instructions dynamically across metadata, hierarchy, and dependency graph predicates", async () => {
    const store = createMemoryStore();
    const services = createServices(store, { machine: "test-machine", actor: "test-actor" });

    await services.tasks.add({ id: "ROOT", title: "Root work" });
    await services.tasks.add({ id: "DEP", parentTaskId: "ROOT", title: "Dependency" });
    await services.tasks.add({ id: "WORK", title: "Implementation work", priority: 3 });
    await services.dependencies.add("WORK", "DEP");
    await services.tags.add({ id: "BACKEND", name: "backend" });
    await services.tags.assign("WORK", ["BACKEND"]);
    await services.tracks.add({ actor: "codex-a" });
    await services.tracks.assign("codex-a", "WORK");

    const backend = await services.instructions.add({
      name: "Backend note",
      query: "tag in (backend, frontend) and assigned = test-machine:codex-a",
      body: "Use the backend checklist."
    });
    await services.instructions.add({
      name: "Root sequencing",
      query: "depends on DEP and priority >= 3",
      body: "This sees explicit and hierarchy dependency edges."
    });
    await services.instructions.add({
      name: "Direct dependency only",
      query: "depends on DEP depth = 1",
      body: "Direct explicit dependency."
    });

    const explanation = await services.query.explain("WORK");
    expect(explanation.instructions.map((match) => match.instruction.name)).toEqual([
      "Backend note",
      "Direct dependency only",
      "Root sequencing"
    ]);
    expect(explanation.instructions.find((match) => match.instruction.id === backend.id)?.reasons).toContain("tag in backend, frontend");

    const preview = await services.instructions.preview("unblocks WORK");
    expect(preview.ok).toBe(true);
    expect(preview.matches.map((match) => match.task.id)).toEqual(["DEP"]);

    const tagSuggestions = await services.instructions.suggest("tag", { prefix: "back", limit: 5 });
    expect(tagSuggestions.map((suggestion) => suggestion.value)).toContain("backend");
    const idSuggestions = await services.instructions.suggest("id", { prefix: "WO", limit: 1 });
    expect(idSuggestions).toEqual([expect.objectContaining({ value: "WORK" })]);
    const assignedSuggestions = await services.instructions.suggest("assigned", { prefix: "test", limit: 5 });
    expect(assignedSuggestions.map((suggestion) => suggestion.value)).toEqual(["test-machine:codex-a"]);
  });

  it("orders matcher task id suggestions by hierarchy depth and supports acronym prefixes", async () => {
    const store = createMemoryStore();
    const services = createServices(store, { machine: "test-machine", actor: "test-actor" });

    await services.tasks.add({ id: "P-IMPLEMENTATION", title: "Implementation root" });
    await services.tasks.add({ id: "P-INTEGRATION", title: "Integration root" });
    await services.tasks.add({ id: "P-IMPLEMENTATION-API", parentTaskId: "P-IMPLEMENTATION", title: "API child" });
    await services.tasks.add({ id: "P-IMPLEMENTATION-API-TESTS", parentTaskId: "P-IMPLEMENTATION-API", title: "API tests" });

    const suggestions = await services.instructions.suggest("id", { prefix: "P-I", limit: 10 });
    const values = suggestions.map((suggestion) => suggestion.value);

    expect(values).toContain("P-IMPLEMENTATION");
    expect(values.indexOf("P-IMPLEMENTATION")).toBeLessThan(values.indexOf("P-IMPLEMENTATION-API"));
    expect(values.indexOf("P-INTEGRATION")).toBeLessThan(values.indexOf("P-IMPLEMENTATION-API"));
    expect(values.indexOf("P-IMPLEMENTATION-API")).toBeLessThan(values.indexOf("P-IMPLEMENTATION-API-TESTS"));
  });

  it("suggests archived status and supports not in membership predicates", async () => {
    const store = createMemoryStore();
    const services = createServices(store, { machine: "test-machine", actor: "test-actor" });

    await services.tasks.add({ id: "READY", title: "Ready task" });
    await services.tasks.add({ id: "DONE", title: "Done task" });
    await services.tasks.add({ id: "OLD", title: "Archived task" });
    await services.tasks.finish("DONE");
    await services.tasks.archive("OLD");

    const statusSuggestions = await services.instructions.suggest("status", { prefix: "a", limit: 10 });
    expect(statusSuggestions.map((suggestion) => suggestion.value)).toContain("archived");

    const matches = await services.query.list({
      where: "status not in (finished, archived)",
      includeFinished: true,
      includeArchived: true,
      sort: "id"
    });
    expect(matches.map((task) => task.id)).toEqual(["READY"]);
  });

  it("round-trips instructions through JSON import and export", async () => {
    const store = createMemoryStore();
    const services = createServices(store, { machine: "test-machine", actor: "test-actor" });
    const now = "2026-05-02T00:00:00.000Z";

    const result = await services.imports.json("instructions.json", {
      tasks: [{ id: "A", title: "A", lifecycle: "open", priority: 2, createdAt: now, updatedAt: now, version: 1 }],
      instructions: [{
        id: "BACKEND-NOTE",
        name: "Backend note",
        query: "id = A",
        body: "Remember the checklist.",
        enabled: true,
        createdAt: now,
        updatedAt: now,
        archivedAt: null
      }]
    });

    expect(result.instructionsCreated).toBe(1);
    const exported = await services.exports.json();
    expect(exported.instructions?.map((instruction) => instruction.id)).toEqual(["BACKEND-NOTE"]);
    expect((await services.query.explain("A")).instructions[0]?.instruction.body).toBe("Remember the checklist.");
  });

  it("uses the matcher language for queries, saved views, queue feeds, and context export", async () => {
    const store = createMemoryStore();
    const services = createServices(store, { machine: "test-machine", actor: "test-actor" });

    await services.tasks.add({ id: "API", title: "API work", priority: 1 });
    await services.tasks.add({ id: "WEB", title: "Web work", priority: 3 });
    await services.tasks.add({ id: "LATER", title: "Later work", priority: 4 });
    await services.dependencies.add("LATER", "API");
    await services.tags.add({ id: "BACKEND", name: "backend" });
    await services.tags.assign("API", ["BACKEND"]);

    await services.views.add({ name: "Backend", query: "tag = backend" });
    await services.feeds.add({ name: "High priority ready", query: "priority >= 3" });

    expect((await services.query.match("tag = backend", 10)).map((task) => task.id)).toEqual(["API"]);
    expect((await services.views.tasks("BACKEND", 10)).map((task) => task.id)).toEqual(["API"]);
    expect((await services.feeds.tasks("HIGH-PRIORITY-READY", 10)).map((task) => task.id)).toEqual(["WEB"]);

    const markdown = await services.exports.markdown({ where: "tag = backend", limit: 10 });
    expect(markdown).toContain("### `API` API work");
    expect(markdown).not.toContain("### `WEB` Web work");
  });

  it("matches lifecycle timestamps with presence, dates, and relative time", async () => {
    const store = createMemoryStore();
    const services = createServices(store, { machine: "test-machine", actor: "test-actor" });
    const now = "2026-05-10T10:00:00.000Z";

    await services.imports.json("time.json", {
      tasks: [
        {
          id: "TODAY",
          title: "Created today",
          lifecycle: "open",
          priority: 2,
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          finishedAt: null,
          archivedAt: null,
          version: 1
        },
        {
          id: "OLD",
          title: "Old started work",
          lifecycle: "started",
          priority: 2,
          createdAt: "2020-01-01T10:00:00.000Z",
          updatedAt: "2020-01-02T10:00:00.000Z",
          startedAt: "2020-01-01T11:00:00.000Z",
          finishedAt: null,
          archivedAt: null,
          version: 1
        }
      ],
      dependencies: [],
      tags: [],
      taskTags: [],
      tracks: [],
      assignments: []
    });

    expect((await services.query.match("created = 2026-05-10", 10, { includeFinished: true })).map((task) => task.id)).toEqual(["TODAY"]);
    expect((await services.query.match("started is empty", 10, { includeFinished: true })).map((task) => task.id)).toEqual(["TODAY"]);
    expect((await services.query.match("started is not empty", 10, { includeFinished: true })).map((task) => task.id)).toEqual(["OLD"]);
    expect((await services.query.match("updated < now - 1w", 10, { includeFinished: true })).map((task) => task.id)).toEqual(["OLD"]);
  });

  it("exports markdown as a complete readable graph report", async () => {
    const store = createMemoryStore();
    const services = createServices(store, { machine: "test-machine", actor: "test-actor" });

    await services.tasks.add({
      id: "ROOT",
      title: "Root task",
      description: "Root description body"
    });
    await services.tasks.add({
      id: "A",
      parentTaskId: "ROOT",
      title: "Dependency task",
      description: "Dependency details\nwith a second line"
    });
    await services.tasks.add({
      id: "B",
      parentTaskId: "ROOT",
      title: "Blocked task",
      description: "Blocked task description",
      sourceDoc: "docs/design.md",
      sourceSection: "Export"
    });
    await services.dependencies.add("B", "A");
    await services.tags.add({ id: "UI", name: "ui", color: "#22b889" });
    await services.tags.assign("B", ["UI"]);
    await services.tracks.add({ actor: "codex-a" });
    await services.tracks.assign("codex-a", "A");

    const markdown = await services.exports.markdown();

    expect(markdown).toContain("# Unblock Export");
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("### `B` Blocked task");
    expect(markdown).toContain("Blocked task description");
    expect(markdown).toContain("- Parent: ROOT Root task");
    expect(markdown).toContain("- Tags: ui");
    expect(markdown).toContain("- Source: docs/design.md - Export");
    expect(markdown).toContain("- Rollup: blocked by 2 unfinished descendants");
    expect(markdown).toContain("- Critical child path: `B` Blocked task [blocked, 1 unfinished deps]");
    expect(markdown).toContain("- Dependencies: `A` Dependency task [ready]");
    expect(markdown).toContain("- `B` Blocked task depends on `A` Dependency task");
    expect(markdown).toContain("### test-machine:codex-a");
    expect(markdown).toContain("- `A` Dependency task [ready]");
    expect(markdown).not.toContain("| Done |");
  });

  it("imports a full JSON graph in one service call", async () => {
    const store = createMemoryStore();
    const services = createServices(store, { machine: "test-machine", actor: "test-actor" });
    const now = "2026-05-02T00:00:00.000Z";

    const result = await services.imports.json("fixture.json", {
      tasks: [
        {
          id: "ROOT",
          parentTaskId: null,
          title: "Root",
          description: "",
          lifecycle: "open",
          priority: 2,
          size: null,
          sourceDoc: "docs/design.md",
          sourceSection: "Root",
          sourceAnchor: null,
          sourceLine: null,
          sourceText: null,
          completionBar: null,
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          finishedAt: null,
          archivedAt: null,
          version: 1
        },
        {
          id: "A",
          parentTaskId: "ROOT",
          title: "Dependency",
          description: "",
          lifecycle: "open",
          priority: 2,
          size: null,
          sourceDoc: "docs/design.md",
          sourceSection: "A",
          sourceAnchor: null,
          sourceLine: null,
          sourceText: null,
          completionBar: null,
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          finishedAt: null,
          archivedAt: null,
          version: 1
        },
        {
          id: "B",
          parentTaskId: "ROOT",
          title: "Blocked",
          description: "",
          lifecycle: "open",
          priority: 3,
          size: "M",
          sourceDoc: "docs/design.md",
          sourceSection: "B",
          sourceAnchor: null,
          sourceLine: null,
          sourceText: null,
          completionBar: null,
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          finishedAt: null,
          archivedAt: null,
          version: 1
        }
      ],
      dependencies: [{ taskId: "B", dependsOnTaskId: "A", createdAt: now }],
      tags: [{ id: "COMPILER", name: "compiler", color: "#00f", description: null, sortOrder: 0, createdAt: now, updatedAt: now, archivedAt: null }],
      taskTags: [{ taskId: "B", tagId: "COMPILER", createdAt: now }],
      tracks: [],
      assignments: []
    });

    expect(result.tasksCreated).toBe(3);
    expect(result.dependenciesAdded).toBe(1);
    expect(result.taskTagsAdded).toBe(1);

    const tasks = await services.query.list({ includeFinished: true });
    expect(tasks.find((task) => task.id === "B")?.blocked).toBe(true);
    expect(tasks.find((task) => task.id === "B")?.tags.map((tag) => tag.name)).toEqual(["compiler"]);
  });

  it("keeps task ids, metadata, and activity scoped by project", async () => {
    const store = createMemoryStore();
    const globalServices = createServices(store, { machine: "test-machine", actor: "test-actor" });

    await globalServices.projects.add({ id: "ALPHA", name: "Alpha" });
    await globalServices.projects.add({ id: "BETA", name: "Beta" });

    const alpha = createServices(store, { projectId: "ALPHA", machine: "test-machine", actor: "test-actor" });
    const beta = createServices(store, { projectId: "BETA", machine: "test-machine", actor: "test-actor" });

    await alpha.tasks.add({ id: "TASK-1", title: "Alpha task" });
    await beta.tasks.add({ id: "TASK-1", title: "Beta task" });
    await alpha.tags.add({ id: "UI", name: "frontend" });
    await alpha.tags.assign("TASK-1", ["UI"]);

    expect((await alpha.query.list({ includeFinished: true })).map((task) => task.title)).toEqual(["Alpha task"]);
    expect((await beta.query.list({ includeFinished: true })).map((task) => task.title)).toEqual(["Beta task"]);
    expect((await beta.tags.list()).map((tag) => tag.id)).toEqual([]);
    expect((await alpha.activity.list()).map((entry) => entry.projectId)).toEqual(["ALPHA", "ALPHA", "ALPHA"]);
    expect((await beta.activity.list()).map((entry) => entry.projectId)).toEqual(["BETA"]);
  });

  it("does not allow dependency wiring across project namespaces", async () => {
    const store = createMemoryStore();
    const globalServices = createServices(store, { machine: "test-machine", actor: "test-actor" });

    await globalServices.projects.add({ id: "ALPHA" });
    await globalServices.projects.add({ id: "BETA" });

    const alpha = createServices(store, { projectId: "ALPHA", machine: "test-machine", actor: "test-actor" });
    const beta = createServices(store, { projectId: "BETA", machine: "test-machine", actor: "test-actor" });

    await alpha.tasks.add({ id: "DEP", title: "Alpha dependency" });
    await beta.tasks.add({ id: "WORK", title: "Beta work" });

    await expect(beta.dependencies.add("WORK", "DEP")).rejects.toBeInstanceOf(UnblockError);
    await expect(alpha.dependencies.add("WORK", "DEP")).rejects.toBeInstanceOf(UnblockError);
  });

  it("archives and restores projects without affecting other projects", async () => {
    const store = createMemoryStore();
    const services = createServices(store, { machine: "test-machine", actor: "test-actor" });

    await services.projects.add({ id: "ALPHA", name: "Alpha" });
    await services.projects.add({ id: "BETA", name: "Beta" });
    await services.projects.archive("ALPHA");

    let projects = await services.projects.list();
    expect(projects.find((project) => project.id === "ALPHA")?.archivedAt).toEqual(expect.any(String));
    expect(projects.find((project) => project.id === "BETA")?.archivedAt).toBeNull();

    await services.projects.restore("ALPHA");
    projects = await services.projects.list();
    expect(projects.find((project) => project.id === "ALPHA")?.archivedAt).toBeNull();
  });
});
