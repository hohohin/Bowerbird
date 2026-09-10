import type { CanvasEdge, CanvasNode, ProjectTimelineScope } from "./types";
import {
  agentGroupNodeId,
  agentPromptNodeId,
  generationPromptNodeId,
} from "./projectNodeIds.ts";
import {
  cloudAgentNeedsAttention,
  type CloudAgentAttentionInput,
} from "./cloudAgentRuntime.ts";

export interface ProjectActivityInput {
  projectId: string;
  unreadThreadIds: readonly string[];
  generationJobs: readonly {
    projectId: string | null;
    threadId?: string | null;
    running: boolean;
    turns: readonly { error?: string | null }[];
  }[];
  agentRuns: readonly {
    projectId?: string | null;
    threadId?: string | null;
    status: string;
  }[];
}

export interface ProjectActivitySummary {
  running: number;
  failed: number;
  unread: number;
}

export interface GenerationTaskProjectionInput {
  projectId?: string | null;
  threadId?: string | null;
  running: boolean;
  turns: readonly { error?: string | null }[];
}

export interface AgentTaskProjectionInput extends CloudAgentAttentionInput {
  projectId?: string | null;
  threadId?: string | null;
}

export interface CreativeTaskNavigation {
  projectId: string;
  threadId: string;
  nodeId: string | null;
}

export type CreativeTaskOwnerState = "owned" | "unowned" | "invalid";

export type ProjectFocusResolution<T> =
  | { state: "thread-only" | "pending" | "rejected"; node: null }
  | { state: "ready"; node: T };

export type ProjectThreadFocusResolution = "ready" | "pending" | "rejected";

export interface GenerationTaskLocatorInput extends GenerationTaskProjectionInput {
  id: string;
  turns: readonly { turnKey?: string | null; error?: string | null }[];
}

export interface AgentTaskLocatorInput extends AgentTaskProjectionInput {
  runId: string;
  creativeLaunchId?: string | null;
}

function cloneUnread(current: Readonly<Record<string, readonly string[]>>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(current).map(([projectId, threads]) => [projectId, [...threads]]));
}

const TERMINAL_AGENT_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

export function isGenerationTaskFailed(job: GenerationTaskProjectionInput): boolean {
  return !job.running && job.turns.some((turn) => !!turn.error);
}

export function taskCenterGenerationJobs<T extends GenerationTaskProjectionInput>(jobs: readonly T[]): T[] {
  return jobs.filter((job) => job.running || isGenerationTaskFailed(job));
}

export function isAgentTaskActive(status: string): boolean {
  return !TERMINAL_AGENT_STATUSES.has(status);
}

export function taskCenterAgentRuns<T extends AgentTaskProjectionInput>(runs: readonly T[]): T[] {
  return runs.filter(cloudAgentNeedsAttention);
}

export function creativeTaskOwnerState(
  task: Pick<GenerationTaskProjectionInput, "projectId" | "threadId">,
): CreativeTaskOwnerState {
  const hasProject = !!task.projectId;
  const hasThread = !!task.threadId;
  if (hasProject && hasThread) return "owned";
  if (!hasProject && !hasThread) return "unowned";
  return "invalid";
}

export function creativeTaskNavigation(
  task: Pick<GenerationTaskProjectionInput, "projectId" | "threadId">,
  nodeId: string | null = null,
): CreativeTaskNavigation | null {
  if (creativeTaskOwnerState(task) !== "owned" || !task.projectId || !task.threadId) return null;
  return { projectId: task.projectId, threadId: task.threadId, nodeId };
}

/** New generation projections use a deterministic prompt-node id. Old recovered
 * jobs without a turn key still navigate to their project/thread without guessing. */
export function generationTaskNavigation(task: GenerationTaskLocatorInput): CreativeTaskNavigation | null {
  const turnKey = task.turns[task.turns.length - 1]?.turnKey ?? null;
  const nodeId = turnKey ? generationPromptNodeId(task.id, turnKey) : null;
  return creativeTaskNavigation(task, nodeId);
}

/** Prefer the launch prompt because it exists before the worker has emitted an
 * execution group. Legacy records can still fall back to the stable run group. */
export function agentTaskNavigation(task: AgentTaskLocatorInput): CreativeTaskNavigation | null {
  const nodeId = task.creativeLaunchId
    ? agentPromptNodeId(task.creativeLaunchId)
    : task.runId
      ? agentGroupNodeId(task.runId)
      : null;
  return creativeTaskNavigation(task, nodeId);
}

export function summarizeProjectActivity(input: ProjectActivityInput): ProjectActivitySummary {
  const jobs = input.generationJobs.filter((job) => job.projectId === input.projectId && job.threadId);
  const runs = input.agentRuns.filter((run) => run.projectId === input.projectId && run.threadId);
  return {
    running:
      jobs.filter((job) => job.running).length +
      runs.filter((run) => isAgentTaskActive(run.status)).length,
    failed:
      jobs.filter((job) => isGenerationTaskFailed(job)).length +
      runs.filter((run) => run.status === "failed").length,
    unread: new Set(input.unreadThreadIds).size,
  };
}

export function projectTimelineProjection(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  scope: ProjectTimelineScope,
  focusedThreadId: string | null,
) {
  if (scope === "all" || !focusedThreadId) {
    return { nodes: [...nodes], edges: [...edges] };
  }
  return {
    nodes: nodes.filter((node) => node.threadId === focusedThreadId),
    edges: edges.filter((edge) => edge.threadId === focusedThreadId),
  };
}

/** Project-wide material stays prominent; only nodes owned by another thread are subdued. */
export function isOutsideFocusedThread(
  threadId: string | null | undefined,
  focusedThreadId: string | null,
): boolean {
  return !!focusedThreadId && !!threadId && threadId !== focusedThreadId;
}

/** Only explicit retry/edit successors retire a task card, never thread focus. */
export function supersededProjectTaskIds(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
): Set<string> {
  const visible = new Map(nodes.filter((node) => node.hiddenAt == null).map((node) => [node.id, node]));
  const isTask = (id: string) => {
    const node = visible.get(id);
    return node?.kind === "prompt" || node?.kind === "agent_group";
  };
  const superseded = new Set<string>();
  for (const edge of edges) {
    if ((edge.kind !== "retry" && edge.kind !== "branch") || !isTask(edge.toNodeId)) continue;
    const parent = visible.get(edge.fromNodeId);
    const successor = visible.get(edge.toNodeId)!;
    if (!parent || parent.threadId !== successor.threadId) continue;
    if (isTask(parent.id)) superseded.add(parent.id);
    for (const output of edges) {
      if (output.kind === "produced" && output.toNodeId === parent.id
        && isTask(output.fromNodeId)
        && visible.get(output.fromNodeId)?.threadId === successor.threadId) {
        superseded.add(output.fromNodeId);
      }
    }
  }
  return superseded;
}

/** Archived threads are hidden from the default canvas/activity projection.
 * Passing an explicit archived thread keeps only that thread available for inspection/restoration.
 */
export function projectGraphVisibility(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  archivedThreadIds: ReadonlySet<string>,
  explicitlyIncludedThreadId: string | null = null,
) {
  const visibleThread = (threadId: string | null) =>
    !threadId || !archivedThreadIds.has(threadId) || threadId === explicitlyIncludedThreadId;
  return {
    nodes: nodes.filter((node) => visibleThread(node.threadId)),
    edges: edges.filter((edge) => visibleThread(edge.threadId)),
  };
}

export function isProjectNodeNavigable(
  node: Pick<CanvasNode, "threadId" | "hiddenAt">,
  archivedThreadIds: ReadonlySet<string>,
): boolean {
  return node.hiddenAt == null && (!node.threadId || !archivedThreadIds.has(node.threadId));
}

/** A non-null locator may arrive before its projection node. Keep the request
 * pending until the node appears; consume only a found-but-hidden target. */
export function resolveProjectFocusNode<T extends Pick<CanvasNode, "id" | "threadId" | "hiddenAt">>(
  nodes: readonly T[],
  requestedNodeId: string | null,
  archivedThreadIds: ReadonlySet<string>,
  requestedThreadId: string | null = null,
): ProjectFocusResolution<T> {
  if (!requestedNodeId) return { state: "thread-only", node: null };
  const node = nodes.find((candidate) => candidate.id === requestedNodeId);
  if (!node) return { state: "pending", node: null };
  if (requestedThreadId && node.threadId !== requestedThreadId) {
    return { state: "rejected", node: null };
  }
  return isProjectNodeNavigable(node, archivedThreadIds)
    ? { state: "ready", node }
    : { state: "rejected", node: null };
}

/** A thread-only task locator is authoritative too. Wait until the matching
 * snapshot contains it, and never replace the requested thread with a saved
 * workspace focus from an older visit. */
export function resolveProjectFocusThread<T extends { id: string; archivedAt: number | null }>(
  threads: readonly T[],
  requestedThreadId: string | null,
): ProjectThreadFocusResolution {
  if (!requestedThreadId) return "rejected";
  const thread = threads.find((candidate) => candidate.id === requestedThreadId);
  if (!thread) return "pending";
  return thread.archivedAt == null ? "ready" : "rejected";
}

export function markThreadUnread(
  current: Readonly<Record<string, readonly string[]>>,
  projectId: string,
  threadId: string,
): Record<string, string[]> {
  const threads = current[projectId] ?? [];
  if (threads.includes(threadId)) return current as Record<string, string[]>;
  return { ...cloneUnread(current), [projectId]: [...threads, threadId] };
}

export function clearThreadUnread(
  current: Readonly<Record<string, readonly string[]>>,
  projectId: string,
  threadId?: string | null,
): Record<string, string[]> {
  if (!(projectId in current)) return current as Record<string, string[]>;
  const next = cloneUnread(current);
  if (!threadId) {
    delete next[projectId];
    return next;
  }
  const remaining = (current[projectId] ?? []).filter((id) => id !== threadId);
  if (remaining.length > 0) next[projectId] = remaining;
  else delete next[projectId];
  return next;
}
