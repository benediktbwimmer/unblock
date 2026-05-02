import type { AppStore } from "./store.js";
import { priorityLabel, type JsonExport, type TaskView } from "./types.js";

export async function exportStoreJson(store: AppStore, includeActivity = false): Promise<JsonExport> {
  const [tasks, dependencies, tags, taskTags, tracks, assignments, activity] = await Promise.all([
    store.tasks.list(),
    store.dependencies.list(),
    store.tags.list(),
    store.tags.listTaskTags(),
    store.tracks.list(),
    store.tracks.listAssignments(),
    includeActivity ? store.activity.list(Number.MAX_SAFE_INTEGER) : Promise.resolve(undefined)
  ]);
  const result: JsonExport = {
    tasks,
    dependencies,
    tags,
    taskTags,
    tracks,
    assignments
  };
  if (activity) {
    result.activity = activity;
  }
  return result;
}

export function exportMarkdown(tasks: TaskView[]): string {
  const bySource = new Map<string, TaskView[]>();
  for (const task of tasks) {
    const key = `${task.sourceDoc ?? "Unattributed"} - ${task.sourceSection ?? "No section"}`;
    const existing = bySource.get(key) ?? [];
    existing.push(task);
    bySource.set(key, existing);
  }

  const lines: string[] = ["# Not Jira Export", ""];
  for (const [section, sectionTasks] of [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${section}`, "");
    lines.push("| Done | ID | Parent | Feature | Priority | Status | Progress | Unblocks | Completion bar |");
    lines.push("| --- | --- | --- | --- | --- | --- | ---: | ---: | --- |");
    for (const task of sectionTasks) {
      const done = task.lifecycle === "finished" ? "[x]" : "[ ]";
      lines.push(`| ${done} | ${escapeCell(task.id)} | ${escapeCell(task.parentTaskId ?? "")} | ${escapeCell(task.title)} | ${priorityLabel(task.priority)} | ${task.computedStatus} | ${task.descendantsCount > 0 ? `${task.subtreeProgress}%` : ""} | ${task.transitiveDependentsCount} | ${escapeCell(task.completionBar ?? "")} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}
