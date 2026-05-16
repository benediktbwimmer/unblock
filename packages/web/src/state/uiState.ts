import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { DEFAULT_APP_CONFIG, DEFAULT_STATUS_FILTERS, DEFAULT_UI_STATE, STATUS_FILTER_ORDER, UI_STATE_KEY, type ActivityTimelineRange, type ActivityUiState, type AppConfig, type AppliedTaskFilters, type StatusFilter, type UiState, type ViewMode } from "../types";

export function appliedFiltersFromUiState(uiState: UiState): AppliedTaskFilters {
  return {
    statusFilters: normalizeStatusFilters(uiState.statusFilters),
    search: uiState.search.trim(),
    matcher: uiState.matcher.trim()
  };
}

export function sameAppliedFilters(left: AppliedTaskFilters, right: AppliedTaskFilters): boolean {
  return sameStatusFilters(left.statusFilters, right.statusFilters)
    && left.search === right.search
    && left.matcher === right.matcher;
}

export function normalizeAppConfig(input: unknown): AppConfig {
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

export function usePersistentUiState(enabled: boolean): [UiState, Dispatch<SetStateAction<UiState>>] {
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
    activity: normalizeActivityUiState(record.activity),
    collapsedTaskIds,
    scrollPositions: normalizeScrollPositions(record.scrollPositions),
    newProjectDraft: typeof record.newProjectDraft === "string" ? record.newProjectDraft : "",
    newTrackDraft: typeof record.newTrackDraft === "string" ? record.newTrackDraft : "",
    newTagDraft: typeof record.newTagDraft === "string" ? record.newTagDraft : ""
  };
}

function normalizeActivityUiState(input: unknown): ActivityUiState {
  const record = isRecord(input) ? input : {};
  const range = isActivityTimelineRange(record.range) ? record.range : DEFAULT_UI_STATE.activity.range;
  const showEvents = typeof record.showEvents === "boolean" ? record.showEvents : DEFAULT_UI_STATE.activity.showEvents;
  return {
    matcher: typeof record.matcher === "string" ? record.matcher : "",
    appliedMatcher: typeof record.appliedMatcher === "string" ? record.appliedMatcher : "",
    range,
    showEvents,
    showRoutineEvents: showEvents && typeof record.showRoutineEvents === "boolean" ? record.showRoutineEvents : DEFAULT_UI_STATE.activity.showRoutineEvents
  };
}

function isActivityTimelineRange(value: unknown): value is ActivityTimelineRange {
  return value === "fit" || value === "6h" || value === "24h" || value === "7d" || value === "all";
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
  return value === "tasks" || value === "queues" || value === "tags" || value === "instructions" || value === "connectors" || value === "coverage" || value === "activity";
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
