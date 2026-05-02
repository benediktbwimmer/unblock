import { describe, expect, it } from "vitest";
import { createMemoryStore, createServices, NotJiraError } from "./index.js";

describe("not-jira core services", () => {
  it("keeps readiness dependency-first while computing hierarchy progress", async () => {
    const store = createMemoryStore();
    const services = createServices(store);

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
    expect(parent?.subtreeProgress).toBe(33);
    expect(parent?.finishedLeafDescendantsCount).toBe(1);
    expect(parent?.leafDescendantsCount).toBe(3);
    expect(capture?.computedStatus).toBe("ready");
  });

  it("sorts ready work by downstream unblock count before priority by default", async () => {
    const store = createMemoryStore();
    const services = createServices(store);

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

  it("rejects parent cycles", async () => {
    const store = createMemoryStore();
    const services = createServices(store);

    await services.tasks.add({ id: "A", title: "A" });
    await services.tasks.add({ id: "B", parentTaskId: "A", title: "B" });

    await expect(services.tasks.edit("A", { parentTaskId: "B" })).rejects.toBeInstanceOf(NotJiraError);
  });

  it("rejects dependencies on descendants to keep hierarchy and readiness clear", async () => {
    const store = createMemoryStore();
    const services = createServices(store);

    await services.tasks.add({ id: "A", title: "A" });
    await services.tasks.add({ id: "B", parentTaskId: "A", title: "B" });

    await expect(services.dependencies.add("A", "B")).rejects.toBeInstanceOf(NotJiraError);
  });

  it("blocks assignment when dependencies are unfinished", async () => {
    const store = createMemoryStore();
    const services = createServices(store);

    await services.tasks.add({ id: "A", title: "Dependency" });
    await services.tasks.add({ id: "B", title: "Blocked task" });
    await services.dependencies.add("B", "A");
    await services.tracks.add({ actor: "codex-a" });

    await expect(services.tracks.assign("codex-a", "B")).rejects.toBeInstanceOf(NotJiraError);
    await services.tasks.finish("A");
    await expect(services.tracks.assign("codex-a", "B")).resolves.toMatchObject({ taskId: "B" });
  });

  it("imports a full JSON graph in one service call", async () => {
    const store = createMemoryStore();
    const services = createServices(store);
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
});
