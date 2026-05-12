import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MouseEvent, type SetStateAction } from "react";
import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import { createRoot, type Root } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import {
  Activity,
  Archive,
  Blocks,
  BookOpen,
  Check,
  ChevronDown,
  CircleDot,
  Edit3,
  Filter,
  GitBranch,
  ListChecks,
  ListTree,
  MessageSquare,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Tags,
  UserRound,
  X
} from "lucide-react";
import remarkGfm from "remark-gfm";
import "./styles.css";

type Lifecycle = "open" | "started" | "finished";
type ComputedStatus = "ready" | "blocked" | "started" | "finished" | "archived";
type RollupStatus = "leaf" | "complete" | "blocked-by-children";
type Size = "XS" | "S" | "M" | "L" | "XL";
type Priority = 0 | 1 | 2 | 3 | 4;

interface TagRecord {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
  sortOrder: number;
  archivedAt: string | null;
}

interface TrackRecord {
  id: string;
  machine: string;
  actor: string;
  name: string | null;
  archivedAt: string | null;
}

interface ProjectRecord {
  id: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
}

interface TaskView {
  id: string;
  parentTaskId: string | null;
  title: string;
  description: string;
  lifecycle: Lifecycle;
  computedStatus: ComputedStatus;
  priority: Priority;
  size: Size | null;
  sourceDoc: string | null;
  sourceSection: string | null;
  completionBar: string | null;
  archivedAt: string | null;
  ready: boolean;
  blocked: boolean;
  unfinishedDependenciesCount: number;
  finishedDependenciesCount: number;
  dependencyDepth: number;
  dependentsCount: number;
  transitiveDependentsCount: number;
  parent: { id: string; title: string; lifecycle: Lifecycle } | null;
  childrenCount: number;
  descendantsCount: number;
  leafDescendantsCount: number;
  finishedLeafDescendantsCount: number;
  subtreeProgress: number;
  subtreeOpenCount: number;
  subtreeReadyCount: number;
  subtreeBlockedCount: number;
  subtreeStartedCount: number;
  subtreeFinishedCount: number;
  hierarchyDepth: number;
  rollupStatus?: RollupStatus;
  unfinishedDescendantsCount?: number;
  criticalChildPath?: Array<{
    id: string;
    title: string;
    lifecycle: Lifecycle;
    computedStatus: ComputedStatus;
    unfinishedDependenciesCount: number;
  }>;
  assignedTrack: { trackId: string; machine: string; actor: string; name: string | null; position: string } | null;
  tags: TagRecord[];
  commentCount: number;
  recentCommentCount: number;
  lastCommentAt: string | null;
  commentAuthors: string[];
}

interface Explanation {
  task: TaskView;
  dependencies: TaskView[];
  unfinishedDependencies: TaskView[];
  finishedDependencies: TaskView[];
  directDependents: TaskView[];
  transitiveDependentsCount: number;
  assignable: boolean;
  reason: string;
  instructions: InstructionMatchRecord[];
}

interface InstructionRecord {
  projectId: string;
  id: string;
  name: string;
  query: string;
  body: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

interface InstructionMatchRecord {
  instruction: InstructionRecord;
  task: TaskView;
  reasons: string[];
}

interface CommentRecord {
  projectId: string;
  id: string;
  taskId: string;
  machine: string;
  actor: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

interface InstructionPreviewRecord {
  ok: boolean;
  errors: string[];
  matches: InstructionMatchRecord[];
}

interface InstructionGrammarRecord {
  fields: string[];
  fieldOperators: string[];
  comparisonOperators: string[];
  booleanOperators: string[];
  graphVerbs: string[];
  edgeKinds: string[];
  valueForms: Array<{ name: string; description: string }>;
  clauses: Array<{ name: string; forms: string[]; description: string }>;
  examples: string[];
  notes: string[];
}

interface InstructionFieldValueSuggestionRecord {
  field: string;
  value: string;
  label: string;
  detail: string;
  count: number;
}

interface SavedViewRecord {
  projectId: string;
  id: string;
  name: string;
  query: string;
  archivedAt: string | null;
}

interface QueueFeedRecord {
  projectId: string;
  id: string;
  name: string;
  query: string;
  archivedAt: string | null;
}

interface ActivityRecord {
  id: string;
  type: string;
  subjectType: string;
  subjectId: string | null;
  message: string;
  machine: string;
  actor: string;
  createdAt: string;
}

interface SourceCoverage {
  sourceDoc: string | null;
  sourceSection: string | null;
  total: number;
  open: number;
  ready: number;
  blocked: number;
  started: number;
  finished: number;
  archived: number;
}

type ViewMode = "tasks" | "queues" | "tags" | "instructions" | "coverage" | "activity";
type StatusFilter = ComputedStatus;
type TaskAction = "start" | "finish" | "reopen" | "archive" | "restore";

interface AppConfig {
  identity: {
    machine: string;
    actor: string;
  };
  ui: {
    refreshIntervalMs: number;
    persistState: boolean;
  };
  issues?: string[];
}

interface UiState {
  mode: ViewMode;
  projectId: string;
  selectedId: string | null;
  statusFilters: StatusFilter[];
  search: string;
  matcher: string;
  selectedViewId: string;
  collapsedTaskIds: string[];
  scrollPositions: Record<string, number>;
  newProjectDraft: string;
  newTrackDraft: string;
  newTagDraft: string;
}

interface RefreshOptions {
  silent?: boolean;
}

interface AppliedTaskFilters {
  statusFilters: StatusFilter[];
  search: string;
  matcher: string;
}

interface DependencyMode {
  targetIds: string[];
  draftByTaskId: Record<string, string[]>;
  dependencyMap: Record<string, string[]>;
  loading: boolean;
}

interface CreateTaskDraft {
  parentTaskId: string | null;
  id: string;
  title: string;
  priority: string;
}

interface DependencyCandidateState {
  selected: boolean;
  disabled: boolean;
  reason: string | null;
}

const UI_STATE_KEY = "unblock.ui-state.v1";
const STATUS_FILTER_ORDER: StatusFilter[] = ["ready", "blocked", "started", "finished", "archived"];
const DEFAULT_STATUS_FILTERS: StatusFilter[] = ["ready", "blocked", "started"];
const DEFAULT_APP_CONFIG: AppConfig = {
  identity: {
    machine: "",
    actor: ""
  },
  ui: {
    refreshIntervalMs: 5000,
    persistState: true
  },
  issues: []
};
const DEFAULT_UI_STATE: UiState = {
  mode: "tasks",
  projectId: "DEFAULT",
  selectedId: null,
  statusFilters: DEFAULT_STATUS_FILTERS,
  search: "",
  matcher: "",
  selectedViewId: "",
  collapsedTaskIds: [],
  scrollPositions: {},
  newProjectDraft: "",
  newTrackDraft: "",
  newTagDraft: ""
};

function App() {
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [tracks, setTracks] = useState<TrackRecord[]>([]);
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [instructions, setInstructions] = useState<InstructionRecord[]>([]);
  const [instructionGrammar, setInstructionGrammar] = useState<InstructionGrammarRecord | null>(null);
  const [savedViews, setSavedViews] = useState<SavedViewRecord[]>([]);
  const [queueFeeds, setQueueFeeds] = useState<QueueFeedRecord[]>([]);
  const [activity, setActivity] = useState<ActivityRecord[]>([]);
  const [coverage, setCoverage] = useState<SourceCoverage[]>([]);
  const [appConfig, setAppConfig] = useState<AppConfig>(DEFAULT_APP_CONFIG);
  const [identityDraft, setIdentityDraft] = useState(DEFAULT_APP_CONFIG.identity);
  const [uiState, setUiState] = usePersistentUiState(appConfig.ui.persistState);
  const [appliedFilters, setAppliedFilters] = useState<AppliedTaskFilters>(() => appliedFiltersFromUiState(uiState));
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [dependencyMode, setDependencyMode] = useState<DependencyMode | null>(null);
  const [createDraft, setCreateDraft] = useState<CreateTaskDraft | null>(null);
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [comments, setComments] = useState<CommentRecord[]>([]);
  const [commentDraft, setCommentDraft] = useState("");
  const [commentsFocusTarget, setCommentsFocusTarget] = useState<{ taskId: string; nonce: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [matcherSuggestTick, setMatcherSuggestTick] = useState(0);
  const taskTreeRef = useRef<HTMLDivElement | null>(null);
  const refreshRef = useRef<((options?: RefreshOptions) => Promise<void>) | null>(null);
  const filterRefreshReadyRef = useRef(false);
  const selectionAnchorRef = useRef<string | null>(null);
  const scrollPatchRef = useRef<Record<string, number>>({});
  const scrollFrameRef = useRef<number | null>(null);

  const selectedTask = useMemo(() => tasks.find((task) => task.id === uiState.selectedId) ?? tasks[0] ?? null, [uiState.selectedId, tasks]);
  const roots = useMemo(() => buildTaskTree(tasks), [tasks]);
  const readyTasks = useMemo(() => tasks.filter((task) => task.ready), [tasks]);
  const collapsedTaskIds = useMemo(() => new Set(uiState.collapsedTaskIds), [uiState.collapsedTaskIds]);
  const visibleTaskIds = useMemo(() => flattenVisibleTaskIds(roots, collapsedTaskIds), [roots, collapsedTaskIds]);
  const activeSelectedIds = useMemo(() => selectedIds.length > 0 ? selectedIds : selectedTask ? [selectedTask.id] : [], [selectedIds, selectedTask]);
  const activeSelectedIdSet = useMemo(() => new Set(activeSelectedIds), [activeSelectedIds]);
  const selectedTasks = useMemo(() => activeSelectedIds.map((id) => tasks.find((task) => task.id === id)).filter((task): task is TaskView => Boolean(task)), [activeSelectedIds, tasks]);
  const detailTask = selectedIds.length === 1 ? selectedTasks[0] ?? selectedTask : selectedTask;
  const activeProjects = useMemo(() => projects.filter((project) => !project.archivedAt), [projects]);
  const selectedProject = useMemo(() => projects.find((project) => project.id === uiState.projectId) ?? null, [projects, uiState.projectId]);
  const commentsFocusNonce = detailTask && commentsFocusTarget?.taskId === detailTask.id ? commentsFocusTarget.nonce : 0;

  const updateUiState = useCallback((update: Partial<UiState> | ((current: UiState) => UiState)) => {
    setUiState((current) => typeof update === "function" ? update(current) : { ...current, ...update });
  }, [setUiState]);

  useEffect(() => {
    fetchJson<AppConfig>("/api/config")
      .then((config) => {
        const normalized = normalizeAppConfig(config);
        setAppConfig(normalized);
        setIdentityDraft(normalized.identity);
      })
      .catch(() => setAppConfig(DEFAULT_APP_CONFIG));
    void refreshProjects();
    fetchJson<InstructionGrammarRecord>("/api/instructions/grammar").then(setInstructionGrammar).catch(() => setInstructionGrammar(null));
  }, []);

  const identityReady = Boolean(appConfig.identity.machine.trim() && appConfig.identity.actor.trim());

  useEffect(() => {
    if (!detailTask) {
      setExplanation(null);
      setComments([]);
      return;
    }
    fetchJson<Explanation>(withProject(`/api/tasks/${detailTask.id}/explain`, uiState.projectId)).then(setExplanation).catch((reason) => setError(String(reason)));
    fetchJson<CommentRecord[]>(withProject(`/api/tasks/${detailTask.id}/comments?limit=50`, uiState.projectId)).then(setComments).catch((reason) => setError(String(reason)));
  }, [detailTask?.id, uiState.projectId, dataVersion]);

  useEffect(() => {
    setCommentDraft("");
  }, [detailTask?.id]);

  useEffect(() => {
    if (projects.length === 0) {
      return;
    }
    if (projects.some((project) => project.id === uiState.projectId && !project.archivedAt)) {
      return;
    }
    const fallbackProject = activeProjects[0] ?? projects[0];
    if (fallbackProject) {
      updateUiState({ projectId: fallbackProject.id, selectedId: null, collapsedTaskIds: [] });
    }
  }, [activeProjects, projects, uiState.projectId, updateUiState]);

  useEffect(() => {
    setSelectedIds([]);
    setDependencyMode(null);
    setCreateDraft(null);
    selectionAnchorRef.current = null;
  }, [uiState.projectId]);

  useEffect(() => {
    const taskIds = new Set(tasks.map((task) => task.id));
    setSelectedIds((current) => current.filter((id) => taskIds.has(id)));
    if (dependencyMode && dependencyMode.targetIds.some((id) => !taskIds.has(id))) {
      setDependencyMode(null);
    }
  }, [tasks, dependencyMode]);

  const refresh = useCallback(async (options: RefreshOptions = {}) => {
    if (projects.length > 0 && !projects.some((project) => project.id === uiState.projectId && !project.archivedAt)) {
      return;
    }
    if (!options.silent) {
      setLoading(true);
    }
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("projectId", uiState.projectId);
      params.set("sort", "dependency");
      if (appliedFilters.search) {
        params.set("search", appliedFilters.search);
      }
      if (appliedFilters.matcher) {
        params.set("where", appliedFilters.matcher);
      }
      if (appliedFilters.statusFilters.includes("finished") || appliedFilters.statusFilters.includes("archived")) {
        params.set("includeFinished", "true");
      }
      if (appliedFilters.statusFilters.includes("archived")) {
        params.set("includeArchived", "true");
      }
      const [taskData, trackData, tagData, instructionData, viewData, feedData, activityData, coverageData] = await Promise.all([
        fetchJson<TaskView[]>(`/api/tasks?${params.toString()}`),
        fetchJson<TrackRecord[]>(withProject("/api/tracks", uiState.projectId)),
        fetchJson<TagRecord[]>(withProject("/api/tags", uiState.projectId)),
        fetchJson<InstructionRecord[]>(withProject("/api/instructions?includeArchived=true", uiState.projectId)),
        fetchJson<SavedViewRecord[]>(withProject("/api/views", uiState.projectId)),
        fetchJson<QueueFeedRecord[]>(withProject("/api/feeds", uiState.projectId)),
        fetchJson<ActivityRecord[]>(withProject("/api/activity?limit=40", uiState.projectId)),
        fetchJson<SourceCoverage[]>(withProject("/api/source-coverage", uiState.projectId))
      ]);
      const visibleTaskData = taskData.filter((task) => appliedFilters.statusFilters.includes(task.computedStatus));
      setTasks(visibleTaskData);
      setTracks(trackData);
      setTags(tagData);
      setInstructions(instructionData);
      setSavedViews(viewData);
      setQueueFeeds(feedData);
      setActivity(activityData);
      setCoverage(coverageData);
      updateUiState((current) => ({
        ...current,
        selectedId: current.selectedId && visibleTaskData.some((task) => task.id === current.selectedId)
          ? current.selectedId
          : visibleTaskData[0]?.id ?? null
      }));
      setDataVersion((version) => version + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!options.silent) {
        setLoading(false);
      }
    }
  }, [appliedFilters, projects, uiState.projectId, updateUiState]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (projects.length > 0) {
      void refresh({ silent: false });
    }
  }, [projects.length]);

  useEffect(() => {
    if (!filterRefreshReadyRef.current) {
      filterRefreshReadyRef.current = true;
      return;
    }
    void refresh({ silent: false });
  }, [refresh]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const nextSearch = uiState.search.trim();
      setAppliedFilters((current) => sameAppliedFilters(current, { ...current, search: nextSearch }) ? current : { ...current, search: nextSearch });
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [uiState.search]);

  useEffect(() => {
    const intervalMs = appConfig.ui.refreshIntervalMs;
    if (intervalMs <= 0) {
      return undefined;
    }
    const interval = window.setInterval(() => {
      void refreshRef.current?.({ silent: true });
    }, intervalMs);
    return () => window.clearInterval(interval);
  }, [appConfig.ui.refreshIntervalMs]);

  useEffect(() => {
    if (loading) {
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      const taskTreeScroll = uiState.scrollPositions["tasks.tree"];
      if (taskTreeRef.current && taskTreeScroll !== undefined) {
        taskTreeRef.current.scrollTop = taskTreeScroll;
      }
      const windowScroll = uiState.scrollPositions[`window.${uiState.mode}`];
      if (windowScroll !== undefined) {
        window.scrollTo({ top: windowScroll });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loading, uiState.mode]);

  useEffect(() => {
    const onScroll = () => recordScrollPosition(`window.${uiState.mode}`, window.scrollY);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [uiState.mode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (createDraft) {
        setCreateDraft(null);
        return;
      }
      if (dependencyMode) {
        setDependencyMode(null);
        return;
      }
      if (selectedIds.length > 1 && selectedTask) {
        setSelectedIds([selectedTask.id]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [createDraft, dependencyMode, selectedIds.length, selectedTask]);

  function recordScrollPosition(key: string, value: number) {
    scrollPatchRef.current[key] = value;
    if (scrollFrameRef.current !== null) {
      return;
    }
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      const patch = scrollPatchRef.current;
      scrollPatchRef.current = {};
      scrollFrameRef.current = null;
      updateUiState((current) => ({
        ...current,
        scrollPositions: { ...current.scrollPositions, ...patch }
      }));
    });
  }

  function toggleTaskExpanded(taskId: string) {
    updateUiState((current) => {
      const collapsed = new Set(current.collapsedTaskIds);
      if (collapsed.has(taskId)) {
        collapsed.delete(taskId);
      } else {
        collapsed.add(taskId);
      }
      return { ...current, collapsedTaskIds: [...collapsed].sort() };
    });
  }

  function selectTask(taskId: string, event: MouseEvent<HTMLDivElement>) {
    if (dependencyMode) {
      toggleDependencyCandidate(taskId);
      return;
    }
    const selectionAnchor = selectionAnchorRef.current ?? selectedTask?.id ?? null;
    if (event.shiftKey && selectionAnchor) {
      const range = getSelectionRange(visibleTaskIds, selectionAnchor, taskId);
      setSelectedIds(range);
      updateUiState({ selectedId: taskId });
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      setSelectedIds((current) => {
        const base = current.length > 0 ? current : selectedTask ? [selectedTask.id] : [];
        const next = base.includes(taskId) ? base.filter((id) => id !== taskId) : [...base, taskId];
        return next.length > 0 ? next : [taskId];
      });
      selectionAnchorRef.current = taskId;
      updateUiState({ selectedId: taskId });
      return;
    }
    selectionAnchorRef.current = taskId;
    setSelectedIds([taskId]);
    updateUiState({ selectedId: taskId });
  }

  function selectSubtree(taskId: string) {
    const subtreeIds = getSubtreeTaskIds(taskId, tasks);
    selectionAnchorRef.current = taskId;
    setSelectedIds(subtreeIds);
    updateUiState({ selectedId: taskId });
  }

  function selectDisplayedTasks() {
    const ids = tasks.map((task) => task.id);
    setSelectedIds(ids);
    if (ids[0]) {
      selectionAnchorRef.current = ids[0];
      updateUiState({ selectedId: ids[0] });
    }
  }

  function openTask(taskId: string) {
    selectionAnchorRef.current = taskId;
    setDependencyMode(null);
    setCreateDraft(null);
    setSelectedIds([taskId]);
    updateUiState({ mode: "tasks", selectedId: taskId });
  }

  function openTaskComments(taskId: string) {
    openTask(taskId);
    setCommentsFocusTarget({ taskId, nonce: Date.now() });
  }

  function startCreateTask(parentTaskId: string | null) {
    setDependencyMode(null);
    setCreateDraft({ parentTaskId, id: "", title: "", priority: "2" });
    if (parentTaskId) {
      updateUiState((current) => ({
        ...current,
        collapsedTaskIds: current.collapsedTaskIds.filter((id) => id !== parentTaskId)
      }));
    }
  }

  async function refreshProjects() {
    try {
      const projectData = await fetchJson<ProjectRecord[]>("/api/projects");
      setProjects(projectData);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function createProject() {
    const draft = uiState.newProjectDraft.trim();
    if (!draft) {
      return;
    }
    const nextId = draft.toUpperCase().replace(/\s+/g, "-");
    await runMutation(async () => {
      await mutate("/api/projects", { method: "POST", body: { id: nextId, name: draft } });
      updateUiState({ projectId: nextId, selectedId: null, collapsedTaskIds: [], newProjectDraft: "" });
      await refreshProjects();
      await refresh();
    });
  }

  async function saveIdentity() {
    await runMutation(async () => {
      const config = await mutateJson<AppConfig>("/api/config", {
        method: "PATCH",
        body: { identity: identityDraft }
      });
      const normalized = normalizeAppConfig(config);
      setAppConfig(normalized);
      setIdentityDraft(normalized.identity);
    });
  }

  async function createTask() {
    if (!createDraft?.id.trim() || !createDraft.title.trim()) {
      return;
    }
    const nextId = createDraft.id.trim().toUpperCase();
    await runMutation(async () => {
      await mutate(withProject("/api/tasks", uiState.projectId), {
        method: "POST",
        body: {
          id: createDraft.id,
          title: createDraft.title.trim(),
          parentTaskId: createDraft.parentTaskId,
          priority: Number(createDraft.priority)
        }
      });
      setCreateDraft(null);
      selectionAnchorRef.current = nextId;
      setSelectedIds([nextId]);
      updateUiState({ selectedId: nextId });
      await refresh();
    });
  }

  async function transitionTask(task: TaskView, action: TaskAction) {
    await runMutation(async () => {
      await mutate(withProject(`/api/tasks/${task.id}/${action}`, uiState.projectId), { method: "POST" });
      await refresh();
    });
  }

  async function bulkTransition(action: TaskAction) {
    await runMutation(async () => {
      for (const task of selectedTasks) {
        if (action !== "restore" && task.archivedAt) {
          continue;
        }
        if (action === "start" && task.lifecycle !== "open") {
          continue;
        }
        if (action === "finish" && task.lifecycle === "finished") {
          continue;
        }
        if (action === "archive" && task.archivedAt) {
          continue;
        }
        if (action === "restore" && !task.archivedAt) {
          continue;
        }
        await mutate(withProject(`/api/tasks/${task.id}/${action}`, uiState.projectId), { method: "POST" });
      }
      await refresh();
    });
  }

  async function updateTask(task: TaskView, input: { title: string; description: string }) {
    await runMutation(async () => {
      await mutate(withProject(`/api/tasks/${task.id}`, uiState.projectId), {
        method: "PATCH",
        body: {
          title: input.title,
          description: input.description
        }
      });
      await refresh();
    });
  }

  async function addComment(task: TaskView) {
    const body = commentDraft.trim();
    if (!body) {
      return;
    }
    await runMutation(async () => {
      await mutate(withProject(`/api/tasks/${task.id}/comments`, uiState.projectId), { method: "POST", body: { body } });
      setCommentDraft("");
      setComments(await fetchJson<CommentRecord[]>(withProject(`/api/tasks/${task.id}/comments?limit=50`, uiState.projectId)));
    });
  }

  async function archiveComment(comment: CommentRecord) {
    await runMutation(async () => {
      await mutate(withProject(`/api/comments/${comment.id}/archive`, uiState.projectId), { method: "POST" });
      setComments(await fetchJson<CommentRecord[]>(withProject(`/api/tasks/${comment.taskId}/comments?limit=50`, uiState.projectId)));
    });
  }

  async function createTrack() {
    if (!uiState.newTrackDraft.trim()) {
      return;
    }
    await runMutation(async () => {
      await mutate(withProject("/api/tracks", uiState.projectId), { method: "POST", body: { actor: uiState.newTrackDraft.trim() } });
      updateUiState({ newTrackDraft: "" });
      await refresh();
    });
  }

  async function createTag() {
    if (!uiState.newTagDraft.trim()) {
      return;
    }
    await runMutation(async () => {
      await mutate(withProject("/api/tags", uiState.projectId), { method: "POST", body: { name: uiState.newTagDraft.trim() } });
      updateUiState({ newTagDraft: "" });
      await refresh();
    });
  }

  async function assignTask(track: TrackRecord, task: TaskView) {
    await runMutation(async () => {
      await mutate(withProject(`/api/tracks/${track.id}/assignments`, uiState.projectId), { method: "POST", body: { taskId: task.id } });
      await refresh();
    });
  }

  async function bulkAssignTask(track: TrackRecord) {
    await runMutation(async () => {
      for (const task of selectedTasks) {
        if (task.assignedTrack || task.archivedAt || task.lifecycle === "finished") {
          continue;
        }
        await mutate(withProject(`/api/tracks/${track.id}/assignments`, uiState.projectId), { method: "POST", body: { taskId: task.id } });
      }
      await refresh();
    });
  }

  async function bulkUnassignTask() {
    await runMutation(async () => {
      for (const task of selectedTasks) {
        if (!task.assignedTrack) {
          continue;
        }
        await mutate(withProject(`/api/tracks/${task.assignedTrack.trackId}/assignments/${task.id}`, uiState.projectId), { method: "DELETE" });
      }
      await refresh();
    });
  }

  async function unassignTask(task: TaskView) {
    if (!task.assignedTrack) {
      return;
    }
    await runMutation(async () => {
      await mutate(withProject(`/api/tracks/${task.assignedTrack?.trackId}/assignments/${task.id}`, uiState.projectId), { method: "DELETE" });
      await refresh();
    });
  }

  async function assignTag(task: TaskView, tagId: string) {
    if (!tagId) {
      return;
    }
    await runMutation(async () => {
      await mutate(withProject(`/api/tasks/${task.id}/tags/${tagId}`, uiState.projectId), { method: "POST" });
      await refresh();
    });
  }

  async function bulkAssignTag(tagId: string) {
    if (!tagId) {
      return;
    }
    await runMutation(async () => {
      for (const task of selectedTasks) {
        if (task.tags.some((tag) => tag.id === tagId)) {
          continue;
        }
        await mutate(withProject(`/api/tasks/${task.id}/tags/${tagId}`, uiState.projectId), { method: "POST" });
      }
      await refresh();
    });
  }

  async function removeTag(task: TaskView, tagId: string) {
    await runMutation(async () => {
      await mutate(withProject(`/api/tasks/${task.id}/tags/${tagId}`, uiState.projectId), { method: "DELETE" });
      await refresh();
    });
  }

  async function runMutation(fn: () => Promise<void>) {
    setError(null);
    try {
      await fn();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function startDependencyMode(targetIds: string[]) {
    const uniqueTargetIds = [...new Set(targetIds)].filter((id) => tasks.some((task) => task.id === id));
    if (uniqueTargetIds.length === 0) {
      return;
    }
    setError(null);
    setDependencyMode({ targetIds: uniqueTargetIds, draftByTaskId: {}, dependencyMap: {}, loading: true });
    try {
      const explanations = await Promise.all(tasks.map((task) => fetchJson<Explanation>(withProject(`/api/tasks/${task.id}/explain`, uiState.projectId))));
      const dependencyMap = Object.fromEntries(explanations.map((item) => [item.task.id, item.dependencies.map((dependency) => dependency.id)]));
      const draftByTaskId = Object.fromEntries(uniqueTargetIds.map((id) => [id, [...(dependencyMap[id] ?? [])]]));
      setDependencyMode({ targetIds: uniqueTargetIds, draftByTaskId, dependencyMap, loading: false });
    } catch (reason) {
      setDependencyMode(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function toggleDependencyCandidate(candidateId: string) {
    setDependencyMode((current) => {
      if (!current || current.loading) {
        return current;
      }
      const state = getDependencyCandidateState(candidateId, current, tasks);
      if (state.disabled) {
        return current;
      }
      const allSelected = current.targetIds.every((targetId) => current.draftByTaskId[targetId]?.includes(candidateId));
      const draftByTaskId = Object.fromEntries(current.targetIds.map((targetId) => {
        const currentIds = current.draftByTaskId[targetId] ?? [];
        const nextIds = allSelected
          ? currentIds.filter((id) => id !== candidateId)
          : currentIds.includes(candidateId)
            ? currentIds
            : [...currentIds, candidateId];
        return [targetId, nextIds];
      }));
      return { ...current, draftByTaskId: { ...current.draftByTaskId, ...draftByTaskId } };
    });
  }

  async function saveDependencyMode() {
    if (!dependencyMode || dependencyMode.loading) {
      return;
    }
    await runMutation(async () => {
      for (const targetId of dependencyMode.targetIds) {
        await mutate(withProject(`/api/tasks/${targetId}/dependencies`, uiState.projectId), {
          method: "PUT",
          body: { dependencyIds: dependencyMode.draftByTaskId[targetId] ?? [] }
        });
      }
      setDependencyMode(null);
      await refresh();
    });
  }

  async function saveCurrentMatcherAsView() {
    const query = uiState.matcher.trim();
    if (!query) {
      return;
    }
    const name = window.prompt("Saved view name");
    if (!name?.trim()) {
      return;
    }
    await runMutation(async () => {
      const saved = await mutateJson<SavedViewRecord>(withProject("/api/views", uiState.projectId), {
        method: "POST",
        body: { name: name.trim(), query }
      });
      updateUiState({ selectedViewId: saved.id });
      await refresh();
    });
  }

  function toggleStatusFilter(status: StatusFilter) {
    const nextStatuses = uiState.statusFilters.includes(status)
      ? uiState.statusFilters.filter((candidate) => candidate !== status)
      : [...uiState.statusFilters, status];
    const nextFilters = {
      statusFilters: nextStatuses,
      search: uiState.search.trim(),
      matcher: appliedFilters.matcher
    };
    updateUiState({ statusFilters: nextStatuses });
    setAppliedFilters((current) => sameAppliedFilters(current, nextFilters) ? current : nextFilters);
  }

  function applySearchNow() {
    const nextSearch = uiState.search.trim();
    setAppliedFilters((current) => sameAppliedFilters(current, { ...current, search: nextSearch }) ? current : { ...current, search: nextSearch });
  }

  function applyMatcherNow() {
    const nextMatcher = uiState.matcher.trim();
    setAppliedFilters((current) => sameAppliedFilters(current, { ...current, matcher: nextMatcher }) ? current : { ...current, matcher: nextMatcher });
  }

  function showMatcherSuggestions() {
    setMatcherSuggestTick((tick) => tick + 1);
  }

  function applySavedView(viewId: string) {
    const selected = savedViews.find((view) => view.id === viewId);
    const matcher = selected?.query ?? "";
    updateUiState({ selectedViewId: viewId, matcher });
    setAppliedFilters((current) => {
      const next = { ...current, matcher };
      return sameAppliedFilters(current, next) ? current : next;
    });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <GitBranch size={22} />
          <span>unblock</span>
        </div>
        <div className="project-switcher">
          <label>
            <span>Project</span>
            <select
              value={uiState.projectId}
              onChange={(event) => updateUiState({ projectId: event.target.value, selectedId: null, collapsedTaskIds: [] })}
            >
              {activeProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              {selectedProject?.archivedAt ? <option value={selectedProject.id}>{selectedProject.name} (archived)</option> : null}
            </select>
          </label>
          <div className="project-create">
            <input
              value={uiState.newProjectDraft}
              onChange={(event) => updateUiState({ newProjectDraft: event.target.value })}
              onKeyDown={(event) => event.key === "Enter" && void createProject()}
              placeholder="New project"
            />
            <button className="icon-button" onClick={() => void createProject()} title="Create project"><Plus size={15} /></button>
          </div>
        </div>
        <div className="identity-panel">
          <label>
            <span>Machine</span>
            <input value={identityDraft.machine} onChange={(event) => setIdentityDraft((current) => ({ ...current, machine: event.target.value }))} placeholder="machine" />
          </label>
          <label>
            <span>Actor</span>
            <input value={identityDraft.actor} onChange={(event) => setIdentityDraft((current) => ({ ...current, actor: event.target.value }))} placeholder="actor" />
          </label>
          <button disabled={identityDraft.machine.trim() === appConfig.identity.machine && identityDraft.actor.trim() === appConfig.identity.actor} onClick={() => void saveIdentity()}>Save identity</button>
        </div>
        <nav className="nav">
          <NavButton active={uiState.mode === "tasks"} icon={<ListTree size={17} />} label="Tasks" onClick={() => updateUiState({ mode: "tasks" })} />
          <NavButton active={uiState.mode === "queues"} icon={<UserRound size={17} />} label="Queues" onClick={() => updateUiState({ mode: "queues" })} />
          <NavButton active={uiState.mode === "tags"} icon={<Tags size={17} />} label="Tags" onClick={() => updateUiState({ mode: "tags" })} />
          <NavButton active={uiState.mode === "instructions"} icon={<BookOpen size={17} />} label="Instructions" onClick={() => updateUiState({ mode: "instructions" })} />
          <NavButton active={uiState.mode === "coverage"} icon={<Blocks size={17} />} label="Coverage" onClick={() => updateUiState({ mode: "coverage" })} />
          <NavButton active={uiState.mode === "activity"} icon={<Activity size={17} />} label="Activity" onClick={() => updateUiState({ mode: "activity" })} />
        </nav>
        <div className="ready-summary">
          <div>
            <span className="metric">{readyTasks.length}</span>
            <span className="label">ready</span>
          </div>
          <div>
            <span className="metric">{tasks.reduce((sum, task) => sum + (task.blocked ? 1 : 0), 0)}</span>
            <span className="label">blocked</span>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="toolbar">
          <div className="toolbar-main-row">
            <div className="search-wrap">
              <Search size={17} />
              <input value={uiState.search} onChange={(event) => updateUiState({ search: event.target.value })} onKeyDown={(event) => event.key === "Enter" && applySearchNow()} placeholder="Search tasks, assignees, tags, docs" />
            </div>
            <StatusTabs
              value={uiState.statusFilters}
              onChange={toggleStatusFilter}
            />
            <button className="icon-button" onClick={() => void refresh()} title="Refresh"><RefreshCw size={17} /></button>
          </div>
          <div className="toolbar-matcher-row">
            <div className={uiState.matcher.trim() !== appliedFilters.matcher ? "top-matcher dirty" : "top-matcher"}>
              <button className="matcher-icon-button" onClick={showMatcherSuggestions} title="Show matcher suggestions"><Filter size={17} /></button>
              <TopMatcherEditor
                value={uiState.matcher}
                projectId={uiState.projectId}
                grammar={instructionGrammar}
                suggestSignal={matcherSuggestTick}
                onChange={(matcher) => updateUiState({ matcher, selectedViewId: "" })}
                onApply={applyMatcherNow}
              />
              {!uiState.matcher ? <span className="matcher-placeholder">tag = backend and status = ready</span> : null}
            </div>
            <span className="shortcut-hint matcher-shortcut"><kbd>Shift</kbd> + <kbd>Enter</kbd></span>
            <button className="primary-button" disabled={uiState.matcher.trim() === appliedFilters.matcher} onClick={applyMatcherNow}><Check size={16} /> Apply</button>
            <select value={uiState.selectedViewId} onChange={(event) => applySavedView(event.target.value)} title="Saved view">
              <option value="">Saved view</option>
              {savedViews.filter((view) => !view.archivedAt).map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
            </select>
            <button disabled={!uiState.matcher.trim() || !identityReady} onClick={() => void saveCurrentMatcherAsView()} title="Save matcher as view"><Plus size={16} /> View</button>
          </div>
        </header>

        {error ? <div className="error">{error}</div> : null}
        {loading ? <div className="loading">Loading dependency graph...</div> : null}

        {appConfig.issues?.length ? <div className="warning">Config warning: {appConfig.issues.join("; ")}</div> : null}
        {!identityReady ? <div className="warning">Set machine and actor in the sidebar before mutating tasks.</div> : null}

        {uiState.mode === "tasks" ? (
          <section className="task-layout">
            <div className="task-list-panel">
              <div className="panel-heading">
                <div>
                  <h1>Dependency-First Tasks</h1>
                  <p>Default order ranks ready work by downstream tasks unblocked, then priority and graph depth.</p>
                </div>
                <div className="panel-heading-actions">
                  <button disabled={tasks.length === 0} onClick={selectDisplayedTasks}><ListChecks size={16} /> Select displayed</button>
                  <button onClick={() => startCreateTask(null)}><Plus size={16} /> New root task</button>
                  <button className="icon-button" onClick={showMatcherSuggestions} title="Show matcher suggestions"><Filter size={18} /></button>
                </div>
              </div>
              <div className="task-list-header">
                <span />
                <span />
                <span>Task</span>
                <span>Signals</span>
                <span />
              </div>
              <div className="task-tree" ref={taskTreeRef} onScroll={(event) => recordScrollPosition("tasks.tree", event.currentTarget.scrollTop)}>
                {createDraft?.parentTaskId === null ? (
                  <CreateTaskRow
                    draft={createDraft}
                    depth={0}
                    onChange={setCreateDraft}
                    onSubmit={() => void createTask()}
                    onCancel={() => setCreateDraft(null)}
                  />
                ) : null}
                {roots.map((node) => (
                  <TaskNode
                    key={node.task.id}
                    node={node}
                    selectedId={selectedTask?.id ?? null}
                    selectedIds={activeSelectedIdSet}
                    collapsedTaskIds={collapsedTaskIds}
                    dependencyMode={dependencyMode}
                    createDraft={createDraft}
                    tasks={tasks}
                    onSelect={selectTask}
                    onSelectSubtree={selectSubtree}
                    onStartCreateSubtask={startCreateTask}
                    onOpenComments={openTaskComments}
                    onCreateDraftChange={setCreateDraft}
                    onCreateDraftSubmit={() => void createTask()}
                    onCreateDraftCancel={() => setCreateDraft(null)}
                    onToggleExpanded={toggleTaskExpanded}
                    onTransition={transitionTask}
                  />
                ))}
              </div>
            </div>
            {dependencyMode ? (
              <DependencyModePanel
                mode={dependencyMode}
                tasks={tasks}
                onSave={() => void saveDependencyMode()}
                onCancel={() => setDependencyMode(null)}
              />
            ) : selectedTasks.length > 1 ? (
              <BulkTaskDetails
                tasks={selectedTasks}
                tracks={tracks}
                tags={tags}
                onAssign={(track) => void bulkAssignTask(track)}
                onUnassign={() => void bulkUnassignTask()}
                onAssignTag={(tagId) => void bulkAssignTag(tagId)}
                onTransition={(action) => void bulkTransition(action)}
                onEditDependencies={() => void startDependencyMode(activeSelectedIds)}
                onClear={() => {
                  const fallbackId = selectedTasks[0]?.id ?? selectedTask?.id ?? null;
                  setSelectedIds(fallbackId ? [fallbackId] : []);
                }}
              />
            ) : (
              <TaskDetails
                task={detailTask}
                explanation={explanation}
                comments={comments}
                commentDraft={commentDraft}
                commentsFocusNonce={commentsFocusNonce}
                identityReady={identityReady}
                tracks={tracks}
                tags={tags}
                onCommentDraftChange={setCommentDraft}
                onAddComment={(task) => void addComment(task)}
                onArchiveComment={(comment) => void archiveComment(comment)}
                onAssign={(track, task) => void assignTask(track, task)}
                onUnassign={(task) => void unassignTask(task)}
                onAssignTag={(task, tagId) => void assignTag(task, tagId)}
                onRemoveTag={(task, tagId) => void removeTag(task, tagId)}
                onUpdate={(task, input) => void updateTask(task, input)}
                onTransition={(task, action) => void transitionTask(task, action)}
                onEditDependencies={(task) => void startDependencyMode([task.id])}
                onSelectSubtree={(task) => selectSubtree(task.id)}
                onStartCreateSubtask={(task) => startCreateTask(task.id)}
              />
            )}
          </section>
        ) : null}

        {uiState.mode === "queues" ? (
          <QueuesView tracks={tracks} tasks={tasks} feeds={queueFeeds} projectId={uiState.projectId} newTrack={uiState.newTrackDraft} setNewTrack={(newTrackDraft) => updateUiState({ newTrackDraft })} createTrack={() => void createTrack()} onAssign={(track, task) => void assignTask(track, task)} onOpenTask={(task) => openTask(task.id)} />
        ) : null}

        {uiState.mode === "tags" ? (
          <TagsView tags={tags} tasks={tasks} newTag={uiState.newTagDraft} setNewTag={(newTagDraft) => updateUiState({ newTagDraft })} createTag={() => void createTag()} />
        ) : null}

        {uiState.mode === "instructions" ? (
          <InstructionsView
            key={uiState.projectId}
            projectId={uiState.projectId}
            instructions={instructions}
            grammar={instructionGrammar}
            tasks={tasks}
            onRefresh={() => refresh({ silent: true })}
            onOpenTask={(task) => openTask(task.id)}
          />
        ) : null}

        {uiState.mode === "coverage" ? <CoverageView coverage={coverage} /> : null}
        {uiState.mode === "activity" ? <ActivityView activity={activity} /> : null}
      </main>
    </div>
  );
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return <button className={active ? "nav-button active" : "nav-button"} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function TopMatcherEditor({
  value,
  projectId,
  grammar,
  suggestSignal,
  onChange,
  onApply
}: {
  value: string;
  projectId: string;
  grammar: InstructionGrammarRecord | null;
  suggestSignal: number;
  onChange: (value: string) => void;
  onApply: () => void;
}) {
  const completionProviderRef = useRef<{ dispose: () => void } | null>(null);
  const editorRef = useRef<any>(null);
  const onApplyRef = useRef(onApply);

  useEffect(() => {
    onApplyRef.current = onApply;
  }, [onApply]);

  useEffect(() => () => completionProviderRef.current?.dispose(), []);

  useEffect(() => {
    if (suggestSignal > 0 && editorRef.current) {
      editorRef.current.focus();
      editorRef.current.trigger("toolbar", "editor.action.triggerSuggest", {});
    }
  }, [suggestSignal]);

  const handleMount = useCallback<OnMount>((editor, monaco) => {
    editorRef.current = editor;
    if (grammar) {
      completionProviderRef.current?.dispose();
      completionProviderRef.current = registerInstructionCompletions(monaco, projectId, grammar);
    }
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space, () => {
      editor.trigger("keyboard", "editor.action.triggerSuggest", {});
    });
    editor.onKeyDown((event: any) => {
      if (event.keyCode !== monaco.KeyCode.Enter && event.browserEvent.key !== "Enter") {
        return;
      }
      if (event.shiftKey || event.browserEvent.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        event.browserEvent.preventDefault();
        event.browserEvent.stopPropagation();
        editor.trigger("keyboard", "hideSuggestWidget", {});
        onApplyRef.current();
        return;
      }
      const suggestVisible = Boolean((editor as any)._contextKeyService?.getContextKeyValue?.("suggestWidgetVisible"));
      if (!suggestVisible) {
        event.preventDefault();
        event.stopPropagation();
        event.browserEvent.preventDefault();
        event.browserEvent.stopPropagation();
      }
    });
  }, [grammar, projectId]);

  return (
    <div
      className="top-matcher-editor"
      onKeyDownCapture={(event) => {
        if (event.key === "Enter" && event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          editorRef.current?.trigger("keyboard", "hideSuggestWidget", {});
          onApplyRef.current();
        }
      }}
    >
      <Editor
        key={`${projectId}-${grammar ? "ready" : "loading"}-top-matcher`}
        height="34px"
        defaultLanguage="unblock-query"
        language="unblock-query"
        theme="unblock"
        beforeMount={configureInstructionLanguage}
        onMount={handleMount}
        value={value}
        options={{
          minimap: { enabled: false },
          fontSize: 14,
          lineHeight: 22,
          lineNumbers: "off",
          folding: false,
          wordWrap: "off",
          scrollBeyondLastLine: false,
          overviewRulerLanes: 0,
          renderLineHighlight: "none",
          glyphMargin: false,
          lineDecorationsWidth: 0,
          lineNumbersMinChars: 0,
          scrollbar: { horizontal: "hidden", vertical: "hidden" },
          padding: { top: 6, bottom: 0 },
          quickSuggestions: true,
          suggestOnTriggerCharacters: true,
          fixedOverflowWidgets: true
        }}
        onChange={(next) => onChange((next ?? "").replace(/\s*\r?\n\s*/g, " "))}
      />
    </div>
  );
}

function StatusTabs({ value, onChange }: { value: StatusFilter[]; onChange: (status: StatusFilter) => void }) {
  const filters: Array<{ value: StatusFilter; label: string }> = [
    { value: "ready", label: "Ready" },
    { value: "blocked", label: "Blocked" },
    { value: "started", label: "Started" },
    { value: "finished", label: "Finished" },
    { value: "archived", label: "Archived" }
  ];
  return (
    <div className="status-tabs" role="tablist" aria-label="Task status filter">
      {filters.map((filter) => (
        <button
          key={filter.value}
          className={value.includes(filter.value) ? "status-tab active" : "status-tab"}
          onClick={() => onChange(filter.value)}
          role="tab"
          aria-selected={value.includes(filter.value)}
          aria-pressed={value.includes(filter.value)}
        >
          {filter.label}
        </button>
      ))}
    </div>
  );
}

function CreateTaskRow({
  draft,
  depth,
  onChange,
  onSubmit,
  onCancel
}: {
  draft: CreateTaskDraft;
  depth: number;
  onChange: Dispatch<SetStateAction<CreateTaskDraft | null>>;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const idInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    idInputRef.current?.focus();
  }, [draft.parentTaskId]);

  const patchDraft = (patch: Partial<CreateTaskDraft>) => onChange((current) => current ? { ...current, ...patch } : current);
  const canCreate = draft.id.trim().length > 0 && draft.title.trim().length > 0;
  return (
    <div
      className="task-create-row"
      style={{ paddingLeft: `${12 + depth * 22}px` }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
        if (event.key === "Enter") {
          event.preventDefault();
          onSubmit();
        }
      }}
    >
      <span className="create-disclosure-spacer" />
      <StatusDot status="ready" />
      <div className="create-main">
        <input ref={idInputRef} value={draft.id} onChange={(event) => patchDraft({ id: event.target.value })} placeholder="ID" />
        <input value={draft.title} onChange={(event) => patchDraft({ title: event.target.value })} placeholder="Task title" />
        <select value={draft.priority} onChange={(event) => patchDraft({ priority: event.target.value })} aria-label="Priority">
          <option value="4">Urgent</option>
          <option value="3">High</option>
          <option value="2">Normal</option>
          <option value="1">Low</option>
          <option value="0">Someday</option>
        </select>
      </div>
      <span />
      <div className="create-actions">
        <button className="primary-button" disabled={!canCreate} onClick={onSubmit}><Plus size={15} /> Add</button>
        <button onClick={onCancel}><X size={15} /></button>
      </div>
    </div>
  );
}

interface TreeNode {
  task: TaskView;
  children: TreeNode[];
}

function buildTaskTree(tasks: TaskView[]): TreeNode[] {
  const nodeById = new Map(tasks.map((task) => [task.id, { task, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];
  for (const task of tasks) {
    const node = nodeById.get(task.id);
    if (!node) {
      continue;
    }
    const parent = task.parentTaskId ? nodeById.get(task.parentTaskId) : null;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function flattenVisibleTaskIds(nodes: TreeNode[], collapsedTaskIds: Set<string>): string[] {
  const result: string[] = [];
  const visit = (node: TreeNode) => {
    result.push(node.task.id);
    if (!collapsedTaskIds.has(node.task.id)) {
      node.children.forEach(visit);
    }
  };
  nodes.forEach(visit);
  return result;
}

function getSelectionRange(visibleTaskIds: string[], anchorId: string, taskId: string): string[] {
  const anchorIndex = visibleTaskIds.indexOf(anchorId);
  const taskIndex = visibleTaskIds.indexOf(taskId);
  if (anchorIndex === -1 || taskIndex === -1) {
    return [taskId];
  }
  const start = Math.min(anchorIndex, taskIndex);
  const end = Math.max(anchorIndex, taskIndex);
  return visibleTaskIds.slice(start, end + 1);
}

function getSubtreeTaskIds(taskId: string, tasks: TaskView[]): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const task of tasks) {
    if (!task.parentTaskId) {
      continue;
    }
    childrenByParent.set(task.parentTaskId, [...(childrenByParent.get(task.parentTaskId) ?? []), task.id]);
  }
  const result = [taskId];
  const stack = [...(childrenByParent.get(taskId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || result.includes(current)) {
      continue;
    }
    result.push(current);
    stack.push(...(childrenByParent.get(current) ?? []));
  }
  return result;
}

function isTaskDescendant(taskId: string, possibleDescendantId: string, tasks: TaskView[]): boolean {
  return getSubtreeTaskIds(taskId, tasks).slice(1).includes(possibleDescendantId);
}

function getDependencyCandidateState(candidateId: string, mode: DependencyMode, tasks: TaskView[]): DependencyCandidateState {
  const selected = mode.targetIds.some((targetId) => mode.draftByTaskId[targetId]?.includes(candidateId));
  if (mode.loading) {
    return { selected, disabled: true, reason: "Loading dependency graph." };
  }
  if (mode.targetIds.includes(candidateId)) {
    return { selected, disabled: true, reason: "A target task cannot depend on itself." };
  }
  for (const targetId of mode.targetIds) {
    if (isTaskDescendant(targetId, candidateId, tasks)) {
      return { selected, disabled: true, reason: "Hierarchy descendants cannot be dependencies." };
    }
    if (isTaskDescendant(candidateId, targetId, tasks)) {
      return { selected, disabled: true, reason: "Hierarchy ancestors cannot be dependencies." };
    }
    const graph = { ...mode.dependencyMap, ...mode.draftByTaskId };
    if (hasDependencyPath(candidateId, targetId, graph)) {
      return { selected, disabled: true, reason: "This dependency would create a cycle." };
    }
  }
  return { selected, disabled: false, reason: null };
}

function getDependencyPreview(task: TaskView, mode: DependencyMode | null, tasks: TaskView[]): { status: ComputedStatus; unfinishedDependenciesCount: number } {
  if (!mode || mode.loading || !mode.targetIds.includes(task.id)) {
    return { status: task.computedStatus, unfinishedDependenciesCount: task.unfinishedDependenciesCount };
  }
  if (task.archivedAt) {
    return { status: "archived", unfinishedDependenciesCount: task.unfinishedDependenciesCount };
  }
  if (task.lifecycle === "finished") {
    return { status: "finished", unfinishedDependenciesCount: 0 };
  }
  if (task.lifecycle === "started") {
    return { status: "started", unfinishedDependenciesCount: 0 };
  }
  const taskById = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  const draftDependencies = mode.draftByTaskId[task.id] ?? [];
  const unfinishedDependenciesCount = draftDependencies.filter((id) => taskById.get(id)?.lifecycle !== "finished").length;
  return {
    status: unfinishedDependenciesCount > 0 ? "blocked" : "ready",
    unfinishedDependenciesCount
  };
}

function formatPreviewStatus(task: TaskView, preview: { status: ComputedStatus; unfinishedDependenciesCount: number }): string {
  if (task.computedStatus === preview.status && task.unfinishedDependenciesCount === preview.unfinishedDependenciesCount) {
    return preview.status;
  }
  const dependencyText = preview.unfinishedDependenciesCount > 0 ? `, ${preview.unfinishedDependenciesCount} deps` : "";
  return `${task.computedStatus} -> ${preview.status}${dependencyText}`;
}

function hasDependencyPath(startId: string, targetId: string, dependencyMap: Record<string, string[]>): boolean {
  const stack = [...(dependencyMap[startId] ?? [])];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    if (current === targetId) {
      return true;
    }
    visited.add(current);
    stack.push(...(dependencyMap[current] ?? []));
  }
  return false;
}

function countBy<T>(items: T[], getKey: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function TaskNode({
  node,
  selectedId,
  selectedIds,
  collapsedTaskIds,
  dependencyMode,
  createDraft,
  tasks,
  onSelect,
  onSelectSubtree,
  onStartCreateSubtask,
  onOpenComments,
  onCreateDraftChange,
  onCreateDraftSubmit,
  onCreateDraftCancel,
  onToggleExpanded,
  onTransition
}: {
  node: TreeNode;
  selectedId: string | null;
  selectedIds: Set<string>;
  collapsedTaskIds: Set<string>;
  dependencyMode: DependencyMode | null;
  createDraft: CreateTaskDraft | null;
  tasks: TaskView[];
  onSelect: (id: string, event: MouseEvent<HTMLDivElement>) => void;
  onSelectSubtree: (id: string) => void;
  onStartCreateSubtask: (parentTaskId: string) => void;
  onOpenComments: (id: string) => void;
  onCreateDraftChange: Dispatch<SetStateAction<CreateTaskDraft | null>>;
  onCreateDraftSubmit: () => void;
  onCreateDraftCancel: () => void;
  onToggleExpanded: (id: string) => void;
  onTransition: (task: TaskView, action: TaskAction) => Promise<void>;
}) {
  const task = node.task;
  const expanded = !collapsedTaskIds.has(task.id);
  const unfinishedDependencies = task.unfinishedDependenciesCount;
  const unfinishedDescendants = getUnfinishedDescendantsCount(task);
  const progress = task.descendantsCount > 0 ? task.subtreeProgress : task.lifecycle === "finished" ? 100 : 0;
  const dependencyCandidate = dependencyMode ? getDependencyCandidateState(task.id, dependencyMode, tasks) : null;
  const dependencyPreview = getDependencyPreview(task, dependencyMode, tasks);
  const previewChanged = dependencyPreview.status !== task.computedStatus || dependencyPreview.unfinishedDependenciesCount !== task.unfinishedDependenciesCount;
  const rowClassName = [
    "task-row",
    selectedIds.has(task.id) ? "selected" : "",
    selectedId === task.id ? "focused" : "",
    dependencyCandidate ? "dependency-candidate" : "",
    dependencyCandidate?.selected ? "dependency-selected" : "",
    dependencyCandidate?.disabled ? "dependency-disabled" : ""
  ].filter(Boolean).join(" ");
  return (
    <div className="task-node">
      <div className={rowClassName} style={{ paddingLeft: `${12 + task.hierarchyDepth * 22}px` }} onClick={(event) => onSelect(task.id, event)} title={dependencyCandidate?.reason ?? undefined}>
        <button className="disclosure" onClick={(event) => { event.stopPropagation(); onToggleExpanded(task.id); }} disabled={node.children.length === 0} title={expanded ? "Collapse" : "Expand"}>
          {node.children.length > 0 ? <ChevronDown size={15} className={expanded ? "" : "rotated"} /> : <span />}
        </button>
        <StatusDot status={dependencyPreview.status} />
        <div className="task-main">
          <div className="task-title-line">
            <span>{task.title}</span>
            <strong>{task.id}</strong>
          </div>
          <div className="task-meta">
            <span className={`status-chip ${dependencyPreview.status}`}>{previewChanged ? formatPreviewStatus(task, dependencyPreview) : task.computedStatus}</span>
            <span>P{task.priority}</span>
            {dependencyPreview.unfinishedDependenciesCount > 0 ? <span className="blocked-chip">{dependencyPreview.unfinishedDependenciesCount} deps</span> : null}
            {previewChanged ? <span className="preview-chip">preview</span> : null}
            {task.transitiveDependentsCount > 0 ? <span>unblocks {task.transitiveDependentsCount}</span> : null}
            {task.childrenCount > 0 ? <span>{task.childrenCount} children</span> : null}
            {unfinishedDescendants > 0 && getRollupStatus(task) === "blocked-by-children" ? <span className="rollup-chip">{unfinishedDescendants} child blockers</span> : null}
            {task.assignedTrack ? <span>{formatActorRef(task.assignedTrack)}</span> : null}
            {task.tags.length > 0 ? task.tags.slice(0, 2).map((tag) => <TagChip key={tag.id} tag={tag} />) : null}
            {task.tags.length > 2 ? <span>+{task.tags.length - 2} tags</span> : null}
            {task.commentCount > 0 ? (
              <button
                className={task.recentCommentCount > 0 ? "comment-chip recent" : "comment-chip"}
                title={`${task.commentCount} ${task.commentCount === 1 ? "comment" : "comments"}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenComments(task.id);
                }}
              >
                <span>{task.commentCount}</span>
                <MessageSquare size={13} />
              </button>
            ) : null}
          </div>
        </div>
        <div className="task-signals">
          {progress > 0 || task.descendantsCount > 0 ? <Progress value={progress} /> : null}
          {task.descendantsCount > 0 ? <span>{progress}%</span> : null}
        </div>
        <div className="row-actions">
          {task.archivedAt ? (
            <button title="Restore" onClick={(event) => { event.stopPropagation(); void onTransition(task, "restore"); }}><RefreshCw size={15} /></button>
          ) : task.lifecycle !== "finished" ? (
            <button title="Finish" onClick={(event) => { event.stopPropagation(); void onTransition(task, "finish"); }}><Check size={15} /></button>
          ) : (
            <button title="Reopen" onClick={(event) => { event.stopPropagation(); void onTransition(task, "reopen"); }}><RefreshCw size={15} /></button>
          )}
          <button className="row-secondary" title="Start" onClick={(event) => { event.stopPropagation(); void onTransition(task, "start"); }} disabled={task.lifecycle !== "open"}><CircleDot size={15} /></button>
          <button className="row-secondary" title="Add subtask" onClick={(event) => { event.stopPropagation(); onStartCreateSubtask(task.id); }} disabled={Boolean(task.archivedAt)}><Plus size={15} /></button>
          {!task.archivedAt ? <button className="row-secondary" title="Archive" onClick={(event) => { event.stopPropagation(); void onTransition(task, "archive"); }}><Archive size={15} /></button> : null}
          <button className="row-secondary" title="Select subtree" onClick={(event) => { event.stopPropagation(); onSelectSubtree(task.id); }} disabled={task.childrenCount === 0}><ListTree size={15} /></button>
          <span className="row-more" title="More actions"><MoreHorizontal size={15} /></span>
        </div>
      </div>
      {createDraft?.parentTaskId === task.id ? (
        <CreateTaskRow
          draft={createDraft}
          depth={task.hierarchyDepth + 1}
          onChange={onCreateDraftChange}
          onSubmit={onCreateDraftSubmit}
          onCancel={onCreateDraftCancel}
        />
      ) : null}
      {expanded ? node.children.map((child) => (
        <TaskNode
          key={child.task.id}
          node={child}
          selectedId={selectedId}
          selectedIds={selectedIds}
          collapsedTaskIds={collapsedTaskIds}
          dependencyMode={dependencyMode}
          createDraft={createDraft}
          tasks={tasks}
          onSelect={onSelect}
          onSelectSubtree={onSelectSubtree}
          onStartCreateSubtask={onStartCreateSubtask}
          onOpenComments={onOpenComments}
          onCreateDraftChange={onCreateDraftChange}
          onCreateDraftSubmit={onCreateDraftSubmit}
          onCreateDraftCancel={onCreateDraftCancel}
          onToggleExpanded={onToggleExpanded}
          onTransition={onTransition}
        />
      )) : null}
    </div>
  );
}

function BulkTaskDetails({
  tasks,
  tracks,
  tags,
  onAssign,
  onUnassign,
  onAssignTag,
  onTransition,
  onEditDependencies,
  onClear
}: {
  tasks: TaskView[];
  tracks: TrackRecord[];
  tags: TagRecord[];
  onAssign: (track: TrackRecord) => void;
  onUnassign: () => void;
  onAssignTag: (tagId: string) => void;
  onTransition: (action: TaskAction) => void;
  onEditDependencies: () => void;
  onClear: () => void;
}) {
  const [tagToAssign, setTagToAssign] = useState("");
  const statusCounts = countBy(tasks, (task) => task.computedStatus);
  const activeTasks = tasks.filter((task) => !task.archivedAt);
  const assignableTasks = tasks.filter((task) => !task.assignedTrack && !task.archivedAt && task.lifecycle !== "finished");
  const assignedTasks = tasks.filter((task) => task.assignedTrack);
  const archivedTasks = tasks.filter((task) => task.archivedAt);
  const activeTags = tags.filter((tag) => !tag.archivedAt);
  return (
    <aside className="details-panel bulk-panel">
      <div className="details-header">
        <ListTree size={18} />
        <div className="details-title">
          <h2>{tasks.length} tasks selected</h2>
          <div className="details-meta">
            <span>{statusCounts.ready ?? 0} ready</span>
            <span>{statusCounts.blocked ?? 0} blocked</span>
            <span>{statusCounts.started ?? 0} started</span>
            <span>{statusCounts.finished ?? 0} finished</span>
          </div>
        </div>
      </div>

      <div className="details-actions primary-actions">
        <button onClick={onEditDependencies}><GitBranch size={15} /> Edit dependencies</button>
        <button onClick={() => onTransition("start")}><CircleDot size={15} /> Start {activeTasks.filter((task) => task.lifecycle === "open").length}</button>
        <button className="primary-button" onClick={() => onTransition("finish")}><Check size={15} /> Finish {activeTasks.filter((task) => task.lifecycle !== "finished").length}</button>
        <button className="subtle-button" onClick={() => onTransition("archive")}><Archive size={15} /> Archive {activeTasks.length}</button>
        <button disabled={archivedTasks.length === 0} onClick={() => onTransition("restore")}><RefreshCw size={15} /> Restore {archivedTasks.length}</button>
        <button onClick={onClear}>Clear selection</button>
      </div>

      <section className="detail-section">
        <h3>Assign Actor</h3>
        <p>{assignableTasks.length} selected tasks can receive an actor queue.</p>
        <div className="assign-buttons">
          {tracks.filter((track) => !track.archivedAt).map((track) => (
            <button key={track.id} disabled={assignableTasks.length === 0} onClick={() => onAssign(track)}>
              <UserRound size={15} /> Assign {assignableTasks.length} to {formatActorRef(track)}
            </button>
          ))}
          <button disabled={assignedTasks.length === 0} onClick={onUnassign}>Unassign {assignedTasks.length}</button>
        </div>
      </section>

      <section className="detail-section">
        <h3>Assign Tag</h3>
        <div className="tag-assign-row">
          <select value={tagToAssign} onChange={(event) => setTagToAssign(event.target.value)}>
            <option value="">Assign tag...</option>
            {activeTags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
          </select>
          <button disabled={!tagToAssign} onClick={() => { onAssignTag(tagToAssign); setTagToAssign(""); }}>Assign to {tasks.length}</button>
        </div>
      </section>

      <section className="detail-section">
        <h3>Selected Tasks</h3>
        <div className="dependency-list">
          {tasks.slice(0, 12).map((task) => <DependencyItem key={task.id} task={task} />)}
          {tasks.length > 12 ? <p>{tasks.length - 12} more selected.</p> : null}
        </div>
      </section>
    </aside>
  );
}

function DependencyModePanel({
  mode,
  tasks,
  onSave,
  onCancel
}: {
  mode: DependencyMode;
  tasks: TaskView[];
  onSave: () => void;
  onCancel: () => void;
}) {
  const targets = mode.targetIds.map((id) => tasks.find((task) => task.id === id)).filter((task): task is TaskView => Boolean(task));
  const targetPreviews = targets.map((task) => ({ task, preview: getDependencyPreview(task, mode, tasks) }));
  const previewCounts = countBy(targetPreviews, (item) => item.preview.status);
  const changedPreviewCount = targetPreviews.filter((item) => item.task.computedStatus !== item.preview.status || item.task.unfinishedDependenciesCount !== item.preview.unfinishedDependenciesCount).length;
  const unionDependencyIds = [...new Set(mode.targetIds.flatMap((id) => mode.draftByTaskId[id] ?? []))].sort();
  const commonDependencyIds = unionDependencyIds.filter((id) => mode.targetIds.every((targetId) => mode.draftByTaskId[targetId]?.includes(id)));
  return (
    <aside className="details-panel dependency-mode-panel">
      <div className="details-header">
        <GitBranch size={18} />
        <div className="details-title">
          <h2>Edit dependencies</h2>
          <div className="details-meta">
            <span>{targets.length} target{targets.length === 1 ? "" : "s"}</span>
            <span>{unionDependencyIds.length} selected dependencies</span>
            <span>{changedPreviewCount} status changes</span>
          </div>
        </div>
      </div>

      <div className="details-actions primary-actions">
        <button className="primary-button" disabled={mode.loading} onClick={onSave}>Save dependencies</button>
        <button onClick={onCancel}>Cancel</button>
      </div>

      <section className="detail-section">
        <h3>Targets</h3>
        <div className="details-meta preview-summary">
          <span>{previewCounts.ready ?? 0} ready</span>
          <span>{previewCounts.blocked ?? 0} blocked</span>
          <span>{previewCounts.started ?? 0} started</span>
          <span>{previewCounts.finished ?? 0} finished</span>
        </div>
        <div className="dependency-list">
          {targetPreviews.map(({ task, preview }) => {
            const changed = task.computedStatus !== preview.status || task.unfinishedDependenciesCount !== preview.unfinishedDependenciesCount;
            return changed
              ? <DependencyItem key={task.id} task={task} meta={formatPreviewStatus(task, preview)} statusOverride={preview.status} />
              : <DependencyItem key={task.id} task={task} statusOverride={preview.status} />;
          })}
        </div>
      </section>

      <section className="detail-section">
        <h3>Pick Dependencies</h3>
        <p>{mode.loading ? "Loading dependency graph..." : "Click task rows in the list to toggle dependencies for every target."}</p>
        <p>Disabled rows are the target tasks themselves, hierarchy ancestors or descendants, or tasks that would create a cycle.</p>
      </section>

      <section className="detail-section">
        <h3>Selected Dependencies</h3>
        {unionDependencyIds.length ? (
          <div className="dependency-list">
            {unionDependencyIds.map((id) => {
              const task = tasks.find((candidate) => candidate.id === id);
              const label = commonDependencyIds.includes(id) ? "all targets" : "some targets";
              return task ? <DependencyItem key={id} task={task} meta={label} /> : <p key={id}>{id} ({label})</p>;
            })}
          </div>
        ) : <p>No dependencies selected.</p>}
      </section>
    </aside>
  );
}

function TaskDetails({
  task,
  explanation,
  comments,
  commentDraft,
  commentsFocusNonce,
  identityReady,
  tracks,
  tags,
  onCommentDraftChange,
  onAddComment,
  onArchiveComment,
  onAssign,
  onUnassign,
  onAssignTag,
  onRemoveTag,
  onUpdate,
  onTransition,
  onEditDependencies,
  onSelectSubtree,
  onStartCreateSubtask
}: {
  task: TaskView | null;
  explanation: Explanation | null;
  comments: CommentRecord[];
  commentDraft: string;
  commentsFocusNonce: number;
  identityReady: boolean;
  tracks: TrackRecord[];
  tags: TagRecord[];
  onCommentDraftChange: Dispatch<SetStateAction<string>>;
  onAddComment: (task: TaskView) => void;
  onArchiveComment: (comment: CommentRecord) => void;
  onAssign: (track: TrackRecord, task: TaskView) => void;
  onUnassign: (task: TaskView) => void;
  onAssignTag: (task: TaskView, tagId: string) => void;
  onRemoveTag: (task: TaskView, tagId: string) => void;
  onUpdate: (task: TaskView, input: { title: string; description: string }) => void;
  onTransition: (task: TaskView, action: TaskAction) => void;
  onEditDependencies: (task: TaskView) => void;
  onSelectSubtree: (task: TaskView) => void;
  onStartCreateSubtask: (task: TaskView) => void;
}) {
  const [tagToAssign, setTagToAssign] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const commentsSectionRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setIsEditing(false);
    setDraftTitle(task?.title ?? "");
    setDraftDescription(task?.description ?? "");
  }, [task?.id, task?.title, task?.description]);

  useEffect(() => {
    if (commentsFocusNonce > 0) {
      commentsSectionRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [commentsFocusNonce]);

  if (!task) {
    return <aside className="details-panel empty">No task selected</aside>;
  }
  const assignableTags = tags.filter((tag) => !tag.archivedAt && !task.tags.some((taskTag) => taskTag.id === tag.id));
  const contentChanged = draftTitle.trim() !== task.title || draftDescription !== task.description;
  const unfinishedDependencies = explanation?.unfinishedDependencies ?? [];
  const finishedDependencies = explanation?.finishedDependencies ?? [];
  const directDependents = explanation?.directDependents ?? [];
  const instructionMatches = explanation?.instructions ?? [];
  return (
    <aside className="details-panel">
      <div className="details-header">
        <StatusDot status={task.computedStatus} />
        <div className="details-title">
          <h2>{task.title}</h2>
          <div className="details-meta">
            <span>{task.id}</span>
            <span className={`status-chip ${task.computedStatus}`}>{task.computedStatus}</span>
            <span>P{task.priority}</span>
          </div>
        </div>
      </div>

      <div className="details-actions primary-actions">
        {!isEditing ? <button disabled={Boolean(task.archivedAt)} onClick={() => setIsEditing(true)}><Edit3 size={15} /> Edit</button> : null}
        {task.archivedAt ? <button className="primary-button" onClick={() => onTransition(task, "restore")}><RefreshCw size={15} /> Restore</button> : null}
        <button disabled={Boolean(task.archivedAt)} onClick={() => onStartCreateSubtask(task)}><Plus size={15} /> Add subtask</button>
        <button disabled={Boolean(task.archivedAt)} onClick={() => onEditDependencies(task)}><GitBranch size={15} /> Edit dependencies</button>
        {task.childrenCount > 0 ? <button onClick={() => onSelectSubtree(task)}><ListTree size={15} /> Select subtree</button> : null}
        {!task.archivedAt && task.lifecycle === "open" ? <button onClick={() => onTransition(task, "start")}><CircleDot size={15} /> Start</button> : null}
        {!task.archivedAt && task.lifecycle !== "finished" ? <button className="primary-button" onClick={() => onTransition(task, "finish")}><Check size={15} /> Finish</button> : null}
        {!task.archivedAt && task.lifecycle === "finished" ? <button onClick={() => onTransition(task, "reopen")}><RefreshCw size={15} /> Reopen</button> : null}
        {!task.archivedAt ? <button className="subtle-button" onClick={() => onTransition(task, "archive")}><Archive size={15} /> Archive</button> : null}
      </div>

      {isEditing ? (
        <section className="detail-section content-editor">
          <h3>Edit Task</h3>
          <label>
            <span>Title</span>
            <input className="title-input" value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} />
          </label>
          <label>
            <span>Description</span>
            <textarea className="description-textarea" value={draftDescription} onChange={(event) => setDraftDescription(event.target.value)} placeholder="Add implementation notes, acceptance criteria, links, or context." />
          </label>
          <div className="editor-actions">
            <button
              className="primary-button"
              disabled={!contentChanged || !draftTitle.trim()}
              onClick={() => {
                onUpdate(task, { title: draftTitle.trim(), description: draftDescription });
                setIsEditing(false);
              }}
            >
              Save
            </button>
            <button onClick={() => { setDraftTitle(task.title); setDraftDescription(task.description); setIsEditing(false); }}>Cancel</button>
          </div>
        </section>
      ) : (
        <section className="detail-section detail-summary">
          <h3>Description</h3>
          {task.description.trim() ? <MarkdownContent value={task.description} /> : <p>No description yet.</p>}
        </section>
      )}

      <div className="detail-grid">
        <Metric label="Status" value={task.computedStatus} />
        <Metric label="Priority" value={`P${task.priority}`} />
        <Metric label="Depth" value={String(task.dependencyDepth)} />
        <Metric label="Unblocks" value={String(task.transitiveDependentsCount)} />
        <Metric label="Children" value={String(task.childrenCount)} />
        <Metric label="Progress" value={`${task.subtreeProgress}%`} />
      </div>
      {task.descendantsCount > 0 || task.lifecycle === "finished" ? <Progress value={task.subtreeProgress} large /> : null}

      <section className="detail-section">
        <h3>Dependencies</h3>
        <div className="dependency-list">
          {unfinishedDependencies.length ? unfinishedDependencies.map((dependency) => (
            <DependencyItem key={dependency.id} task={dependency} tone="blocked" />
          )) : <p>No unfinished dependencies.</p>}
          {finishedDependencies.length ? (
            <details className="dependency-more">
              <summary>{finishedDependencies.length} finished {finishedDependencies.length === 1 ? "dependency" : "dependencies"}</summary>
              <div className="dependency-list nested-list">
                {finishedDependencies.slice(0, 8).map((dependency) => <DependencyItem key={dependency.id} task={dependency} />)}
              </div>
            </details>
          ) : null}
        </div>
        <p className={explanation?.assignable ? "assignable yes" : "assignable no"}>{explanation?.reason ?? "Loading explanation..."}</p>
      </section>

      <section className="detail-section">
        <h3>Hierarchy</h3>
        <div className="info-list">
          <p><span>Parent</span>{task.parent ? `${task.parent.id} ${task.parent.title}` : "Root task"}</p>
          <p><span>Leaf progress</span>{task.finishedLeafDescendantsCount}/{task.leafDescendantsCount} finished</p>
          <p className={getRollupStatus(task) === "blocked-by-children" ? "rollup-warning" : undefined}><span>Rollup</span>{formatRollupStatus(task)}</p>
        </div>
        {getCriticalChildPath(task).length > 0 ? (
          <div className="critical-path">
            {getCriticalChildPath(task).map((child) => (
              <span key={child.id}>{child.id} [{child.computedStatus}{child.unfinishedDependenciesCount > 0 ? `, ${child.unfinishedDependenciesCount} deps` : ""}]</span>
            ))}
          </div>
        ) : null}
      </section>

      {directDependents.length ? (
        <section className="detail-section">
          <h3>Unblocks</h3>
          <div className="dependency-list">
            {directDependents.slice(0, 5).map((dependent) => <DependencyItem key={dependent.id} task={dependent} />)}
          </div>
        </section>
      ) : null}

      {instructionMatches.length ? (
        <section className="detail-section">
          <h3>Instructions</h3>
          <div className="instruction-match-stack">
            {instructionMatches.map((match) => (
              <div className="instruction-card" key={match.instruction.id}>
                <div className="instruction-card-header">
                  <strong>{match.instruction.name}</strong>
                  <span>{match.reasons.join(", ") || "matched"}</span>
                </div>
                <MarkdownContent value={match.instruction.body} />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="detail-section comments-section" ref={commentsSectionRef}>
        <h3>Comments</h3>
        <div className="comment-list">
          {comments.length > 0 ? comments.map((comment) => (
            <article className="comment-card" key={comment.id}>
              <div className="comment-meta">
                <span>{formatActorRef(comment)}</span>
                <span>{formatShortDateTime(comment.createdAt)}</span>
                {comment.updatedAt !== comment.createdAt ? <span>edited</span> : null}
                <button className="text-button" disabled={!identityReady} onClick={() => onArchiveComment(comment)}>Archive</button>
              </div>
              <MarkdownContent value={comment.body} />
            </article>
          )) : <p>No comments yet.</p>}
        </div>
        <div className="comment-form">
          <textarea
            value={commentDraft}
            onChange={(event) => onCommentDraftChange(event.target.value)}
            placeholder="Add a markdown comment..."
          />
          <button className="primary-button" disabled={!identityReady || !commentDraft.trim()} onClick={() => onAddComment(task)}>
            <Plus size={15} /> Comment
          </button>
        </div>
      </section>

      <section className="detail-section">
        <h3>Assignment</h3>
        <p>{task.assignedTrack ? formatActorRef(task.assignedTrack) : "Unassigned"}</p>
        <div className="assign-buttons">
          {tracks.filter((track) => !track.archivedAt).map((track) => (
            <button key={track.id} disabled={task.archivedAt !== null || task.lifecycle === "finished" || Boolean(task.assignedTrack)} onClick={() => onAssign(track, task)}>
              <UserRound size={15} /> {formatActorRef(track)}
            </button>
          ))}
          {task.assignedTrack ? <button onClick={() => onUnassign(task)}>Unassign</button> : null}
          {tracks.filter((track) => !track.archivedAt).length === 0 ? <p>No actor queues yet. Add one in Queues.</p> : null}
        </div>
      </section>

      <section className="detail-section">
        <h3>Tags</h3>
        <div className="tag-editor-list">
          {task.tags.length > 0 ? task.tags.map((tag) => (
            <button key={tag.id} className="tag-remove" onClick={() => onRemoveTag(task, tag.id)} title={`Remove ${tag.name}`}>
              <TagChip tag={tag} />
              <X size={13} />
            </button>
          )) : <p>No tags assigned.</p>}
        </div>
        <div className="tag-assign-row">
          <select value={tagToAssign} onChange={(event) => setTagToAssign(event.target.value)}>
            <option value="">Assign tag...</option>
            {assignableTags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
          </select>
          <button disabled={!tagToAssign} onClick={() => { onAssignTag(task, tagToAssign); setTagToAssign(""); }}>Assign</button>
        </div>
      </section>

      {(task.sourceDoc || task.sourceSection) ? (
        <section className="detail-section">
          <h3>Source</h3>
          <p>{task.sourceDoc ?? "No source doc"}</p>
          <p>{task.sourceSection ?? "No source section"}</p>
        </section>
      ) : null}
    </aside>
  );
}

function MarkdownContent({ value }: { value: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {value}
      </ReactMarkdown>
    </div>
  );
}

function DependencyItem({ task, tone, meta, statusOverride }: { task: TaskView; tone?: "blocked"; meta?: string; statusOverride?: ComputedStatus }) {
  const status = statusOverride ?? task.computedStatus;
  return (
    <div className={tone === "blocked" ? "dependency-item blocked" : "dependency-item"}>
      <StatusDot status={status} />
      <div>
        <strong>{task.title}</strong>
        <span>{task.id} / {status}{task.unfinishedDependenciesCount > 0 ? ` / ${task.unfinishedDependenciesCount} deps` : ""}{meta ? ` / ${meta}` : ""}</span>
      </div>
    </div>
  );
}

function QueuesView({
  tracks,
  tasks,
  feeds,
  projectId,
  newTrack,
  setNewTrack,
  createTrack,
  onAssign,
  onOpenTask
}: {
  tracks: TrackRecord[];
  tasks: TaskView[];
  feeds: QueueFeedRecord[];
  projectId: string;
  newTrack: string;
  setNewTrack: (value: string) => void;
  createTrack: () => void;
  onAssign: (track: TrackRecord, task: TaskView) => void;
  onOpenTask: (task: TaskView) => void;
}) {
  const ready = tasks.filter((task) => task.ready && !task.assignedTrack);
  const [feedTasks, setFeedTasks] = useState<Record<string, TaskView[]>>({});

  useEffect(() => {
    let cancelled = false;
    async function loadFeedTasks() {
      const entries = await Promise.all(feeds.filter((feed) => !feed.archivedAt).map(async (feed) => {
        const candidates = await fetchJson<TaskView[]>(withProject(`/api/feeds/${feed.id}/tasks?limit=5`, projectId));
        return [feed.id, candidates] as const;
      }));
      if (!cancelled) {
        setFeedTasks(Object.fromEntries(entries));
      }
    }
    if (feeds.length === 0) {
      setFeedTasks({});
      return undefined;
    }
    void loadFeedTasks();
    return () => {
      cancelled = true;
    };
  }, [feeds, projectId]);

  return (
    <section className="wide-view">
      <div className="view-heading">
        <h1>Actor Queues</h1>
        <div className="inline-create"><input value={newTrack} onChange={(event) => setNewTrack(event.target.value)} placeholder="actor or machine:actor" /><button onClick={createTrack}><Plus size={16} /> Add queue</button></div>
      </div>
      {feeds.filter((feed) => !feed.archivedAt).length > 0 ? (
        <div className="feed-strip">
          {feeds.filter((feed) => !feed.archivedAt).map((feed) => (
            <div className="feed-card" key={feed.id}>
              <h2>{feed.name}</h2>
              <p className="muted">{feed.query}</p>
              {(feedTasks[feed.id] ?? []).map((task) => <TaskMini key={task.id} task={task} onClick={() => onOpenTask(task)} />)}
              {(feedTasks[feed.id] ?? []).length === 0 ? <p className="muted">No ready candidates</p> : null}
            </div>
          ))}
        </div>
      ) : null}
      <div className="queue-grid">
        {tracks.map((track) => {
          const assigned = tasks.filter((task) => task.assignedTrack?.trackId === track.id);
          return (
            <div className="queue-column" key={track.id}>
              <h2>{track.name ?? formatActorRef(track)}</h2>
              {assigned.map((task) => <TaskMini key={task.id} task={task} onClick={() => onOpenTask(task)} />)}
              {assigned.length === 0 ? <p className="muted">No assigned tasks</p> : null}
              <div className="queue-ready">
                {ready.slice(0, 5).map((task) => <button key={task.id} onClick={() => onAssign(track, task)}>Assign {task.id}</button>)}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TagsView({ tags, tasks, newTag, setNewTag, createTag }: { tags: TagRecord[]; tasks: TaskView[]; newTag: string; setNewTag: (value: string) => void; createTag: () => void }) {
  return (
    <section className="wide-view">
      <div className="view-heading">
        <h1>Tags</h1>
        <div className="inline-create"><input value={newTag} onChange={(event) => setNewTag(event.target.value)} placeholder="tag name" /><button onClick={createTag}><Plus size={16} /> Add tag</button></div>
      </div>
      <div className="tag-grid">
        {tags.map((tag) => {
          const tagged = tasks.filter((task) => task.tags.some((candidate) => candidate.id === tag.id));
          return (
            <div className="tag-row" key={tag.id}>
              <span className="tag-swatch" style={{ background: tag.color ?? "#64748b" }} />
              <strong>{tag.name}</strong>
              <span>{tagged.length} tasks</span>
              <span>{tagged.filter((task) => task.ready).length} ready</span>
              <span>{tagged.filter((task) => task.blocked).length} blocked</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

interface InstructionDraft {
  id: string;
  name: string;
  query: string;
  body: string;
  enabled: boolean;
  archivedAt: string | null;
  isNew: boolean;
}

function InstructionsView({
  projectId,
  instructions,
  grammar,
  tasks,
  onRefresh,
  onOpenTask
}: {
  projectId: string;
  instructions: InstructionRecord[];
  grammar: InstructionGrammarRecord | null;
  tasks: TaskView[];
  onRefresh: () => Promise<void>;
  onOpenTask: (task: TaskView) => void;
}) {
  const sortedInstructions = useMemo(() => [...instructions].sort((a, b) => Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) || a.name.localeCompare(b.name)), [instructions]);
  const [selectedInstructionId, setSelectedInstructionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<InstructionDraft>(() => makeNewInstructionDraft());
  const [preview, setPreview] = useState<InstructionPreviewRecord | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const initializedSelectionRef = useRef(false);
  const shortcuts = useMemo(() => getKeyboardShortcuts(), []);
  const selectedInstruction = selectedInstructionId ? instructions.find((instruction) => instruction.id === selectedInstructionId) ?? null : null;
  const dirty = selectedInstruction
    ? draft.name.trim() !== selectedInstruction.name
      || draft.query.trim() !== selectedInstruction.query
      || draft.body !== selectedInstruction.body
      || draft.enabled !== selectedInstruction.enabled
    : draft.name.trim().length > 0 || draft.query.trim().length > 0 || draft.body.trim().length > 0;
  const previewMatches = preview?.matches ?? [];
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  useEffect(() => {
    initializedSelectionRef.current = false;
    setSelectedInstructionId(null);
    setDraft(makeNewInstructionDraft());
    setPreview(null);
  }, [projectId]);

  useEffect(() => {
    if (initializedSelectionRef.current) {
      return;
    }
    const firstActive = sortedInstructions.find((instruction) => !instruction.archivedAt);
    const first = firstActive ?? sortedInstructions[0] ?? null;
    if (first) {
      setSelectedInstructionId(first.id);
    }
    initializedSelectionRef.current = true;
  }, [sortedInstructions]);

  useEffect(() => {
    if (!selectedInstruction) {
      return;
    }
    setDraft({
      id: selectedInstruction.id,
      name: selectedInstruction.name,
      query: selectedInstruction.query,
      body: selectedInstruction.body,
      enabled: selectedInstruction.enabled,
      archivedAt: selectedInstruction.archivedAt,
      isNew: false
    });
    setPreview(null);
  }, [selectedInstruction]);

  function startNewInstruction() {
    setSelectedInstructionId(null);
    setDraft(makeNewInstructionDraft());
    setPreview(null);
  }

  async function saveInstruction() {
    const body = {
      id: draft.id.trim() || undefined,
      name: draft.name.trim(),
      query: draft.query.trim(),
      body: draft.body,
      enabled: draft.enabled
    };
    if (!body.name || !body.query) {
      return;
    }
    const saved = draft.isNew
      ? await mutateJson<InstructionRecord>(withProject("/api/instructions", projectId), { method: "POST", body })
      : await mutateJson<InstructionRecord>(withProject(`/api/instructions/${draft.id}`, projectId), { method: "PATCH", body });
    setSelectedInstructionId(saved.id);
    setDraft({
      id: saved.id,
      name: saved.name,
      query: saved.query,
      body: saved.body,
      enabled: saved.enabled,
      archivedAt: saved.archivedAt,
      isNew: false
    });
    await onRefresh();
    await previewInstruction(saved.query);
  }

  async function archiveInstruction() {
    if (draft.isNew) {
      return;
    }
    await mutateJson<InstructionRecord>(withProject(`/api/instructions/${draft.id}/archive`, projectId), { method: "POST" });
    await onRefresh();
  }

  async function restoreInstruction() {
    if (draft.isNew) {
      return;
    }
    const restored = await mutateJson<InstructionRecord>(withProject(`/api/instructions/${draft.id}/restore`, projectId), { method: "POST" });
    setSelectedInstructionId(restored.id);
    await onRefresh();
  }

  async function previewInstruction(query = draft.query) {
    setPreviewLoading(true);
    try {
      const result = await mutateJson<InstructionPreviewRecord>(withProject("/api/instructions/preview", projectId), { method: "POST", body: { query } });
      setPreview(result);
    } finally {
      setPreviewLoading(false);
    }
  }

  const handleInstructionEditorMount = useCallback<OnMount>((editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space, () => {
      editor.trigger("keyboard", "editor.action.triggerSuggest", {});
    });
  }, []);

  return (
    <section className="instruction-layout">
      <div className="instruction-list-panel">
        <div className="view-heading">
          <div>
            <h1>Instructions</h1>
            <p>Matched dynamically when tasks are shown. They are never copied onto tasks.</p>
          </div>
          <button onClick={startNewInstruction}><Plus size={16} /> New</button>
        </div>
        <div className="instruction-list">
          {sortedInstructions.map((instruction) => (
            <button
              key={instruction.id}
              className={selectedInstructionId === instruction.id ? "instruction-list-item active" : "instruction-list-item"}
              onClick={() => setSelectedInstructionId(instruction.id)}
            >
              <div>
                <strong>{instruction.name}</strong>
                <span>{instruction.query}</span>
              </div>
              <span className={instruction.enabled && !instruction.archivedAt ? "status-chip ready" : "status-chip archived"}>
                {instruction.archivedAt ? "archived" : instruction.enabled ? "enabled" : "disabled"}
              </span>
            </button>
          ))}
          {sortedInstructions.length === 0 ? <p className="muted">No instructions yet.</p> : null}
        </div>
      </div>

      <div className="instruction-editor-panel">
        <div className="instruction-editor-header">
          <div>
            <h1>{draft.isNew ? "New Instruction" : draft.name}</h1>
            <p>{draft.isNew ? "Create a matcher and body." : draft.id}</p>
          </div>
          <div className="details-actions">
            <button className="primary-button" disabled={!dirty || !draft.name.trim() || !draft.query.trim()} onClick={() => void saveInstruction()}>
              <Check size={15} /> Save
            </button>
            <button disabled={!draft.query.trim() || previewLoading} onClick={() => void previewInstruction()}>
              <Search size={15} /> {previewLoading ? "Checking" : "Show matching tasks"}
            </button>
            {!draft.isNew && !draft.archivedAt ? <button className="subtle-button" onClick={() => void archiveInstruction()}><Archive size={15} /> Archive</button> : null}
            {!draft.isNew && draft.archivedAt ? <button onClick={() => void restoreInstruction()}><RefreshCw size={15} /> Restore</button> : null}
          </div>
        </div>

        <div className="instruction-form">
          <label>
            <span>Name</span>
            <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Instruction name" />
          </label>
          <label>
            <span>ID</span>
            <input disabled={!draft.isNew} value={draft.id} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} placeholder="auto from name" />
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} />
            <span>Enabled</span>
          </label>
        </div>

        <div className="instruction-query-block">
          <div className="field-heading">
            <span>Matcher</span>
            <code>depends on TASK depth = 1 and tag = backend</code>
          </div>
          <p className="shortcut-hint"><kbd>{shortcuts.suggest}</kbd> show suggestions</p>
          <div className="monaco-shell">
            <Editor
              key={`${projectId}-${grammar ? "ready" : "loading"}`}
              height="340px"
              defaultLanguage="unblock-query"
              language="unblock-query"
              theme="unblock"
              beforeMount={configureInstructionLanguage}
              onMount={handleInstructionEditorMount}
              value={draft.query}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                lineNumbers: "off",
                folding: false,
                wordWrap: "on",
                scrollBeyondLastLine: false,
                overviewRulerLanes: 0,
                renderLineHighlight: "none"
              }}
              onChange={(value) => setDraft((current) => ({ ...current, query: value ?? "" }))}
            />
          </div>
        </div>

        <div className="instruction-body-block">
          <div className="field-heading">
            <span>Instruction Markdown</span>
          </div>
          <textarea value={draft.body} onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))} placeholder="Write the guidance that matching tasks should include." />
          {draft.body.trim() ? <MarkdownContent value={draft.body} /> : null}
        </div>

        {preview ? (
          <div className="instruction-preview">
            <div className="field-heading">
              <span>Matches</span>
              <strong>{preview.ok ? `${previewMatches.length} tasks` : `${preview.errors.length} errors`}</strong>
            </div>
            {!preview.ok ? (
              <div className="error compact">{preview.errors.join("; ")}</div>
            ) : (
              <div className="match-list">
                {previewMatches.map((match) => {
                  const task = taskById.get(match.task.id) ?? match.task;
                  return (
                    <button key={task.id} className="match-row" onClick={() => onOpenTask(task)}>
                      <StatusDot status={task.computedStatus} />
                      <div>
                        <strong>{task.id} {task.title}</strong>
                        <span>{match.reasons.join(", ") || "matched"}</span>
                      </div>
                    </button>
                  );
                })}
                {previewMatches.length === 0 ? <p className="muted">No tasks match this query.</p> : null}
              </div>
            )}
          </div>
        ) : null}
      </div>

      <InstructionGrammarPanel grammar={grammar} />
    </section>
  );
}

function InstructionGrammarPanel({ grammar }: { grammar: InstructionGrammarRecord | null }) {
  return (
    <aside className="instruction-grammar-panel">
      <div>
        <h2>Matcher Reference</h2>
        <p>Generated from the matcher definition used by CLI, API, and preview.</p>
      </div>
      {grammar ? (
        <>
          <section>
            <h3>Clauses</h3>
            <div className="grammar-clause-list">
              {grammar.clauses.map((clause) => (
                <div className="grammar-clause" key={clause.name}>
                  <strong>{clause.name}</strong>
                  {clause.forms.map((form) => <code key={form}>{form}</code>)}
                  <p>{clause.description}</p>
                </div>
              ))}
            </div>
          </section>
          <section>
            <h3>Fields</h3>
            <div className="grammar-chip-list">
              {grammar.fields.map((field) => <code key={field}>{field}</code>)}
            </div>
          </section>
          <section>
            <h3>Operators</h3>
            <p>Fields: {grammar.fieldOperators.join(" ")}</p>
            <p>Counts and depth: {grammar.comparisonOperators.join(" ")}</p>
            <p>Boolean: {grammar.booleanOperators.join(", ")}</p>
          </section>
          <section>
            <h3>Values</h3>
            <div className="grammar-value-list">
              {grammar.valueForms.map((value) => (
                <p key={value.name}><strong>{value.name}</strong>: {value.description}</p>
              ))}
            </div>
          </section>
          <section>
            <h3>Graph</h3>
            <p>{grammar.graphVerbs.join(" / ")}</p>
            <p>{grammar.edgeKinds.join(" + ")}</p>
          </section>
          <section>
            <h3>Notes</h3>
            <ul>
              {grammar.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          </section>
          <section>
            <h3>Examples</h3>
            <div className="grammar-examples">
              {grammar.examples.map((example) => <code key={example}>{example}</code>)}
            </div>
          </section>
        </>
      ) : (
        <p className="muted">Loading grammar...</p>
      )}
    </aside>
  );
}

function makeNewInstructionDraft(): InstructionDraft {
  return {
    id: "",
    name: "",
    query: "",
    body: "",
    enabled: true,
    archivedAt: null,
    isNew: true
  };
}

const configureInstructionLanguage: BeforeMount = (monaco) => {
  const languageId = "unblock-query";
  if (!monaco.languages.getLanguages().some((language: { id: string }) => language.id === languageId)) {
    monaco.languages.register({ id: languageId });
  }
  monaco.languages.setMonarchTokensProvider(languageId, {
    ignoreCase: true,
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/\b(and|or|not|in|is|empty|now|today|depth|tag|assigned|machine|actor|status|lifecycle|parent|priority|created|updated|started|finished|archived|id|source|doc|section|descendant|of)\b/, "keyword"],
        [/\b(depends|on|unblocks)\b/, "keyword.graph"],
        [/[()]/, "delimiter.parenthesis"],
        [/,/, "delimiter"],
        [/(>=|<=|!=|=|>|<)/, "operator"],
        [/"(?:[^"\\]|\\.)*"/, "string"],
        [/'(?:[^'\\]|\\.)*'/, "string"],
        [/\d+/, "number"],
        [/[A-Za-z0-9._:/-]+/, "identifier"]
      ]
    }
  });
  monaco.languages.setLanguageConfiguration(languageId, {
    comments: { lineComment: "#" },
    brackets: [["(", ")"]],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "\"", close: "\"" },
      { open: "'", close: "'" }
    ]
  });
  monaco.editor.defineTheme("unblock", {
    base: window.matchMedia("(prefers-color-scheme: dark)").matches ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "keyword", foreground: "176f53", fontStyle: "bold" },
      { token: "keyword.graph", foreground: "2f7dd1", fontStyle: "bold" },
      { token: "operator", foreground: "9e3528" },
      { token: "string", foreground: "7a4d00" },
      { token: "number", foreground: "7a4d00" }
    ],
    colors: {
      "editor.background": window.matchMedia("(prefers-color-scheme: dark)").matches ? "#181c23" : "#ffffff",
      "editor.lineHighlightBackground": "#00000000"
    }
  });
};

function registerInstructionCompletions(monaco: any, projectId: string, grammar: InstructionGrammarRecord): { dispose: () => void } {
  return monaco.languages.registerCompletionItemProvider("unblock-query", {
    triggerCharacters: [" ", "=", "(", ",", ":", "-", "."],
    provideCompletionItems: async (model: any, position: { lineNumber: number; column: number }) => {
      const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const token = currentMatcherToken(line);
      const range = new monaco.Range(position.lineNumber, position.column - token.length, position.lineNumber, position.column);
      const context = getInstructionCompletionContext(line, grammar);
      const suggestions: unknown[] = [];

      if (context.kind === "value") {
        const values = await fetchInstructionValueSuggestions(projectId, context.field, context.prefix || token, 50);
        suggestions.push(...values.map((item, index) => ({
          label: item.label,
          kind: monaco.languages.CompletionItemKind.Value,
          detail: `${item.detail}${item.count > 0 ? ` / ${item.count}` : ""}`,
          insertText: isMatcherTimeField(context.field) ? item.value : formatMatcherValue(item.value),
          sortText: completionSortText(index),
          range
        })));
      } else if (context.kind === "operator") {
        const operators = isMatcherTimeField(context.field) ? [...grammar.comparisonOperators, "is empty", "is not empty"] : grammar.fieldOperators;
        suggestions.push(...operators.map((operator) => ({
          label: operator,
          kind: monaco.languages.CompletionItemKind.Operator,
          insertText: operator === "in" ? "in ()" : operator === "not in" ? "not in ()" : operator,
          range
        })));
      } else if (context.kind === "task") {
        const values = await fetchInstructionValueSuggestions(projectId, "id", context.prefix || token, 50);
        suggestions.push(...values.map((item, index) => ({
          label: item.label,
          kind: monaco.languages.CompletionItemKind.Reference,
          detail: item.detail,
          insertText: formatMatcherValue(item.value),
          sortText: completionSortText(index),
          range
        })));
        suggestions.push(...grammar.comparisonOperators.map((operator) => ({
          label: operator,
          kind: monaco.languages.CompletionItemKind.Operator,
          detail: "count comparison",
          insertText: operator,
          range
        })));
      } else {
        suggestions.push(...grammar.fields.map((field) => ({
          label: field,
          kind: monaco.languages.CompletionItemKind.Field,
          detail: "field",
          insertText: field,
          range
        })));
        suggestions.push(
          { label: "depends on", kind: monaco.languages.CompletionItemKind.Keyword, detail: "dependency relation", insertText: "depends on ", range },
          { label: "unblocks", kind: monaco.languages.CompletionItemKind.Keyword, detail: "unblocks relation", insertText: "unblocks ", range },
          { label: "descendant of", kind: monaco.languages.CompletionItemKind.Keyword, detail: "hierarchy relation", insertText: "descendant of ", range },
          ...grammar.booleanOperators.map((operator) => ({ label: operator, kind: monaco.languages.CompletionItemKind.Keyword, insertText: operator, range }))
        );
      }

      return { suggestions };
    }
  });
}

function completionSortText(index: number): string {
  return String(index).padStart(6, "0");
}

function getInstructionCompletionContext(line: string, grammar: InstructionGrammarRecord): { kind: "root" } | { kind: "operator"; field: string } | { kind: "task"; prefix: string } | { kind: "value"; field: string; prefix: string } {
  const sortedFields = [...grammar.fields].sort((left, right) => right.length - left.length);
  for (const field of sortedFields) {
    const fieldRegex = fieldMatcherRegex(field);
    const comparison = line.match(new RegExp(`(?:^|[\\s(])${fieldRegex}\\s*(?:=|!=|>=|<=|>|<)\\s*([^\\s(),]*)$`, "i"));
    if (comparison) {
      return { kind: "value", field, prefix: comparison[1] ?? "" };
    }
    const membership = line.match(new RegExp(`(?:^|[\\s(])${fieldRegex}\\s+in\\s*\\([^)]*$`, "i"));
    if (membership) {
      return { kind: "value", field, prefix: currentMatcherToken(line) };
    }
    const negativeMembership = line.match(new RegExp(`(?:^|[\\s(])${fieldRegex}\\s+not\\s+in\\s*\\([^)]*$`, "i"));
    if (negativeMembership) {
      return { kind: "value", field, prefix: currentMatcherToken(line) };
    }
    if (line.match(new RegExp(`(?:^|[\\s(])${fieldRegex}\\s*$`, "i"))) {
      return { kind: "operator", field };
    }
    if (line.match(new RegExp(`(?:^|[\\s(])${fieldRegex}\\s+not\\s*$`, "i"))) {
      return { kind: "operator", field };
    }
  }
  const taskRelation = line.match(/(?:^|[\s(])(?:depends\s+on|unblocks|descendant\s+of)\s+([A-Za-z0-9._:/-]*)$/i);
  if (taskRelation) {
    return { kind: "task", prefix: taskRelation[1] ?? "" };
  }
  return { kind: "root" };
}

function fieldMatcherRegex(field: string): string {
  return field.split(/\s+/).map(escapeRegExp).join("\\s+");
}

function currentMatcherToken(line: string): string {
  return line.match(/[A-Za-z0-9._:/-]*$/)?.[0] ?? "";
}

async function fetchInstructionValueSuggestions(projectId: string, field: string, prefix: string, limit: number): Promise<InstructionFieldValueSuggestionRecord[]> {
  const params = new URLSearchParams({ projectId, field, limit: String(limit) });
  if (prefix) {
    params.set("prefix", prefix);
  }
  return fetchJson<InstructionFieldValueSuggestionRecord[]>(`/api/instructions/suggest?${params.toString()}`);
}

function formatMatcherValue(value: string): string {
  return /^[A-Za-z0-9._:/-]+$/.test(value) ? value : JSON.stringify(value);
}

function isMatcherTimeField(field: string): boolean {
  return field === "created" || field === "updated" || field === "started" || field === "finished" || field === "archived";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function CoverageView({ coverage }: { coverage: SourceCoverage[] }) {
  return (
    <section className="wide-view">
      <div className="view-heading"><h1>Source Coverage</h1></div>
      <div className="coverage-table">
        <div className="coverage-row header"><span>Source</span><span>Total</span><span>Ready</span><span>Blocked</span><span>Started</span><span>Finished</span></div>
        {coverage.map((row, index) => (
          <div className="coverage-row" key={`${row.sourceDoc ?? "none"}-${row.sourceSection ?? "none"}-${index}`}>
            <span>{row.sourceDoc ?? "No source"} / {row.sourceSection ?? "No section"}</span>
            <span>{row.total}</span>
            <span>{row.ready}</span>
            <span>{row.blocked}</span>
            <span>{row.started}</span>
            <span>{row.finished}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ActivityView({ activity }: { activity: ActivityRecord[] }) {
  return (
    <section className="wide-view">
      <div className="view-heading"><h1>Activity</h1></div>
      <div className="activity-list">
        {activity.map((item) => (
          <div className="activity-row" key={item.id}>
            <span>{new Date(item.createdAt).toLocaleString()}</span>
            <span>{formatActorRef(item)}</span>
            <strong>{item.type}</strong>
            <span>{item.message}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function TaskMini({ task, onClick }: { task: TaskView; onClick?: () => void }) {
  const content = (
    <>
      <StatusDot status={task.computedStatus} />
      <div>
        <strong>{task.id}</strong>
        <span>{task.title}</span>
        {task.commentCount > 0 ? <CommentChip task={task} /> : null}
      </div>
    </>
  );
  return onClick ? (
    <button className="task-mini clickable" onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className="task-mini">
      {content}
    </div>
  );
}

function CommentChip({ task }: { task: TaskView }) {
  return (
    <span className={task.recentCommentCount > 0 ? "comment-chip recent" : "comment-chip"} title={`${task.commentCount} ${task.commentCount === 1 ? "comment" : "comments"}`}>
      <span>{task.commentCount}</span>
      <MessageSquare size={13} />
    </span>
  );
}

function TagChip({ tag }: { tag: TagRecord }) {
  return (
    <span className="tag-chip">
      <span className="tag-dot" style={{ background: tag.color ?? "#64748b" }} />
      <span>{tag.name}</span>
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric-box"><span>{label}</span><strong>{value}</strong></div>;
}

function Progress({ value, large = false }: { value: number; large?: boolean }) {
  return <div className={large ? "progress large" : "progress"}><span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>;
}

function StatusDot({ status }: { status: ComputedStatus }) {
  return <span className={`status-dot ${status}`} title={status} />;
}

function formatRollupStatus(task: TaskView): string {
  const rollupStatus = getRollupStatus(task);
  if (rollupStatus === "leaf") {
    return "leaf task";
  }
  if (rollupStatus === "complete") {
    return "child rollup complete";
  }
  const unfinishedDescendantsCount = getUnfinishedDescendantsCount(task);
  return `blocked by ${unfinishedDescendantsCount} unfinished ${unfinishedDescendantsCount === 1 ? "descendant" : "descendants"}`;
}

function getRollupStatus(task: TaskView): RollupStatus {
  if (task.rollupStatus) {
    return task.rollupStatus;
  }
  if (task.childrenCount === 0) {
    return "leaf";
  }
  return getUnfinishedDescendantsCount(task) === 0 ? "complete" : "blocked-by-children";
}

function getUnfinishedDescendantsCount(task: TaskView): number {
  return task.unfinishedDescendantsCount ?? Math.max(0, task.descendantsCount - task.subtreeFinishedCount);
}

function getCriticalChildPath(task: TaskView): NonNullable<TaskView["criticalChildPath"]> {
  return task.criticalChildPath ?? [];
}

function appliedFiltersFromUiState(uiState: UiState): AppliedTaskFilters {
  return {
    statusFilters: normalizeStatusFilters(uiState.statusFilters),
    search: uiState.search.trim(),
    matcher: uiState.matcher.trim()
  };
}

function sameAppliedFilters(left: AppliedTaskFilters, right: AppliedTaskFilters): boolean {
  return sameStatusFilters(left.statusFilters, right.statusFilters)
    && left.search === right.search
    && left.matcher === right.matcher;
}

function normalizeAppConfig(input: unknown): AppConfig {
  const record = isRecord(input) ? input : {};
  const identity = isRecord(record.identity) ? record.identity : {};
  const ui = isRecord(record.ui) ? record.ui : {};
  const machine = typeof identity.machine === "string" ? identity.machine : "";
  const actor = typeof identity.actor === "string" ? identity.actor : "";
  const refreshIntervalMs = typeof ui.refreshIntervalMs === "number" && Number.isFinite(ui.refreshIntervalMs)
    ? Math.max(1000, Math.min(600000, Math.trunc(ui.refreshIntervalMs)))
    : DEFAULT_APP_CONFIG.ui.refreshIntervalMs;
  const persistState = typeof ui.persistState === "boolean" ? ui.persistState : DEFAULT_APP_CONFIG.ui.persistState;
  const issues = Array.isArray(record.issues) ? record.issues.filter((issue): issue is string => typeof issue === "string") : [];
  return { identity: { machine, actor }, ui: { refreshIntervalMs, persistState }, issues };
}

function usePersistentUiState(enabled: boolean): [UiState, Dispatch<SetStateAction<UiState>>] {
  const previousEnabledRef = useRef(enabled);
  const [state, setState] = useState<UiState>(() => {
    if (!enabled) {
      return DEFAULT_UI_STATE;
    }
    return readStoredUiState();
  });

  useEffect(() => {
    if (!enabled) {
      window.localStorage.removeItem(UI_STATE_KEY);
      if (previousEnabledRef.current) {
        setState(DEFAULT_UI_STATE);
      }
      previousEnabledRef.current = enabled;
      return;
    }
    previousEnabledRef.current = enabled;
    window.localStorage.setItem(UI_STATE_KEY, JSON.stringify(state));
  }, [enabled, state]);

  return [state, setState];
}

function readStoredUiState(): UiState {
  try {
    const raw = window.localStorage.getItem(UI_STATE_KEY);
    if (!raw) {
      return DEFAULT_UI_STATE;
    }
    return normalizeUiState(JSON.parse(raw) as unknown);
  } catch {
    window.localStorage.removeItem(UI_STATE_KEY);
    return DEFAULT_UI_STATE;
  }
}

function normalizeUiState(input: unknown): UiState {
  const record = isRecord(input) ? input : {};
  const mode = isViewMode(record.mode) ? record.mode : DEFAULT_UI_STATE.mode;
  const statusFilters = normalizeStoredStatusFilters(record);
  const selectedId = typeof record.selectedId === "string" ? record.selectedId : null;
  const collapsedTaskIds = Array.isArray(record.collapsedTaskIds)
    ? [...new Set(record.collapsedTaskIds.filter((item): item is string => typeof item === "string"))]
    : [];
  return {
    mode,
    projectId: typeof record.projectId === "string" && record.projectId.trim() ? record.projectId : DEFAULT_UI_STATE.projectId,
    selectedId,
    statusFilters,
    search: typeof record.search === "string" ? record.search : "",
    matcher: typeof record.matcher === "string" ? record.matcher : "",
    selectedViewId: typeof record.selectedViewId === "string" ? record.selectedViewId : "",
    collapsedTaskIds,
    scrollPositions: normalizeScrollPositions(record.scrollPositions),
    newProjectDraft: typeof record.newProjectDraft === "string" ? record.newProjectDraft : "",
    newTrackDraft: typeof record.newTrackDraft === "string" ? record.newTrackDraft : "",
    newTagDraft: typeof record.newTagDraft === "string" ? record.newTagDraft : ""
  };
}

function normalizeScrollPositions(input: unknown): Record<string, number> {
  if (!isRecord(input)) {
    return {};
  }
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      result[key] = value;
    }
  }
  return result;
}

function isViewMode(value: unknown): value is ViewMode {
  return value === "tasks" || value === "queues" || value === "tags" || value === "instructions" || value === "coverage" || value === "activity";
}

function isStatusFilter(value: unknown): value is StatusFilter {
  return value === "ready" || value === "blocked" || value === "started" || value === "finished" || value === "archived";
}

function normalizeStoredStatusFilters(record: Record<string, unknown>): StatusFilter[] {
  if (Array.isArray(record.statusFilters)) {
    return normalizeStatusFilters(record.statusFilters);
  }
  const migrated: StatusFilter[] = [];
  if (isStatusFilter(record.status)) {
    migrated.push(record.status);
  }
  if (record.status === "all") {
    migrated.push(...DEFAULT_STATUS_FILTERS);
  }
  if (record.includeFinished === true) {
    migrated.push("finished");
  }
  if (record.includeArchived === true) {
    migrated.push("archived");
  }
  return migrated.length > 0 ? normalizeStatusFilters(migrated) : [...DEFAULT_STATUS_FILTERS];
}

function normalizeStatusFilters(input: unknown): StatusFilter[] {
  const values = Array.isArray(input) ? input : [];
  const selected = new Set<StatusFilter>();
  for (const value of values) {
    if (isStatusFilter(value)) {
      selected.add(value);
    }
  }
  return STATUS_FILTER_ORDER.filter((status) => selected.has(status));
}

function sameStatusFilters(left: StatusFilter[], right: StatusFilter[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((status) => rightSet.has(status));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function withProject(path: string, projectId: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}projectId=${encodeURIComponent(projectId)}`;
}

function getKeyboardShortcuts(): { suggest: string } {
  return { suggest: `${isMacPlatform() ? "Command" : "Ctrl"} + Space` };
}

function isMacPlatform(): boolean {
  const nav = window.navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

async function mutate(url: string, options: { method: string; body?: unknown }): Promise<void> {
  await mutateResponse(url, options);
}

async function mutateJson<T>(url: string, options: { method: string; body?: unknown }): Promise<T> {
  const response = await mutateResponse(url, options);
  return response.json() as Promise<T>;
}

async function mutateResponse(url: string, options: { method: string; body?: unknown }): Promise<Response> {
  const init: RequestInit = {
    method: options.method,
  };
  if (options.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response;
}

function formatActorRef(identity: { machine: string; actor: string }): string {
  return `${identity.machine}:${identity.actor}`;
}

function formatShortDateTime(value: string): string {
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

type UnblockWindow = Window & typeof globalThis & { __unblockRoot?: Root };

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing root element.");
}
const unblockWindow = window as UnblockWindow;
const root = unblockWindow.__unblockRoot ?? createRoot(rootElement);
unblockWindow.__unblockRoot = root;
root.render(<StrictMode><App /></StrictMode>);
