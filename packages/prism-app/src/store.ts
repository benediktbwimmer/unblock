import { execFile } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { credentials, loadPackageDefinition, type ChannelCredentials, type Client, type ClientUnaryCall, type ServiceError } from "@grpc/grpc-js";
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
  tenantId?: string;
  unblockProjectId?: string;
  shardId?: string;
  actorId?: string;
  client?: PrismRuntimeClient;
  protoPath?: string;
  offline?: boolean;
  readMode?: "query" | "materialized";
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
    outputKey?: string;
    limit?: number;
    offset?: number;
  }): Promise<T[]>;
  batchReadMaterializedSurfaces?<T extends Record<string, unknown>>(input: {
    projectId: string;
    shardId: string;
    appId: string;
    requests: Array<{
      surfaceId: string;
      replacementScope?: string;
      outputKey?: string;
      limit?: number;
      offset?: number;
    }>;
  }): Promise<T[][]>;
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
  compileRuntimeQueryFragment?(input: {
    projectId: string;
    fragmentId: string;
    purpose?: string;
    sourceKind: "typescript_app" | "authoring_ir_json" | "query_plan_json";
    sourceJson: string;
    denyWarnings?: boolean;
  }): Promise<RuntimeQueryFragmentArtifact>;
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

interface TimedCacheEntry<T> {
  promise: Promise<T>;
  expiresAt: number;
}

export interface PrismTagAssignment {
  subjectRef: string;
  tagId: string;
  valueKey: string;
  value: unknown;
  origin: string;
}

const TASK_DERIVED_SURFACES = [
  "taskRows",
  "taskReadModel",
  "taskCommentMatcherModel",
  "taskAssignmentMatcherModel",
  "taskMatcherReadModel",
  "readyTasks",
  "taskStatus",
  "hierarchyStatus",
  "unfinishedDirectDependencySummary",
  "unfinishedDescendantSummary",
] as const;

const DEPENDENCY_DERIVED_SURFACES = [
  "taskDependencyRows",
  "directDependencySummary",
  "directDependentSummary",
  "unfinishedDirectDependencySummary",
  "taskDependencySummary",
  "taskUnblockSummary",
  "taskStatus",
  "taskReadModel",
  "taskMatcherReadModel",
  "readyTasks",
] as const;

const HIERARCHY_DERIVED_SURFACES = [
  "taskHierarchyRows",
  "childSummary",
  "descendantSummary",
  "unfinishedDescendantSummary",
  "parentSummary",
  "hierarchyStatus",
  "taskMatcherReadModel",
] as const;

const TASK_LABEL_DERIVED_SURFACES = [
  "taskLabelRows",
  "taskMatcherReadModel",
] as const;

const COMMENT_DERIVED_SURFACES = [
  "commentRows",
  "commentSummary",
  "taskCommentMatcherModel",
  "taskMatcherReadModel",
] as const;

const TRACK_DERIVED_SURFACES = [
  "trackRows",
  "taskAssignmentRows",
  "assignmentSummary",
  "taskAssignmentMatcherModel",
  "taskMatcherReadModel",
] as const;

const ASSIGNMENT_DERIVED_SURFACES = [
  "taskAssignmentRows",
  "assignmentSummary",
  "taskAssignmentMatcherModel",
  "taskMatcherReadModel",
] as const;

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

export function prismShardIdForUnblockProject(tenantId: string, projectId: string): string {
  const tenant = tenantId.trim();
  const project = projectId.trim();
  if (!tenant) throw new Error("tenantId is required to derive a Prism shard id");
  if (!project) throw new Error("projectId is required to derive a Prism shard id");
  return `tenant:${tenant}:project:${project}`;
}

export function createPrismStore(options: PrismStoreOptions = {}): PrismStore {
  if (options.offline && !options.client) {
    throw new Error("PrismStore no longer has an offline compatibility cache; provide a PrismRuntimeClient or use the sqlite backend.");
  }
  const grpcOptions: { endpoint?: string; protoPath?: string } = {};
  if (options.endpoint !== undefined) grpcOptions.endpoint = options.endpoint;
  if (options.protoPath !== undefined) grpcOptions.protoPath = options.protoPath;
  const client = options.client ?? new PrismGrpcRuntimeClient(grpcOptions);
  const projectId = options.projectId ?? "prism";
  const shardId = options.shardId
    ?? (options.unblockProjectId
      ? prismShardIdForUnblockProject(options.tenantId ?? "local", options.unblockProjectId)
      : "default");
  return new PrismStore({
    client,
    projectId,
    shardId,
    actorId: options.actorId ?? "unblock-api",
    readMode: options.readMode ?? (process.env.UNBLOCK_PRISM_READ_MODE === "materialized" ? "materialized" : "query"),
    fragmentCompiler: options.fragmentCompiler ?? new PrismRuntimeMatcherFragmentCompiler(client, { projectId }),
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
  private readonly matcherFragmentUses = new Map<string, Promise<RuntimeQueryFragmentUseRecord>>();
  private readonly matcherResultCache = new Map<string, Promise<string[]>>();
  private readonly instructionMatchCache = new Map<string, TimedCacheEntry<Array<{ instructionId: string; taskId: string }>>>();
  private readonly rowCache = new Map<string, TimedCacheEntry<Record<string, unknown>[]>>();
  private readonly tagReadCache = new Map<string, Promise<PrismTagAssignment[]>>();

  constructor(private readonly options: {
    client: PrismRuntimeClient;
    projectId: string;
    shardId: string;
    actorId: string;
    readMode: "query" | "materialized";
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

  async rows<T extends Record<string, unknown>>(surfaceId: string, replacementScope?: string): Promise<T[]> {
    const cacheKey = `rows:${surfaceId}:${replacementScope ?? ""}:${this.options.readMode}`;
    return await this.cachedRows(cacheKey, async () => await this.readRows<T>(surfaceId, replacementScope));
  }

  private async readRows<T extends Record<string, unknown>>(surfaceId: string, replacementScope?: string): Promise<T[]> {
    if (this.options.readMode === "materialized") {
      const rows = await this.options.client.readMaterializedSurface<T>({
        projectId: this.options.projectId,
        shardId: this.options.shardId,
        appId: "unblock",
        surfaceId,
        ...(replacementScope ? { replacementScope } : {}),
        limit: 10_000,
        offset: 0,
      });
      if (!replacementScope) return rows;
      return rows.filter((row) => row.project_id === replacementScope || row.id === replacementScope);
    }
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

  canReadMaterializedRows(): boolean {
    return this.options.readMode === "materialized";
  }

  async materializedRowByOutputKey<T extends Record<string, unknown>>(
    surfaceId: string,
    replacementScope: string,
    outputKey: string,
  ): Promise<T | null> {
    const cacheKey = `output:${surfaceId}:${replacementScope}:${outputKey}`;
    const rows = await this.cachedRows(cacheKey, async () => await this.options.client.readMaterializedSurface<T>({
        projectId: this.options.projectId,
        shardId: this.options.shardId,
        appId: "unblock",
        surfaceId,
        replacementScope,
        outputKey,
        limit: 1,
        offset: 0,
      }));
    return rows[0] ?? null;
  }

  async materializedRowsByOutputKeys<T extends Record<string, unknown>>(
    requests: Array<{ surfaceId: string; replacementScope: string; outputKey: string }>,
  ): Promise<Array<T | null>> {
    if (requests.length === 0) return [];
    if (!useBatchMaterializedReads() || !this.options.client.batchReadMaterializedSurfaces || requests.length === 1) {
      return await Promise.all(requests.map(async (request) =>
        await this.materializedRowByOutputKey<T>(request.surfaceId, request.replacementScope, request.outputKey)
      ));
    }

    const now = Date.now();
    const ttlMs = this.options.readMode === "materialized" ? materializedRowCacheTtlMs() : Number.POSITIVE_INFINITY;
    const rowPromises = new Array<Promise<T[]>>(requests.length);
    const misses: Array<{ index: number; cacheKey: string; request: { surfaceId: string; replacementScope: string; outputKey: string } }> = [];

    requests.forEach((request, index) => {
      const cacheKey = `output:${request.surfaceId}:${request.replacementScope}:${request.outputKey}`;
      const cached = this.rowCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        rowPromises[index] = cached.promise as Promise<T[]>;
        return;
      }
      misses.push({ index, cacheKey, request });
    });

    if (misses.length > 0) {
      const batchPromise = this.options.client.batchReadMaterializedSurfaces<T>({
        projectId: this.options.projectId,
        shardId: this.options.shardId,
        appId: "unblock",
        requests: misses.map(({ request }) => ({
          surfaceId: request.surfaceId,
          replacementScope: request.replacementScope,
          outputKey: request.outputKey,
          limit: 1,
          offset: 0,
        })),
      });
      const expiresAt = now + ttlMs;
      misses.forEach((miss, missIndex) => {
        const promise = batchPromise.then((sets) => sets[missIndex] ?? []) as Promise<Record<string, unknown>[]>;
        this.rowCache.set(miss.cacheKey, { promise, expiresAt });
        rowPromises[miss.index] = promise as Promise<T[]>;
      });
      batchPromise.catch(() => {
        for (const miss of misses) {
          if (this.rowCache.get(miss.cacheKey)?.expiresAt === expiresAt) this.rowCache.delete(miss.cacheKey);
        }
      });
    }

    const rows = await Promise.all(rowPromises);
    return rows.map((items) => items[0] ?? null);
  }

  private async cachedRows<T extends Record<string, unknown>>(
    cacheKey: string,
    load: () => Promise<T[]>,
  ): Promise<T[]> {
    const now = Date.now();
    const cached = this.rowCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return await cached.promise as T[];
    const ttlMs = this.options.readMode === "materialized" ? materializedRowCacheTtlMs() : Number.POSITIVE_INFINITY;
    const promise = load() as Promise<Record<string, unknown>[]>;
    this.rowCache.set(cacheKey, { promise, expiresAt: now + ttlMs });
    try {
      return await promise as T[];
    } catch (error) {
      if (this.rowCache.get(cacheKey)?.promise === promise) this.rowCache.delete(cacheKey);
      throw error;
    }
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
    const useKey = hashJson(request);
    let pendingUse = this.matcherFragmentUses.get(useKey);
    if (!pendingUse) {
      pendingUse = this.options.client.upsertRuntimeQueryFragmentUse(request);
      this.matcherFragmentUses.set(useKey, pendingUse);
    }
    await pendingUse;
    return admitted;
  }

  async matchTaskIds(projectId: string, query: string, filters: Record<string, unknown> = {}): Promise<string[]> {
    const fragment = await this.ensureMatcherFragment(query);
    const input = fragment.lowering.input(new Date(), projectId);
    if (fragment.lowering.usesDynamicTime) {
      return await this.fetchMatcherTaskIds(fragment, input);
    }
    if (this.options.readMode === "materialized") {
      await this.ensureMatcherFragmentUse({
        query,
        consumerKind: "unblock.matcher_query",
        consumerId: `${projectId}:${fragment.fragmentId}`,
        replacementScope: projectId,
      });
      const materialized = await this.readMaterializedMatcherTaskIds(fragment, projectId);
      if (materialized.length > 0) return materialized;
    }
    const cacheKey = `${fragment.fragmentId}:${fragment.fragmentHash}:${hashJson(input)}:${hashJson(filters)}`;
    let pending = this.matcherResultCache.get(cacheKey);
    if (!pending) {
      pending = this.fetchMatcherTaskIds(fragment, input);
      this.matcherResultCache.set(cacheKey, pending);
    }
    return await pending;
  }

  async matchTaskIdsByInstructionQuery(
    projectId: string,
    instructions: Instruction[],
    filters: Record<string, unknown> = {},
  ): Promise<Map<string, string[]>> {
    const queries = [...new Set(instructions.map((instruction) => instruction.query))];
    if (queries.length === 0) return new Map();
    if (this.options.readMode !== "materialized") {
      const entries = await Promise.all(queries.map(async (query) => [
        query,
        await this.matchTaskIds(projectId, query, filters),
      ] as const));
      return new Map(entries);
    }

    const instructionIds = new Set(instructions.map((instruction) => instruction.id));
    const catalog = await this.rows<InstructionSelectorCatalogRow>("instructionSelectorCatalog", projectId);
    const enabledFragmentKeys = new Set(
      catalog
        .filter((row) => row.project_id === projectId && instructionIds.has(row.instruction_id) && row.selector_fragment_id)
        .map((row) => `${row.selector_text}\u0000${row.selector_fragment_id}`),
    );

    const entries = await Promise.all(queries.map(async (query) => {
      const fragment = lowerMatcherQueryToPrismFragment(query, this.options.matcherFragmentLoweringOptions);
      const hasEnabledMaterializedUse = enabledFragmentKeys.has(`${query}\u0000${fragment.fragmentId}`);
      if (!fragment.usesDynamicTime && hasEnabledMaterializedUse) {
        return [query, await this.readMaterializedMatcherTaskIdsBySurfaceId(fragment.fragmentId, projectId)] as const;
      }
      return [query, await this.matchTaskIds(projectId, query, filters)] as const;
    }));
    return new Map(entries);
  }

  async matchingInstructionIds(projectId: string, filters: Record<string, unknown> = {}): Promise<Array<{ instructionId: string; taskId: string }>> {
    if (this.options.readMode !== "materialized") {
      const instructions = (await this.instructions.list(projectId)).filter((instruction) => instruction.enabled && !instruction.archivedAt);
      const taskIdsByQuery = await this.matchTaskIdsByInstructionQuery(projectId, instructions, filters);
      return instructionTaskMatches(instructions, taskIdsByQuery);
    }

    const cacheKey = `instructionMatches:${projectId}:${hashJson(filters)}`;
    const now = Date.now();
    const cached = this.instructionMatchCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return await cached.promise;
    const promise = this.computeMaterializedInstructionIds(projectId, filters);
    this.instructionMatchCache.set(cacheKey, {
      promise,
      expiresAt: now + materializedRowCacheTtlMs(),
    });
    try {
      return await promise;
    } catch (error) {
      if (this.instructionMatchCache.get(cacheKey)?.promise === promise) this.instructionMatchCache.delete(cacheKey);
      throw error;
    }
  }

  private async computeMaterializedInstructionIds(projectId: string, filters: Record<string, unknown>): Promise<Array<{ instructionId: string; taskId: string }>> {
    const catalog = await this.rows<InstructionSelectorCatalogRow>("instructionSelectorCatalog", projectId);
    const activeRows = catalog.filter((row) =>
      row.project_id === projectId
      && row.enabled
      && row.archived_at === null
      && row.selector_fragment_id
    );
    if (activeRows.length === 0) return [];

    const fragmentIdsByQuery = new Map<string, string>();
    for (const row of activeRows) {
      if (row.selector_fragment_id) fragmentIdsByQuery.set(row.selector_text, row.selector_fragment_id);
    }
    const taskIdsByQuery = new Map(await Promise.all([...fragmentIdsByQuery].map(async ([query, fragmentId]) =>
      [query, await this.materializedInstructionTaskIdsForQuery(projectId, query, fragmentId, filters)] as const
    )));
    const matches: Array<{ instructionId: string; taskId: string }> = [];
    for (const row of activeRows) {
      for (const taskId of taskIdsByQuery.get(row.selector_text) ?? []) {
        matches.push({ instructionId: row.instruction_id, taskId });
      }
    }
    return matches.sort((a, b) => a.instructionId.localeCompare(b.instructionId) || a.taskId.localeCompare(b.taskId));
  }

  private async materializedInstructionTaskIdsForQuery(
    projectId: string,
    query: string,
    fragmentId: string,
    filters: Record<string, unknown>,
  ): Promise<string[]> {
    const fragment = lowerMatcherQueryToPrismFragment(query, this.options.matcherFragmentLoweringOptions);
    if (fragment.usesDynamicTime || fragment.fragmentId !== fragmentId) {
      return await this.matchTaskIds(projectId, query, filters);
    }
    return await this.readMaterializedMatcherTaskIdsBySurfaceId(fragmentId, projectId);
  }

  projectId(): string {
    return this.options.projectId;
  }

  async readTags(subjectRef: string, tagId?: string): Promise<PrismTagAssignment[]> {
    const cacheKey = `read:${subjectRef}:${tagId ?? ""}`;
    let pending = this.tagReadCache.get(cacheKey);
    if (pending) return await pending;
    const input: { projectId: string; shardId: string; subjectRef: string; tagId?: string } = {
      projectId: this.options.projectId,
      shardId: this.options.shardId,
      subjectRef,
    };
    if (tagId !== undefined) input.tagId = tagId;
    pending = this.options.client.readSubjectTags(input);
    this.tagReadCache.set(cacheKey, pending);
    return await pending;
  }

  async findTags(tagId: string, valueKey?: string): Promise<PrismTagAssignment[]> {
    const cacheKey = `find:${tagId}:${valueKey ?? ""}`;
    let pending = this.tagReadCache.get(cacheKey);
    if (pending) return await pending;
    const input: { projectId: string; shardId: string; tagId: string; valueKey?: string; limit?: number; offset?: number } = {
      projectId: this.options.projectId,
      shardId: this.options.shardId,
      tagId,
      limit: 10_000,
      offset: 0,
    };
    if (valueKey !== undefined) input.valueKey = valueKey;
    pending = this.options.client.findSubjectsByTag(input);
    this.tagReadCache.set(cacheKey, pending);
    return await pending;
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
    this.invalidateReadCaches(operations);
  }

  private invalidateReadCaches(operations: PrismMutation[]): void {
    const surfaces = new Set<string>();
    let clearMatcherResults = false;
    let clearInstructionMatches = false;
    let clearTagReads = false;
    let clearAllRows = false;
    const changedTagAssignments: PrismMutation[] = [];

    for (const operation of operations) {
      switch (operation.kind) {
        case "object.create":
        case "object.update":
        case "object.delete":
          switch (operation.objectKind) {
            case "Project":
              surfaces.add("projectRows");
              clearTagReads = true;
              break;
            case "Task":
              addAll(surfaces, TASK_DERIVED_SURFACES);
              clearMatcherResults = true;
              break;
            case "Comment":
              addAll(surfaces, COMMENT_DERIVED_SURFACES);
              clearMatcherResults = true;
              break;
            case "Track":
              addAll(surfaces, TRACK_DERIVED_SURFACES);
              clearMatcherResults = true;
              break;
            case "Instruction":
              surfaces.add("instructionRows");
              surfaces.add("instructionSelectorCatalog");
              clearInstructionMatches = true;
              break;
            case "SavedSelector":
              surfaces.add("savedSelectorRows");
              surfaces.add("savedSelectorCatalog");
              break;
            case "ActivityEvent":
              surfaces.add("activityRows");
              break;
            default:
              clearAllRows = true;
              clearMatcherResults = true;
              clearTagReads = true;
          }
          break;
        case "relation.link":
        case "relation.unlink":
          switch (operation.relationKind) {
            case "TaskDependsOnTask":
              addAll(surfaces, DEPENDENCY_DERIVED_SURFACES);
              clearMatcherResults = true;
              break;
            case "TaskContainsTask":
              addAll(surfaces, HIERARCHY_DERIVED_SURFACES);
              clearMatcherResults = true;
              break;
            case "TaskAssignedToTrack":
              addAll(surfaces, ASSIGNMENT_DERIVED_SURFACES);
              clearMatcherResults = true;
              break;
            default:
              clearAllRows = true;
              clearMatcherResults = true;
          }
          break;
        case "tag.set":
        case "tag.clear":
          changedTagAssignments.push(operation);
          if (operation.tagId === "task.label") {
            addAll(surfaces, TASK_LABEL_DERIVED_SURFACES);
            clearMatcherResults = true;
          } else if (operation.tagId === "project.label_definition") {
            clearTagReads = true;
            surfaces.add("taskLabelRows");
            clearMatcherResults = true;
          } else {
            clearTagReads = true;
            clearMatcherResults = true;
          }
          break;
        default:
          clearAllRows = true;
          clearMatcherResults = true;
          clearTagReads = true;
      }
    }

    if (clearAllRows) this.rowCache.clear();
    else this.deleteRowCaches(surfaces);
    if (clearMatcherResults) this.deleteMatcherRowCaches();
    if (clearMatcherResults) this.matcherResultCache.clear();
    if (clearAllRows || clearInstructionMatches) this.instructionMatchCache.clear();
    if (clearTagReads) this.tagReadCache.clear();
    else this.deleteTagReadCaches(changedTagAssignments);
  }

  private deleteRowCaches(surfaceIds: Set<string>): void {
    if (surfaceIds.size === 0) return;
    for (const key of this.rowCache.keys()) {
      const surfaceId = rowCacheSurfaceId(key);
      if (surfaceId && surfaceIds.has(surfaceId)) this.rowCache.delete(key);
    }
  }

  private deleteMatcherRowCaches(): void {
    for (const key of this.rowCache.keys()) {
      if (key.startsWith("matcher:")) this.rowCache.delete(key);
    }
  }

  private deleteTagReadCaches(operations: PrismMutation[]): void {
    for (const operation of operations) {
      if (operation.kind !== "tag.set" && operation.kind !== "tag.clear") continue;
      this.tagReadCache.delete(`read:${operation.subjectRef}:`);
      this.tagReadCache.delete(`read:${operation.subjectRef}:${operation.tagId}`);
      this.tagReadCache.delete(`find:${operation.tagId}:`);
      if (operation.valueKey !== undefined) {
        this.tagReadCache.delete(`find:${operation.tagId}:${operation.valueKey}`);
      }
    }
  }

  private async fetchMatcherTaskIds(fragment: AdmittedMatcherFragment, input: Record<string, unknown>): Promise<string[]> {
    const rows = await this.query<{ task_id: string }>(fragment.fragmentId, input);
    return [...new Set(rows.map((row) => row.task_id))].sort();
  }

  private async readMaterializedMatcherTaskIds(fragment: AdmittedMatcherFragment, projectId: string): Promise<string[]> {
    return await this.readMaterializedMatcherTaskIdsBySurfaceId(fragment.fragmentId, projectId);
  }

  private async readMaterializedMatcherTaskIdsBySurfaceId(surfaceId: string, projectId: string): Promise<string[]> {
    const rows = await this.cachedRows(`matcher:${surfaceId}:${projectId}`, async () =>
      await this.options.client.readMaterializedSurface<{ task_id: string }>({
        projectId: this.options.projectId,
        shardId: this.options.shardId,
        appId: "unblock",
        surfaceId,
        replacementScope: projectId,
        limit: 10_000,
        offset: 0,
      })
    );
    return [...new Set(rows.map((row) => row.task_id))].sort();
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
    if (process.env.UNBLOCK_PRISM_TRACE_COMMITS === "1") {
      const receipt = parseRecordJson(response.receipt_json ?? "");
      console.error(JSON.stringify({
        kind: "prism.commit",
        elapsedMs: numberValue(response.elapsed_ms, 0),
        operationCount: numberValue(response.operation_count, 0),
        mutationCount: numberValue(response.mutation_count, 0),
        diagnostics: isRecord(receipt.diagnostics) ? receipt.diagnostics : {},
      }));
    }
  }

  async readMaterializedSurface<T extends Record<string, unknown>>(input: {
    projectId: string;
    shardId: string;
    appId: string;
    surfaceId: string;
    replacementScope?: string;
    outputKey?: string;
    limit?: number;
    offset?: number;
  }): Promise<T[]> {
    const response = await unary<MaterializedSurfaceResponse>(this.client, "ReadMaterializedSurface", {
      project_id: input.projectId,
      shard_id: input.shardId,
      app_id: input.appId,
      surface_id: input.surfaceId,
      replacement_scope: input.replacementScope ?? "",
      output_key: input.outputKey ?? "",
      page: page(input.limit, input.offset),
    });
    return response.outputs.map((output) => JSON.parse(output.output_json) as T);
  }

  async batchReadMaterializedSurfaces<T extends Record<string, unknown>>(input: {
    projectId: string;
    shardId: string;
    appId: string;
    requests: Array<{
      surfaceId: string;
      replacementScope?: string;
      outputKey?: string;
      limit?: number;
      offset?: number;
    }>;
  }): Promise<T[][]> {
    if (input.requests.length === 0) return [];
    const response = await unary<MaterializedSurfaceBatchResponse>(this.client, "ReadMaterializedSurfaces", {
      requests: input.requests.map((request, index) => ({
        project_id: input.projectId,
        shard_id: input.shardId,
        app_id: input.appId,
        surface_id: request.surfaceId,
        replacement_scope: request.replacementScope ?? "",
        output_key: request.outputKey ?? "",
        page: page(request.limit, request.offset),
      })),
    });
    return input.requests.map((_request, index) => {
      const surface = response.responses[index];
      if (!surface) throw new Error(`Prism batch response missing materialized surface ${index}`);
      return surface.outputs.map((output) => JSON.parse(output.output_json) as T);
    });
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

  async compileRuntimeQueryFragment(input: {
    projectId: string;
    fragmentId: string;
    purpose?: string;
    sourceKind: "typescript_app" | "authoring_ir_json" | "query_plan_json";
    sourceJson: string;
    denyWarnings?: boolean;
  }): Promise<RuntimeQueryFragmentArtifact> {
    const response = await unary<CompileRuntimeQueryFragmentResponse>(this.client, "CompileRuntimeQueryFragment", {
      project_id: input.projectId,
      fragment_id: input.fragmentId,
      purpose: input.purpose ?? "",
      source_kind: input.sourceKind,
      source_json: input.sourceJson,
      deny_warnings: input.denyWarnings ?? false,
    });
    return JSON.parse(response.artifact_json) as RuntimeQueryFragmentArtifact;
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

export class PrismRuntimeMatcherFragmentCompiler implements MatcherFragmentCompiler {
  constructor(private readonly client: PrismRuntimeClient, private readonly options: {
    projectId: string;
    purpose?: string;
    denyWarnings?: boolean;
  }) {}

  async compile(fragment: MatcherFragmentLowering): Promise<RuntimeQueryFragmentArtifact> {
    if (!this.client.compileRuntimeQueryFragment) {
      throw new Error("Prism runtime client does not support runtime query fragment compilation");
    }
    return await this.client.compileRuntimeQueryFragment({
      projectId: this.options.projectId,
      fragmentId: fragment.fragmentId,
      purpose: this.options.purpose ?? "unblock.matcher",
      sourceKind: fragment.queryPlan ? "query_plan_json" : "typescript_app",
      sourceJson: fragment.queryPlan
        ? JSON.stringify({
          app_id: "unblock",
          query_plan: fragment.queryPlan,
        })
        : JSON.stringify({
          entrypoint: "src/app.ts",
          files: {
            "src/app.ts": fragment.source,
          },
        }),
      denyWarnings: this.options.denyWarnings ?? false,
    });
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
    if (this.store.canReadMaterializedRows()) {
      const row = await this.store.materializedRowByOutputKey<ProjectRow>("projectRows", id, id);
      return row ? projectFromRow(row) : null;
    }
    return (await this.store.rows<ProjectRow>("projectRows", id)).map(projectFromRow)[0] ?? null;
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
    return (await tasksFromPrism(this.store, projectId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async get(projectId: string, id: string): Promise<Task | null> {
    if (this.store.canReadMaterializedRows()) {
      const row = await this.store.materializedRowByOutputKey<TaskRow>("taskRows", projectId, `${projectId}:${id}`);
      if (!row) return null;
      const hierarchy = await this.store.materializedRowByOutputKey<HierarchyRow>("taskHierarchyRows", projectId, `${projectId}:${id}`);
      return taskFromRow(row, hierarchy?.parent_task_id ?? null);
    }
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
    await this.updateWithPrevious(previous, task);
  }

  async updateWithPrevious(previous: Task | null, task: Task): Promise<void> {
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
    return (await this.store.rows<DependencyRow>("taskDependencyRows", projectId))
      .map(dependencyFromRow)
      .filter((dependency) => !projectId || dependency.projectId === projectId);
  }

  async listForTask(projectId: string, taskId: string): Promise<Dependency[]> {
    return (await this.list(projectId)).filter((dependency) => dependency.taskId === taskId);
  }

  async listDependents(projectId: string, dependsOnTaskId: string): Promise<Dependency[]> {
    return (await this.list(projectId)).filter((dependency) => dependency.dependsOnTaskId === dependsOnTaskId);
  }

  async inspectAdd(projectId: string, taskId: string, dependsOnTaskId: string): Promise<{
    task: { id: string; archivedAt: string | null } | null;
    dependsOnTask: { id: string; archivedAt: string | null } | null;
    exists: boolean;
    createsDependencyCycle: boolean;
    taskContainsDependsOnTask: boolean;
    dependsOnTaskContainsTask: boolean;
  }> {
    if (!this.store.canReadMaterializedRows()) {
      const [tasks, dependencies] = await Promise.all([
        this.store.tasks.list(projectId),
        this.list(projectId),
      ]);
      const task = tasks.find((candidate) => candidate.id === taskId) ?? null;
      const dependsOnTask = tasks.find((candidate) => candidate.id === dependsOnTaskId) ?? null;
      return {
        task: task ? { id: task.id, archivedAt: task.archivedAt } : null,
        dependsOnTask: dependsOnTask ? { id: dependsOnTask.id, archivedAt: dependsOnTask.archivedAt } : null,
        exists: dependencies.some((dependency) => dependency.taskId === taskId && dependency.dependsOnTaskId === dependsOnTaskId),
        createsDependencyCycle: hasDependencyPath(dependencies, dependsOnTaskId, taskId),
        taskContainsDependsOnTask: hasHierarchyPath(tasks, taskId, dependsOnTaskId),
        dependsOnTaskContainsTask: hasHierarchyPath(tasks, dependsOnTaskId, taskId),
      };
    }

    const [
      taskRow,
      dependsOnTaskRow,
      existingDependency,
      reverseDependencyPath,
      taskContainsDependsOnTaskPath,
      dependsOnTaskContainsTaskPath,
    ] = await this.store.materializedRowsByOutputKeys<Record<string, unknown>>([
      { surfaceId: "taskRows", replacementScope: projectId, outputKey: `${projectId}:${taskId}` },
      { surfaceId: "taskRows", replacementScope: projectId, outputKey: `${projectId}:${dependsOnTaskId}` },
      { surfaceId: "taskDependencyRows", replacementScope: projectId, outputKey: `${projectId}:${taskId}:${dependsOnTaskId}` },
      { surfaceId: "taskDependencyClosure", replacementScope: projectId, outputKey: `${projectId}:Task:${dependsOnTaskId}:Task:${taskId}` },
      { surfaceId: "hierarchyClosure", replacementScope: projectId, outputKey: `${projectId}:Task:${taskId}:Task:${dependsOnTaskId}` },
      { surfaceId: "hierarchyClosure", replacementScope: projectId, outputKey: `${projectId}:Task:${dependsOnTaskId}:Task:${taskId}` },
    ]);

    return {
      task: taskRow ? { id: stringValue(taskRow.id, ""), archivedAt: nullableString(taskRow.archived_at) } : null,
      dependsOnTask: dependsOnTaskRow ? { id: stringValue(dependsOnTaskRow.id, ""), archivedAt: nullableString(dependsOnTaskRow.archived_at) } : null,
      exists: existingDependency !== null,
      createsDependencyCycle: reverseDependencyPath !== null,
      taskContainsDependsOnTask: taskContainsDependsOnTaskPath !== null,
      dependsOnTaskContainsTask: dependsOnTaskContainsTaskPath !== null,
    };
  }

  async hasDependency(projectId: string, taskId: string, dependsOnTaskId: string): Promise<boolean> {
    if (this.store.canReadMaterializedRows()) {
      const row = await this.store.materializedRowByOutputKey<DependencyRow>(
        "taskDependencyRows",
        projectId,
        `${projectId}:${taskId}:${dependsOnTaskId}`,
      );
      return row !== null;
    }
    return (await this.listForTask(projectId, taskId)).some((dependency) => dependency.dependsOnTaskId === dependsOnTaskId);
  }

  async hasDependencyPath(projectId: string, fromTaskId: string, toTaskId: string): Promise<boolean> {
    if (this.store.canReadMaterializedRows()) {
      const row = await this.store.materializedRowByOutputKey<DependencySummaryRow>(
        "taskDependencySummary",
        projectId,
        `${projectId}:${fromTaskId}`,
      );
      return row?.dependency_ids.includes(toTaskId) ?? false;
    }
    return hasDependencyPath(await this.list(projectId), fromTaskId, toTaskId);
  }

  async hasHierarchyPath(projectId: string, ancestorTaskId: string, descendantTaskId: string): Promise<boolean> {
    if (this.store.canReadMaterializedRows()) {
      const row = await this.store.materializedRowByOutputKey<DescendantSummaryRow>(
        "descendantSummary",
        projectId,
        `${projectId}:${ancestorTaskId}`,
      );
      return row?.descendant_ids.includes(descendantTaskId) ?? false;
    }
    return hasHierarchyPath(await this.store.tasks.list(projectId), ancestorTaskId, descendantTaskId);
  }

  async add(dependency: Dependency): Promise<void> {
    await this.store.record([dependencyLink(dependency)]);
  }

  async addMany(dependencies: Dependency[]): Promise<void> {
    await this.store.record(dependencies.map(dependencyLink));
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
    return (await this.store.rows<CommentRow>("commentRows", projectId))
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
    if (projectId) {
      return (await this.store.rows<TaskLabelRow>("taskLabelRows", projectId))
        .map(taskTagFromRow)
        .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.tagId.localeCompare(b.tagId));
    }
    const taskIds = projectId ? new Set((await this.store.tasks.list(projectId)).map((task) => task.id)) : null;
    const taskTags = (await this.store.findTags("task.label"))
      .map(taskTagFromAssignment)
      .filter((taskTag): taskTag is TaskTag => taskTag !== null);
    return taskTags.filter((taskTag) => !projectId || taskTag.projectId === projectId || Boolean(taskIds?.has(taskTag.taskId)));
  }

  async hasTaskTag(projectId: string, taskId: string, tagId: string): Promise<boolean> {
    if (this.store.canReadMaterializedRows()) {
      const row = await this.store.materializedRowByOutputKey<TaskLabelRow>(
        "taskLabelRows",
        projectId,
        `${projectId}:${taskId}:${tagId}`,
      );
      return row !== null;
    }
    return (await this.listTaskTags(projectId)).some((taskTag) => taskTag.taskId === taskId && taskTag.tagId === tagId);
  }

  async addTaskTag(taskTag: TaskTag): Promise<void> {
    const tag = await this.get(taskTag.projectId, taskTag.tagId);
    await this.store.record([taskLabelSet(taskTag, tag)]);
  }

  async addTaskTags(assignments: Array<{ taskTag: TaskTag; tag?: Tag | null }>): Promise<void> {
    await this.store.record(assignments.map(({ taskTag, tag }) => taskLabelSet(taskTag, tag ?? null)));
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
    return (await this.store.rows<TrackRow>("trackRows", projectId))
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
    return (await this.store.rows<AssignmentRow>("taskAssignmentRows", projectId))
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
    return (await this.store.rows<InstructionRow>("instructionRows", projectId))
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

  async createMany(instructions: Instruction[]): Promise<void> {
    const fragments = await Promise.all(instructions.map(async (instruction) => await this.store.ensureMatcherFragmentUse({
      query: instruction.query,
      consumerKind: "unblock.instruction",
      consumerId: instruction.id,
      enabled: instruction.enabled && instruction.archivedAt === null,
      replacementScope: [instruction.projectId, instruction.id],
    })));
    await this.store.record(instructions.map((instruction, index) =>
      objectMutation("object.create", "Instruction", instruction.id, instructionFields(instruction, fragments[index]!))
    ));
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
    return (await this.store.rows<SavedSelectorRow>("savedSelectorRows", projectId))
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
    return (await this.store.rows<SavedSelectorRow>("savedSelectorRows", projectId))
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
    return (await this.store.rows<ActivityRow>("activityRows", projectId ?? undefined))
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

  async matchTaskIds(projectId: string, query: string, filters: Record<string, unknown> = {}): Promise<string[]> {
    return await this.store.matchTaskIds(projectId, query, filters);
  }

  async matchingInstructionIds(projectId: string, filters: Record<string, unknown> = {}): Promise<Array<{ instructionId: string; taskId: string }>> {
    return await this.store.matchingInstructionIds(projectId, filters);
  }

  async matchTaskIdsByInstructionQuery(
    projectId: string,
    instructions: Instruction[],
    filters: Record<string, unknown> = {},
  ): Promise<Map<string, string[]>> {
    return await this.store.matchTaskIdsByInstructionQuery(projectId, instructions, filters);
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

async function tasksFromPrism(store: PrismStore, projectId?: string): Promise<Task[]> {
  const [taskRows, hierarchyRows] = await Promise.all([
    store.rows<TaskRow>("taskRows", projectId),
    store.rows<HierarchyRow>("taskHierarchyRows", projectId),
  ]);
  const parentByTask = new Map(hierarchyRows.map((row) => [scopedKey(row.project_id, row.task_id), row.parent_task_id]));
  return taskRows
    .map((row) => taskFromRow(row, parentByTask.get(scopedKey(row.project_id, row.id)) ?? null))
    .filter((task) => !projectId || task.projectId === projectId);
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

function taskTagFromRow(row: TaskLabelRow): TaskTag {
  return {
    projectId: row.project_id,
    taskId: row.task_id,
    tagId: row.label_id,
    createdAt: row.assigned_at,
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
    const timeoutMs = Number(process.env.UNBLOCK_PRISM_RPC_TIMEOUT_MS ?? "30000");
    let settled = false;
    let call: ClientUnaryCall | undefined;
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
        if (settled) return;
        settled = true;
        call?.cancel();
        reject(new Error(`Timed out waiting for Prism RPC ${method} after ${timeoutMs}ms request=${JSON.stringify(request).slice(0, 1000)}`));
      }, timeoutMs)
      : undefined;
    call = (client[method] as unknown as (request: Record<string, unknown>, callback: (error: ServiceError | null, response: Response) => void) => ClientUnaryCall)(request, (error, response) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
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

function hasDependencyPath(dependencies: Dependency[], fromTaskId: string, toTaskId: string): boolean {
  const dependenciesByTask = new Map<string, string[]>();
  for (const dependency of dependencies) {
    const ids = dependenciesByTask.get(dependency.taskId) ?? [];
    ids.push(dependency.dependsOnTaskId);
    dependenciesByTask.set(dependency.taskId, ids);
  }
  return reaches(dependenciesByTask, fromTaskId, toTaskId);
}

function hasHierarchyPath(tasks: Task[], ancestorTaskId: string, descendantTaskId: string): boolean {
  const childrenByTask = new Map<string, string[]>();
  for (const task of tasks) {
    if (!task.parentTaskId) continue;
    const ids = childrenByTask.get(task.parentTaskId) ?? [];
    ids.push(task.id);
    childrenByTask.set(task.parentTaskId, ids);
  }
  return reaches(childrenByTask, ancestorTaskId, descendantTaskId);
}

function reaches(graph: Map<string, string[]>, fromId: string, toId: string): boolean {
  const pending = [...(graph.get(fromId) ?? [])];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (id === toId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(graph.get(id) ?? []));
  }
  return false;
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

function addAll(target: Set<string>, values: readonly string[]): void {
  for (const value of values) target.add(value);
}

function instructionTaskMatches(
  instructions: Instruction[],
  taskIdsByQuery: Map<string, string[]>,
): Array<{ instructionId: string; taskId: string }> {
  const matches: Array<{ instructionId: string; taskId: string }> = [];
  for (const instruction of instructions) {
    for (const taskId of taskIdsByQuery.get(instruction.query) ?? []) {
      matches.push({ instructionId: instruction.id, taskId });
    }
  }
  return matches.sort((a, b) => a.instructionId.localeCompare(b.instructionId) || a.taskId.localeCompare(b.taskId));
}

function rowCacheSurfaceId(key: string): string | null {
  if (key.startsWith("rows:")) return key.slice("rows:".length).split(":", 1)[0] || null;
  if (key.startsWith("output:")) return key.slice("output:".length).split(":", 1)[0] || null;
  return null;
}

function materializedRowCacheTtlMs(): number {
  const raw = process.env.UNBLOCK_PRISM_MATERIALIZED_ROW_CACHE_MS;
  if (raw === undefined) return 250;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 250;
}

function useBatchMaterializedReads(): boolean {
  return process.env.UNBLOCK_PRISM_BATCH_MATERIALIZED_READS !== "0";
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

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

type RuntimeMethod =
  | "CompileRuntimeQueryFragment"
  | "SubmitSemanticCommit"
  | "ReadMaterializedSurface"
  | "ReadMaterializedSurfaces"
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
  receipt_json?: string;
  elapsed_ms?: number;
  operation_count?: number;
  mutation_count?: number;
}

interface MaterializedSurfaceResponse {
  outputs: Array<{ output_json: string }>;
}

interface MaterializedSurfaceBatchResponse {
  responses: MaterializedSurfaceResponse[];
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

interface CompileRuntimeQueryFragmentResponse {
  project_id: string;
  app_id: string;
  fragment_id: string;
  fragment_hash: string;
  base_manifest_hash: string;
  state: string;
  artifact_json: string;
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

type DependencySummaryRow = {
  project_id: string;
  task_id: string;
  dependency_count: number;
  dependency_ids: string[];
};

type HierarchyRow = {
  project_id: string;
  parent_task_id: string;
  task_id: string;
};

type DescendantSummaryRow = {
  project_id: string;
  task_id: string;
  descendants_count: number;
  descendant_ids: string[];
};

type TaskLabelRow = {
  project_id: string;
  task_id: string;
  label_id: string;
  assigned_at: string;
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

type InstructionSelectorCatalogRow = {
  project_id: string;
  instruction_id: string;
  selector_text: string;
  selector_hash: string;
  selector_fragment_id: string | null;
  selector_fragment_hash: string | null;
  body: string;
  enabled: boolean;
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
