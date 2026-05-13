import { describe, expect, it } from "vitest";
import { lowerMatcherQueryToPrismFragment, type MatcherFragmentLowering } from "./matcher-fragment.js";
import {
  createPrismStore,
  type MatcherFragmentCompiler,
  type PrismRuntimeClient,
  type PrismSemanticOperation,
  type PrismTagAssignment,
  type RuntimeQueryFragmentArtifact,
  type RuntimeQueryFragmentRecord,
  type RuntimeQueryFragmentUseRecord,
} from "./store.js";

class RecordingClient implements PrismRuntimeClient {
  readonly batches: Array<{
    projectId: string;
    shardId: string;
    appId: string;
    actorId: string;
    idempotencyKey: string;
    operations: PrismSemanticOperation[];
  }> = [];
  surfaces = new Map<string, Record<string, unknown>[]>();
  tags = new Map<string, PrismTagAssignment[]>();
  fragments: RuntimeQueryFragmentRecord[] = [];
  fragmentUses: RuntimeQueryFragmentUseRecord[] = [];

  async submitSemanticCommit(batch: {
    projectId: string;
    shardId: string;
    appId: string;
    actorId: string;
    idempotencyKey: string;
    operations: PrismSemanticOperation[];
  }): Promise<void> {
    this.batches.push(batch);
  }

  async readMaterializedSurface<T extends Record<string, unknown>>(input: { surfaceId: string }): Promise<T[]> {
    return (this.surfaces.get(input.surfaceId) ?? []) as T[];
  }

  async query<T extends Record<string, unknown>>(input: { surfaceId: string }): Promise<T[]> {
    return (this.surfaces.get(input.surfaceId) ?? []) as T[];
  }

  async readSubjectTags(input: { subjectRef: string; tagId?: string }): Promise<PrismTagAssignment[]> {
    return (this.tags.get(input.subjectRef) ?? []).filter((tag) => !input.tagId || tag.tagId === input.tagId);
  }

  async findSubjectsByTag(input: { tagId: string; valueKey?: string }): Promise<PrismTagAssignment[]> {
    return [...this.tags.values()].flat().filter((tag) =>
      tag.tagId === input.tagId && (!input.valueKey || tag.valueKey === input.valueKey)
    );
  }

  async storeRuntimeQueryFragment(input: {
    projectId: string;
    artifact: RuntimeQueryFragmentArtifact;
  }): Promise<RuntimeQueryFragmentRecord> {
    const record: RuntimeQueryFragmentRecord = {
      projectId: input.projectId,
      appId: input.artifact.app_id,
      fragmentId: input.artifact.fragment_id,
      fragmentHash: input.artifact.fragment_hash,
      baseManifestHash: input.artifact.base_manifest_hash,
      state: input.artifact.state,
      record: input.artifact,
    };
    this.fragments.push(record);
    return record;
  }

  async upsertRuntimeQueryFragmentUse(input: {
    projectId: string;
    appId: string;
    fragmentId: string;
    consumerKind: string;
    consumerId: string;
    fragmentHash?: string;
    enabled?: boolean;
  }): Promise<RuntimeQueryFragmentUseRecord> {
    const record: RuntimeQueryFragmentUseRecord = {
      projectId: input.projectId,
      appId: input.appId,
      fragmentId: input.fragmentId,
      consumerKind: input.consumerKind,
      consumerId: input.consumerId,
      fragmentHash: input.fragmentHash ?? "",
      enabled: input.enabled ?? true,
      record: {},
    };
    this.fragmentUses.push(record);
    return record;
  }
}

class RecordingCompiler implements MatcherFragmentCompiler {
  readonly compiled: MatcherFragmentLowering[] = [];

  async compile(fragment: MatcherFragmentLowering): Promise<RuntimeQueryFragmentArtifact> {
    this.compiled.push(fragment);
    return {
      artifact_version: 1,
      project_id: "prism",
      app_id: "unblock",
      fragment_id: fragment.fragmentId,
      fragment_hash: `fragment:${fragment.sourceHash}`,
      base_manifest_hash: "base",
      purpose: "unblock.matcher",
      state: "admitted",
      supported_modes: ["projected_run", "materialize"],
    };
  }
}

describe("PrismStore", () => {
  it("emits Prism object and hierarchy mutations for tasks", async () => {
    const client = new RecordingClient();
    const store = createPrismStore({ client, projectId: "test-project", shardId: "P", actorId: "test" });

    await store.tasks.create(task({ id: "ROOT", parentTaskId: null }));
    await store.tasks.create(task({ id: "CHILD", parentTaskId: "ROOT" }));

    expect(client.batches.flatMap((batch) => batch.operations)).toEqual([
      expect.objectContaining({ family: "object", operation: { Create: expect.objectContaining({ object_kind: "Task", object_id: "ROOT" }) } }),
      expect.objectContaining({ family: "object", operation: { Create: expect.objectContaining({ object_kind: "Task", object_id: "CHILD" }) } }),
      expect.objectContaining({
        family: "relation",
        operation: {
          Link: expect.objectContaining({
            relation_kind: "TaskContainsTask",
            from_ref: "object:Task:ROOT",
            to_ref: "object:Task:CHILD",
          }),
        },
      }),
    ]);
  });

  it("emits dependency and label tag mutations", async () => {
    const client = new RecordingClient();
    const store = createPrismStore({ client, offline: false });
    const now = new Date("2026-05-13T00:00:00.000Z").toISOString();

    await store.tags.create({
      projectId: "P",
      id: "BACKEND",
      name: "backend",
      color: "#00f",
      description: null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    await store.tags.addTaskTag({ projectId: "P", taskId: "API", tagId: "BACKEND", createdAt: now });
    await store.dependencies.add({ projectId: "P", taskId: "API", dependsOnTaskId: "SCHEMA", createdAt: now });

    expect(client.batches.flatMap((batch) => batch.operations)).toEqual([
      expect.objectContaining({
        family: "tag",
        operation: { Set: expect.objectContaining({ subject_ref: "object:Project:P", tag_id: "project.label_definition", value_key: "BACKEND" }) },
      }),
      expect.objectContaining({
        family: "tag",
        operation: { Set: expect.objectContaining({ subject_ref: "object:Task:API", tag_id: "task.label", value_key: "BACKEND" }) },
      }),
      expect.objectContaining({
        family: "relation",
        operation: {
          Link: expect.objectContaining({
            relation_kind: "TaskDependsOnTask",
            from_ref: "object:Task:API",
            to_ref: "object:Task:SCHEMA",
          }),
        },
      }),
    ]);
  });

  it("buffers repository mutations into one transaction batch", async () => {
    const client = new RecordingClient();
    const store = createPrismStore({ client });

    await store.transaction(async (repos) => {
      await repos.tasks.create(task({ id: "A", parentTaskId: null }));
      await repos.tasks.create(task({ id: "B", parentTaskId: "A" }));
    });

    expect(client.batches).toHaveLength(1);
    expect(client.batches[0]?.operations).toHaveLength(3);
  });

  it("lowers matcher queries to Prism fragment source and executes the fragment by id", async () => {
    const fragment = lowerMatcherQueryToPrismFragment("tag = backend and depends on API depth <= 2");
    expect(fragment.source).toContain(".from(taskMatcherReadModel)");
    expect(fragment.source).toContain(".leftJoin(taskLabelRows");
    expect(fragment.source).toContain(".leftJoin(taskDependencyClosure");

    const client = new RecordingClient();
    client.surfaces.set(fragment.fragmentId, [{ project_id: "P", task_id: "WORK" }]);
    const compiler = new RecordingCompiler();
    const store = createPrismStore({ client, fragmentCompiler: compiler });

    await expect(store.matcher.matchTaskIds("P", "tag = backend and depends on API depth <= 2")).resolves.toEqual(["WORK"]);
    expect(compiler.compiled).toHaveLength(1);
    expect(client.fragments).toHaveLength(1);
    expect(client.fragments[0]?.fragmentId).toBe(fragment.fragmentId);
  });

  it("admits selector fragments and records fragment uses before saving instructions", async () => {
    const client = new RecordingClient();
    const compiler = new RecordingCompiler();
    const store = createPrismStore({ client, fragmentCompiler: compiler });
    const now = new Date("2026-05-13T00:00:00.000Z").toISOString();

    await store.instructions.create({
      projectId: "P",
      id: "I",
      name: "Backend work",
      query: "tag = backend",
      body: "Do the backend-specific instructions.",
      enabled: true,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });

    expect(client.fragments).toHaveLength(1);
    expect(client.fragmentUses).toEqual([
      expect.objectContaining({
        consumerKind: "unblock.instruction",
        consumerId: "I",
        enabled: true,
      }),
    ]);
    expect(client.batches[0]?.operations[0]).toEqual(expect.objectContaining({
      family: "object",
      operation: {
        Create: expect.objectContaining({
          object_kind: "Instruction",
          object_id: "I",
          fields: expect.objectContaining({
            selector_fragment_id: client.fragments[0]?.fragmentId,
            selector_fragment_hash: client.fragments[0]?.fragmentHash,
          }),
        }),
      },
    }));
  });
});

function task(input: { id: string; parentTaskId: string | null }) {
  const now = new Date("2026-05-13T00:00:00.000Z").toISOString();
  return {
    projectId: "P",
    id: input.id,
    parentTaskId: input.parentTaskId,
    title: input.id,
    description: "",
    lifecycle: "open" as const,
    priority: 2 as const,
    size: null,
    sourceDoc: null,
    sourceSection: null,
    sourceAnchor: null,
    sourceLine: null,
    sourceText: null,
    completionBar: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    archivedAt: null,
    version: 1,
  };
}
