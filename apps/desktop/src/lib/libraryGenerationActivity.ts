import type { CloudAgentRunRecord, GenJob, GenTurn, Project } from "./types";
import type { ChatSummary } from "./localChat";
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

type TaskStatus = Pick<LibraryActivityTask, "status" | "statusLabel">;

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
