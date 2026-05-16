import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  Activity,
  Blocks,
  BookOpen,
  Check,
  Filter,
  GitBranch,
  ListChecks,
  ListTree,
  Plus,
  PlugZap,
  RefreshCw,
  Tags,
  UserRound
} from "lucide-react";

import { fetchJson, mutate, mutateJson, withProject } from "./api";
import { TopMatcherEditor } from "./matcher/MatcherEditor";
import { ActivityView } from "./views/ActivityView";
import { CoverageView } from "./views/CoverageView";
import { ConnectorsView } from "./views/ConnectorsView";
import { InstructionsView } from "./views/InstructionsView";
import { QueuesView } from "./views/QueuesView";
import { TagsView } from "./views/TagsView";
import { BulkTaskDetails, CreateTaskRow, DependencyModePanel, TaskDetails, TaskNode, buildTaskTree, flattenVisibleTaskIds, getDependencyCandidateState, getSelectionRange, getSubtreeTaskIds } from "./tasks/TaskComponents";
import { NavButton, StatusTabs } from "./components/navigation";
import { appliedFiltersFromUiState, normalizeAppConfig, sameAppliedFilters, usePersistentUiState } from "./state/uiState";
import { parseUnifiedQuery } from "./query/unifiedQuery";
import {
  DEFAULT_APP_CONFIG,
  type ActivityRecord,
  type ActivityUiState,
  type AppConfig,
  type AppliedTaskFilters,
  type CommentRecord,
  type CreateTaskDraft,
  type DependencyMode,
  type Explanation,
  type InstructionRecord,
  type MatcherGrammarRecord,
  type ProjectRecord,
  type QueueFeedRecord,
  type RefreshOptions,
  type SavedViewRecord,
  type SourceCoverage,
  type StatusFilter,
  type TagRecord,
  type TaskAction,
  type TaskView,
  type TrackRecord,
  type UiState
} from "./types";

const EMPTY_TASKS: TaskView[] = [];

function App() {
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [tracks, setTracks] = useState<TrackRecord[]>([]);
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [instructions, setInstructions] = useState<InstructionRecord[]>([]);
  const [matcherGrammar, setMatcherGrammar] = useState<MatcherGrammarRecord | null>(null);
  const [savedViews, setSavedViews] = useState<SavedViewRecord[]>([]);
  const [queueFeeds, setQueueFeeds] = useState<QueueFeedRecord[]>([]);
  const [activity, setActivity] = useState<ActivityRecord[]>([]);
  const [coverage, setCoverage] = useState<SourceCoverage[]>([]);
  const [appConfig, setAppConfig] = useState<AppConfig>(DEFAULT_APP_CONFIG);
  const [identityDraft, setIdentityDraft] = useState(DEFAULT_APP_CONFIG.identity);
  const [uiState, setUiState] = usePersistentUiState(appConfig.ui.persistState);
  const [appliedFilters, setAppliedFilters] = useState<AppliedTaskFilters>(() => appliedFiltersFromUiState(uiState));
  const [taskDataProjectId, setTaskDataProjectId] = useState<string | null>(null);
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
  const currentProjectIdRef = useRef(uiState.projectId);
  const previousProjectIdRef = useRef(uiState.projectId);
  const selectionAnchorRef = useRef<string | null>(null);
  const scrollPatchRef = useRef<Record<string, number>>({});
  const scrollFrameRef = useRef<number | null>(null);
  currentProjectIdRef.current = uiState.projectId;

  const currentTasks = taskDataProjectId === uiState.projectId ? tasks : EMPTY_TASKS;
  const selectedTask = useMemo(() => currentTasks.find((task) => task.id === uiState.selectedId) ?? currentTasks[0] ?? null, [uiState.selectedId, currentTasks]);
  const roots = useMemo(() => buildTaskTree(currentTasks), [currentTasks]);
  const readyTasks = useMemo(() => currentTasks.filter((task) => task.ready), [currentTasks]);
  const collapsedTaskIds = useMemo(() => new Set(uiState.collapsedTaskIds), [uiState.collapsedTaskIds]);
  const visibleTaskIds = useMemo(() => flattenVisibleTaskIds(roots, collapsedTaskIds), [roots, collapsedTaskIds]);
  const activeSelectedIds = useMemo(() => selectedIds.length > 0 ? selectedIds : selectedTask ? [selectedTask.id] : [], [selectedIds, selectedTask]);
  const activeSelectedIdSet = useMemo(() => new Set(activeSelectedIds), [activeSelectedIds]);
  const selectedTasks = useMemo(() => activeSelectedIds.map((id) => currentTasks.find((task) => task.id === id)).filter((task): task is TaskView => Boolean(task)), [activeSelectedIds, currentTasks]);
  const detailTask = selectedIds.length === 1 ? selectedTasks[0] ?? selectedTask : selectedTask;
  const activeProjects = useMemo(() => projects.filter((project) => !project.archivedAt), [projects]);
  const selectedProject = useMemo(() => projects.find((project) => project.id === uiState.projectId) ?? null, [projects, uiState.projectId]);
  const draftTaskQuery = useMemo(() => parseUnifiedQuery(uiState.query), [uiState.query]);
  const taskQueryDirty = draftTaskQuery.errors.length > 0 || !sameAppliedFilters(appliedFilters, {
    statusFilters: uiState.statusFilters,
    search: draftTaskQuery.search,
    matcher: draftTaskQuery.filter
  });
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
    fetchJson<MatcherGrammarRecord>("/api/matcher/grammar").then(setMatcherGrammar).catch(() => setMatcherGrammar(null));
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
    if (previousProjectIdRef.current === uiState.projectId) {
      return;
    }
    previousProjectIdRef.current = uiState.projectId;
    setTaskDataProjectId(null);
    setTasks([]);
    setTracks([]);
    setTags([]);
    setInstructions([]);
    setSavedViews([]);
    setQueueFeeds([]);
    setActivity([]);
    setCoverage([]);
    setExplanation(null);
    setComments([]);
    setCommentDraft("");
    setCommentsFocusTarget(null);
    setError(null);
    setSelectedIds([]);
    setDependencyMode(null);
    setCreateDraft(null);
    selectionAnchorRef.current = null;
    updateUiState((current) => current.selectedId === null && current.collapsedTaskIds.length === 0
      ? current
      : { ...current, selectedId: null, collapsedTaskIds: [] });
  }, [uiState.projectId, updateUiState]);

  useEffect(() => {
    const taskIds = new Set(currentTasks.map((task) => task.id));
    setSelectedIds((current) => {
      const next = current.filter((id) => taskIds.has(id));
      return next.length === current.length ? current : next;
    });
    if (dependencyMode && dependencyMode.targetIds.some((id) => !taskIds.has(id))) {
      setDependencyMode(null);
    }
  }, [currentTasks, dependencyMode]);

  const refresh = useCallback(async (options: RefreshOptions = {}) => {
    const requestProjectId = uiState.projectId;
    if (projects.length === 0 || !projects.some((project) => project.id === requestProjectId && !project.archivedAt)) {
      return;
    }
    if (!options.silent) {
      setLoading(true);
    }
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("projectId", requestProjectId);
      params.set("sort", "dependency");
      const useTaskFilters = uiState.mode === "tasks";
      if (useTaskFilters && appliedFilters.search) {
        params.set("search", appliedFilters.search);
      }
      if (useTaskFilters && appliedFilters.matcher) {
        params.set("where", appliedFilters.matcher);
      }
      if (useTaskFilters && (appliedFilters.statusFilters.includes("finished") || appliedFilters.statusFilters.includes("archived"))) {
        params.set("includeFinished", "true");
      }
      if (useTaskFilters && appliedFilters.statusFilters.includes("archived")) {
        params.set("includeArchived", "true");
      }
      const [taskData, trackData, tagData, instructionData, viewData, feedData, activityData, coverageData] = await Promise.all([
        fetchJson<TaskView[]>(`/api/tasks?${params.toString()}`),
        fetchJson<TrackRecord[]>(withProject("/api/tracks", requestProjectId)),
        fetchJson<TagRecord[]>(withProject("/api/tags", requestProjectId)),
        fetchJson<InstructionRecord[]>(withProject("/api/instructions?includeArchived=true", requestProjectId)),
        fetchJson<SavedViewRecord[]>(withProject("/api/views", requestProjectId)),
        fetchJson<QueueFeedRecord[]>(withProject("/api/feeds", requestProjectId)),
        fetchJson<ActivityRecord[]>(withProject("/api/activity?limit=200", requestProjectId)),
        fetchJson<SourceCoverage[]>(withProject("/api/source-coverage", requestProjectId))
      ]);
      if (currentProjectIdRef.current !== requestProjectId) {
        return;
      }
      const visibleTaskData = useTaskFilters
        ? taskData.filter((task) => appliedFilters.statusFilters.includes(task.computedStatus))
        : taskData;
      setTasks(visibleTaskData);
      setTaskDataProjectId(requestProjectId);
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
      if (currentProjectIdRef.current === requestProjectId) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (currentProjectIdRef.current === requestProjectId && !options.silent) {
        setLoading(false);
      }
    }
  }, [appliedFilters, projects, uiState.mode, uiState.projectId, updateUiState]);

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
    const subtreeIds = getSubtreeTaskIds(taskId, currentTasks);
    selectionAnchorRef.current = taskId;
    setSelectedIds(subtreeIds);
    updateUiState({ selectedId: taskId });
  }

  function selectDisplayedTasks() {
    const ids = currentTasks.map((task) => task.id);
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

  async function releaseTask(task: TaskView, reason: string) {
    await runMutation(async () => {
      await mutate(withProject(`/api/tasks/${task.id}/release`, uiState.projectId), { method: "POST", body: { reason } });
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
    const uniqueTargetIds = [...new Set(targetIds)].filter((id) => currentTasks.some((task) => task.id === id));
    if (uniqueTargetIds.length === 0) {
      return;
    }
    setError(null);
    setDependencyMode({ targetIds: uniqueTargetIds, draftByTaskId: {}, dependencyMap: {}, loading: true });
    try {
      const explanations = await Promise.all(currentTasks.map((task) => fetchJson<Explanation>(withProject(`/api/tasks/${task.id}/explain`, uiState.projectId))));
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
      const state = getDependencyCandidateState(candidateId, current, currentTasks);
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
    if (draftTaskQuery.errors.length > 0) {
      setError(draftTaskQuery.errors.join(" "));
      return;
    }
    if (!draftTaskQuery.filter) {
      return;
    }
    const name = window.prompt("Saved view name");
    if (!name?.trim()) {
      return;
    }
    await runMutation(async () => {
      const saved = await mutateJson<SavedViewRecord>(withProject("/api/views", uiState.projectId), {
        method: "POST",
        body: { name: name.trim(), query: draftTaskQuery.filter }
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
      search: draftTaskQuery.errors.length > 0 ? appliedFilters.search : draftTaskQuery.search,
      matcher: draftTaskQuery.errors.length > 0 ? appliedFilters.matcher : draftTaskQuery.filter
    };
    updateUiState({ statusFilters: nextStatuses });
    setAppliedFilters((current) => sameAppliedFilters(current, nextFilters) ? current : nextFilters);
  }

  function applyQueryNow() {
    if (draftTaskQuery.errors.length > 0) {
      setError(draftTaskQuery.errors.join(" "));
      return;
    }
    setError(null);
    const nextFilters = { statusFilters: uiState.statusFilters, search: draftTaskQuery.search, matcher: draftTaskQuery.filter };
    setAppliedFilters((current) => sameAppliedFilters(current, nextFilters) ? current : nextFilters);
  }

  function showMatcherSuggestions() {
    setMatcherSuggestTick((tick) => tick + 1);
  }

  function applySavedView(viewId: string) {
    const selected = savedViews.find((view) => view.id === viewId);
    const query = selected ? `filter(${selected.query})` : "";
    const parsed = parseUnifiedQuery(query);
    updateUiState({ selectedViewId: viewId, query });
    setAppliedFilters((current) => {
      const next = { ...current, search: parsed.search, matcher: parsed.filter };
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
          <NavButton active={uiState.mode === "connectors"} icon={<PlugZap size={17} />} label="Connectors" onClick={() => updateUiState({ mode: "connectors" })} />
          <NavButton active={uiState.mode === "coverage"} icon={<Blocks size={17} />} label="Coverage" onClick={() => updateUiState({ mode: "coverage" })} />
          <NavButton active={uiState.mode === "activity"} icon={<Activity size={17} />} label="Activity" onClick={() => updateUiState({ mode: "activity" })} />
        </nav>
        <div className="ready-summary">
          <div>
            <span className="metric">{readyTasks.length}</span>
            <span className="label">ready</span>
          </div>
          <div>
            <span className="metric">{currentTasks.reduce((sum, task) => sum + (task.blocked ? 1 : 0), 0)}</span>
            <span className="label">blocked</span>
          </div>
        </div>
      </aside>

      <main className="workspace">
        {uiState.mode === "tasks" ? (
          <header className="toolbar">
            <div className="toolbar-main-row">
              <div className={taskQueryDirty ? "top-matcher unified-query dirty" : "top-matcher unified-query"}>
                <button className="matcher-icon-button" onClick={showMatcherSuggestions} title="Show query suggestions"><Filter size={17} /></button>
                <TopMatcherEditor
                  value={uiState.query}
                  projectId={uiState.projectId}
                  grammar={matcherGrammar}
                  suggestSignal={matcherSuggestTick}
                  variant="query"
                  onChange={(query) => updateUiState({ query, selectedViewId: "" })}
                  onApply={applyQueryNow}
                />
                {!uiState.query ? <span className="matcher-placeholder">Search tasks or use filter(status = ready)</span> : null}
              </div>
              <span className="shortcut-hint matcher-shortcut"><kbd>Shift</kbd> + <kbd>Enter</kbd></span>
              <button className="primary-button" disabled={!taskQueryDirty} onClick={applyQueryNow}><Check size={16} /> Apply</button>
              <select value={uiState.selectedViewId} onChange={(event) => applySavedView(event.target.value)} title="Saved view">
                <option value="">Saved view</option>
                {savedViews.filter((view) => !view.archivedAt).map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
              </select>
              <button disabled={draftTaskQuery.errors.length > 0 || !draftTaskQuery.filter || !identityReady} onClick={() => void saveCurrentMatcherAsView()} title="Save filter as view"><Plus size={16} /> View</button>
              <StatusTabs
                value={uiState.statusFilters}
                onChange={toggleStatusFilter}
              />
              <button className="icon-button" onClick={() => void refresh()} title="Refresh"><RefreshCw size={17} /></button>
            </div>
          </header>
        ) : null}

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
                  <button disabled={currentTasks.length === 0} onClick={selectDisplayedTasks}><ListChecks size={16} /> Select displayed</button>
                  <button onClick={() => startCreateTask(null)}><Plus size={16} /> New root task</button>
                  <button className="icon-button" onClick={showMatcherSuggestions} title="Show query suggestions"><Filter size={18} /></button>
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
                    tasks={currentTasks}
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
                tasks={currentTasks}
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
                onRelease={(task, reason) => void releaseTask(task, reason)}
                onEditDependencies={(task) => void startDependencyMode([task.id])}
                onSelectSubtree={(task) => selectSubtree(task.id)}
                onStartCreateSubtask={(task) => startCreateTask(task.id)}
              />
            )}
          </section>
        ) : null}

        {uiState.mode === "queues" ? (
          <QueuesView tracks={tracks} tasks={currentTasks} feeds={queueFeeds} projectId={uiState.projectId} newTrack={uiState.newTrackDraft} setNewTrack={(newTrackDraft) => updateUiState({ newTrackDraft })} createTrack={() => void createTrack()} onAssign={(track, task) => void assignTask(track, task)} onOpenTask={(task) => openTask(task.id)} />
        ) : null}

        {uiState.mode === "tags" ? (
          <TagsView tags={tags} tasks={currentTasks} newTag={uiState.newTagDraft} setNewTag={(newTagDraft) => updateUiState({ newTagDraft })} createTag={() => void createTag()} />
        ) : null}

        {uiState.mode === "instructions" ? (
          <InstructionsView
            key={uiState.projectId}
            projectId={uiState.projectId}
            instructions={instructions}
            grammar={matcherGrammar}
            tasks={currentTasks}
            onRefresh={() => refresh({ silent: true })}
            onOpenTask={(task) => openTask(task.id)}
          />
        ) : null}

        {uiState.mode === "connectors" ? <ConnectorsView projectId={uiState.projectId} onError={setError} /> : null}
        {uiState.mode === "coverage" ? <CoverageView coverage={coverage} /> : null}
        {uiState.mode === "activity" ? (
          <ActivityView
            initialActivity={activity}
            projectId={uiState.projectId}
            grammar={matcherGrammar}
            state={uiState.activity}
            onStateChange={(activityPatch: Partial<ActivityUiState>) => updateUiState((current) => ({ ...current, activity: { ...current.activity, ...activityPatch } }))}
            onOpenTask={(task) => openTask(task.id)}
          />
        ) : null}
      </main>
    </div>
  );
}



export default App;
