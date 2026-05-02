import { conflict } from "./errors.js";
import type { ComputedStatus, Dependency, Task, TaskView } from "./types.js";

export interface GraphIndexes {
  dependenciesByTask: Map<string, string[]>;
  dependentsByTask: Map<string, string[]>;
}

export interface HierarchyIndexes {
  childrenByParent: Map<string, string[]>;
  parentByChild: Map<string, string | null>;
}

export interface HierarchyRollup {
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
}

export function buildGraphIndexes(dependencies: Dependency[]): GraphIndexes {
  const dependenciesByTask = new Map<string, string[]>();
  const dependentsByTask = new Map<string, string[]>();

  for (const edge of dependencies) {
    const deps = dependenciesByTask.get(edge.taskId) ?? [];
    deps.push(edge.dependsOnTaskId);
    dependenciesByTask.set(edge.taskId, deps);

    const dependents = dependentsByTask.get(edge.dependsOnTaskId) ?? [];
    dependents.push(edge.taskId);
    dependentsByTask.set(edge.dependsOnTaskId, dependents);
  }

  return { dependenciesByTask, dependentsByTask };
}

export function buildHierarchyIndexes(tasks: Task[]): HierarchyIndexes {
  const childrenByParent = new Map<string, string[]>();
  const parentByChild = new Map<string, string | null>();
  const taskIds = new Set(tasks.map((task) => task.id));

  for (const task of tasks) {
    const parentTaskId = task.parentTaskId && taskIds.has(task.parentTaskId) ? task.parentTaskId : null;
    parentByChild.set(task.id, parentTaskId);
    if (parentTaskId) {
      const children = childrenByParent.get(parentTaskId) ?? [];
      children.push(task.id);
      childrenByParent.set(parentTaskId, children);
    }
  }

  return { childrenByParent, parentByChild };
}

export function assertNoParentCycle(taskId: string, parentTaskId: string | null, tasks: Task[]): void {
  if (!parentTaskId) {
    return;
  }
  if (taskId === parentTaskId) {
    conflict("A task cannot be its own parent.", { taskId, parentTaskId });
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  let current: string | null = parentTaskId;
  const visited = new Set<string>();
  while (current) {
    if (current === taskId) {
      conflict("Parent link would create a cycle.", { taskId, parentTaskId });
    }
    if (visited.has(current)) {
      conflict("Existing parent hierarchy contains a cycle.", { taskId, parentTaskId, current });
    }
    visited.add(current);
    current = byId.get(current)?.parentTaskId ?? null;
  }
}

export function isDescendant(taskId: string, possibleDescendantId: string, tasks: Task[]): boolean {
  const hierarchy = buildHierarchyIndexes(tasks);
  const stack = [...(hierarchy.childrenByParent.get(taskId) ?? [])];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    if (current === possibleDescendantId) {
      return true;
    }
    visited.add(current);
    stack.push(...(hierarchy.childrenByParent.get(current) ?? []));
  }
  return false;
}

export function assertNoCycle(taskId: string, dependsOnTaskId: string, dependencies: Dependency[]): void {
  if (taskId === dependsOnTaskId) {
    conflict("A task cannot depend on itself.", { taskId, dependsOnTaskId });
  }

  const graph = buildGraphIndexes(dependencies);
  const stack = [dependsOnTaskId];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    if (current === taskId) {
      conflict("Dependency would create a cycle.", { taskId, dependsOnTaskId });
    }
    visited.add(current);
    for (const next of graph.dependenciesByTask.get(current) ?? []) {
      stack.push(next);
    }
  }
}

export function assertDependencySetHasNoCycle(taskId: string, dependencyIds: string[], dependencies: Dependency[]): void {
  const remaining = dependencies.filter((edge) => edge.taskId !== taskId);
  for (const dependencyId of dependencyIds) {
    assertNoCycle(taskId, dependencyId, remaining);
    remaining.push({ taskId, dependsOnTaskId: dependencyId, createdAt: new Date().toISOString() });
  }
}

export function computeDepths(tasks: Task[], dependencies: Dependency[]): Map<string, number> {
  const taskIds = new Set(tasks.map((task) => task.id));
  const graph = buildGraphIndexes(dependencies);
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const visit = (taskId: string): number => {
    if (memo.has(taskId)) {
      return memo.get(taskId) ?? 0;
    }
    if (visiting.has(taskId)) {
      return 0;
    }
    visiting.add(taskId);
    let maxDepth = 0;
    for (const dependencyId of graph.dependenciesByTask.get(taskId) ?? []) {
      if (!taskIds.has(dependencyId)) {
        continue;
      }
      maxDepth = Math.max(maxDepth, 1 + visit(dependencyId));
    }
    visiting.delete(taskId);
    memo.set(taskId, maxDepth);
    return maxDepth;
  };

  for (const task of tasks) {
    visit(task.id);
  }

  return memo;
}

export function computeTransitiveDependents(tasks: Task[], dependencies: Dependency[]): Map<string, Set<string>> {
  const taskIds = new Set(tasks.map((task) => task.id));
  const graph = buildGraphIndexes(dependencies);
  const memo = new Map<string, Set<string>>();
  const visiting = new Set<string>();

  const visit = (taskId: string): Set<string> => {
    if (memo.has(taskId)) {
      return new Set(memo.get(taskId));
    }
    if (visiting.has(taskId)) {
      return new Set();
    }
    visiting.add(taskId);
    const result = new Set<string>();
    for (const dependentId of graph.dependentsByTask.get(taskId) ?? []) {
      if (!taskIds.has(dependentId)) {
        continue;
      }
      result.add(dependentId);
      for (const downstream of visit(dependentId)) {
        result.add(downstream);
      }
    }
    visiting.delete(taskId);
    memo.set(taskId, result);
    return new Set(result);
  };

  for (const task of tasks) {
    visit(task.id);
  }

  return memo;
}

export function computeHierarchyRollups(tasks: Task[], statuses: Map<string, ComputedStatus>): Map<string, HierarchyRollup> {
  const hierarchy = buildHierarchyIndexes(tasks);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const memo = new Map<string, HierarchyRollup>();
  const depthMemo = new Map<string, number>();
  const visiting = new Set<string>();

  const computeDepth = (taskId: string): number => {
    if (depthMemo.has(taskId)) {
      return depthMemo.get(taskId) ?? 0;
    }
    const parentId = hierarchy.parentByChild.get(taskId) ?? null;
    if (!parentId || !taskById.has(parentId)) {
      depthMemo.set(taskId, 0);
      return 0;
    }
    const depth = 1 + computeDepth(parentId);
    depthMemo.set(taskId, depth);
    return depth;
  };

  const emptyFor = (taskId: string): HierarchyRollup => ({
    childrenCount: hierarchy.childrenByParent.get(taskId)?.length ?? 0,
    descendantsCount: 0,
    leafDescendantsCount: 0,
    finishedLeafDescendantsCount: 0,
    subtreeProgress: statuses.get(taskId) === "finished" ? 100 : 0,
    subtreeOpenCount: 0,
    subtreeReadyCount: 0,
    subtreeBlockedCount: 0,
    subtreeStartedCount: 0,
    subtreeFinishedCount: 0,
    hierarchyDepth: computeDepth(taskId)
  });

  const visit = (taskId: string): HierarchyRollup => {
    if (memo.has(taskId)) {
      return memo.get(taskId) ?? emptyFor(taskId);
    }
    if (visiting.has(taskId)) {
      return emptyFor(taskId);
    }
    visiting.add(taskId);

    const children = hierarchy.childrenByParent.get(taskId) ?? [];
    let rollup = emptyFor(taskId);

    if (children.length === 0) {
      memo.set(taskId, rollup);
      visiting.delete(taskId);
      return rollup;
    }

    for (const childId of children) {
      const childStatus = statuses.get(childId);
      const childRollup = visit(childId);
      rollup.descendantsCount += 1 + childRollup.descendantsCount;

      if (childStatus === "ready") {
        rollup.subtreeReadyCount += 1;
        rollup.subtreeOpenCount += 1;
      } else if (childStatus === "blocked") {
        rollup.subtreeBlockedCount += 1;
        rollup.subtreeOpenCount += 1;
      } else if (childStatus === "started") {
        rollup.subtreeStartedCount += 1;
      } else if (childStatus === "finished") {
        rollup.subtreeFinishedCount += 1;
      }

      rollup.subtreeOpenCount += childRollup.subtreeOpenCount;
      rollup.subtreeReadyCount += childRollup.subtreeReadyCount;
      rollup.subtreeBlockedCount += childRollup.subtreeBlockedCount;
      rollup.subtreeStartedCount += childRollup.subtreeStartedCount;
      rollup.subtreeFinishedCount += childRollup.subtreeFinishedCount;

      if ((hierarchy.childrenByParent.get(childId) ?? []).length === 0) {
        rollup.leafDescendantsCount += 1;
        if (childStatus === "finished") {
          rollup.finishedLeafDescendantsCount += 1;
        }
      } else {
        rollup.leafDescendantsCount += childRollup.leafDescendantsCount;
        rollup.finishedLeafDescendantsCount += childRollup.finishedLeafDescendantsCount;
      }
    }

    rollup.subtreeProgress = rollup.leafDescendantsCount === 0
      ? (statuses.get(taskId) === "finished" ? 100 : 0)
      : Math.round((rollup.finishedLeafDescendantsCount / rollup.leafDescendantsCount) * 100);

    memo.set(taskId, rollup);
    visiting.delete(taskId);
    return rollup;
  };

  for (const task of tasks) {
    visit(task.id);
  }

  return memo;
}

export function sortTaskViews(tasks: TaskView[], sort: string | undefined): TaskView[] {
  const copy = [...tasks];
  const byStable = (a: TaskView, b: TaskView): number => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  const readyRank = (task: TaskView): number => task.ready ? 0 : task.computedStatus === "started" ? 1 : task.blocked ? 2 : task.computedStatus === "finished" ? 3 : 4;

  copy.sort((a, b) => {
    switch (sort) {
      case "priority":
        return b.priority - a.priority || b.transitiveDependentsCount - a.transitiveDependentsCount || a.dependencyDepth - b.dependencyDepth || byStable(a, b);
      case "depth":
        return a.dependencyDepth - b.dependencyDepth || b.transitiveDependentsCount - a.transitiveDependentsCount || b.priority - a.priority || byStable(a, b);
      case "created":
        return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
      case "updated":
        return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
      case "id":
        return a.id.localeCompare(b.id);
      case "title":
        return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
      case "dependency":
      default:
        return readyRank(a) - readyRank(b)
          || b.transitiveDependentsCount - a.transitiveDependentsCount
          || b.priority - a.priority
          || a.dependencyDepth - b.dependencyDepth
          || byStable(a, b);
    }
  });

  return copy;
}
