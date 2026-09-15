import type { GenJob, GenTurn } from "./types";

function preferText<T extends string | null | undefined>(
  live: T,
  persisted: T,
): T {
  return live != null && live.length > 0 ? live : persisted;
}

function preferItems<T>(live: T[] | undefined, persisted: T[] | undefined): T[] | undefined {
  return live && live.length > 0 ? live : persisted;
}

function hydrateMatchingTurn(live: GenTurn, persisted: GenTurn): GenTurn {
  return {
    ...persisted,
    ...live,
    turnKey: preferText(live.turnKey, persisted.turnKey),
    prompt: preferText(live.prompt, persisted.prompt),
    appliedPrompt: preferText(live.appliedPrompt, persisted.appliedPrompt),
    promptRaw: preferText(live.promptRaw, persisted.promptRaw),
    images: preferItems(live.images, persisted.images) ?? [],
    refs: preferItems(live.refs, persisted.refs),
    referenceNodeIds: preferItems(live.referenceNodeIds, persisted.referenceNodeIds),
    refAssets: preferItems(live.refAssets, persisted.refAssets),
    media: live.media ?? persisted.media,
    videoOptions: live.videoOptions ?? persisted.videoOptions,
    provider: preferText(live.provider, persisted.provider),
  };
}

/**
 * `list_gen_jobs` is a startup snapshot and can resolve after `recover_started`
 * has already created a deliberately sparse live job. Fill immutable/persisted
 * metadata without rolling back newer event-driven turns or runtime state.
 */
function hydrateRecoveredGenJob(live: GenJob, persisted: GenJob): GenJob {
  const persistedTurn = persisted.turns[persisted.turns.length - 1];
  let turns = live.turns;
  if (persistedTurn && live.turns.length === 0) {
    turns = persisted.turns;
  } else if (persistedTurn) {
    const matchingIndex = persistedTurn.turnKey
      ? live.turns.findIndex((turn) => turn.turnKey === persistedTurn.turnKey)
      : live.turns.length === 1 && !live.turns[0]?.turnKey
        ? 0
        : -1;
    if (matchingIndex >= 0) {
      turns = live.turns.map((turn, index) => (
        index === matchingIndex ? hydrateMatchingTurn(turn, persistedTurn) : turn
      ));
    }
  }

  return {
    ...live,
    conversationId: preferText(live.conversationId, persisted.conversationId),
    threadId: preferText(live.threadId, persisted.threadId),
    creativeSessionId: preferText(live.creativeSessionId, persisted.creativeSessionId),
    turns,
    sessionId: preferText(live.sessionId, persisted.sessionId),
    lastPrompt: preferText(live.lastPrompt, persisted.lastPrompt),
    lastRefs: preferItems(live.lastRefs, persisted.lastRefs) ?? [],
    refAssets: preferItems(live.refAssets, persisted.refAssets) ?? [],
    dimAssets: preferItems(live.dimAssets, persisted.dimAssets),
    lastRatio: preferText(live.lastRatio, persisted.lastRatio),
    media: live.media ?? persisted.media,
    videoOptions: live.videoOptions ?? persisted.videoOptions,
    provider: preferText(live.provider, persisted.provider),
    projectId: preferText(live.projectId, persisted.projectId),
    visualProfile: live.visualProfile ?? persisted.visualProfile,
    visualProfileId: preferText(live.visualProfileId, persisted.visualProfileId),
    createdAt: persisted.createdAt,
    submitId: preferText(live.submitId, persisted.submitId),
    // Event state is newer than the startup list snapshot, including terminal
    // transitions that may have arrived while list_gen_jobs was in flight.
    streaming: live.streaming,
    running: live.running,
    remoteStatus: live.remoteStatus,
  };
}

export function mergeRecoveredGenJobs(
  currentJobs: Readonly<Record<string, GenJob>>,
  currentOrder: readonly string[],
  persistedJobs: readonly GenJob[],
): { jobs: Record<string, GenJob>; order: string[] } {
  const jobs: Record<string, GenJob> = { ...currentJobs };
  for (const persisted of persistedJobs) {
    const live = jobs[persisted.id];
    jobs[persisted.id] = live ? hydrateRecoveredGenJob(live, persisted) : persisted;
  }

  const order: string[] = [];
  const seen = new Set<string>();
  for (const jobId of [
    ...currentOrder,
    ...persistedJobs.map((job) => job.id),
    ...Object.keys(jobs),
  ]) {
    if (!jobs[jobId] || seen.has(jobId)) continue;
    seen.add(jobId);
    order.push(jobId);
  }
  return { jobs, order };
}
