import type { GenJob } from "./types";

export type CanvasProjectJob = Pick<GenJob, "projectId" | "threadId" | "conversationId" | "running" | "turns" | "provider" | "media" | "videoOptions" | "lastPrompt">;

// Keep the projection stable across streaming, progress and preview updates.
// The detail panel and live card leaves subscribe to their own job.
export function createCanvasProjectJobsSelector(projectId: string | null) {
  let previous: Record<string, CanvasProjectJob> = {};
  let previousInput: Record<string, GenJob> | undefined;
  return (state: { genJobs: Record<string, GenJob> }) => {
    if (previousInput === state.genJobs) return previous;
    previousInput = state.genJobs;
    const next: Record<string, CanvasProjectJob> = {};
    let changed = false;
    for (const [id, job] of Object.entries(state.genJobs)) {
      if (!projectId || job.projectId !== projectId) continue;
      const old = previous[id];
      if (old && old.turns === job.turns && old.running === job.running && old.conversationId === job.conversationId
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
