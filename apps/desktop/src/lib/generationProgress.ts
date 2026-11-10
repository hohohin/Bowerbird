import type { GenJob } from "./types";

export interface GenerationProgress {
  stage: "waiting_slot" | "submitting" | "processing" | "queued" | "generating" | "tool_running" | "querying" | "saving";
  queue_position?: number;
  queue_length?: number;
  turnKey?: string;
}

/** Execution feedback is transient and belongs to one exact running turn. */
export function applyGenerationProgress(job: GenJob, progress: GenerationProgress): GenJob {
  const turn = job.turns[job.turns.length - 1];
  if (!job.running || !progress.turnKey || progress.turnKey !== turn?.turnKey) return job;
  return { ...job, progress };
}

export function generationProgressLabel(job?: Pick<GenJob, "progress" | "turns" | "remoteStatus">): string {
  const progress = job?.progress;
  if (!progress || progress.turnKey !== job?.turns[job.turns.length - 1]?.turnKey) {
    return !job || job.remoteStatus === "querying" ? "上游处理中" : "准备生成";
  }
  switch (progress.stage) {
    case "waiting_slot": return "等待本机提交名额";
    case "submitting": return "正在提交任务";
    case "processing": return "上游处理中";
    case "queued": {
      const position = progress.queue_position, length = progress.queue_length;
      return Number.isSafeInteger(position) && Number.isSafeInteger(length) && position! > 0 && length! >= position!
        ? `排队中 · 队列位置 ${position} / ${length}` : "上游处理中";
    }
    case "generating": return "正在生成图像";
    case "tool_running": return "正在执行工具";
    case "querying": return "正在查询原任务";
    case "saving": return "正在保存结果";
    default: return "上游处理中";
  }
}
