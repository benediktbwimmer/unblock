import { execFile } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { credentials, loadPackageDefinition, type ChannelCredentials, type Client, type ServiceError } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import {
  sqliteMigrations,
  type Activity,
  type ActivityRepository,
  type AppStore,
  type Comment,
  type CommentRepository,
  type Dependency,
  type DependencyRepository,
  type Instruction,
  type InstructionRepository,
  type Migration,
  type MigrationRepository,
  type MatcherQueryRepository,
  type Project,
  type ProjectRepository,
  type QueueFeed,
  type QueueFeedRepository,
  type RepositorySet,
  type SavedView,
  type SavedViewRepository,
  type Tag,
  type TagRepository,
  type Task,
  type TaskRepository,
  type TaskTag,
  type Track,
  type TrackAssignment,
  type TrackRepository,
} from "@unblock/core";
import { lowerMatcherQueryToPrismFragment, type MatcherFragmentLowering, type MatcherFragmentLoweringOptions } from "./matcher-fragment.js";

export interface PrismStoreOptions {
  endpoint?: string;
  projectId?: string;
  shardId?: string;
  actorId?: string;
  client?: PrismRuntimeClient;
  protoPath?: string;
  offline?: boolean;
  fragmentCompiler?: MatcherFragmentCompiler;
  matcherFragmentLoweringOptions?: MatcherFragmentLoweringOptions;
}

export interface PrismRuntimeClient {
  submitSemanticCommit(input: {
    projectId: string;
    shardId: string;
    appId: string;
    actorId: string;
    idempotencyKey: string;
    operations: PrismSemanticOperation[];
  }): Promise<void>;
  readMaterializedSurface<T extends Record<string, unknown>>(input: {
    projectId: string;
    shardId: string;
    appId: string;
    surfaceId: string;
    replacementScope?: string;
    limit?: number;
    offset?: number;
  }): Promise<T[]>;
  query<T extends Record<string, unknown>>(input: {
    projectId: string;
    shardId: string;
    appId: string;
    surfaceId: string;
    input?: Record<string, unknown>;
    limit?: number;
    offset?: number;
  }): Promise<T[]>;
  readSubjectTags(input: {
    projectId: string;
    shardId: string;
    subjectRef: string;
    tagId?: string;
  }): Promise<PrismTagAssignment[]>;
  findSubjectsByTag(input: {
    projectId: string;
    shardId: string;
    tagId: string;
    valueKey?: string;
    limit?: number;
    offset?: number;
  }): Promise<PrismTagAssignment[]>;
  storeRuntimeQueryFragment(input: {
    projectId: string;
    artifact: RuntimeQueryFragmentArtifact;
    owner?: string;
    sourceKind?: string;
    sourceHash?: string;
    budget?: Record<string, unknown>;
  }): Promise<RuntimeQueryFragmentRecord>;
  upsertRuntimeQueryFragmentUse(input: {
    projectId: string;
    appId: string;
    fragmentId: string;
    consumerKind: string;
    consumerId: string;
    fragmentHash?: string;
    materializationTarget?: Record<string, unknown>;
    replacementScope?: unknown;
    enabled?: boolean;
  }): Promise<RuntimeQueryFragmentUseRecord>;
  close?(): void;
}

export interface MatcherFragmentCompiler {
  compile(fragment: MatcherFragmentLowering): Promise<RuntimeQueryFragmentArtifact>;
}

export interface RuntimeQueryFragmentArtifact extends Record<string, unknown> {
  artifact_version: number;
  project_id: string;
  app_id: string;
  fragment_id: string;
  fragment_hash: string;
  base_manifest_hash: string;
  purpose: string;
  state: "admitted" | "rejected" | string;
  supported_modes: string[];
}

export interface RuntimeQueryFragmentRecord {
  projectId: string;
  appId: string;
  fragmentId: string;
  fragmentHash: string;
  baseManifestHash: string;
  state: string;
  record: Record<string, unknown>;
}

export interface RuntimeQueryFragmentUseRecord {
  projectId: string;
  appId: string;
  fragmentId: string;
  consumerKind: string;
  consumerId: string;
  fragmentHash: string;
  enabled: boolean;
  record: Record<string, unknown>;
}

export interface PrismTagAssignment {
  subjectRef: string;
  tagId: string;
  valueKey: string;
  value: unknown;
  origin: string;
}

export type PrismMutation =
  | {
    kind: "object.create" | "object.update";
    objectKind: string;
    objectId: string;
    changedFields?: string[];
    fields: Record<string, unknown>;
  }
  | { kind: "object.delete"; objectKind: string; objectId: string }
  | {
    kind: "relation.link";
    relationKind: string;
    relationId: string;
    fromRef: string;
    toRef: string;
    fields: Record<string, unknown>;
  }
  | { kind: "relation.unlink"; relationKind: string; relationId: string }
  | {
    kind: "tag.set";
    subjectRef: string;
    tagId: string;
    valueKey?: string;
    value: unknown;
    origin?: string;
  }
  | { kind: "tag.clear"; subjectRef: string; tagId: string; valueKey?: string };

export type PrismSemanticOperation =
  | { family: "object"; operation: { Create: { object_kind: string; object_id: string; fields: Record<string, unknown> } } }
  | { family: "object"; operation: { Update: { object_kind: string; object_id: string; changed_fields: string[]; fields: Record<string, unknown> } } }
  | { family: "object"; operation: { Delete: { object_kind: string; object_id: string } } }
  | { family: "relation"; operation: { Link: { relation_kind: string; relation_id: string; from_ref: string; to_ref: string; fields: Record<string, unknown> } } }
  | { family: "relation"; operation: { Unlink: { relation_kind: string; relation_id: string } } }
  | { family: "tag"; operation: { Set: { subject_ref: string; tag_id: string; value_key: string | null; value: unknown; origin: string | null } } }
  | { family: "tag"; operation: { Clear: { subject_ref: string; tag_id: string; value_key: string | null } } };

export function createPrismStore(options: PrismStoreOptions = {}): PrismStore {
  if (options.offline && !options.client) {
    throw new Error("PrismStore no longer has an offline compatibility cache; provide a PrismRuntimeClient or use the sqlite backend.");
  }
  const grpcOptions: { endpoint?: string; protoPath?: string } = {};
  if (options.endpoint !== undefined) grpcOptions.endpoint = options.endpoint;
  if (options.protoPath !== undefined) grpcOptions.protoPath = options.protoPath;
  const client = options.client ?? new PrismGrpcRuntimeClient(grpcOptions);
  return new PrismStore({
    client,
    projectId: options.projectId ?? "prism",
    shardId: options.shardId ?? "default",
    actorId: options.actorId ?? "unblock-api",
    fragmentCompiler: options.fragmentCompiler ?? new PrismCliMatcherFragmentCompiler(),
    matcherFragmentLoweringOptions: options.matcherFragmentLoweringOptions ?? defaultMatcherFragmentLoweringOptions(),
  });
}

export class PrismStore implements AppStore {
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  readonly dependencies: DependencyRepository;
  readonly comments: CommentRepository;
  readonly tags: TagRepository;
  readonly tracks: TrackRepository;
  readonly instructions: InstructionRepository;
  readonly views: SavedViewRepository;
  readonly feeds: QueueFeedRepository;
  readonly activity: ActivityRepository;
  readonly migrations: MigrationRepository;
  readonly matcher: MatcherQueryRepository;

  private readonly transactionOperations = new AsyncLocalStorage<PrismMutation[]>();
  private readonly matcherFragments = new Map<string, Promise<AdmittedMatcherFragment>>();

  constructor(private readonly options: {
    client: PrismRuntimeClient;
    projectId: string;
    shardId: string;
    actorId: string;
    fragmentCompiler: MatcherFragmentCompiler;
    matcherFragmentLoweringOptions: MatcherFragmentLoweringOptions;
  }) {
    this.projects = new PrismProjectRepository(this);
    this.tasks = new PrismTaskRepository(this);
    this.dependencies = new PrismDependencyRepository(this);
    this.comments = new PrismCommentRepository(this);
    this.tags = new PrismTagRepository(this);
    this.tracks = new PrismTrackRepository(this);
    this.instructions = new PrismInstructionRepository(this);
    this.views = new PrismSavedViewRepository(this);
    this.feeds = new PrismQueueFeedRepository(this);
    this.activity = new PrismActivityRepository(this);
    this.migrations = new PrismMigrationRepository();
    this.matcher = new PrismMatcherQueryRepository(this);
  }

  async transaction<T>(fn: (repos: RepositorySet) => Promise<T>): Promise<T> {
    if (this.transactionOperations.getStore()) return await fn(this);
    const operations: PrismMutation[] = [];
    return await this.transactionOperations.run(operations, async () => {
      const result = await fn(this);
      await this.flush(operations, `tx:${hashJson(operations)}`);
      return result;
    });
  }

  async record(operations: PrismMutation[], idempotencyKey = `op:${hashJson(operations)}`): Promise<void> {
    if (operations.length === 0) return;
    const pending = this.transactionOperations.getStore();
    if (pending) {
      pending.push(...operations);
      return;
    }
    await this.flush(operations, idempotencyKey);
  }

  async rows<T extends Record<string, unknown>>(surfaceId: string): Promise<T[]> {
    return await this.query<T>(surfaceId);
  }

  async query<T extends Record<string, unknown>>(surfaceId: string, input: Record<string, unknown> = {}): Promise<T[]> {
    return await this.options.client.query<T>({
      projectId: this.options.projectId,
      shardId: this.options.shardId,
      appId: "unblock",
      surfaceId,
      input,
      limit: 10_000,
      offset: 0,
    });
  }

  async ensureMatcherFragment(query: string): Promise<AdmittedMatcherFragment> {
    const fragment = lowerMatcherQueryToPrismFragment(query, this.options.matcherFragmentLoweringOptions);
    const cacheKey = `${fragment.fragmentId}:${fragment.sourceHash}`;
    let pending = this.matcherFragments.get(cacheKey);
    if (!pending) {
      pending = this.compileAndStoreMatcherFragment(fragment);
      this.matcherFragments.set(cacheKey, pending);
    }
    return await pending;
  }

  async ensureMatcherFragmentUse(input: {
    query: string;
    consumerKind: string;
    consumerId: string;
    enabled?: boolean;
    materializationTarget?: Record<string, unknown>;
    replacementScope?: unknown;
  }): Promise<AdmittedMatcherFragment> {
    const admitted = await this.ensureMatcherFragment(input.query);
    const request: {
      projectId: string;
      appId: string;
      fragmentId: string;
      consumerKind: string;
      consumerId: string;
      fragmentHash: string;
      materializationTarget?: Record<string, unknown>;
      replacementScope?: unknown;
      enabled: boolean;
    } = {
      projectId: this.options.projectId,
      appId: "unblock",
      fragmentId: admitted.fragmentId,
      consumerKind: input.consumerKind,
      consumerId: input.consumerId,
      fragmentHash: admitted.fragmentHash,
      enabled: input.enabled ?? true,
    };
    if (input.materializationTarget !== undefined) request.materializationTarget = input.materializationTarget;
    if (input.replacementScope !== undefined) request.replacementScope = input.replacementScope;
    await this.options.client.upsertRuntimeQueryFragmentUse(request);
    return admitted;
  }

  projectId(): string {
    return this.options.projectId;
  }

  async readTags(subjectRef: string, tagId?: string): Promise<PrismTagAssignment[]> {
    const input: { projectId: string; shardId: string; subjectRef: string; tagId?: string } = {
      projectId: this.options.projectId,
      shardId: this.options.shardId,
      subjectRef,
    };
    if (tagId !== undefined) input.tagId = tagId;
    return await this.options.client.readSubjectTags(input);
  }

  async findTags(tagId: string, valueKey?: string): Promise<PrismTagAssignment[]> {
    const input: { projectId: string; shardId: string; tagId: string; valueKey?: string; limit?: number; offset?: number } = {
      projectId: this.options.projectId,
      shardId: this.options.shardId,
      tagId,
      limit: 10_000,
      offset: 0,
    };
    if (valueKey !== undefined) input.valueKey = valueKey;
    return await this.options.client.findSubjectsByTag(input);
  }

  close(): void {
    this.options.client.close?.();
  }

  private async flush(operations: PrismMutation[], idempotencyKey: string): Promise<void> {
    if (operations.length === 0) return;
    await this.options.client.submitSemanticCommit({
      projectId: this.options.projectId,
      shardId: this.options.shardId,
      appId: "unblock",
      actorId: this.options.actorId,
      idempotencyKey,
      operations: operations.map(toSemanticOperation),
    });
  }

  private async compileAndStoreMatcherFragment(fragment: MatcherFragmentLowering): Promise<AdmittedMatcherFragment> {
    const artifact = await this.options.fragmentCompiler.compile(fragment);
    if (artifact.project_id !== this.options.projectId) {
      throw new Error(`Prism matcher fragment project mismatch: artifact=${artifact.project_id} store=${this.options.projectId}`);
    }
    if (artifact.fragment_id !== fragment.fragmentId) {
      throw new Error(`Prism matcher fragment id mismatch: artifact=${artifact.fragment_id} lowered=${fragment.fragmentId}`);
    }
    const record = await this.options.client.storeRuntimeQueryFragment({
      projectId: this.options.projectId,
      artifact,
      owner: this.options.actorId,
      sourceKind: "unblock.matcher",
      sourceHash: fragment.sourceHash,
    });
    const state = record.state || artifact.state;
    if (state !== "admitted") {
      throw new Error(`Prism rejected matcher fragment ${fragment.fragmentId}: state=${state}`);
    }
    return {
      lowering: fragment,
      artifact,
      fragmentId: record.fragmentId || artifact.fragment_id,
      fragmentHash: record.fragmentHash || artifact.fragment_hash,
      selectorHash: fragment.selectorHash,
      sourceHash: fragment.sourceHash,
    };
  }
}

export class PrismGrpcRuntimeClient implements PrismRuntimeClient {
  private readonly client: RuntimeServiceClient;

  constructor(options: { endpoint?: string; protoPath?: string } = {}) {
    const endpoint = grpcEndpoint(options.endpoint ?? process.env.UNBLOCK_PRISM_ENDPOINT ?? "http://127.0.0.1:50051");
    const protoPath = options.protoPath ?? process.env.PRISM_RUNTIME_PROTO ?? defaultRuntimeProtoPath();
    const definition = loadSync(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const loaded = loadPackageDefinition(definition) as unknown as RuntimeProtoPackage;
    this.client = new loaded.prism.runtime.v1.RuntimeService(endpoint, credentials.createInsecure()) as RuntimeServiceClient;
  }

  async submitSemanticCommit(input: {
    projectId: string;
    shardId: string;
    appId: string;
    actorId: string;
    idempotencyKey: string;
    operations: PrismSemanticOperation[];
  }): Promise<void> {
    const response = await unary<SubmitSemanticCommitResponse>(this.client, "SubmitSemanticCommit", {
      project_id: input.projectId,
      shard_id: input.shardId,
      app_id: input.appId,
      actor_id: input.actorId,
      idempotency_key: input.idempotencyKey,
      operations_json: JSON.stringify(input.operations),
    });
    if (response.outcome !== "committed" || !response.has_commit_id) {
      throw new Error(`Prism semantic commit was not committed: ${JSON.stringify(response)}`);
    }
  }

  async readMaterializedSurface<T extends Record<string, unknown>>(input: {
    projectId: string;
    shardId: string;
    appId: string;
    surfaceId: string;
    replacementScope?: string;
    limit?: number;
    offset?: number;
  }): Promise<T[]> {
    const response = await unary<MaterializedSurfaceResponse>(this.client, "ReadMaterializedSurface", {
      project_id: input.projectId,
      shard_id: input.shardId,
      app_id: input.appId,
      surface_id: input.surfaceId,
      replacement_scope: input.replacementScope ?? "",
      page: page(input.limit, input.offset),
    });
    return response.outputs.map((output) => JSON.parse(output.output_json) as T);
  }

  async query<T extends Record<string, unknown>>(input: {
    projectId: string;
    shardId: string;
    appId: string;
    surfaceId: string;
    input?: Record<string, unknown>;
    limit?: number;
    offset?: number;
  }): Promise<T[]> {
    const response = await unary<QueryResponse>(this.client, "Query", {
      project_id: input.projectId,
      shard_id: input.shardId,
      app_id: input.appId,
      surface_id: input.surfaceId,
      input_json: JSON.stringify(input.input ?? {}),
      page: page(input.limit, input.offset),
      consistency: "strong",
    });
    return response.records_json.map((record) => JSON.parse(record) as T);
  }

  async readSubjectTags(input: {
    projectId: string;
    shardId: string;
    subjectRef: string;
    tagId?: string;
  }): Promise<PrismTagAssignment[]> {
    const response = await unary<SubjectTagsResponse>(this.client, "ReadSubjectTags", {
      project_id: input.projectId,
      shard_id: input.shardId,
      subject_ref: input.subjectRef,
      tag_id: input.tagId ?? "",
    });
    return response.assignments.map(tagAssignmentFromProto);
  }

  async findSubjectsByTag(input: {
    projectId: string;
    shardId: string;
    tagId: string;
    valueKey?: string;
    limit?: number;
    offset?: number;
  }): Promise<PrismTagAssignment[]> {
    const response = await unary<TagSubjectsResponse>(this.client, "FindSubjectsByTag", {
      project_id: input.projectId,
      shard_id: input.shardId,
      tag_id: input.tagId,
      value_key: input.valueKey ?? "",
      page: page(input.limit, input.offset),
    });
    return response.assignments.map(tagAssignmentFromProto);
  }

  async storeRuntimeQueryFragment(input: {
    projectId: string;
    artifact: RuntimeQueryFragmentArtifact;
    owner?: string;
    sourceKind?: string;
    sourceHash?: string;
    budget?: Record<string, unknown>;
  }): Promise<RuntimeQueryFragmentRecord> {
    const response = await unary<RuntimeQueryFragmentResponse>(this.client, "StoreRuntimeQueryFragment", {
      project_id: input.projectId,
      artifact_json: JSON.stringify(input.artifact),
      owner: input.owner ?? "",
      source_kind: input.sourceKind ?? "",
      source_hash: input.sourceHash ?? "",
      budget_json: input.budget ? JSON.stringify(input.budget) : "",
    });
    return runtimeQueryFragmentRecordFromProto(response);
  }

  async upsertRuntimeQueryFragmentUse(input: {
    projectId: string;
    appId: string;
    fragmentId: string;
    consumerKind: string;
    consumerId: string;
    fragmentHash?: string;
    materializationTarget?: Record<string, unknown>;
    replacementScope?: unknown;
    enabled?: boolean;
  }): Promise<RuntimeQueryFragmentUseRecord> {
    const response = await unary<RuntimeQueryFragmentUseResponse>(this.client, "UpsertRuntimeQueryFragmentUse", {
      project_id: input.projectId,
      app_id: input.appId,
      fragment_id: input.fragmentId,
      consumer_kind: input.consumerKind,
      consumer_id: input.consumerId,
      fragment_hash: input.fragmentHash ?? "",
      materialization_target_json: input.materializationTarget ? JSON.stringify(input.materializationTarget) : "",
      replacement_scope_json: input.replacementScope === undefined ? "" : JSON.stringify(input.replacementScope),
      enabled: input.enabled ?? true,
    });
    return runtimeQueryFragmentUseRecordFromProto(response);
  }

  close(): void {
    this.client.close();
  }
}

export class PrismCliMatcherFragmentCompiler implements MatcherFragmentCompiler {
  constructor(private readonly options: {
    prismCliPath?: string;
    baseArtifactDir?: string;
    purpose?: string;
    keepTemp?: boolean;
  } = {}) {}

  async compile(fragment: MatcherFragmentLowering): Promise<RuntimeQueryFragmentArtifact> {
    const root = await mkdtemp(join(tmpdir(), "unblock-prism-fragment-"));
    const src = join(root, "src");
    const artifactPath = join(root, "fragment.prism.json");
    try {
      await mkdir(src, { recursive: true });
      await writeFile(join(root, "prism.app.json"), `${JSON.stringify({ entrypoint: "src/app.ts" }, null, 2)}\n`);
      await writeFile(join(src, "app.ts"), fragment.source);
      await execFileChecked(this.prismCliPath(), [
        "query-fragment",
        "compile",
        "--base-artifact-dir",
        this.baseArtifactDir(),
        root,
        "--fragment-id",
        fragment.fragmentId,
        "--purpose",
        this.options.purpose ?? "unblock.matcher",
        "--out",
        artifactPath,
        "--json",
      ]);
      return JSON.parse(await readFile(artifactPath, "utf8")) as RuntimeQueryFragmentArtifact;
    } finally {
      if (!this.options.keepTemp) await rm(root, { recursive: true, force: true });
    }
  }

  private prismCliPath(): string {
    if (this.options.prismCliPath) return this.options.prismCliPath;
    if (process.env.UNBLOCK_PRISM_CLI) return process.env.UNBLOCK_PRISM_CLI;
    if (process.env.PRISM_CLI) return process.env.PRISM_CLI;
    const repoBinary = resolve(packageRoot(), "../../../prism-new2/target/debug/prism");
    return existsSync(repoBinary) ? repoBinary : "prism";
  }

  private baseArtifactDir(): string {
    return this.options.baseArtifactDir ?? process.env.UNBLOCK_PRISM_BASE_ARTIFACT_DIR ?? join(packageRoot(), "generated");
  }
}

class PrismProjectRepository implements ProjectRepository {
  constructor(private readonly store: PrismStore) {}

  async list(): Promise<Project[]> {
    return (await this.store.rows<ProjectRow>("projectRows"))
      .map(projectFromRow)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<Project | null> {
    return (await this.list()).find((project) => project.id === id) ?? null;
  }

  async create(project: Project): Promise<void> {
    await this.store.record([objectMutation("object.create", "Project", project.id, projectFields(project))]);
  }

  async update(project: Project): Promise<void> {
    await this.store.record([objectMutation("object.update", "Project", project.id, projectFields(project))]);
  }
}

class PrismTaskRepository implements TaskRepository {
  constructor(private readonly store: PrismStore) {}

  async list(projectId?: string): Promise<Task[]> {
    return (await tasksFromPrism(this.store))
      .filter((task) => !projectId || task.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async get(projectId: string, id: string): Promise<Task | null> {
    return (await this.list(projectId)).find((task) => task.id === id) ?? null;
  }

  async create(task: Task): Promise<void> {
    await this.store.record([
      objectMutation("object.create", "Task", task.id, taskFields(task)),
      ...parentLinkOperations(null, task),
    ]);
  }

  async update(task: Task): Promise<void> {
    const previous = await this.get(task.projectId, task.id);
    await this.store.record([
      objectMutation("object.update", "Task", task.id, taskFields(task)),
      ...parentLinkOperations(previous?.parentTaskId ?? null, task),
    ]);
  }

  async delete(_projectId: string, id: string): Promise<void> {
    await this.store.record([{ kind: "object.delete", objectKind: "Task", objectId: id }]);
  }
}

class PrismDependencyRepository implements DependencyRepository {
  constructor(private readonly store: PrismStore) {}

  async list(projectId?: string): Promise<Dependency[]> {
    return (await this.store.rows<DependencyRow>("taskDependencyRows"))
      .map(dependencyFromRow)
      .filter((dependency) => !projectId || dependency.projectId === projectId);
  }

  async listForTask(projectId: string, taskId: string): Promise<Dependency[]> {
    return (await this.list(projectId)).filter((dependency) => dependency.taskId === taskId);
  }

  async listDependents(projectId: string, dependsOnTaskId: string): Promise<Dependency[]> {
    return (await this.list(projectId)).filter((dependency) => dependency.dependsOnTaskId === dependsOnTaskId);
  }

  async add(dependency: Dependency): Promise<void> {
    await this.store.record([dependencyLink(dependency)]);
  }

  async remove(projectId: string, taskId: string, dependsOnTaskId: string): Promise<void> {
    await this.store.record([{
      kind: "relation.unlink",
      relationKind: "TaskDependsOnTask",
      relationId: dependencyRelationId(projectId, taskId, dependsOnTaskId),
    }]);
  }

  async replaceForTask(projectId: string, taskId: string, dependencies: Dependency[]): Promise<void> {
    const existing = await this.listForTask(projectId, taskId);
    await this.store.record([
      ...existing.map((dependency): PrismMutation => ({
        kind: "relation.unlink",
        relationKind: "TaskDependsOnTask",
        relationId: dependencyRelationId(projectId, dependency.taskId, dependency.dependsOnTaskId),
      })),
      ...dependencies.map(dependencyLink),
    ]);
  }
}

class PrismCommentRepository implements CommentRepository {
  constructor(private readonly store: PrismStore) {}

  async list(projectId?: string): Promise<Comment[]> {
    return (await this.store.rows<CommentRow>("commentRows"))
      .map(commentFromRow)
      .filter((comment) => !projectId || comment.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async listForTask(projectId: string, taskId: string): Promise<Comment[]> {
    return (await this.list(projectId)).filter((comment) => comment.taskId === taskId);
  }

  async get(projectId: string, id: string): Promise<Comment | null> {
    return (await this.list(projectId)).find((comment) => comment.id === id) ?? null;
  }

  async create(comment: Comment): Promise<void> {
    await this.store.record([objectMutation("object.create", "Comment", comment.id, commentFields(comment))]);
  }

  async update(comment: Comment): Promise<void> {
    await this.store.record([objectMutation("object.update", "Comment", comment.id, commentFields(comment))]);
  }
}

class PrismTagRepository implements TagRepository {
  constructor(private readonly store: PrismStore) {}

  async list(projectId?: string): Promise<Tag[]> {
    const projectIds = projectId ? [projectId] : (await this.store.projects.list()).map((project) => project.id);
    const tags = (await Promise.all(projectIds.map(async (id) => await this.projectTags(id)))).flat();
    return tags.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  async get(projectId: string, id: string): Promise<Tag | null> {
    return (await this.projectTags(projectId)).find((tag) => tag.id === id) ?? null;
  }

  async findByName(projectId: string, name: string): Promise<Tag | null> {
    return (await this.projectTags(projectId)).find((tag) => tag.name === name) ?? null;
  }

  async create(tag: Tag): Promise<void> {
    await this.store.record([projectLabelDefinitionSet(tag)]);
  }

  async update(tag: Tag): Promise<void> {
    await this.store.record([projectLabelDefinitionSet(tag)]);
  }

  async listTaskTags(projectId?: string): Promise<TaskTag[]> {
    const taskIds = projectId ? new Set((await this.store.tasks.list(projectId)).map((task) => task.id)) : null;
    const taskTags = (await this.store.findTags("task.label"))
      .map(taskTagFromAssignment)
      .filter((taskTag): taskTag is TaskTag => taskTag !== null);
    return taskTags.filter((taskTag) => !projectId || taskTag.projectId === projectId || Boolean(taskIds?.has(taskTag.taskId)));
  }

  async addTaskTag(taskTag: TaskTag): Promise<void> {
    const tag = await this.get(taskTag.projectId, taskTag.tagId);
    await this.store.record([taskLabelSet(taskTag, tag)]);
  }

  async removeTaskTag(_projectId: string, taskId: string, tagId: string): Promise<void> {
    await this.store.record([{
      kind: "tag.clear",
      subjectRef: ref("Task", taskId),
      tagId: "task.label",
      valueKey: tagId,
    }]);
  }

  private async projectTags(projectId: string): Promise<Tag[]> {
    return (await this.store.readTags(ref("Project", projectId), "project.label_definition"))
      .map((assignment) => tagFromAssignment(projectId, assignment))
      .filter((tag): tag is Tag => Boolean(tag));
  }
}

class PrismTrackRepository implements TrackRepository {
  constructor(private readonly store: PrismStore) {}

  async list(projectId?: string): Promise<Track[]> {
    return (await this.store.rows<TrackRow>("trackRows"))
      .map(trackFromRow)
      .filter((track) => !projectId || track.projectId === projectId)
      .sort((a, b) => a.machine.localeCompare(b.machine) || a.actor.localeCompare(b.actor));
  }

  async get(projectId: string, id: string): Promise<Track | null> {
    return (await this.list(projectId)).find((track) => track.id === id) ?? null;
  }

  async findByActor(projectId: string, machine: string, actor: string): Promise<Track | null> {
    return (await this.list(projectId)).find((track) => track.machine === machine && track.actor === actor) ?? null;
  }

  async create(track: Track): Promise<void> {
    await this.store.record([objectMutation("object.create", "Track", track.id, trackFields(track))]);
  }

  async update(track: Track): Promise<void> {
    await this.store.record([objectMutation("object.update", "Track", track.id, trackFields(track))]);
  }

  async listAssignments(projectId?: string): Promise<TrackAssignment[]> {
    return (await this.store.rows<AssignmentRow>("taskAssignmentRows"))
      .map(assignmentFromRow)
      .filter((assignment) => !projectId || assignment.projectId === projectId)
      .sort((a, b) => a.trackId.localeCompare(b.trackId) || a.position.localeCompare(b.position));
  }

  async assign(assignment: TrackAssignment): Promise<void> {
    await this.store.record([assignmentLink(assignment)]);
  }

  async unassign(projectId: string, trackId: string, taskId: string): Promise<void> {
    await this.store.record([{
      kind: "relation.unlink",
      relationKind: "TaskAssignedToTrack",
      relationId: assignmentRelationId(projectId, taskId, trackId),
    }]);
  }

  async updateAssignment(assignment: TrackAssignment): Promise<void> {
    await this.store.record([assignmentLink(assignment)]);
  }
}

class PrismInstructionRepository implements InstructionRepository {
  constructor(private readonly store: PrismStore) {}

  async list(projectId?: string): Promise<Instruction[]> {
    return (await this.store.rows<InstructionRow>("instructionRows"))
      .map(instructionFromRow)
      .filter((instruction) => !projectId || instruction.projectId === projectId)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async get(projectId: string, id: string): Promise<Instruction | null> {
    return (await this.list(projectId)).find((instruction) => instruction.id === id) ?? null;
  }

  async create(instruction: Instruction): Promise<void> {
    const fragment = await this.store.ensureMatcherFragmentUse({
      query: instruction.query,
      consumerKind: "unblock.instruction",
      consumerId: instruction.id,
      enabled: instruction.enabled && instruction.archivedAt === null,
      replacementScope: [instruction.projectId, instruction.id],
    });
    await this.store.record([objectMutation("object.create", "Instruction", instruction.id, instructionFields(instruction, fragment))]);
  }

  async update(instruction: Instruction): Promise<void> {
    const fragment = await this.store.ensureMatcherFragmentUse({
      query: instruction.query,
      consumerKind: "unblock.instruction",
      consumerId: instruction.id,
      enabled: instruction.enabled && instruction.archivedAt === null,
      replacementScope: [instruction.projectId, instruction.id],
    });
    await this.store.record([objectMutation("object.update", "Instruction", instruction.id, instructionFields(instruction, fragment))]);
  }
}

class PrismSavedViewRepository implements SavedViewRepository {
  constructor(private readonly store: PrismStore) {}

  async list(projectId?: string): Promise<SavedView[]> {
    return (await this.store.rows<SavedSelectorRow>("savedSelectorRows"))
      .filter((row) => row.kind === "view")
      .map(savedViewFromRow)
      .filter((view) => !projectId || view.projectId === projectId)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async get(projectId: string, id: string): Promise<SavedView | null> {
    return (await this.list(projectId)).find((view) => view.id === id) ?? null;
  }

  async create(view: SavedView): Promise<void> {
    const fragment = await this.store.ensureMatcherFragmentUse({
      query: view.query,
      consumerKind: "unblock.saved_view",
      consumerId: view.id,
      replacementScope: [view.projectId, "view", view.id],
    });
    await this.store.record([objectMutation("object.create", "SavedSelector", view.id, savedSelectorFields(view, "view", fragment))]);
  }

  async update(view: SavedView): Promise<void> {
    const fragment = await this.store.ensureMatcherFragmentUse({
      query: view.query,
      consumerKind: "unblock.saved_view",
      consumerId: view.id,
      enabled: view.archivedAt === null,
      replacementScope: [view.projectId, "view", view.id],
    });
    await this.store.record([objectMutation("object.update", "SavedSelector", view.id, savedSelectorFields(view, "view", fragment))]);
  }
}

class PrismQueueFeedRepository implements QueueFeedRepository {
  constructor(private readonly store: PrismStore) {}

  async list(projectId?: string): Promise<QueueFeed[]> {
    return (await this.store.rows<SavedSelectorRow>("savedSelectorRows"))
      .filter((row) => row.kind === "feed")
      .map(queueFeedFromRow)
      .filter((feed) => !projectId || feed.projectId === projectId)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async get(projectId: string, id: string): Promise<QueueFeed | null> {
    return (await this.list(projectId)).find((feed) => feed.id === id) ?? null;
  }

  async create(feed: QueueFeed): Promise<void> {
    const fragment = await this.store.ensureMatcherFragmentUse({
      query: feed.query,
      consumerKind: "unblock.queue_feed",
      consumerId: feed.id,
      replacementScope: [feed.projectId, "feed", feed.id],
    });
    await this.store.record([objectMutation("object.create", "SavedSelector", feed.id, savedSelectorFields(feed, "feed", fragment))]);
  }

  async update(feed: QueueFeed): Promise<void> {
    const fragment = await this.store.ensureMatcherFragmentUse({
      query: feed.query,
      consumerKind: "unblock.queue_feed",
      consumerId: feed.id,
      enabled: feed.archivedAt === null,
      replacementScope: [feed.projectId, "feed", feed.id],
    });
    await this.store.record([objectMutation("object.update", "SavedSelector", feed.id, savedSelectorFields(feed, "feed", fragment))]);
  }
}

class PrismActivityRepository implements ActivityRepository {
  constructor(private readonly store: PrismStore) {}

  async list(projectId?: string | null, limit = 100): Promise<Activity[]> {
    return (await this.store.rows<ActivityRow>("activityRows"))
      .map(activityFromRow)
      .filter((activity) => projectId === null || projectId === undefined || activity.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async append(activity: Activity): Promise<void> {
    await this.store.record([objectMutation("object.create", "ActivityEvent", activity.id, activityFields(activity))]);
  }
}

class PrismMatcherQueryRepository implements MatcherQueryRepository {
  constructor(private readonly store: PrismStore) {}

  async matchTaskIds(projectId: string, query: string): Promise<string[]> {
    const fragment = await this.store.ensureMatcherFragment(query);
    const rows = await this.store.query<{ task_id: string }>(fragment.fragmentId, fragment.lowering.input(new Date(), projectId));
    return [...new Set(rows.map((row) => row.task_id))].sort();
  }
}

class PrismMigrationRepository implements MigrationRepository {
  async list(): Promise<Migration[]> {
    return sqliteMigrations.map((migration) => ({
      id: migration.id,
      name: migration.name,
      appliedAt: "prism-native",
    }));
  }

  async markApplied(_migration: Migration): Promise<void> {}
}

function objectMutation(
  kind: "object.create" | "object.update",
  objectKind: string,
  objectId: string,
  fields: Record<string, unknown>,
): PrismMutation {
  return {
    kind,
    objectKind,
    objectId,
    fields,
    ...(kind === "object.update" ? { changedFields: Object.keys(fields) } : {}),
  };
}

function projectFields(project: Project): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
    archived_at: project.archivedAt,
  };
}

function taskFields(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    project_id: task.projectId,
    title: task.title,
    description: task.description,
    lifecycle: task.lifecycle,
    priority: task.priority,
    size: task.size,
    source_doc: task.sourceDoc,
    source_section: task.sourceSection,
    source_anchor: task.sourceAnchor,
    source_line: task.sourceLine,
    source_text: task.sourceText,
    completion_bar: task.completionBar,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    started_at: task.startedAt,
    finished_at: task.finishedAt,
    archived_at: task.archivedAt,
    version: task.version,
  };
}

function commentFields(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    project_id: comment.projectId,
    task_id: comment.taskId,
    machine: comment.machine,
    actor: comment.actor,
    body: comment.body,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    archived_at: comment.archivedAt,
  };
}

function trackFields(track: Track): Record<string, unknown> {
  return {
    id: track.id,
    project_id: track.projectId,
    machine: track.machine,
    actor: track.actor,
    name: track.name,
    created_at: track.createdAt,
    updated_at: track.updatedAt,
    archived_at: track.archivedAt,
  };
}

function instructionFields(instruction: Instruction, fragment: AdmittedMatcherFragment): Record<string, unknown> {
  return {
    id: instruction.id,
    project_id: instruction.projectId,
    name: instruction.name,
    selector_text: instruction.query,
    selector_hash: fragment.selectorHash,
    selector_fragment_id: fragment.fragmentId,
    selector_fragment_hash: fragment.fragmentHash,
    body: instruction.body,
    enabled: instruction.enabled,
    created_at: instruction.createdAt,
    updated_at: instruction.updatedAt,
    archived_at: instruction.archivedAt,
  };
}

function savedSelectorFields(selector: SavedView | QueueFeed, kind: "view" | "feed", fragment: AdmittedMatcherFragment): Record<string, unknown> {
  return {
    id: selector.id,
    project_id: selector.projectId,
    kind,
    name: selector.name,
    selector_text: selector.query,
    selector_hash: fragment.selectorHash,
    selector_fragment_id: fragment.fragmentId,
    selector_fragment_hash: fragment.fragmentHash,
    created_at: selector.createdAt,
    updated_at: selector.updatedAt,
    archived_at: selector.archivedAt,
  };
}

function activityFields(activity: Activity): Record<string, unknown> {
  return {
    id: activity.id,
    project_id: activity.projectId,
    type: activity.type,
    subject: activity.subjectType,
    subject_id: activity.subjectId,
    message: activity.message,
    data: activity.data,
    machine: activity.machine,
    actor: activity.actor,
    created_at: activity.createdAt,
  };
}

function dependencyLink(dependency: Dependency): PrismMutation {
  return {
    kind: "relation.link",
    relationKind: "TaskDependsOnTask",
    relationId: dependencyRelationId(dependency.projectId, dependency.taskId, dependency.dependsOnTaskId),
    fromRef: ref("Task", dependency.taskId),
    toRef: ref("Task", dependency.dependsOnTaskId),
    fields: {
      project_id: dependency.projectId,
      created_at: dependency.createdAt,
    },
  };
}

function parentLinkOperations(previousParentTaskId: string | null, task: Task): PrismMutation[] {
  const operations: PrismMutation[] = [];
  if (previousParentTaskId && previousParentTaskId !== task.parentTaskId) {
    operations.push({
      kind: "relation.unlink",
      relationKind: "TaskContainsTask",
      relationId: hierarchyRelationId(task.projectId, previousParentTaskId, task.id),
    });
  }
  if (task.parentTaskId && previousParentTaskId !== task.parentTaskId) {
    operations.push({
      kind: "relation.link",
      relationKind: "TaskContainsTask",
      relationId: hierarchyRelationId(task.projectId, task.parentTaskId, task.id),
      fromRef: ref("Task", task.parentTaskId),
      toRef: ref("Task", task.id),
      fields: {
        project_id: task.projectId,
        sort_key: null,
        created_at: task.createdAt,
      },
    });
  }
  return operations;
}

function projectLabelDefinitionSet(tag: Tag): PrismMutation {
  return {
    kind: "tag.set",
    subjectRef: ref("Project", tag.projectId),
    tagId: "project.label_definition",
    valueKey: tag.id,
    value: {
      id: tag.id,
      name: tag.name,
      color: tag.color,
      description: tag.description,
      sort_order: tag.sortOrder,
      created_at: tag.createdAt,
      updated_at: tag.updatedAt,
      archived_at: tag.archivedAt,
    },
    origin: "unblock.tag",
  };
}

function taskLabelSet(taskTag: TaskTag, tag: Tag | null): PrismMutation {
  return {
    kind: "tag.set",
    subjectRef: ref("Task", taskTag.taskId),
    tagId: "task.label",
    valueKey: taskTag.tagId,
    value: {
      project_id: taskTag.projectId,
      id: taskTag.tagId,
      name: tag?.name ?? taskTag.tagId,
      color: tag?.color ?? null,
      description: tag?.description ?? null,
      sort_order: tag?.sortOrder ?? 0,
      assigned_at: taskTag.createdAt,
    },
    origin: "unblock.task_tag",
  };
}

function assignmentLink(assignment: TrackAssignment): PrismMutation {
  return {
    kind: "relation.link",
    relationKind: "TaskAssignedToTrack",
    relationId: assignmentRelationId(assignment.projectId, assignment.taskId, assignment.trackId),
    fromRef: ref("Task", assignment.taskId),
    toRef: ref("Track", assignment.trackId),
    fields: {
      project_id: assignment.projectId,
      position: assignment.position,
      assigned_at: assignment.assignedAt,
    },
  };
}

function toSemanticOperation(mutation: PrismMutation): PrismSemanticOperation {
  switch (mutation.kind) {
    case "object.create":
      return { family: "object", operation: { Create: { object_kind: mutation.objectKind, object_id: mutation.objectId, fields: mutation.fields } } };
    case "object.update":
      return {
        family: "object",
        operation: {
          Update: {
            object_kind: mutation.objectKind,
            object_id: mutation.objectId,
            changed_fields: mutation.changedFields ?? Object.keys(mutation.fields),
            fields: mutation.fields,
          },
        },
      };
    case "object.delete":
      return { family: "object", operation: { Delete: { object_kind: mutation.objectKind, object_id: mutation.objectId } } };
    case "relation.link":
      return {
        family: "relation",
        operation: {
          Link: {
            relation_kind: mutation.relationKind,
            relation_id: mutation.relationId,
            from_ref: mutation.fromRef,
            to_ref: mutation.toRef,
            fields: mutation.fields,
          },
        },
      };
    case "relation.unlink":
      return { family: "relation", operation: { Unlink: { relation_kind: mutation.relationKind, relation_id: mutation.relationId } } };
    case "tag.set":
      return {
        family: "tag",
        operation: {
          Set: {
            subject_ref: mutation.subjectRef,
            tag_id: mutation.tagId,
            value_key: mutation.valueKey ?? null,
            value: mutation.value,
            origin: mutation.origin ?? null,
          },
        },
      };
    case "tag.clear":
      return {
        family: "tag",
        operation: {
          Clear: {
            subject_ref: mutation.subjectRef,
            tag_id: mutation.tagId,
            value_key: mutation.valueKey ?? null,
          },
        },
      };
  }
}

function ref(kind: string, id: string): string {
  return `object:${kind}:${id}`;
}

function parseSubjectRef(refValue: string): { kind: string; id: string } | null {
  const parts = refValue.split(":");
  if (parts.length === 3 && parts[0] === "object" && parts[1] && parts[2]) {
    return { kind: parts[1], id: parts[2] };
  }
  const slash = refValue.split("/");
  if (slash.length === 2 && slash[0] && slash[1]) {
    return { kind: slash[0], id: slash[1] };
  }
  return null;
}

function dependencyRelationId(projectId: string, taskId: string, dependsOnTaskId: string): string {
  return `${projectId}:depends:${taskId}:${dependsOnTaskId}`;
}

function hierarchyRelationId(projectId: string, parentTaskId: string, childTaskId: string): string {
  return `${projectId}:contains:${parentTaskId}:${childTaskId}`;
}

function assignmentRelationId(projectId: string, taskId: string, trackId: string): string {
  return `${projectId}:assigned:${taskId}:${trackId}`;
}

async function tasksFromPrism(store: PrismStore): Promise<Task[]> {
  const [taskRows, hierarchyRows] = await Promise.all([
    store.rows<TaskRow>("taskRows"),
    store.rows<HierarchyRow>("taskHierarchyRows"),
  ]);
  const parentByTask = new Map(hierarchyRows.map((row) => [scopedKey(row.project_id, row.task_id), row.parent_task_id]));
  return taskRows.map((row) => taskFromRow(row, parentByTask.get(scopedKey(row.project_id, row.id)) ?? null));
}

function projectFromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function taskFromRow(row: TaskRow, parentTaskId: string | null): Task {
  return {
    projectId: row.project_id,
    id: row.id,
    parentTaskId,
    title: row.title,
    description: row.description,
    lifecycle: row.lifecycle,
    priority: row.priority,
    size: row.size,
    sourceDoc: row.source_doc,
    sourceSection: row.source_section,
    sourceAnchor: row.source_anchor,
    sourceLine: row.source_line,
    sourceText: row.source_text,
    completionBar: row.completion_bar,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    archivedAt: row.archived_at,
    version: row.version,
  };
}

function dependencyFromRow(row: DependencyRow): Dependency {
  return {
    projectId: row.project_id,
    taskId: row.task_id,
    dependsOnTaskId: row.depends_on_task_id,
    createdAt: row.created_at,
  };
}

function commentFromRow(row: CommentRow): Comment {
  return {
    projectId: row.project_id,
    id: row.id,
    taskId: row.task_id,
    machine: row.machine,
    actor: row.actor,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function tagFromAssignment(projectId: string, assignment: PrismTagAssignment): Tag | null {
  if (!isRecord(assignment.value)) return null;
  return {
    projectId,
    id: stringValue(assignment.value.id, assignment.valueKey),
    name: stringValue(assignment.value.name, assignment.valueKey),
    color: nullableString(assignment.value.color),
    description: nullableString(assignment.value.description),
    sortOrder: numberValue(assignment.value.sort_order, 0),
    createdAt: stringValue(assignment.value.created_at, ""),
    updatedAt: stringValue(assignment.value.updated_at, ""),
    archivedAt: nullableString(assignment.value.archived_at),
  };
}

function taskTagFromAssignment(assignment: PrismTagAssignment): TaskTag | null {
  const subject = parseSubjectRef(assignment.subjectRef);
  if (!subject || subject.kind !== "Task" || !isRecord(assignment.value)) return null;
  return {
    projectId: stringValue(assignment.value.project_id, ""),
    taskId: subject.id,
    tagId: stringValue(assignment.value.id, assignment.valueKey),
    createdAt: stringValue(assignment.value.assigned_at, ""),
  };
}

function trackFromRow(row: TrackRow): Track {
  return {
    projectId: row.project_id,
    id: row.id,
    machine: row.machine,
    actor: row.actor,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function assignmentFromRow(row: AssignmentRow): TrackAssignment {
  return {
    projectId: row.project_id,
    trackId: row.track_id,
    taskId: row.task_id,
    position: row.position,
    assignedAt: row.assigned_at,
  };
}

function instructionFromRow(row: InstructionRow): Instruction {
  return {
    projectId: row.project_id,
    id: row.id,
    name: row.name,
    query: row.selector_text,
    body: row.body,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function savedViewFromRow(row: SavedSelectorRow): SavedView {
  return {
    projectId: row.project_id,
    id: row.id,
    name: row.name,
    query: row.selector_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function queueFeedFromRow(row: SavedSelectorRow): QueueFeed {
  return savedViewFromRow(row);
}

function activityFromRow(row: ActivityRow): Activity {
  return {
    projectId: row.project_id,
    id: row.id,
    type: row.type,
    subjectType: row.subject,
    subjectId: row.subject_id,
    message: row.message,
    data: isRecord(row.data) ? row.data : {},
    machine: row.machine,
    actor: row.actor,
    createdAt: row.created_at,
  };
}

function tagAssignmentFromProto(input: ProtoTagAssignment): PrismTagAssignment {
  return {
    subjectRef: input.subject_ref,
    tagId: input.tag_id,
    valueKey: input.value_key,
    value: input.value_present ? JSON.parse(input.value_json) as unknown : null,
    origin: input.origin,
  };
}

function runtimeQueryFragmentRecordFromProto(input: RuntimeQueryFragmentResponse): RuntimeQueryFragmentRecord {
  return {
    projectId: input.project_id,
    appId: input.app_id,
    fragmentId: input.fragment_id,
    fragmentHash: input.fragment_hash,
    baseManifestHash: input.base_manifest_hash,
    state: input.state,
    record: parseRecordJson(input.record_json),
  };
}

function runtimeQueryFragmentUseRecordFromProto(input: RuntimeQueryFragmentUseResponse): RuntimeQueryFragmentUseRecord {
  return {
    projectId: input.project_id,
    appId: input.app_id,
    fragmentId: input.fragment_id,
    consumerKind: input.consumer_kind,
    consumerId: input.consumer_id,
    fragmentHash: input.fragment_hash,
    enabled: input.enabled,
    record: parseRecordJson(input.record_json),
  };
}

function parseRecordJson(recordJson: string): Record<string, unknown> {
  if (!recordJson.trim()) return {};
  const parsed = JSON.parse(recordJson) as unknown;
  return isRecord(parsed) ? parsed : {};
}

function unary<Response>(client: RuntimeServiceClient, method: RuntimeMethod, request: Record<string, unknown>): Promise<Response> {
  return new Promise((resolve, reject) => {
    client[method](request, (error: ServiceError | null, response: Response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

function page(limit?: number, offset?: number): { limit: number; offset: number } | undefined {
  if (limit === undefined && offset === undefined) return undefined;
  return { limit: limit ?? 100, offset: offset ?? 0 };
}

function grpcEndpoint(endpoint: string): string {
  return endpoint.replace(/^https?:\/\//, "");
}

function defaultRuntimeProtoPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../proto/prism/runtime/v1/runtime.proto");
}

function defaultMatcherFragmentLoweringOptions(): MatcherFragmentLoweringOptions {
  return {
    authoringImportPath: process.env.UNBLOCK_PRISM_AUTHORING_IMPORT ?? pathToFileURL(resolve(packageRoot(), "../../../prism-new2/packages/prism-authoring/mod.ts")).href,
    appImportPath: process.env.UNBLOCK_PRISM_APP_IMPORT ?? pathToFileURL(join(packageRoot(), "src/app.ts")).href,
  };
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function execFileChecked(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) {
        resolvePromise();
        return;
      }
      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      reject(new Error(`Prism query fragment compile failed: ${error.message}${details ? `\n${details}` : ""}`));
    });
  });
}

function scopedKey(projectId: string, id: string): string {
  return `${projectId}\0${id}`;
}

function hashJson(value: unknown): string {
  const source = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

type RuntimeMethod =
  | "SubmitSemanticCommit"
  | "ReadMaterializedSurface"
  | "Query"
  | "ReadSubjectTags"
  | "FindSubjectsByTag"
  | "StoreRuntimeQueryFragment"
  | "UpsertRuntimeQueryFragmentUse";

type RuntimeServiceClient = Client & {
  [K in RuntimeMethod]: (request: Record<string, unknown>, callback: (error: ServiceError | null, response: never) => void) => void;
};

interface RuntimeProtoPackage {
  prism: {
    runtime: {
      v1: {
        RuntimeService: new (endpoint: string, credentials: ChannelCredentials) => Client;
      };
    };
  };
}

interface SubmitSemanticCommitResponse {
  outcome: string;
  has_commit_id: boolean;
}

interface MaterializedSurfaceResponse {
  outputs: Array<{ output_json: string }>;
}

interface QueryResponse {
  records_json: string[];
}

interface SubjectTagsResponse {
  assignments: ProtoTagAssignment[];
}

interface TagSubjectsResponse {
  assignments: ProtoTagAssignment[];
}

interface RuntimeQueryFragmentResponse {
  project_id: string;
  app_id: string;
  fragment_id: string;
  fragment_hash: string;
  base_manifest_hash: string;
  state: string;
  record_json: string;
}

interface RuntimeQueryFragmentUseResponse {
  project_id: string;
  app_id: string;
  fragment_id: string;
  consumer_kind: string;
  consumer_id: string;
  fragment_hash: string;
  enabled: boolean;
  record_json: string;
}

interface ProtoTagAssignment {
  subject_ref: string;
  tag_id: string;
  value_key: string;
  value_present: boolean;
  value_json: string;
  origin: string;
}

interface AdmittedMatcherFragment {
  lowering: MatcherFragmentLowering;
  artifact: RuntimeQueryFragmentArtifact;
  fragmentId: string;
  fragmentHash: string;
  selectorHash: string;
  sourceHash: string;
}

type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type TaskRow = {
  id: string;
  project_id: string;
  title: string;
  description: string;
  lifecycle: Task["lifecycle"];
  priority: Task["priority"];
  size: Task["size"];
  source_doc: string | null;
  source_section: string | null;
  source_anchor: string | null;
  source_line: number | null;
  source_text: string | null;
  completion_bar: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  archived_at: string | null;
  version: number;
};

type DependencyRow = {
  project_id: string;
  task_id: string;
  depends_on_task_id: string;
  created_at: string;
};

type HierarchyRow = {
  project_id: string;
  parent_task_id: string;
  task_id: string;
};

type CommentRow = {
  id: string;
  project_id: string;
  task_id: string;
  machine: string;
  actor: string;
  body: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type TrackRow = {
  id: string;
  project_id: string;
  machine: string;
  actor: string;
  name: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type AssignmentRow = {
  project_id: string;
  task_id: string;
  track_id: string;
  position: string;
  assigned_at: string;
};

type InstructionRow = {
  id: string;
  project_id: string;
  name: string;
  selector_text: string;
  body: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type SavedSelectorRow = {
  id: string;
  project_id: string;
  kind: "view" | "feed";
  name: string;
  selector_text: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type ActivityRow = {
  id: string;
  project_id: string | null;
  type: string;
  subject: Activity["subjectType"];
  subject_id: string | null;
  message: string;
  data: unknown;
  machine: string;
  actor: string;
  created_at: string;
};
