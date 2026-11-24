import type { CanvasNode, GenJob, GenTurn } from "./types";
import type { WorkflowRun } from "./canvasWorkflow";
import { canvasNodePayload } from "./canvasNodePayload.ts";

type CanvasTurn = Pick<GenTurn, "turnKey" | "images" | "promptRaw" | "prompt" | "error">;
export type CanvasProjectJob = Pick<GenJob, "projectId" | "threadId" | "conversationId" | "running" | "provider" | "media" | "videoOptions" | "lastPrompt"> & { turns: CanvasTurn[] };

function sameCanvasTurns(previous: CanvasTurn[], turns: CanvasTurn[]): boolean {
  return previous === turns || previous.length === turns.length && previous.every((turn, index) => {
    const next = turns[index];
    return turn === next || turn.turnKey === next.turnKey && turn.prompt === next.prompt && turn.promptRaw === next.promptRaw
      && turn.error === next.error && (turn.images === next.images
        || turn.images.length === next.images.length && turn.images.every((image, index) => image === next.images[index]));
  });
}

// Keep the projection stable across streaming, progress and preview updates.
// The detail panel and live card leaves subscribe to their own job.
export function createCanvasProjectJobsSelector(projectId: string | null, nodes: readonly CanvasNode[] = [], runs: readonly WorkflowRun[] = []) {
  // Recovery can deliver a job before its project owner is hydrated. Only exact
  // job identities from this board can associate such a job with its layout.
  const referenced = new Set<string>();
  for (const node of nodes) {
    if (node.projectId !== projectId || (node.kind !== "prompt" && node.role !== "output")) continue;
    const data = canvasNodePayload(node);
    const id = node.kind === "prompt" ? data.job_id : data.execution?.job_id;
    if (id) referenced.add(id);
  }
  for (const run of runs) for (const step of Object.values(run.steps)) if (step.jobId) referenced.add(step.jobId);

  let previous: Record<string, CanvasProjectJob> = {};
  let previousInput: Record<string, GenJob> | undefined;
  return (state: { genJobs: Record<string, GenJob> }) => {
    if (previousInput === state.genJobs) return previous;
    previousInput = state.genJobs;
    const next: Record<string, CanvasProjectJob> = {};
    let changed = false;
    for (const [id, job] of Object.entries(state.genJobs)) {
      if (!projectId || (job.projectId == null ? !referenced.has(id) : job.projectId !== projectId)) continue;
      const old = previous[id];
      if (old && old.projectId === job.projectId && sameCanvasTurns(old.turns, job.turns) && old.running === job.running && old.conversationId === job.conversationId
        && old.threadId === job.threadId && old.provider === job.provider && old.media === job.media
        && old.videoOptions === job.videoOptions && old.lastPrompt === job.lastPrompt) {
        next[id] = old;
      } else {
        const { projectId, threadId, conversationId, running, turns, provider, media, videoOptions, lastPrompt } = job;
        next[id] = { projectId, threadId, conversationId, running, turns, provider, media, videoOptions, lastPrompt };
        changed = true;
      }
    }
    if (changed || Object.keys(previous).length !== Object.keys(next).length) previous = next;
    return previous;
  };
}
