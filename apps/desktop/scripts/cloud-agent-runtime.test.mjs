import assert from "node:assert/strict";
import test from "node:test";

import {
  activeCloudAgentRunIds,
  cloudAgentIngestionFingerprint,
  cloudAgentIngestionPersisted,
  cloudAgentIngestReconcilePhase,
  cloudAgentIngestRetryDelayMs,
  cloudAgentNeedsAttention,
  cloudAgentNeedsIngestion,
  cloudAgentNeedsRuntime,
  cloudAgentShouldAttemptIngestion,
  enqueueCloudAgentRunOperation,
  getCloudAgentIngestState,
  mergeCloudAgentAssets,
  mergeRecoveredCloudAgentRuns,
  pendingLocalTaskKey,
  publishCloudAgentIngestState,
  requestCloudAgentIngestRetry,
} from "../src/lib/cloudAgentRuntime.ts";

function run(runId, status, callId = null) {
  return {
    runId,
    status,
    snapshot: {
      ...(callId ? { pendingLocalTask: { callId } } : {}),
    },
  };
}

test("background Agent runtime follows every non-terminal run, not only the open inspector", () => {
  const runs = {
    running: run("running", "running"),
    approval: run("approval", "awaiting_approval"),
    succeeded: run("succeeded", "succeeded"),
    failed: run("failed", "failed"),
  };
  assert.deepEqual(activeCloudAgentRunIds(runs, ["succeeded", "approval"]), ["approval", "running"]);
  assert.equal(cloudAgentNeedsRuntime("awaiting_local_task"), true);
  assert.equal(cloudAgentNeedsRuntime("cancelled"), false);
});

test("pending local task keys are run-scoped and stable across polling", () => {
  assert.equal(pendingLocalTaskKey(run("run-1", "awaiting_local_task", "call-1")), "run-1:call-1");
  assert.equal(pendingLocalTaskKey(run("run-2", "running")), null);
});

test("restart-time Agent detail merges exact canvas assets without in-memory ingest state", () => {
  const listed = [{ id: "reference", name: "ref" }];
  const hydrated = [{ id: "final", name: "final" }, { id: "reference", name: "ref-exact" }];
  const merged = mergeCloudAgentAssets(listed, hydrated, []);
  assert.deepEqual(merged.map((asset) => asset.id), ["reference", "final"]);
  assert.equal(merged.find((asset) => asset.id === "reference").name, "ref-exact");
  assert.equal(merged.find((asset) => asset.id === "final").name, "final");
});

test("a deferred startup list cannot overwrite runs created or enriched while it was in flight", async () => {
  let releaseList;
  const deferredList = new Promise((resolve) => { releaseList = resolve; });
  let state = {
    runs: {
      shared: { runId: "shared", updatedAt: 10, snapshot: { phase: "listed-old" } },
      retained: { runId: "retained", updatedAt: 20, snapshot: { phase: "already-live" } },
    },
    order: ["retained", "shared", "shared"],
  };

  const load = (async () => {
    const recovered = await deferredList;
    state = mergeRecoveredCloudAgentRuns(state.runs, state.order, recovered);
  })();

  // Mirrors updateCloudAgentRun(new) followed by updateCloudAgentRun(richer)
  // after cloudAgentList started but before its older snapshot was released.
  state = {
    runs: {
      ...state.runs,
      createdDuringList: { runId: "createdDuringList", updatedAt: 30, snapshot: { phase: "new" } },
      shared: { runId: "shared", updatedAt: 40, snapshot: { phase: "live-richer" } },
    },
    order: ["createdDuringList", ...state.order],
  };
  releaseList([
    { runId: "shared", updatedAt: 15, snapshot: { phase: "listed-stale" } },
    { runId: "listedOnly", updatedAt: 12, snapshot: { phase: "listed" } },
    { runId: "retained", updatedAt: 11, snapshot: { phase: "listed-stale" } },
  ]);
  await load;

  assert.equal(state.runs.shared.snapshot.phase, "live-richer");
  assert.equal(state.runs.retained.snapshot.phase, "already-live");
  assert.equal(state.runs.createdDuringList.snapshot.phase, "new");
  assert.equal(state.runs.listedOnly.snapshot.phase, "listed");
  assert.deepEqual(state.order, ["createdDuringList", "retained", "shared", "listedOnly"]);
});

test("startup recovery accepts a newer persisted run and preserves live data on timestamp ties", () => {
  const merged = mergeRecoveredCloudAgentRuns(
    {
      newerOnDisk: { runId: "newerOnDisk", updatedAt: 10, snapshot: { phase: "live-old" } },
      equal: { runId: "equal", updatedAt: 20, snapshot: { phase: "live-richer" } },
    },
    ["equal", "newerOnDisk"],
    [
      { runId: "newerOnDisk", updatedAt: 30, snapshot: { phase: "persisted-newer" } },
      { runId: "equal", updatedAt: 20, snapshot: { phase: "persisted-tie" } },
    ],
  );

  assert.equal(merged.runs.newerOnDisk.snapshot.phase, "persisted-newer");
  assert.equal(merged.runs.equal.snapshot.phase, "live-richer");
  assert.deepEqual(merged.order, ["equal", "newerOnDisk"]);
});

function acceptedRun(overrides = {}) {
  return {
    runId: "accepted-run",
    status: "succeeded",
    feedbackAction: "accept",
    projectId: "project-1",
    threadId: "thread-1",
    finalAssetId: null,
    snapshot: {
      run: { result_feedback_action: "accept" },
      artifacts: [
        {
          id: "stage-1",
          role: "stage_result",
          mime: "image/png",
          sha256: "sha-stage",
          user_visible: true,
          downloaded_at: null,
        },
        {
          id: "final-1",
          role: "final_result",
          mime: "image/png",
          sha256: "sha-final",
          user_visible: true,
          downloaded_at: null,
        },
      ],
    },
    ...overrides,
  };
}

test("accepted succeeded project runs remain owned by the background ingestion lifecycle", () => {
  const accepted = acceptedRun();
  assert.equal(cloudAgentNeedsRuntime(accepted.status), false);
  assert.equal(cloudAgentNeedsIngestion(accepted), true);
  assert.equal(cloudAgentNeedsIngestion(acceptedRun({ feedbackAction: "retry" })), false);
  assert.equal(cloudAgentNeedsIngestion(acceptedRun({ projectId: null })), false);
});

test("artifact fingerprint is stable and changes when the accepted result group changes", () => {
  const accepted = acceptedRun();
  const reversed = acceptedRun({
    snapshot: { ...accepted.snapshot, artifacts: [...accepted.snapshot.artifacts].reverse() },
  });
  assert.equal(cloudAgentIngestionFingerprint(accepted), cloudAgentIngestionFingerprint(reversed));
  const changed = acceptedRun({
    snapshot: {
      ...accepted.snapshot,
      artifacts: accepted.snapshot.artifacts.map((artifact) => (
        artifact.id === "final-1" ? { ...artifact, sha256: "sha-revised" } : artifact
      )),
    },
  });
  assert.notEqual(cloudAgentIngestionFingerprint(accepted), cloudAgentIngestionFingerprint(changed));
});

test("durable completion requires the primary local asset and acknowledgement for the whole group", () => {
  const accepted = acceptedRun();
  assert.equal(cloudAgentIngestionPersisted(accepted), false);
  assert.equal(cloudAgentIngestionPersisted(acceptedRun({ finalAssetId: "asset-final" })), false);
  const acknowledged = accepted.snapshot.artifacts.map((artifact) => ({
    ...artifact,
    downloaded_at: "2026-09-04T00:00:00.000Z",
  }));
  assert.equal(cloudAgentIngestionPersisted(acceptedRun({
    finalAssetId: "asset-final",
    snapshot: { ...accepted.snapshot, artifacts: acknowledged },
  })), false, "artifact receipts alone are not the atomic whole-group marker");
  const fingerprint = cloudAgentIngestionFingerprint(acceptedRun({
    finalAssetId: "asset-final",
    snapshot: { ...accepted.snapshot, artifacts: acknowledged },
  }));
  assert.equal(cloudAgentIngestionPersisted(acceptedRun({
    finalAssetId: "asset-final",
    snapshot: {
      ...accepted.snapshot,
      artifacts: acknowledged,
      _bowerbirdAgentIngestV1: {
        schemaVersion: 1,
        fingerprint,
        completedAt: 1,
      },
    },
  })), true);
  assert.equal(cloudAgentIngestionPersisted(acceptedRun({
    finalAssetId: "asset-final",
    snapshot: {
      ...accepted.snapshot,
      artifacts: acknowledged,
      _bowerbirdAgentIngestV1: {
        schemaVersion: 1,
        fingerprint: "stale-fingerprint",
        completedAt: 1,
      },
    },
  })), false, "a checkpoint for a different artifact group is not durable evidence");
});

test("accepted results remain task-center attention until the whole group is durable", () => {
  const pending = acceptedRun({ finalAssetId: "asset-final" });
  assert.equal(cloudAgentNeedsAttention(pending), true);
  assert.equal(cloudAgentNeedsAttention(acceptedRun({ status: "failed" })), true);
  const acknowledged = pending.snapshot.artifacts.map((artifact) => ({
    ...artifact,
    downloaded_at: "2026-09-04T00:00:00.000Z",
  }));
  const fingerprint = cloudAgentIngestionFingerprint(acceptedRun({
    finalAssetId: "asset-final",
    snapshot: { ...pending.snapshot, artifacts: acknowledged },
  }));
  assert.equal(cloudAgentNeedsAttention(acceptedRun({
    finalAssetId: "asset-final",
    snapshot: {
      ...pending.snapshot,
      artifacts: acknowledged,
      _bowerbirdAgentIngestV1: {
        schemaVersion: 1,
        fingerprint,
        completedAt: 1,
      },
    },
  })), false);
});

test("same-fingerprint ingest never reports success before durable reconciliation", () => {
  const accepted = acceptedRun({ finalAssetId: "asset-final" });
  const fingerprint = cloudAgentIngestionFingerprint(accepted);
  assert.ok(fingerprint);
  assert.equal(cloudAgentIngestReconcilePhase(fingerprint, accepted), "failed");
  assert.equal(cloudAgentShouldAttemptIngestion(accepted, {
    runId: accepted.runId,
    fingerprint,
    phase: "succeeded",
    attempt: 1,
    nextRetryAt: null,
    assets: [],
    error: null,
  }, 1_000), true);
  const backedOff = {
    runId: accepted.runId,
    fingerprint,
    phase: "failed",
    attempt: 1,
    nextRetryAt: 2_000,
    assets: [],
    error: "not durable",
  };
  assert.equal(cloudAgentShouldAttemptIngestion(accepted, backedOff, 1_999), false);
  assert.equal(cloudAgentShouldAttemptIngestion(accepted, backedOff, 2_000), true);

  const changed = acceptedRun({
    finalAssetId: "asset-final",
    snapshot: {
      ...accepted.snapshot,
      artifacts: accepted.snapshot.artifacts.map((artifact) => (
        artifact.id === "final-1" ? { ...artifact, sha256: "new-final" } : artifact
      )),
    },
  });
  assert.equal(cloudAgentIngestReconcilePhase(fingerprint, changed), "pending");

  const acknowledged = accepted.snapshot.artifacts.map((artifact) => ({
    ...artifact,
    downloaded_at: "2026-09-04T00:00:00.000Z",
  }));
  const durable = acceptedRun({
    finalAssetId: "asset-final",
    snapshot: {
      ...accepted.snapshot,
      artifacts: acknowledged,
      _bowerbirdAgentIngestV1: {
        schemaVersion: 1,
        fingerprint,
        completedAt: 1,
      },
    },
  });
  assert.equal(cloudAgentIngestReconcilePhase(fingerprint, durable), "succeeded");
});

test("run operation lane serializes one run without blocking a different run", async () => {
  const events = [];
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = enqueueCloudAgentRunOperation("lane-run", async () => {
    events.push("first:start");
    await gate;
    events.push("first:end");
  });
  const second = enqueueCloudAgentRunOperation("lane-run", async () => {
    events.push("second:start");
  });
  const independent = enqueueCloudAgentRunOperation("other-run", async () => {
    events.push("other:start");
  });

  await independent;
  assert.deepEqual(events, ["first:start", "other:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "other:start", "first:end", "second:start"]);

  await assert.rejects(
    enqueueCloudAgentRunOperation("lane-run", async () => { throw new Error("expected"); }),
    /expected/,
  );
  assert.equal(await enqueueCloudAgentRunOperation("lane-run", async () => "continued"), "continued");
});

test("failed ingestion is retryable per run and automatic retry delay is capped", () => {
  publishCloudAgentIngestState({
    runId: "retry-run",
    fingerprint: "retry-run:artifact",
    phase: "failed",
    attempt: 3,
    nextRetryAt: 999,
    assets: [],
    error: "network",
  });
  requestCloudAgentIngestRetry("retry-run");
  assert.deepEqual(getCloudAgentIngestState("retry-run"), {
    runId: "retry-run",
    fingerprint: "retry-run:artifact",
    phase: "pending",
    attempt: 3,
    nextRetryAt: null,
    assets: [],
    error: null,
  });
  assert.equal(cloudAgentIngestRetryDelayMs(1), 2_500);
  assert.equal(cloudAgentIngestRetryDelayMs(20), 30_000);
});
