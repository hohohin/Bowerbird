export type ProjectInspectorKind = "generation" | "agent";

export interface ProjectInspectorHeader {
  kind: ProjectInspectorKind;
  title: string;
  detail: string;
  running: boolean;
  closeLabel: "关闭项目详情";
}

export type ProjectInspectorPlacement = "project" | "legacy" | "hidden";

export interface ProjectInspectorExecutionOwner {
  projectId?: string | null;
  threadId?: string | null;
}

/**
 * An execution detail belongs to exactly one surface.
 *
 * Project-owned work is only eligible inside its owning project and must carry
 * a thread id. Truly unowned work may use the read-only Library fallback. While
 * a route or project snapshot is changing, neither surface is allowed to show
 * the stale selection from the previous location.
 */
export function resolveProjectInspectorPlacement(input: {
  open: boolean;
  loading: boolean;
  navigationPending: boolean;
  activeProjectId: string | null;
  execution: ProjectInspectorExecutionOwner | null;
}): ProjectInspectorPlacement {
  if (!input.open || input.loading || input.navigationPending || !input.execution) return "hidden";

  const executionProjectId = input.execution.projectId;
  if (executionProjectId == null) {
    return input.activeProjectId == null ? "legacy" : "hidden";
  }
  if (!executionProjectId || !input.execution.threadId || !input.activeProjectId) return "hidden";
  return executionProjectId === input.activeProjectId ? "project" : "hidden";
}

export function projectInspectorHeader(input: {
  kind: ProjectInspectorKind;
  prompt?: string | null;
  detail: string;
  running: boolean;
}): ProjectInspectorHeader {
  const title = input.prompt
    ?.split("\n")
    .find((line) => line.trim())
    ?.trim();
  return {
    kind: input.kind,
    title: title || (input.kind === "generation" ? "生成任务详情" : "Agent 任务详情"),
    detail: input.detail,
    running: input.running,
    closeLabel: "关闭项目详情",
  };
}

export function shouldCloseProjectInspectorOnEscape(input: {
  key: string;
  open: boolean;
  defaultPrevented?: boolean;
  editing?: boolean;
  targetTagName?: string | null;
  targetContentEditable?: boolean;
  blockingDialogOpen?: boolean;
  popupOpen?: boolean;
}): boolean {
  if (input.key !== "Escape" || !input.open || input.defaultPrevented || input.editing) return false;
  if (input.blockingDialogOpen || input.popupOpen || input.targetContentEditable) return false;
  const tagName = input.targetTagName?.toUpperCase();
  return tagName !== "INPUT" && tagName !== "TEXTAREA" && tagName !== "SELECT";
}
