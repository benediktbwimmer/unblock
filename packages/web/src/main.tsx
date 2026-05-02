import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Archive,
  Blocks,
  Check,
  ChevronDown,
  CircleDot,
  Filter,
  GitBranch,
  ListTree,
  Plus,
  RefreshCw,
  Search,
  Tags,
  UserRound
} from "lucide-react";
import "./styles.css";

type Lifecycle = "open" | "started" | "finished";
type ComputedStatus = "ready" | "blocked" | "started" | "finished" | "archived";
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
  actor: string;
  name: string | null;
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
  assignedTrack: { trackId: string; actor: string; name: string | null; position: string } | null;
  tags: TagRecord[];
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
}

interface ActivityRecord {
  id: string;
  type: string;
  subjectType: string;
  subjectId: string | null;
  message: string;
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

type ViewMode = "tasks" | "queues" | "tags" | "coverage" | "activity";

function App() {
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [tracks, setTracks] = useState<TrackRecord[]>([]);
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [activity, setActivity] = useState<ActivityRecord[]>([]);
  const [coverage, setCoverage] = useState<SourceCoverage[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [mode, setMode] = useState<ViewMode>("tasks");
  const [status, setStatus] = useState<ComputedStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [includeFinished, setIncludeFinished] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newTask, setNewTask] = useState({ id: "", title: "", parentTaskId: "", priority: "2" });
  const [newTrack, setNewTrack] = useState("");
  const [newTag, setNewTag] = useState("");

  const selectedTask = useMemo(() => tasks.find((task) => task.id === selectedId) ?? tasks[0] ?? null, [selectedId, tasks]);
  const roots = useMemo(() => buildTaskTree(tasks), [tasks]);
  const readyTasks = useMemo(() => tasks.filter((task) => task.ready), [tasks]);

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!selectedTask) {
      setExplanation(null);
      return;
    }
    fetchJson<Explanation>(`/api/tasks/${selectedTask.id}/explain`).then(setExplanation).catch((reason) => setError(String(reason)));
  }, [selectedTask?.id]);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("sort", "dependency");
      if (status !== "all") {
        params.set("status", status);
      }
      if (search.trim()) {
        params.set("search", search.trim());
      }
      if (includeFinished) {
        params.set("includeFinished", "true");
      }
      if (includeArchived) {
        params.set("includeArchived", "true");
      }
      const [taskData, trackData, tagData, activityData, coverageData] = await Promise.all([
        fetchJson<TaskView[]>(`/api/tasks?${params.toString()}`),
        fetchJson<TrackRecord[]>("/api/tracks"),
        fetchJson<TagRecord[]>("/api/tags"),
        fetchJson<ActivityRecord[]>("/api/activity?limit=40"),
        fetchJson<SourceCoverage[]>("/api/source-coverage")
      ]);
      setTasks(taskData);
      setTracks(trackData);
      setTags(tagData);
      setActivity(activityData);
      setCoverage(coverageData);
      if (!selectedId && taskData.length > 0) {
        setSelectedId(taskData[0]?.id ?? null);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }

  async function createTask() {
    if (!newTask.id.trim() || !newTask.title.trim()) {
      return;
    }
    await mutate("/api/tasks", {
      method: "POST",
      body: {
        id: newTask.id,
        title: newTask.title,
        parentTaskId: newTask.parentTaskId.trim() || null,
        priority: Number(newTask.priority)
      }
    });
    setNewTask({ id: "", title: "", parentTaskId: "", priority: "2" });
    await refresh();
  }

  async function transitionTask(task: TaskView, action: "start" | "finish" | "reopen" | "archive") {
    await mutate(`/api/tasks/${task.id}/${action}`, { method: "POST" });
    await refresh();
  }

  async function createTrack() {
    if (!newTrack.trim()) {
      return;
    }
    await mutate("/api/tracks", { method: "POST", body: { actor: newTrack.trim() } });
    setNewTrack("");
    await refresh();
  }

  async function createTag() {
    if (!newTag.trim()) {
      return;
    }
    await mutate("/api/tags", { method: "POST", body: { name: newTag.trim() } });
    setNewTag("");
    await refresh();
  }

  async function assignTask(track: TrackRecord, task: TaskView) {
    await mutate(`/api/tracks/${track.id}/assignments`, { method: "POST", body: { taskId: task.id } });
    await refresh();
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <GitBranch size={22} />
          <span>not-jira</span>
        </div>
        <nav className="nav">
          <NavButton active={mode === "tasks"} icon={<ListTree size={17} />} label="Tasks" onClick={() => setMode("tasks")} />
          <NavButton active={mode === "queues"} icon={<UserRound size={17} />} label="Queues" onClick={() => setMode("queues")} />
          <NavButton active={mode === "tags"} icon={<Tags size={17} />} label="Tags" onClick={() => setMode("tags")} />
          <NavButton active={mode === "coverage"} icon={<Blocks size={17} />} label="Coverage" onClick={() => setMode("coverage")} />
          <NavButton active={mode === "activity"} icon={<Activity size={17} />} label="Activity" onClick={() => setMode("activity")} />
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
          <div className="search-wrap">
            <Search size={17} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void refresh()} placeholder="Search tasks, source text, docs" />
          </div>
          <select value={status} onChange={(event) => setStatus(event.target.value as ComputedStatus | "all")}>
            <option value="all">All active</option>
            <option value="ready">Ready</option>
            <option value="blocked">Blocked</option>
            <option value="started">Started</option>
            <option value="finished">Finished</option>
            <option value="archived">Archived</option>
          </select>
          <label className="toggle"><input type="checkbox" checked={includeFinished} onChange={(event) => setIncludeFinished(event.target.checked)} /> Finished</label>
          <label className="toggle"><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /> Archived</label>
          <button className="icon-button" onClick={() => void refresh()} title="Refresh"><RefreshCw size={17} /></button>
        </header>

        {error ? <div className="error">{error}</div> : null}
        {loading ? <div className="loading">Loading dependency graph...</div> : null}

        {mode === "tasks" ? (
          <section className="task-layout">
            <div className="task-list-panel">
              <div className="panel-heading">
                <div>
                  <h1>Dependency-First Tasks</h1>
                  <p>Default order ranks ready work by downstream tasks unblocked, then priority and graph depth.</p>
                </div>
                <Filter size={18} />
              </div>
              <QuickCreateTask value={newTask} tasks={tasks} onChange={setNewTask} onSubmit={() => void createTask()} />
              <div className="task-tree">
                {roots.map((node) => (
                  <TaskNode
                    key={node.task.id}
                    node={node}
                    selectedId={selectedTask?.id ?? null}
                    onSelect={setSelectedId}
                    onTransition={transitionTask}
                  />
                ))}
              </div>
            </div>
            <TaskDetails task={selectedTask} explanation={explanation} tracks={tracks} onAssign={(track, task) => void assignTask(track, task)} onTransition={(task, action) => void transitionTask(task, action)} />
          </section>
        ) : null}

        {mode === "queues" ? (
          <QueuesView tracks={tracks} tasks={tasks} newTrack={newTrack} setNewTrack={setNewTrack} createTrack={() => void createTrack()} onAssign={(track, task) => void assignTask(track, task)} />
        ) : null}

        {mode === "tags" ? (
          <TagsView tags={tags} tasks={tasks} newTag={newTag} setNewTag={setNewTag} createTag={() => void createTag()} />
        ) : null}

        {mode === "coverage" ? <CoverageView coverage={coverage} /> : null}
        {mode === "activity" ? <ActivityView activity={activity} /> : null}
      </main>
    </div>
  );
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return <button className={active ? "nav-button active" : "nav-button"} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function QuickCreateTask({ value, tasks, onChange, onSubmit }: { value: { id: string; title: string; parentTaskId: string; priority: string }; tasks: TaskView[]; onChange: (value: { id: string; title: string; parentTaskId: string; priority: string }) => void; onSubmit: () => void }) {
  return (
    <div className="quick-create">
      <input value={value.id} onChange={(event) => onChange({ ...value, id: event.target.value })} placeholder="ID" />
      <input value={value.title} onChange={(event) => onChange({ ...value, title: event.target.value })} placeholder="Task title" />
      <select value={value.parentTaskId} onChange={(event) => onChange({ ...value, parentTaskId: event.target.value })}>
        <option value="">Root</option>
        {tasks.map((task) => <option key={task.id} value={task.id}>{task.id} {task.title}</option>)}
      </select>
      <select value={value.priority} onChange={(event) => onChange({ ...value, priority: event.target.value })}>
        <option value="4">Urgent</option>
        <option value="3">High</option>
        <option value="2">Normal</option>
        <option value="1">Low</option>
        <option value="0">Someday</option>
      </select>
      <button onClick={onSubmit}><Plus size={16} /> Add</button>
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

function TaskNode({ node, selectedId, onSelect, onTransition }: { node: TreeNode; selectedId: string | null; onSelect: (id: string) => void; onTransition: (task: TaskView, action: "start" | "finish" | "reopen" | "archive") => Promise<void> }) {
  const [expanded, setExpanded] = useState(true);
  const task = node.task;
  return (
    <div className="task-node">
      <div className={selectedId === task.id ? "task-row selected" : "task-row"} style={{ paddingLeft: `${10 + task.hierarchyDepth * 22}px` }} onClick={() => onSelect(task.id)}>
        <button className="disclosure" onClick={(event) => { event.stopPropagation(); setExpanded(!expanded); }} disabled={node.children.length === 0} title={expanded ? "Collapse" : "Expand"}>
          {node.children.length > 0 ? <ChevronDown size={15} className={expanded ? "" : "rotated"} /> : <span />}
        </button>
        <StatusDot status={task.computedStatus} />
        <div className="task-main">
          <div className="task-title-line">
            <strong>{task.id}</strong>
            <span>{task.title}</span>
          </div>
          <div className="task-meta">
            <span>{task.computedStatus}</span>
            <span>P{task.priority}</span>
            <span>depth {task.dependencyDepth}</span>
            <span>unblocks {task.transitiveDependentsCount}</span>
            {task.descendantsCount > 0 ? <span>{task.subtreeProgress}% subtree</span> : null}
            {task.assignedTrack ? <span>{task.assignedTrack.actor}</span> : null}
          </div>
        </div>
        <Progress value={task.descendantsCount > 0 ? task.subtreeProgress : task.lifecycle === "finished" ? 100 : 0} />
        <div className="row-actions">
          {task.lifecycle === "open" ? <button title="Start" onClick={(event) => { event.stopPropagation(); void onTransition(task, "start"); }}><CircleDot size={15} /></button> : null}
          {task.lifecycle !== "finished" ? <button title="Finish" onClick={(event) => { event.stopPropagation(); void onTransition(task, "finish"); }}><Check size={15} /></button> : <button title="Reopen" onClick={(event) => { event.stopPropagation(); void onTransition(task, "reopen"); }}><RefreshCw size={15} /></button>}
          <button title="Archive" onClick={(event) => { event.stopPropagation(); void onTransition(task, "archive"); }}><Archive size={15} /></button>
        </div>
      </div>
      {expanded ? node.children.map((child) => <TaskNode key={child.task.id} node={child} selectedId={selectedId} onSelect={onSelect} onTransition={onTransition} />) : null}
    </div>
  );
}

function TaskDetails({ task, explanation, tracks, onAssign, onTransition }: { task: TaskView | null; explanation: Explanation | null; tracks: TrackRecord[]; onAssign: (track: TrackRecord, task: TaskView) => void; onTransition: (task: TaskView, action: "start" | "finish" | "reopen" | "archive") => void }) {
  if (!task) {
    return <aside className="details-panel empty">No task selected</aside>;
  }
  return (
    <aside className="details-panel">
      <div className="details-header">
        <StatusDot status={task.computedStatus} />
        <div>
          <h2>{task.id}</h2>
          <p>{task.title}</p>
        </div>
      </div>
      <div className="detail-grid">
        <Metric label="Status" value={task.computedStatus} />
        <Metric label="Priority" value={`P${task.priority}`} />
        <Metric label="Depth" value={String(task.dependencyDepth)} />
        <Metric label="Unblocks" value={String(task.transitiveDependentsCount)} />
        <Metric label="Children" value={String(task.childrenCount)} />
        <Metric label="Progress" value={`${task.subtreeProgress}%`} />
      </div>
      <Progress value={task.subtreeProgress} large />
      <section className="detail-section">
        <h3>Hierarchy</h3>
        <p>Parent: {task.parent ? `${task.parent.id} ${task.parent.title}` : "root"}</p>
        <p>{task.descendantsCount} descendants, {task.finishedLeafDescendantsCount}/{task.leafDescendantsCount} leaf tasks finished.</p>
      </section>
      <section className="detail-section">
        <h3>Dependencies</h3>
        {explanation?.unfinishedDependencies.length ? explanation.unfinishedDependencies.map((dependency) => (
          <p key={dependency.id} className="blocked-line">{dependency.id} {dependency.title} [{dependency.lifecycle}]</p>
        )) : <p>No unfinished dependencies.</p>}
        <p className={explanation?.assignable ? "assignable yes" : "assignable no"}>{explanation?.reason ?? "Loading explanation..."}</p>
      </section>
      <section className="detail-section">
        <h3>Assignment</h3>
        <div className="assign-buttons">
          {tracks.filter((track) => !track.archivedAt).map((track) => (
            <button key={track.id} disabled={!explanation?.assignable || Boolean(task.assignedTrack)} onClick={() => onAssign(track, task)}>
              <UserRound size={15} /> {track.actor}
            </button>
          ))}
        </div>
      </section>
      <section className="detail-section">
        <h3>Source</h3>
        <p>{task.sourceDoc ?? "No source doc"}</p>
        <p>{task.sourceSection ?? "No source section"}</p>
      </section>
      <div className="details-actions">
        {task.lifecycle === "open" ? <button onClick={() => onTransition(task, "start")}>Start</button> : null}
        {task.lifecycle !== "finished" ? <button onClick={() => onTransition(task, "finish")}>Finish</button> : <button onClick={() => onTransition(task, "reopen")}>Reopen</button>}
      </div>
    </aside>
  );
}

function QueuesView({ tracks, tasks, newTrack, setNewTrack, createTrack, onAssign }: { tracks: TrackRecord[]; tasks: TaskView[]; newTrack: string; setNewTrack: (value: string) => void; createTrack: () => void; onAssign: (track: TrackRecord, task: TaskView) => void }) {
  const ready = tasks.filter((task) => task.ready && !task.assignedTrack);
  return (
    <section className="wide-view">
      <div className="view-heading">
        <h1>Actor Queues</h1>
        <div className="inline-create"><input value={newTrack} onChange={(event) => setNewTrack(event.target.value)} placeholder="actor name" /><button onClick={createTrack}><Plus size={16} /> Add queue</button></div>
      </div>
      <div className="queue-grid">
        {tracks.map((track) => {
          const assigned = tasks.filter((task) => task.assignedTrack?.trackId === track.id);
          return (
            <div className="queue-column" key={track.id}>
              <h2>{track.name ?? track.actor}</h2>
              {assigned.map((task) => <TaskMini key={task.id} task={task} />)}
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
            <strong>{item.type}</strong>
            <span>{item.message}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function TaskMini({ task }: { task: TaskView }) {
  return (
    <div className="task-mini">
      <StatusDot status={task.computedStatus} />
      <div><strong>{task.id}</strong><span>{task.title}</span></div>
    </div>
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

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

async function mutate(url: string, options: { method: string; body?: unknown }): Promise<void> {
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
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
