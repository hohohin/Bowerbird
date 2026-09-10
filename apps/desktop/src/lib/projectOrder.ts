import type { Project } from "./types";

const PROJECT_ORDER_KEY = "bowerbird.projectOrder";

export function loadProjectOrder(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PROJECT_ORDER_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function saveProjectOrder(projects: readonly Project[]): void {
  try {
    localStorage.setItem(PROJECT_ORDER_KEY, JSON.stringify(
      projects.filter((project) => !project.provisional).map((project) => project.id),
    ));
  } catch {
    // Storage may be unavailable; the current store still preserves this session's order.
  }
}

/** Keep known projects in place with fresh metadata; newly discovered projects enter at the top. */
export function reconcileProjectOrder(projects: readonly Project[], order: readonly string[]): Project[] {
  const remaining = new Map(projects.map((project) => [project.id, project]));
  const known: Project[] = [];
  for (const id of order) {
    const project = remaining.get(id);
    if (!project) continue;
    known.push(project);
    remaining.delete(id);
  }
  return [...remaining.values(), ...known];
}
