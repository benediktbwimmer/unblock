import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type WheelEvent } from "react";
import { Archive, Check, CircleDot, Edit3, Filter, GitBranch, ListChecks, MessageSquare, Plus, RefreshCw, X } from "lucide-react";
import { fetchJson, mutate, withProject } from "../api";
import { DependencyItem, MarkdownContent, Metric, StatusDot } from "../components/common";
import { TopMatcherEditor } from "../matcher/MatcherEditor";
import { parseUnifiedQuery } from "../query/unifiedQuery";
import type { ActivityRecord, ActivityTimelineRange, ActivityUiState, CommentRecord, ComputedStatus, Explanation, MatcherGrammarRecord, TaskAction, TaskView } from "../types";
import { formatActorRef } from "../utils/format";

interface TimelineSession {
  id: string;
  actor: string;
  task: TaskView;
  startAt: string;
  endAt: string | null;
  outcome: "active" | "finished" | "released" | "archived";
  events: ActivityRecord[];
}

interface TimelineLane {
  actor: string;
  sessions: TimelineSession[];
  points: ActivityRecord[];
  latestAt: string;
}

type TimelineRange = ActivityTimelineRange;

interface TimelineWindow {
  start: Date;
  end: Date;
  durationMs: number;
}

interface TimelineTooltipState {
  text: string;
  anchorX: number;
  anchorTop: number;
  anchorBottom: number;
  bounds: { left: number; top: number; right: number; bottom: number };
}

export function ActivityView({
  initialActivity,
  projectId,
  grammar,
  state,
  onStateChange,
  onOpenTask
}: {
  initialActivity: ActivityRecord[];
  projectId: string;
  grammar: MatcherGrammarRecord | null;
  state: ActivityUiState;
  onStateChange: (patch: Partial<ActivityUiState>) => void;
  onOpenTask: (task: TaskView) => void;
}) {
  const [activity, setActivity] = useState(initialActivity);
  const [suggestSignal, setSuggestSignal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selectedTask, setSelectedTask] = useState<TaskView | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<ActivityRecord | null>(null);
  const [drawerTask, setDrawerTask] = useState<TaskView | null>(null);
  const [drawerEvent, setDrawerEvent] = useState<ActivityRecord | null>(null);
  const [drawerExplanation, setDrawerExplanation] = useState<Explanation | null>(null);
  const [drawerComments, setDrawerComments] = useState<CommentRecord[]>([]);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<TimelineTooltipState | null>(null);
  const timelineShellRef = useRef<HTMLDivElement | null>(null);
  const drawerRequestRef = useRef(0);
  const query = state.query;
  const appliedQuery = state.appliedQuery;
  const draftQuery = useMemo(() => parseUnifiedQuery(query), [query]);
  const queryDirty = draftQuery.errors.length > 0 || query.trim() !== appliedQuery;
  const range = state.range;
  const customStart = state.customStart;
  const customEnd = state.customEnd;
  const showEvents = state.showEvents;
  const showRoutineEvents = state.showRoutineEvents;
  const lanes = useMemo(() => buildTimelineLanes(activity), [activity]);
  const windowRange = useMemo(() => buildTimelineWindow(lanes, activity, range, showEvents, customStart, customEnd), [activity, lanes, range, showEvents, customStart, customEnd]);
  const ticks = useMemo(() => buildTimeTicks(windowRange, range), [range, windowRange]);
  const timelineWidth = useMemo(() => timelineWidthForRange(range, windowRange), [range, windowRange]);
  const rangeStartInput = range === "custom" && customStart ? customStart : formatDateTimeLocal(windowRange.start);
  const rangeEndInput = range === "custom" && customEnd ? customEnd : formatDateTimeLocal(windowRange.end);
  const inspectorOpen = Boolean(selectedTask || selectedEvent);
  const visibleLanes = useMemo(() => lanes.filter((lane) => {
    const hasVisibleSession = lane.sessions.some((session) => sessionOverlapsWindow(session, windowRange));
    const hasVisiblePoint = showEvents && lane.points.some((point) => timeInWindow(point.createdAt, windowRange) && shouldShowTimelineEvent(point, showRoutineEvents));
    return hasVisibleSession || hasVisiblePoint;
  }), [lanes, showEvents, showRoutineEvents, windowRange]);
  const timelineEndPadding = useMemo(() => {
    const hasActiveEdgeSession = visibleLanes.some((lane) => lane.sessions.some((session) => !session.endAt && sessionOverlapsWindow(session, windowRange)));
    return hasActiveEdgeSession ? 36 : 0;
  }, [visibleLanes, windowRange]);
  const totals = useMemo(() => ({
    active: lanes.reduce((sum, lane) => sum + lane.sessions.filter((session) => !session.endAt).length, 0),
    sessions: lanes.reduce((sum, lane) => sum + lane.sessions.length, 0),
    events: activity.length
  }), [activity.length, lanes]);

  useEffect(() => {
    if (!appliedQuery.trim()) {
      setActivity(initialActivity);
    }
  }, [appliedQuery, initialActivity]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const element = timelineShellRef.current;
      if (element) {
        const grid = element.querySelector<HTMLElement>(".timeline-grid");
        const rightEdge = grid ? grid.offsetWidth + timelineEndPadding : element.scrollWidth;
        element.scrollLeft = Math.max(0, rightEdge - element.clientWidth);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [range, visibleLanes.length, activity.length, timelineWidth, inspectorOpen, timelineEndPadding]);

  useEffect(() => {
    if (appliedQuery.trim()) {
      void loadActivity(appliedQuery);
    }
  }, [projectId]);

  function updateState(patch: Partial<ActivityUiState>) {
    onStateChange(patch);
  }

  async function loadActivity(nextQuery = appliedQuery) {
    const parsed = parseUnifiedQuery(nextQuery);
    if (parsed.errors.length > 0) {
      setQueryError(parsed.errors.join(" "));
      return;
    }
    setQueryError(null);
    setLoading(true);
    try {
      const params = new URLSearchParams({ projectId, limit: "200" });
      if (parsed.filter) {
        params.set("where", parsed.filter);
      }
      const next = await fetchJson<ActivityRecord[]>(`/api/activity?${params.toString()}`);
      setActivity(parsed.search ? filterActivityBySearch(next, parsed.search) : next);
      updateState({ appliedQuery: nextQuery.trim(), query: nextQuery });
    } finally {
      setLoading(false);
    }
  }

  function applyQuery() {
    void loadActivity(query);
  }

  function selectRange(nextRange: Exclude<TimelineRange, "custom">) {
    updateState({ range: nextRange });
  }

  function updateCustomStart(nextStart: string) {
    const nextEnd = ensureCustomEndAfterStart(nextStart, customEnd ?? rangeEndInput);
    updateState({ range: "custom", customStart: nextStart || null, customEnd: nextEnd });
  }

  function updateCustomEnd(nextEnd: string) {
    const nextStart = ensureCustomStartBeforeEnd(customStart ?? rangeStartInput, nextEnd);
    updateState({ range: "custom", customStart: nextStart, customEnd: nextEnd || null });
  }

  function scrollTimelineHorizontally(event: WheelEvent<HTMLDivElement>) {
    if (!event.shiftKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
      return;
    }
    event.currentTarget.scrollLeft += event.deltaY;
    event.preventDefault();
  }

  function showTimelineTooltip(event: MouseEvent<HTMLElement>, text: string) {
    const targetRect = event.currentTarget.getBoundingClientRect();
    const shellRect = timelineShellRef.current?.getBoundingClientRect();
    setTooltip({
      text,
      anchorX: targetRect.left + targetRect.width / 2,
      anchorTop: targetRect.top,
      anchorBottom: targetRect.bottom,
      bounds: shellRect
        ? { left: shellRect.left, top: shellRect.top, right: shellRect.right, bottom: shellRect.bottom }
        : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
    });
  }

  async function openActivityTask(task: TaskView, event: ActivityRecord | null = null) {
    const requestId = drawerRequestRef.current + 1;
    drawerRequestRef.current = requestId;
    setSelectedTask(task);
    setSelectedEvent(event);
    setDrawerTask((currentTask) => currentTask ?? task);
    setDrawerEvent((currentEvent) => currentEvent ?? event);
    setDrawerError(null);
    setDrawerLoading(true);
    try {
      const [freshTask, explanation, comments] = await Promise.all([
        fetchJson<TaskView>(withProject(`/api/tasks/${task.id}`, projectId)),
        fetchJson<Explanation>(withProject(`/api/tasks/${task.id}/explain`, projectId)),
        fetchJson<CommentRecord[]>(withProject(`/api/tasks/${task.id}/comments?limit=50`, projectId))
      ]);
      if (drawerRequestRef.current !== requestId) {
        return;
      }
      setDrawerTask(freshTask);
      setDrawerEvent(event);
      setDrawerExplanation(explanation);
      setDrawerComments(comments);
    } catch (error) {
      if (drawerRequestRef.current !== requestId) {
        return;
      }
      setDrawerError(error instanceof Error ? error.message : String(error));
    } finally {
      if (drawerRequestRef.current === requestId) {
        setDrawerLoading(false);
      }
    }
  }

  function closeDrawer() {
    drawerRequestRef.current += 1;
    setSelectedTask(null);
    setSelectedEvent(null);
    setDrawerTask(null);
    setDrawerEvent(null);
    setDrawerExplanation(null);
    setDrawerComments([]);
    setDrawerError(null);
    setDrawerLoading(false);
  }

  async function refreshDrawer(taskId: string) {
    const [freshTask, explanation, comments] = await Promise.all([
      fetchJson<TaskView>(withProject(`/api/tasks/${taskId}`, projectId)),
      fetchJson<Explanation>(withProject(`/api/tasks/${taskId}/explain`, projectId)),
      fetchJson<CommentRecord[]>(withProject(`/api/tasks/${taskId}/comments?limit=50`, projectId))
    ]);
    setDrawerTask(freshTask);
    setSelectedTask(freshTask);
    setDrawerExplanation(explanation);
    setDrawerComments(comments);
  }

  async function mutateDrawerTask(task: TaskView, path: string, body?: Record<string, unknown>) {
    await mutate(withProject(`/api/tasks/${task.id}${path}`, projectId), { method: path ? "POST" : "PATCH", body });
    await Promise.all([refreshDrawer(task.id), loadActivity()]);
  }

  return (
    <section className="wide-view activity-page">
      <div className="view-heading activity-heading">
        <div>
          <h1>Activity Timeline</h1>
          <p>Work sessions are grouped by actor and stay continuous from start until finish, release, or archive.</p>
        </div>
        <div className="activity-summary compact">
          <strong>{totals.active}</strong> active
          <span>·</span>
          <strong>{totals.sessions}</strong> sessions
          <span>·</span>
          <strong>{totals.events}</strong> events
        </div>
      </div>

      <div className="activity-filter-row">
        <div className={queryDirty ? "activity-matcher unified-query dirty" : "activity-matcher unified-query"}>
          <button className="matcher-icon-button" onClick={() => setSuggestSignal((value) => value + 1)} title="Show query suggestions"><Filter size={17} /></button>
          <TopMatcherEditor
            value={query}
            projectId={projectId}
            grammar={grammar}
            suggestSignal={suggestSignal}
            variant="query"
            onChange={(nextQuery) => updateState({ query: nextQuery })}
            onApply={applyQuery}
          />
          {!query ? <span className="matcher-placeholder">Search activity or use filter(assigned = bw-mbp:codex-b)</span> : null}
        </div>
        <span className="shortcut-hint matcher-shortcut"><kbd>Shift</kbd> + <kbd>Enter</kbd></span>
        <button className="primary-button" disabled={loading || !queryDirty} onClick={applyQuery}><Check size={16} /> Apply</button>
        {appliedQuery ? <button disabled={loading} onClick={() => { updateState({ query: "", appliedQuery: "" }); void loadActivity(""); }}>Clear</button> : null}
        <button className="icon-button" disabled={loading} onClick={() => void loadActivity()} title="Refresh"><RefreshCw size={16} /></button>
        <div className="timeline-view-tabs" aria-label="Activity layers">
          <button className="active" title="Show task work sessions">Sessions</button>
          <button className={showEvents ? "active" : ""} onClick={() => updateState({ showEvents: !showEvents, showRoutineEvents: !showEvents ? showRoutineEvents : false })} title="Show event annotations on the timeline">Events</button>
          <button className={showRoutineEvents ? "active" : ""} disabled={!showEvents} onClick={() => updateState({ showRoutineEvents: !showRoutineEvents })} title="Include routine task update events">Updates</button>
        </div>
      </div>
      <div className="activity-time-row">
        <div className="timeline-range-tabs" role="tablist" aria-label="Activity time range">
          {[
            ["1h", "1h"],
            ["6h", "6h"],
            ["24h", "24h"],
            ["7d", "7d"],
            ["all", "All"]
          ].map(([value, label]) => (
            <button key={value} className={range === value ? "active" : ""} onClick={() => selectRange(value as Exclude<TimelineRange, "custom">)}>{label}</button>
          ))}
        </div>
        <label className={range === "custom" ? "time-input active" : "time-input"}>
          <span>Start</span>
          <input type="datetime-local" value={rangeStartInput} onChange={(event) => updateCustomStart(event.target.value)} />
        </label>
        <label className={range === "custom" ? "time-input active" : "time-input"}>
          <span>End</span>
          <input type="datetime-local" value={rangeEndInput} onChange={(event) => updateCustomEnd(event.target.value)} />
        </label>
      </div>
      {queryError ? <div className="error compact">{queryError}</div> : null}

      <div className={inspectorOpen ? "activity-main inspector-open" : "activity-main"}>
        <div className="timeline-shell" ref={timelineShellRef} style={{ ["--timeline-end-padding" as string]: `${timelineEndPadding}px` }} onClick={closeDrawer} onWheel={scrollTimelineHorizontally}>
          <div className="timeline-grid" style={{ ["--timeline-width" as string]: `${timelineWidth}px` }}>
            <div className="time-axis-corner">Actor</div>
            <div className="time-axis">
              {ticks.map((tick) => (
                <div className="time-tick" key={tick.iso} style={{ left: `${tick.left}%` }}>
                  <span>{tick.label}</span>
                </div>
              ))}
            </div>
            {visibleLanes.map((lane) => {
              const visibleSessions = lane.sessions.filter((session) => sessionOverlapsWindow(session, windowRange));
              const packedSessions = packTimelineSessions(visibleSessions);
              const visiblePoints = showEvents
                ? lane.points.filter((point) => timeInWindow(point.createdAt, windowRange) && shouldShowTimelineEvent(point, showRoutineEvents))
                : [];
              const laneHeight = timelineLaneHeight(packedSessions.trackCount, visiblePoints.length);
              return (
                <div className="timeline-row" key={lane.actor} style={{ minHeight: laneHeight }}>
                  <div className="timeline-lane-label">
                    <strong>{lane.actor}</strong>
                    <span>{lane.sessions.filter((session) => !session.endAt).length} active · {visibleSessions.length} in view · {relativeTime(lane.latestAt)}</span>
                  </div>
                  <div className="timeline-lane-track" style={{ minHeight: laneHeight }}>
                    <div className="timeline-gridlines">
                      {ticks.map((tick) => <span key={tick.iso} style={{ left: `${tick.left}%` }} />)}
                    </div>
                    {packedSessions.items.map(({ session, track }) => {
                      const placement = sessionPlacement(session, windowRange);
                      const sessionTooltip = `${session.task.id} · ${session.task.title} · ${formatTimeRange(session.startAt, session.endAt)} · ${formatDuration(session.startAt, session.endAt ?? new Date().toISOString())}`;
                      const visibleSessionEvents = showEvents
                        ? session.events.filter((event) => timeInWindow(event.createdAt, windowRange) && shouldShowTimelineEvent(event, showRoutineEvents))
                        : [];
                      return (
                        <div
                          className={`timeline-session ${session.outcome} ${selectedTask?.id === session.task.id ? "selected selected-task" : ""}`}
                          key={session.id}
                          style={{ left: `${placement.left}%`, width: `${placement.width}%`, top: `${timelineSessionTop(track)}px` }}
                          data-tooltip={sessionTooltip}
                          onMouseEnter={(event) => showTimelineTooltip(event, sessionTooltip)}
                          onMouseLeave={() => setTooltip(null)}
                        >
                          <button
                          className="timeline-session-bar"
                          aria-label={`${session.task.id} ${session.task.title}`}
                          onClick={(clickEvent) => {
                            clickEvent.stopPropagation();
                            clickEvent.currentTarget.blur();
                            void openActivityTask(session.task, session.events.at(-1) ?? null);
                          }}
                          >
                            <span>{session.task.id}</span>
                            <strong>{session.task.title}</strong>
                            <em>{formatDuration(session.startAt, session.endAt ?? new Date().toISOString())}</em>
                          </button>
                          <span className="session-endpoint start" title={`Started ${new Date(session.startAt).toLocaleString()}`} />
                          {session.endAt ? <span className="session-endpoint end" title={`${formatSessionOutcome(session)} ${new Date(session.endAt).toLocaleString()}`} /> : <span className="session-live-pulse" title="In progress" />}
                          {visibleSessionEvents.map((event) => {
                            const eventTooltip = `${event.type}: ${event.message}`;
                            return (
                              <button
                                className={`timeline-annotation ${markerTone(event.type)} ${selectedEvent?.id === event.id ? "selected" : ""}`}
                                key={event.id}
                                style={{ left: `${sessionEventPercent(event, session, windowRange)}%` }}
                                data-tooltip={eventTooltip}
                                aria-label={eventTooltip}
                                onMouseEnter={(hoverEvent) => showTimelineTooltip(hoverEvent, eventTooltip)}
                                onMouseLeave={() => setTooltip(null)}
                                onClick={(clickEvent) => {
                                  clickEvent.stopPropagation();
                                  clickEvent.currentTarget.blur();
                                  void openActivityTask(session.task, event);
                                }}
                              >
                                <TimelineEventIcon type={event.type} />
                              </button>
                            );
                          })}
                        </div>
                      );
                    })}
                    {visiblePoints.map((event, pointIndex) => {
                      const eventTooltip = `${event.type}: ${event.message}`;
                      return (
                        <button
                          className={`timeline-marker point ${markerTone(event.type)} ${selectedEvent?.id === event.id ? "selected" : ""}`}
                          key={event.id}
                          style={{ left: `${timePercent(event.createdAt, windowRange)}%`, top: `${timelinePointTop(packedSessions.trackCount, pointIndex)}px` }}
                          data-tooltip={eventTooltip}
                          aria-label={eventTooltip}
                          onMouseEnter={(hoverEvent) => showTimelineTooltip(hoverEvent, eventTooltip)}
                          onMouseLeave={() => setTooltip(null)}
                          onClick={(clickEvent) => {
                            clickEvent.stopPropagation();
                            clickEvent.currentTarget.blur();
                            if (event.task) {
                              void openActivityTask(event.task, event);
                            } else {
                              closeDrawer();
                            }
                          }}
                        >
                          <TimelineEventIcon type={event.type} />
                        </button>
                      );
                    })}
                    {visibleSessions.length === 0 && visiblePoints.length === 0 ? <span className="timeline-empty">No events in range</span> : null}
                  </div>
                </div>
              );
            })}
            {visibleLanes.length === 0 ? <p className="muted timeline-no-results">No activity matches this view.</p> : null}
          </div>
        </div>
        {tooltip ? <TimelineTooltip tooltip={tooltip} /> : null}

        <div className="activity-inspector-slot" aria-hidden={inspectorOpen ? undefined : true}>
          {inspectorOpen ? (
            <ActivityInspector
              task={drawerTask}
              event={drawerEvent}
              explanation={drawerExplanation}
              comments={drawerComments}
              loading={drawerLoading}
              error={drawerError}
              onClose={closeDrawer}
              onOpenInTasks={(task) => onOpenTask(task)}
              onUpdate={async (task, input) => {
                await mutate(withProject(`/api/tasks/${task.id}`, projectId), { method: "PATCH", body: input });
                await Promise.all([refreshDrawer(task.id), loadActivity()]);
              }}
              onTransition={(task, action) => void mutateDrawerTask(task, `/${action}`)}
              onRelease={(task, reason) => void mutateDrawerTask(task, "/release", { reason })}
              onAddComment={async (task, body) => {
                await mutate(withProject(`/api/tasks/${task.id}/comments`, projectId), { method: "POST", body: { body } });
                await Promise.all([refreshDrawer(task.id), loadActivity()]);
              }}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}

function TimelineTooltip({ tooltip }: { tooltip: TimelineTooltipState }) {
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const element = tooltipRef.current;
    if (!element) {
      return;
    }
    const rect = element.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(
      Math.max(tooltip.anchorX - rect.width / 2, tooltip.bounds.left + margin),
      Math.max(tooltip.bounds.left + margin, tooltip.bounds.right - rect.width - margin)
    );
    const topAbove = tooltip.anchorTop - rect.height - margin;
    const topBelow = tooltip.anchorBottom + margin;
    const top = topAbove >= tooltip.bounds.top + margin
      ? topAbove
      : Math.min(topBelow, Math.max(tooltip.bounds.top + margin, tooltip.bounds.bottom - rect.height - margin));
    setPosition({ left, top });
  }, [tooltip]);

  return (
    <div
      className="timeline-floating-tooltip"
      ref={tooltipRef}
      style={position ? { left: position.left, top: position.top } : { left: tooltip.anchorX, top: tooltip.anchorTop, visibility: "hidden" }}
    >
      {tooltip.text}
    </div>
  );
}

function ActivityInspector({
  task,
  event,
  explanation,
  comments,
  loading,
  error,
  onClose,
  onOpenInTasks,
  onUpdate,
  onTransition,
  onRelease,
  onAddComment
}: {
  task: TaskView | null;
  event: ActivityRecord | null;
  explanation: Explanation | null;
  comments: CommentRecord[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onOpenInTasks: (task: TaskView) => void;
  onUpdate: (task: TaskView, input: { title: string; description: string }) => Promise<void>;
  onTransition: (task: TaskView, action: TaskAction) => void;
  onRelease: (task: TaskView, reason: string) => void;
  onAddComment: (task: TaskView, body: string) => Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(task?.title ?? "");
  const [draftDescription, setDraftDescription] = useState(task?.description ?? "");
  const [releaseReason, setReleaseReason] = useState("");
  const [commentDraft, setCommentDraft] = useState("");

  useEffect(() => {
    setIsEditing(false);
    setDraftTitle(task?.title ?? "");
    setDraftDescription(task?.description ?? "");
    setReleaseReason("");
    setCommentDraft("");
  }, [task?.id, task?.title, task?.description]);

  return (
      <aside className="activity-drawer" role="complementary" aria-label="Activity detail">
        <div className="activity-drawer-header">
          <div>
            <span>{event ? `${event.type} · ${relativeTime(event.createdAt)}` : "Task detail"}</span>
            <h2>{task?.title ?? event?.message ?? "Activity"}</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="Close"><X size={16} /></button>
        </div>

        {error ? <div className="error compact">{error}</div> : null}
        {loading && !task ? <div className="loading compact">Loading activity detail...</div> : null}

        {event ? (
          <section className="detail-section">
            <h3>Event</h3>
            <p>{event.message}</p>
            <div className="detail-grid compact-grid">
              <Metric label="Actor" value={formatActorRef(event)} />
              <Metric label="When" value={new Date(event.createdAt).toLocaleString()} />
              <Metric label="Type" value={event.type} />
            </div>
          </section>
        ) : null}

        {task ? (
          <>
            <section className="detail-section">
              <div className="activity-task-title">
                <StatusDot status={task.computedStatus} />
                <div>
                  <strong>{task.id}</strong>
                  <span>{task.computedStatus} · P{task.priority}{task.assignedTrack ? ` · ${formatActorRef(task.assignedTrack)}` : ""}</span>
                </div>
              </div>
              <div className="details-actions">
                <button onClick={() => setIsEditing((value) => !value)}><Edit3 size={15} /> Edit</button>
                {task.lifecycle === "open" && !task.archivedAt ? <button onClick={() => onTransition(task, "start")}><CircleDot size={15} /> Start</button> : null}
                {task.lifecycle === "started" && !task.archivedAt ? <button onClick={() => onTransition(task, "finish")} className="primary-button"><Check size={15} /> Finish</button> : null}
                {task.lifecycle === "finished" && !task.archivedAt ? <button onClick={() => onTransition(task, "reopen")}><RefreshCw size={15} /> Reopen</button> : null}
                {task.archivedAt ? <button onClick={() => onTransition(task, "restore")}><RefreshCw size={15} /> Restore</button> : <button onClick={() => onTransition(task, "archive")}><Archive size={15} /> Archive</button>}
                <button onClick={() => onOpenInTasks(task)}><ListChecks size={15} /> Open in Tasks</button>
              </div>
            </section>

            {isEditing ? (
              <section className="detail-section content-editor">
                <h3>Edit Task</h3>
                <input className="title-input" value={draftTitle} onChange={(eventInput) => setDraftTitle(eventInput.target.value)} />
                <textarea className="description-textarea" value={draftDescription} onChange={(eventInput) => setDraftDescription(eventInput.target.value)} />
                <div className="editor-actions">
                  <button className="primary-button" disabled={!draftTitle.trim()} onClick={() => void onUpdate(task, { title: draftTitle.trim(), description: draftDescription }).then(() => setIsEditing(false))}>Save</button>
                  <button onClick={() => setIsEditing(false)}>Cancel</button>
                </div>
              </section>
            ) : task.description.trim() ? (
              <section className="detail-section">
                <h3>Description</h3>
                <MarkdownContent value={task.description} />
              </section>
            ) : null}

            {task.lifecycle === "started" && !task.archivedAt ? (
              <section className="detail-section release-panel">
                <h3>Release</h3>
                <textarea value={releaseReason} onChange={(eventInput) => setReleaseReason(eventInput.target.value)} placeholder="Why is this no longer active?" />
                <button className="primary-button" disabled={!releaseReason.trim()} onClick={() => { onRelease(task, releaseReason.trim()); setReleaseReason(""); }}>Release</button>
              </section>
            ) : null}

            <section className="detail-section">
              <h3>Dependencies</h3>
              {(explanation?.unfinishedDependencies ?? []).map((dependency) => <DependencyItem key={dependency.id} task={dependency} tone="blocked" />)}
              {(explanation?.finishedDependencies ?? []).slice(0, 4).map((dependency) => <DependencyItem key={dependency.id} task={dependency} />)}
              {!explanation || (explanation.unfinishedDependencies.length === 0 && explanation.finishedDependencies.length === 0) ? <p>No dependencies.</p> : null}
            </section>

            <section className="detail-section comments-section">
              <h3>Comments</h3>
              <div className="comment-list">
                {comments.length > 0 ? comments.map((comment) => (
                  <div className="comment-card" key={comment.id}>
                    <div className="comment-meta">
                      <span>{formatActorRef(comment)}</span>
                      <span>{new Date(comment.createdAt).toLocaleString()}</span>
                    </div>
                    <MarkdownContent value={comment.body} />
                  </div>
                )) : <p>No comments yet.</p>}
              </div>
              <textarea value={commentDraft} onChange={(eventInput) => setCommentDraft(eventInput.target.value)} placeholder="Add a markdown comment..." />
              <button className="primary-button" disabled={!commentDraft.trim()} onClick={() => void onAddComment(task, commentDraft.trim()).then(() => setCommentDraft(""))}><Plus size={15} /> Comment</button>
            </section>
          </>
        ) : null}
      </aside>
  );
}

function TimelineEventMarker({ event }: { event: ActivityRecord }) {
  return (
    <span className="session-event" title={event.message}>
      <TimelineEventIcon type={event.type} />
      <span>{compactActivityLabel(event)}</span>
    </span>
  );
}

function TimelineEventIcon({ type }: { type: string }) {
  if (type === "task.finished") return <Check size={13} />;
  if (type === "task.released") return <X size={13} />;
  if (type === "comment.created") return <MessageSquare size={13} />;
  if (type.startsWith("dependency.")) return <GitBranch size={13} />;
  if (type.includes("archived")) return <Archive size={13} />;
  return <CircleDot size={13} />;
}

function buildTimelineLanes(activity: ActivityRecord[]): TimelineLane[] {
  const byActor = new Map<string, ActivityRecord[]>();
  for (const event of activity) {
    const actor = formatActorRef(event);
    byActor.set(actor, [...(byActor.get(actor) ?? []), event]);
  }
  return [...byActor.entries()].map(([actor, events]) => {
    const sorted = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const open = new Map<string, TimelineSession>();
    const sessions: TimelineSession[] = [];
    const points: ActivityRecord[] = [];
    for (const event of sorted) {
      const task = event.task;
      if (!task) {
        points.push(event);
        continue;
      }
      const existing = open.get(task.id);
      if (event.type === "task.started") {
        const session: TimelineSession = { id: event.id, actor, task, startAt: event.createdAt, endAt: null, outcome: "active", events: [event] };
        open.set(task.id, session);
        continue;
      }
      if (existing) {
        existing.events.push(event);
        if (isSessionCloseEvent(event.type)) {
          existing.endAt = event.createdAt;
          existing.outcome = sessionOutcome(event.type);
          sessions.push(existing);
          open.delete(task.id);
        }
        continue;
      }
      if (isSessionCloseEvent(event.type) && task.startedAt) {
        sessions.push({
          id: event.id,
          actor,
          task,
          startAt: task.startedAt,
          endAt: event.createdAt,
          outcome: sessionOutcome(event.type),
          events: [event]
        });
      } else {
        points.push(event);
      }
    }
    sessions.push(...open.values());
    const latestAt = [...sessions.map((session) => session.endAt ?? session.startAt), ...points.map((point) => point.createdAt)].sort().at(-1) ?? new Date().toISOString();
    return {
      actor,
      latestAt,
      sessions: sessions.sort((a, b) => (b.endAt ?? b.startAt).localeCompare(a.endAt ?? a.startAt)),
      points: points.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    };
  }).sort((a, b) => b.latestAt.localeCompare(a.latestAt));
}

function buildTimelineWindow(lanes: TimelineLane[], activity: ActivityRecord[], range: TimelineRange, includePoints: boolean, customStart: string | null, customEnd: string | null): TimelineWindow {
  const now = new Date();
  const nowMs = now.getTime();
  const eventTimes = activity.map((event) => Date.parse(event.createdAt)).filter(Number.isFinite);
  const sessionStarts = lanes.flatMap((lane) => lane.sessions.map((session) => Date.parse(session.startAt))).filter(Number.isFinite);
  const sessionEnds = lanes.flatMap((lane) => lane.sessions.map((session) => Date.parse(session.endAt ?? new Date().toISOString()))).filter(Number.isFinite);
  const activeSessionCount = lanes.reduce((count, lane) => count + lane.sessions.filter((session) => !session.endAt).length, 0);
  const includedTimes = [
    ...sessionStarts,
    ...sessionEnds,
    ...(includePoints ? eventTimes : [])
  ];
  const starts = [
    ...sessionStarts,
    ...(includePoints ? eventTimes : [])
  ].filter(Number.isFinite);
  const earliest = starts.length > 0 ? Math.min(...starts) : nowMs - 24 * 60 * 60 * 1000;
  const latest = includedTimes.length > 0 ? Math.max(...includedTimes) : nowMs;

  if (range === "custom") {
    const customStartMs = parseDateTimeLocal(customStart);
    const customEndMs = parseDateTimeLocal(customEnd);
    if (customStartMs !== null && customEndMs !== null && customEndMs > customStartMs) {
      const start = new Date(customStartMs);
      const end = new Date(customEndMs);
      return { start, end, durationMs: Math.max(1, end.getTime() - start.getTime()) };
    }
  }

  if (range === "all") {
    const start = new Date(earliest);
    const end = new Date(activeSessionCount > 0 ? Math.max(latest, nowMs) : latest);
    return { start, end, durationMs: Math.max(1, end.getTime() - start.getTime()) };
  }

  const duration = rangeDurationMs(range);
  const end = now;
  const start = new Date(end.getTime() - duration);
  return { start, end, durationMs: Math.max(1, end.getTime() - start.getTime()) };
}

function buildTimeTicks(windowRange: TimelineWindow, range: TimelineRange): Array<{ iso: string; label: string; left: number }> {
  const count = range === "7d" || range === "all"
      ? 8
      : 7;
  return Array.from({ length: count }, (_, index) => {
    const ratio = index / (count - 1);
    const date = new Date(windowRange.start.getTime() + windowRange.durationMs * ratio);
    const showClock = range === "1h" || range === "6h" || range === "24h" || (range === "custom" && windowRange.durationMs <= 36 * 60 * 60 * 1000);
    const label = date.toLocaleString(undefined, showClock
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric" });
    return { iso: date.toISOString(), label, left: ratio * 100 };
  });
}

function timelineWidthForRange(range: TimelineRange, windowRange: TimelineWindow): number {
  if (range === "custom" || range === "all") {
    const hours = windowRange.durationMs / (60 * 60 * 1000);
    return Math.round(Math.min(5200, Math.max(1200, hours * 300)));
  }
  if (range === "1h") return 1200;
  if (range === "6h") return 1800;
  if (range === "24h") return 1800;
  if (range === "7d") return 2600;
  return 1800;
}

function rangeDurationMs(range: TimelineRange): number {
  if (range === "1h") return 60 * 60 * 1000;
  if (range === "6h") return 6 * 60 * 60 * 1000;
  if (range === "24h") return 24 * 60 * 60 * 1000;
  if (range === "7d") return 7 * 24 * 60 * 60 * 1000;
  return 6 * 60 * 60 * 1000;
}

function parseDateTimeLocal(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function formatDateTimeLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function shiftDateTimeLocal(value: string, deltaMs: number): string | null {
  const time = parseDateTimeLocal(value);
  return time === null ? null : formatDateTimeLocal(new Date(time + deltaMs));
}

function ensureCustomEndAfterStart(start: string, end: string): string | null {
  const startTime = parseDateTimeLocal(start);
  const endTime = parseDateTimeLocal(end);
  if (startTime === null) {
    return end || null;
  }
  if (endTime !== null && endTime > startTime) {
    return end;
  }
  return shiftDateTimeLocal(start, 60 * 60 * 1000);
}

function ensureCustomStartBeforeEnd(start: string, end: string): string | null {
  const startTime = parseDateTimeLocal(start);
  const endTime = parseDateTimeLocal(end);
  if (endTime === null) {
    return start || null;
  }
  if (startTime !== null && startTime < endTime) {
    return start;
  }
  return shiftDateTimeLocal(end, -60 * 60 * 1000);
}

function packTimelineSessions(sessions: TimelineSession[]): { items: Array<{ session: TimelineSession; track: number }>; trackCount: number } {
  const trackEnds: number[] = [];
  const items = [...sessions]
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt) || a.id.localeCompare(b.id))
    .map((session) => {
      const start = Date.parse(session.startAt);
      const end = Date.parse(session.endAt ?? new Date().toISOString());
      let track = trackEnds.findIndex((trackEnd) => trackEnd <= start);
      if (track === -1) {
        track = trackEnds.length;
        trackEnds.push(end);
      } else {
        trackEnds[track] = end;
      }
      return { session, track };
    });
  return { items, trackCount: Math.max(1, trackEnds.length) };
}

function timelineLaneHeight(trackCount: number, pointCount: number): number {
  return Math.max(92, 24 + trackCount * 40 + Math.min(pointCount, 3) * 28);
}

function timelineSessionTop(index: number): number {
  return 16 + index * 40;
}

function timelinePointTop(sessionCount: number, pointIndex: number): number {
  return 18 + sessionCount * 38 + Math.min(pointIndex, 2) * 26;
}

function sessionOverlapsWindow(session: TimelineSession, windowRange: TimelineWindow): boolean {
  const start = Date.parse(session.startAt);
  const end = session.endAt ? Date.parse(session.endAt) : Date.now();
  return end >= windowRange.start.getTime() && start <= windowRange.end.getTime();
}

function timeInWindow(value: string, windowRange: TimelineWindow): boolean {
  const time = Date.parse(value);
  return time >= windowRange.start.getTime() && time <= windowRange.end.getTime();
}

function timePercent(value: string, windowRange: TimelineWindow): number {
  const time = Date.parse(value);
  return clampPercent(((time - windowRange.start.getTime()) / windowRange.durationMs) * 100);
}

function sessionPlacement(session: TimelineSession, windowRange: TimelineWindow): { left: number; width: number } {
  const start = Math.max(Date.parse(session.startAt), windowRange.start.getTime());
  const end = Math.min(session.endAt ? Date.parse(session.endAt) : Date.now(), windowRange.end.getTime());
  const left = clampPercent(((start - windowRange.start.getTime()) / windowRange.durationMs) * 100);
  const right = clampPercent(((end - windowRange.start.getTime()) / windowRange.durationMs) * 100);
  return { left, width: Math.max(0.35, right - left) };
}

function sessionEventPercent(event: ActivityRecord, session: TimelineSession, windowRange: TimelineWindow): number {
  const sessionStart = Math.max(Date.parse(session.startAt), windowRange.start.getTime());
  const sessionEnd = Math.min(session.endAt ? Date.parse(session.endAt) : Date.now(), windowRange.end.getTime());
  const duration = Math.max(1, sessionEnd - sessionStart);
  return clampPercent(((Date.parse(event.createdAt) - sessionStart) / duration) * 100);
}

function shouldShowTimelineEvent(event: ActivityRecord, showRoutine: boolean): boolean {
  if (event.type === "task.started" || event.type === "task.finished" || event.type === "task.released" || event.type === "task.archived") {
    return false;
  }
  if (event.type === "comment.created" || event.type.startsWith("dependency.")) {
    return true;
  }
  return showRoutine;
}

function filterActivityBySearch(activity: ActivityRecord[], search: string): ActivityRecord[] {
  const needle = search.trim().toLowerCase();
  if (!needle) {
    return activity;
  }
  return activity.filter((event) => {
    const task = event.task;
    const haystack = [
      event.type,
      event.message,
      event.machine,
      event.actor,
      task?.id,
      task?.title,
      task?.description,
      task?.sourceDoc,
      task?.sourceSection,
      task?.assignedTrack ? formatActorRef(task.assignedTrack) : null,
      ...(task?.tags.flatMap((tag) => [tag.id, tag.name, tag.description]) ?? [])
    ].filter(Boolean).join("\n").toLowerCase();
    return haystack.includes(needle);
  });
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function markerTone(type: string): string {
  if (type === "task.finished") return "finished";
  if (type === "task.released") return "released";
  if (type.includes("archived")) return "archived";
  if (type === "comment.created") return "comment";
  if (type.startsWith("dependency.")) return "dependency";
  return "default";
}

function isSessionCloseEvent(type: string): boolean {
  return type === "task.finished" || type === "task.released" || type === "task.archived";
}

function sessionOutcome(type: string): TimelineSession["outcome"] {
  if (type === "task.finished") return "finished";
  if (type === "task.archived") return "archived";
  return "released";
}

function formatSessionOutcome(session: TimelineSession): string {
  if (!session.endAt) return "in progress";
  if (session.outcome === "finished") return "finished";
  if (session.outcome === "archived") return "archived";
  return "released";
}

function compactActivityLabel(event: ActivityRecord): string {
  if (event.type === "task.started") return "started";
  if (event.type === "task.finished") return "finished";
  if (event.type === "task.released") return "released";
  if (event.type === "comment.created") return "comment";
  if (event.type.startsWith("dependency.")) return event.type.replace("dependency.", "deps ");
  return event.type.replace(/^task\./, "");
}

function formatTimeRange(startAt: string, endAt: string | null): string {
  const start = new Date(startAt);
  const end = endAt ? new Date(endAt) : null;
  const startText = start.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  if (!end) {
    return `${startText} - now`;
  }
  const sameDay = start.toDateString() === end.toDateString();
  const endText = end.toLocaleString(undefined, sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `${startText} - ${endText}`;
}

function formatDuration(startAt: string, endAt: string): string {
  const ms = Math.max(0, Date.parse(endAt) - Date.parse(startAt));
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 24) {
    return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const hourRemainder = hours % 24;
  return hourRemainder > 0 ? `${days}d ${hourRemainder}h` : `${days}d`;
}

function relativeTime(value: string): string {
  const deltaMs = Date.now() - Date.parse(value);
  const minutes = Math.max(0, Math.round(deltaMs / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
