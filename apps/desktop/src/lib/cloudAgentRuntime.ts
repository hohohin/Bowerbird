import { selectCloudAgentResultArtifacts } from "./cloudAgentResult.ts";
import type { Asset, CloudAgentRunRecord } from "./types";

const TERMINAL_AGENT_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

export type CloudAgentIngestPhase = "idle" | "pending" | "ingesting" | "succeeded" | "failed";

export interface CloudAgentIngestRuntimeState {
  runId: string;
  fingerprint: string | null;
  phase: CloudAgentIngestPhase;
  attempt: number;
  nextRetryAt: number | null;
  assets: Asset[];
  error: string | null;
}

const ingestStates = new Map<string, CloudAgentIngestRuntimeState>();
const ingestListeners = new Map<string, Set<() => void>>();
const runOperationLanes = new Map<string, Promise<void>>();

function emptyIngestState(runId: string): CloudAgentIngestRuntimeState {
  return {
    runId,
    fingerprint: null,
    phase: "idle",
    attempt: 0,
    nextRetryAt: null,
    assets: [],
    error: null,
  };
}

export function cloudAgentNeedsRuntime(status: string): boolean {
  return !TERMINAL_AGENT_STATUSES.has(status);
}

export function mergeCloudAgentAssets(...sources: readonly (readonly Asset[])[]): Asset[] {
  const byId = new Map<string, Asset>();
  for (const source of sources) {
    for (const asset of source) byId.set(asset.id, asset);
  }
  return [...byId.values()];
}

/**
 * Startup recovery is an async snapshot read. Runs may be created or receive a
 * richer poll result while that read is in flight, so recovery must merge into
 * the live collection instead of replacing it wholesale when the list returns.
 */
export function mergeRecoveredCloudAgentRuns(
  currentRuns: Readonly<Record<string, CloudAgentRunRecord>>,
  currentOrder: readonly string[],
  recoveredRuns: readonly CloudAgentRunRecord[],
): { runs: Record<string, CloudAgentRunRecord>; order: string[] } {
  const runs: Record<string, CloudAgentRunRecord> = { ...currentRuns };
  for (const recovered of recoveredRuns) {
    const current = runs[recovered.runId];
    // On equal timestamps retain the live value: it may contain a local field
    // written during the request that the older list snapshot does not expose.
    if (!current || recovered.updatedAt > current.updatedAt) runs[recovered.runId] = recovered;
  }

  const order: string[] = [];
  const seen = new Set<string>();
  for (const runId of [
    ...currentOrder,
    ...recoveredRuns.map((run) => run.runId),
    ...Object.keys(runs),
  ]) {
    if (!runs[runId] || seen.has(runId)) continue;
    seen.add(runId);
    order.push(runId);
  }
  return { runs, order };
}

export type CloudAgentAttentionInput = { status: string } & Partial<CloudAgentRunRecord>;

export function cloudAgentIngestionFingerprint(run: CloudAgentRunRecord): string | null {
  const artifactKeys = selectCloudAgentResultArtifacts(
    run.snapshot.artifacts,
    run.snapshot.renderManifest,
  )
    .map((artifact) => `${artifact.id}:${artifact.sha256}`)
    .sort();
  return artifactKeys.length > 0 ? `${run.runId}:${artifactKeys.join("|")}` : null;
}

/**
 * Only project-owned runs belong to the current workspace lifecycle. Legacy
 * project-less sessions remain read-only and must not gain new local writes.
 */
export function cloudAgentNeedsIngestion(run: CloudAgentRunRecord): boolean {
  const feedbackAction = run.feedbackAction ?? run.snapshot.run.result_feedback_action ?? null;
  return run.status === "succeeded"
    && feedbackAction === "accept"
    && !!run.projectId
    && !!run.threadId
    && cloudAgentIngestionFingerprint(run) !== null;
}

/**
 * downloaded_at and finalAssetId prove per-artifact/primary progress. The
 * backend-owned whole-group checkpoint is committed only after every mapping,
 * projection, and provider acknowledgement is durable; all three are required.
 */
export function cloudAgentIngestionPersisted(run: CloudAgentRunRecord): boolean {
  if (!cloudAgentNeedsIngestion(run) || !run.finalAssetId) return false;
  const artifacts = selectCloudAgentResultArtifacts(
    run.snapshot.artifacts,
    run.snapshot.renderManifest,
  );
  const checkpoint = (run.snapshot as unknown as Record<string, unknown>)._bowerbirdAgentIngestV1;
  const durable = checkpoint && typeof checkpoint === "object"
    ? checkpoint as Record<string, unknown>
    : null;
  return artifacts.length > 0
    && artifacts.every((artifact) => !!artifact.downloaded_at)
    && durable?.schemaVersion === 1
    && durable.fingerprint === cloudAgentIngestionFingerprint(run)
    && typeof durable.completedAt === "number";
}

/**
 * The task center is an action surface, not history. Besides active/failed
 * runs, keep an accepted result visible until every selected artifact has a
 * durable local acknowledgement. Minimal legacy projections without a
 * snapshot cannot be mistaken for pending ingestion.
 */
export function cloudAgentNeedsAttention(run: CloudAgentAttentionInput): boolean {
  if (cloudAgentNeedsRuntime(run.status) || run.status === "failed") return true;
  if (run.status !== "succeeded" || !run.runId || !run.snapshot) return false;
  const complete = run as CloudAgentRunRecord;
  return cloudAgentNeedsIngestion(complete) && !cloudAgentIngestionPersisted(complete);
}

export function cloudAgentIngestReconcilePhase(
  startedFingerprint: string,
  next: CloudAgentRunRecord,
): "succeeded" | "pending" | "failed" {
  if (cloudAgentIngestionPersisted(next)) return "succeeded";
  return cloudAgentIngestionFingerprint(next) === startedFingerprint ? "failed" : "pending";
}

export function cloudAgentIngestRetryDelayMs(attempt: number): number {
  return Math.min(30_000, 2_500 * (2 ** Math.max(0, Math.min(attempt - 1, 4))));
}

export function cloudAgentShouldAttemptIngestion(
  run: CloudAgentRunRecord,
  state: CloudAgentIngestRuntimeState,
  now: number,
): boolean {
  if (!cloudAgentNeedsIngestion(run) || cloudAgentIngestionPersisted(run)) return false;
  const fingerprint = cloudAgentIngestionFingerprint(run);
  return state.fingerprint !== fingerprint
    || state.phase !== "failed"
    || state.nextRetryAt == null
    || state.nextRetryAt <= now;
}

/**
 * Every command that refreshes or mutates one Cloud Agent Run shares this lane.
 * Runs remain independent, while a slow response for one Run cannot race a later
 * poll, local tool checkpoint, artifact ingest, preview refresh, or panel action.
 */
export function enqueueCloudAgentRunOperation<T>(
  runId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = runOperationLanes.get(runId) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.then(() => undefined, () => undefined);
  runOperationLanes.set(runId, settled);
  void settled.then(() => {
    if (runOperationLanes.get(runId) === settled) runOperationLanes.delete(runId);
  });
  return result;
}

export function getCloudAgentIngestState(runId: string): CloudAgentIngestRuntimeState {
  return ingestStates.get(runId) ?? emptyIngestState(runId);
}

export function publishCloudAgentIngestState(state: CloudAgentIngestRuntimeState): void {
  ingestStates.set(state.runId, state);
  for (const listener of ingestListeners.get(state.runId) ?? []) listener();
}

export function subscribeCloudAgentIngestState(runId: string, listener: () => void): () => void {
  const listeners = ingestListeners.get(runId) ?? new Set<() => void>();
  listeners.add(listener);
  ingestListeners.set(runId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) ingestListeners.delete(runId);
  };
}

export function requestCloudAgentIngestRetry(runId: string): void {
  const current = getCloudAgentIngestState(runId);
  publishCloudAgentIngestState({
    ...current,
    phase: "pending",
    nextRetryAt: null,
    error: null,
  });
}

export function activeCloudAgentRunIds(
  runs: Readonly<Record<string, CloudAgentRunRecord>>,
  preferredOrder: readonly string[],
): string[] {
  const ordered = preferredOrder.filter((runId) => runs[runId] && cloudAgentNeedsRuntime(runs[runId].status));
  const seen = new Set(ordered);
  for (const run of Object.values(runs)) {
    if (!seen.has(run.runId) && cloudAgentNeedsRuntime(run.status)) ordered.push(run.runId);
  }
  return ordered;
}

export function pendingLocalTaskKey(run: CloudAgentRunRecord): string | null {
  const callId = run.snapshot.pendingLocalTask?.callId;
  return callId ? `${run.runId}:${callId}` : null;
}
