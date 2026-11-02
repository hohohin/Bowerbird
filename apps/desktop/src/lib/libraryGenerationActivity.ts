import type { CloudAgentRunRecord, GenJob, GenTurn, Project } from "./types";
import type { ChatSummary } from "./localChat";
import type { CanvasWorkflow, WorkflowNode, WorkflowRun, WorkflowStep } from "./canvasWorkflow";
import { agentTaskNavigation, generationTaskNavigation } from "./projectActivity.ts";
import { cloudAgentIngestionPersisted } from "./cloudAgentRuntime.ts";
import { cloudAgentStatusLabel } from "./cloudAgent.ts";

export interface LibraryActivityTask {
  id: string;
  source: "generation" | "agent" | "chat" | "extra";
  projectId: string;
  threadId: string;
  nodeId: string | null;
  title: string;
  status: "running" | "completed" | "failed" | "attention" | "cancelled";
  statusLabel: string;
  updatedAt: number;
}

export interface LibraryLocalVideoLocator { projectId: string; nodeId: string; createdAt: number }

type TaskStatus = Pick<LibraryActivityTask, "status" | "statusLabel">;

export function libraryLocalVideoRun(document: CanvasWorkflow, nodeId: string): WorkflowRun | undefined {
  const runs = document.runs ?? (document.run ? [document.run] : []);
  return [...runs].reverse().find(run => run.steps[nodeId]);
}

function localVideoInterruption(run: WorkflowRun, step: WorkflowStep, error: string): TaskStatus | null {
  if (error || step.status === "waiting" || run.status === "waiting") return { status: "attention", statusLabel: "待继续取回" };
  if (step.comfyCancelled || run.status === "stopped") return { status: "cancelled", statusLabel: "已停止" };
  if (step.status === "failed" || run.status === "failed") return { status: "failed", statusLabel: "生成未完成" };
  return null;
}

function localVideoProgress(node: WorkflowNode, step: WorkflowStep): TaskStatus {
  if (step.status !== "done") return { status: "running", statusLabel: "生成中" };
  if (!node.outputs.image?.assetIds?.length) return { status: "attention", statusLabel: "待确认结果" };
  if (!node.resultNodeIds?.length) return { status: "attention", statusLabel: "待保存结果" };
  return { status: "completed", statusLabel: "已完成" };
}

function localVideoTarget(node: WorkflowNode, status: LibraryActivityTask["status"]): string {
  return status === "completed" ? node.resultNodeIds?.[0] ?? node.id : node.id;
}

export function libraryLocalVideoTask(locator: LibraryLocalVideoLocator, document: CanvasWorkflow, error = ""): LibraryActivityTask | null {
  const node = document.nodes.find(node => node.id === locator.nodeId);
  const run = libraryLocalVideoRun(document, locator.nodeId);
  if (!node || !run) return null;
  const step = run.steps[locator.nodeId];
  const progress = localVideoInterruption(run, step, error) ?? localVideoProgress(node, step);
  return { id: `${locator.projectId}:${locator.nodeId}`, source: "extra", projectId: locator.projectId,
    threadId: run.threadId, nodeId: localVideoTarget(node, progress.status), title: node.prompt || "本机 H3 视频", ...progress, updatedAt: locator.createdAt };
}

function generationProgress(job: GenJob, turn?: GenTurn): TaskStatus {
  if (job.running) return { status: "running", statusLabel: "生成中" };
  if (turn?.error || !turn?.images.length) return { status: "attention", statusLabel: "需处理" };
  return { status: "completed", statusLabel: "已完成" };
}

function generationTitle(job: GenJob, turn?: GenTurn): string {
  return turn?.promptRaw || turn?.prompt || job.lastPrompt || "生成任务";
}

function generationUpdatedAt(job: GenJob, turn?: GenTurn): number {
  return turn?.startedAt ? turn.startedAt + (turn.durationMs ?? 0) : job.createdAt;
}

function generationTask(job: GenJob): LibraryActivityTask | null {
  const location = generationTaskNavigation(job);
  if (!location) return null;
  const turn = job.turns[job.turns.length - 1];
  return { ...location, id: job.id, source: "generation", title: generationTitle(job, turn),
    ...generationProgress(job, turn), updatedAt: generationUpdatedAt(job, turn) };
}

function agentTask(run: CloudAgentRunRecord): LibraryActivityTask | null {
  const location = agentTaskNavigation(run);
  if (!location) return null;
  let status: LibraryActivityTask["status"] = "running";
  let statusLabel = cloudAgentStatusLabel(run.status);
  if (run.status === "succeeded") {
    status = cloudAgentIngestionPersisted(run) ? "completed" : "attention";
    statusLabel = status === "completed" ? "已完成" : "待保存结果";
  } else if (run.status === "failed") status = "failed";
  else if (run.status === "cancelled") status = "cancelled";
  else if (["awaiting_clarification", "awaiting_approval", "awaiting_result_feedback"].includes(run.status)) status = "attention";
  return { ...location, id: run.runId, source: "agent", title: run.intentPrompt || "Agent 创作", status, statusLabel, updatedAt: run.updatedAt };
}

function chatTask(chat: ChatSummary): LibraryActivityTask {
  const running = chat.status === "running" || chat.status === "stopping";
  const status = running ? "running" : chat.status === "idle" ? "completed" : "attention";
  return { id: chat.id, source: "chat", projectId: chat.projectId, threadId: chat.threadId, nodeId: chat.nodeId,
    title: chat.title || "对话", status, statusLabel: running ? "回复中" : status === "completed" ? "已回复" : "需处理", updatedAt: chat.updatedAt };
}

/** History is a projection of persisted task owners, never a second task queue. */
export function libraryGenerationTasks({ projects, jobs = [], runs = [], chats = [], extraTasks = [] }: {
  projects: readonly Pick<Project, "id" | "archived_at">[];
  jobs?: readonly GenJob[];
  runs?: readonly CloudAgentRunRecord[];
  chats?: readonly ChatSummary[];
  extraTasks?: readonly LibraryActivityTask[];
}): LibraryActivityTask[] {
  const visibleProjects = new Set(projects.filter(project => project.archived_at == null).map(project => project.id));
  return [...jobs.map(generationTask), ...runs.map(agentTask), ...chats.map(chatTask), ...extraTasks]
    .filter((task): task is LibraryActivityTask => !!task && !!task.threadId && visibleProjects.has(task.projectId))
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    .slice(0, 20);
}
