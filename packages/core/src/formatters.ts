import { priorityLabel, type Activity, type DependencyExplanation, type TaskView } from "./types.js";

export function formatTaskTable(tasks: TaskView[]): string {
  const rows = tasks.map((task) => [
    task.id,
    task.computedStatus,
    priorityLabel(task.priority),
    String(task.dependencyDepth),
    String(task.transitiveDependentsCount),
    task.descendantsCount > 0 ? `${task.subtreeProgress}%` : "",
    task.parentTaskId ?? "",
    task.assignedTrack?.actor ?? "",
    `${"  ".repeat(task.hierarchyDepth)}${task.title}`
  ]);
  return table(["ID", "Status", "Priority", "Depth", "Unblocks", "Progress", "Parent", "Actor", "Title"], rows);
}

export function formatTaskMarkdown(tasks: TaskView[]): string {
  const lines = ["| ID | Status | Priority | Depth | Unblocks | Progress | Parent | Actor | Title |", "| --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |"];
  for (const task of tasks) {
    lines.push(`| ${task.id} | ${task.computedStatus} | ${priorityLabel(task.priority)} | ${task.dependencyDepth} | ${task.transitiveDependentsCount} | ${task.descendantsCount > 0 ? `${task.subtreeProgress}%` : ""} | ${task.parentTaskId ?? ""} | ${task.assignedTrack?.actor ?? ""} | ${task.title.replace(/\|/g, "\\|")} |`);
  }
  return lines.join("\n");
}

export function formatExplain(explanation: DependencyExplanation): string {
  const task = explanation.task;
  const lines = [
    `${task.id} ${task.title}`,
    "",
    `Status: ${task.computedStatus}`,
    `Lifecycle: ${task.lifecycle}`,
    `Priority: ${priorityLabel(task.priority)}`,
    `Depth: ${task.dependencyDepth}`,
    `Unblocks: ${task.transitiveDependentsCount} tasks`,
    `Parent: ${task.parent ? `${task.parent.id} ${task.parent.title}` : "root"}`,
    `Subtree: ${task.subtreeProgress}% (${task.finishedLeafDescendantsCount}/${task.leafDescendantsCount} leaf tasks finished)`,
    `Source: ${task.sourceDoc ?? "none"}${task.sourceSection ? `#${task.sourceSection}` : ""}`,
    `Assigned: ${task.assignedTrack?.actor ?? "none"}`,
    "",
    "Blocked by:"
  ];

  if (explanation.unfinishedDependencies.length === 0) {
    lines.push("- none");
  } else {
    for (const dependency of explanation.unfinishedDependencies) {
      lines.push(`- ${dependency.id} ${dependency.title} [${dependency.lifecycle}]`);
    }
  }

  lines.push("", `Assignable: ${explanation.assignable ? "yes" : "no"}`, `Reason: ${explanation.reason}`);
  return lines.join("\n");
}

export function formatActivity(activity: Activity[]): string {
  return table(["Created", "Type", "Subject", "Message"], activity.map((item) => [
    item.createdAt,
    item.type,
    `${item.subjectType}:${item.subjectId ?? ""}`,
    item.message
  ]));
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)));
  const renderRow = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  return [renderRow(headers), renderRow(widths.map((width) => "-".repeat(width))), ...rows.map(renderRow)].join("\n");
}
