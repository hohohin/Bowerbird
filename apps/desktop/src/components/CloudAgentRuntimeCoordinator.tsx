import { useEffect, useRef } from "react";
import { api } from "../lib/api";
import {
  activeCloudAgentRunIds,
  cloudAgentIngestionFingerprint,
  cloudAgentIngestionPersisted,
  cloudAgentIngestReconcilePhase,
  cloudAgentIngestRetryDelayMs,
  cloudAgentNeedsIngestion,
  cloudAgentShouldAttemptIngestion,
  enqueueCloudAgentRunOperation,
  getCloudAgentIngestState,
  pendingLocalTaskKey,
  publishCloudAgentIngestState,
} from "../lib/cloudAgentRuntime";
import { notifyError, notifySuccess } from "../lib/notify";
import type { CloudAgentRunRecord } from "../lib/types";
import { useStore } from "../store";

const POLL_INTERVAL_MS = 2500;

/**
 * Headless runtime owner for Cloud Agent work. It intentionally lives above any
 * inspector: closing details must never pause polling or a pending local tool step.
 */
export function CloudAgentRuntimeCoordinator() {
  const polling = useRef(new Set<string>());
  const executingLocalTasks = useRef(new Set<string>());
  const ingesting = useRef(new Map<string, string>());
  const reconciledTerminal = useRef(new Set<string>());
  const notifiedIngestFailures = useRef(new Set<string>());

  useEffect(() => {
    let alive = true;

    function reconcileIngestion(run: CloudAgentRunRecord) {
      if (!cloudAgentNeedsIngestion(run)) return;
      const fingerprint = cloudAgentIngestionFingerprint(run);
      if (!fingerprint) return;

      const current = getCloudAgentIngestState(run.runId);
      if (cloudAgentIngestionPersisted(run)) {
        if (current.fingerprint !== fingerprint || current.phase !== "succeeded") {
          publishCloudAgentIngestState({
            runId: run.runId,
            fingerprint,
            phase: "succeeded",
            attempt: current.fingerprint === fingerprint ? current.attempt : 0,
            nextRetryAt: null,
            assets: current.fingerprint === fingerprint ? current.assets : [],
            error: null,
          });
        }
        return;
      }
      if (ingesting.current.has(run.runId)) return;
      if (!cloudAgentShouldAttemptIngestion(run, current, Date.now())) return;

      const sameArtifacts = current.fingerprint === fingerprint;
      const attempt = sameArtifacts ? current.attempt + 1 : 1;

      ingesting.current.set(run.runId, fingerprint);
      publishCloudAgentIngestState({
        runId: run.runId,
        fingerprint,
        phase: "ingesting",
        attempt,
        nextRetryAt: null,
        assets: sameArtifacts ? current.assets : [],
        error: null,
      });
      enqueueCloudAgentRunOperation(run.runId, async () => {
        const assets = await api.cloudAgentIngestArtifacts(run.runId);
        const next = await api.cloudAgentGet(run.runId);
        return { assets, next };
      })
        .then(({ assets, next }) => {
          if (!alive) return;
          useStore.getState().updateCloudAgentRun(next);
          reconciledTerminal.current.add(next.runId);
          const nextFingerprint = cloudAgentIngestionFingerprint(next);
          const reconcilePhase = cloudAgentIngestReconcilePhase(fingerprint, next);
          if (reconcilePhase === "pending") {
            publishCloudAgentIngestState({
              runId: next.runId,
              fingerprint: nextFingerprint,
              phase: "pending",
              attempt: 0,
              nextRetryAt: null,
              assets,
              error: null,
            });
            return;
          }
          if (reconcilePhase === "failed") {
            throw new Error("Agent 产物已写入，但整组持久化确认尚未完成");
          }
          publishCloudAgentIngestState({
            runId: next.runId,
            fingerprint: nextFingerprint ?? fingerprint,
            phase: "succeeded",
            attempt,
            nextRetryAt: null,
            assets,
            error: null,
          });
          notifiedIngestFailures.current.delete(fingerprint);
          notifySuccess(`Agent 的 ${assets.length} 张产物已作为同一组加入素材库`);
        })
        .catch((error) => {
          if (!alive) return;
          const message = error instanceof Error ? error.message : String(error);
          publishCloudAgentIngestState({
            runId: run.runId,
            fingerprint,
            phase: "failed",
            attempt,
            nextRetryAt: Date.now() + cloudAgentIngestRetryDelayMs(attempt),
            assets: sameArtifacts ? current.assets : [],
            error: message,
          });
          if (!notifiedIngestFailures.current.has(fingerprint)) {
            notifiedIngestFailures.current.add(fingerprint);
            notifyError(error, "Agent 产物整组入库失败，将在后台重试");
          }
        })
        .finally(() => {
          if (ingesting.current.get(run.runId) === fingerprint) ingesting.current.delete(run.runId);
        });
    }

    function executePendingLocalTask(run: CloudAgentRunRecord) {
      const key = pendingLocalTaskKey(run);
      if (!key || executingLocalTasks.current.has(key)) return;
      executingLocalTasks.current.add(key);
      enqueueCloudAgentRunOperation(run.runId, () => api.cloudAgentExecuteLocalTask(run.runId))
        .then((next) => {
          if (alive) useStore.getState().updateCloudAgentRun(next);
        })
        .catch((error) => {
          // Network/transient failures are retried on a later tick. The authoritative
          // run snapshot remains visible in the task center and inspector.
          console.error("cloud Agent local task execution failed", error);
        })
        .finally(() => executingLocalTasks.current.delete(key));
    }

    function pollRun(runId: string) {
      if (polling.current.has(runId)) return;
      polling.current.add(runId);
      enqueueCloudAgentRunOperation(runId, () => api.cloudAgentGet(runId))
        .then((next) => {
          if (!alive) return;
          useStore.getState().updateCloudAgentRun(next);
          executePendingLocalTask(next);
          if (cloudAgentNeedsIngestion(next)) {
            reconciledTerminal.current.add(next.runId);
            reconcileIngestion(next);
          } else if (next.status === "succeeded" || next.status === "failed" || next.status === "cancelled") {
            reconciledTerminal.current.add(next.runId);
          } else {
            reconciledTerminal.current.delete(next.runId);
          }
        })
        .catch((error) => console.error("cloud Agent background refresh failed", error))
        .finally(() => polling.current.delete(runId));
    }

    function tick() {
      const state = useStore.getState();
      for (const runId of activeCloudAgentRunIds(state.cloudAgentRuns, state.cloudAgentRunOrder)) {
        const run = state.cloudAgentRuns[runId];
        if (!run) continue;
        reconciledTerminal.current.delete(runId);
        executePendingLocalTask(run);
        pollRun(runId);
      }
      for (const run of Object.values(state.cloudAgentRuns)) {
        if (!cloudAgentNeedsIngestion(run)) continue;
        if (cloudAgentIngestionPersisted(run)) {
          reconcileIngestion(run);
        } else if (reconciledTerminal.current.has(run.runId)) {
          reconcileIngestion(run);
        } else {
          // A terminal local snapshot may predate the final cloud checkpoint.
          // Refresh it once before deciding which artifact group to ingest.
          pollRun(run.runId);
        }
      }
    }

    tick();
    const timer = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
