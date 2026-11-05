import { api } from "./api";
import type { Asset, GenJob, GenerationHistory } from "./types";
import { useStore } from "../store";

/** Display history and restored tasks share the same turn mapping; negative UI IDs avoid live turn collisions. */
export function imageHistoryJob(history: GenerationHistory, identity: Pick<GenJob, "id" | "projectId"> & Partial<GenJob>): GenJob {
  return {
    sessionId: history.session_id, media: history.media, videoOptions: history.video_options,
    turns: history.turns.map((turn, index) => ({
      id: -index - 1, turnKey: turn.turn_key ?? undefined, submitId: turn.submit_id,
      prompt: turn.prompt, promptRaw: turn.prompt_raw, appliedPrompt: turn.applied_prompt,
      images: turn.images, error: turn.error, media: turn.media, videoOptions: turn.video_options,
      ratio: turn.ratio, provider: turn.provider ?? undefined,
      refs: turn.references_resolved === false ? undefined : turn.references,
      referenceNodeIds: turn.reference_node_ids, refAssets: turn.ref_assets,
    })),
    running: false, streaming: "", createdAt: Date.now(),
    lastPrompt: history.turns[0]?.prompt ?? "", lastRefs: history.references.flatMap(ref => ref.store_path ? [ref.store_path] : []),
    refAssets: history.references, dimAssets: history.dimension_assets, lastRatio: history.ratio ?? null,
    provider: history.provider === "dreamina" ? "jimeng" : history.provider ?? "",
    visualProfile: history.visual_profile, visualProfileId: history.visual_profile?.profileId ?? null,
    ...identity,
  };
}

/** Resolve only on explicit send. Never borrow the currently open project's identity or navigate to another editor. */
export async function resolveImagePreviewJob(asset: Asset, displayed: GenJob, sourceJobId: string | null): Promise<GenJob> {
  if (sourceJobId) return useStore.getState().genJobs[sourceJobId] ?? { ...displayed, id: sourceJobId };
  await useStore.getState().loadGenJobs();
  const analyses = await api.listAnalysesByAsset(asset.id);
  const metadata = analyses.filter(row => row.kind === "generation_meta").flatMap(row => {
    try {
      const value = JSON.parse(row.payload);
      return value?.session_id === displayed.sessionId ? [value] : [];
    } catch { return []; }
  });
  const ids = [...new Set(metadata.map(value => value.job_id).filter((id): id is string => typeof id === "string" && !!id))];
  if (ids.length > 1) throw new Error("这张图片关联了多个生成任务，请从对应会话继续");
  const jobs = Object.values(useStore.getState().genJobs);
  const candidates = ids.length ? jobs.filter(job => job.id === ids[0])
    : jobs.filter(job => !!displayed.sessionId && job.sessionId === displayed.sessionId);
  if (candidates.length > 1) throw new Error("这张图片关联了多个生成任务，请从对应会话继续");
  if (candidates[0]) return candidates[0];
  const [history, location] = await Promise.all([api.generationHistory(asset.id, null), api.projectCanvasForAsset(asset.id)]);
  if (!history.session_id || history.session_id !== displayed.sessionId) throw new Error("原会话已变化，请重新打开图片后继续");
  const meta = metadata.find(value => value.job_id === ids[0]) ?? metadata[0];
  const threadId = typeof meta?.thread_id === "string" ? meta.thread_id : null;
  if (threadId && location?.threadId !== threadId) throw new Error("无法确定原会话所属的项目，请从对应项目打开会话");
  return imageHistoryJob(history, {
    id: ids[0] ?? crypto.randomUUID(), projectId: location?.projectId ?? null,
    threadId: location?.threadId ?? null,
    conversationId: typeof meta?.conversation_id === "string" ? meta.conversation_id : undefined,
  });
}
