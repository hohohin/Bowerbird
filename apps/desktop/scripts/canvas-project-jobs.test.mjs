import assert from "node:assert/strict";
import { test } from "node:test";
import { createCanvasProjectJobsSelector, workflowCheckpointJobIds } from "../src/lib/canvasProjectJobs.ts";

test("canvas projections stay stable through progress chunks and update on delivery, retry and removal", () => {
  const select = createCanvasProjectJobsSelector("open");
  const turns = [{ turnKey: "first", images: [] }];
  const active = { projectId: "open", conversationId: "chat", running: true, turns };
  const background = { projectId: "other", turns, running: true };
  const initial = select({ genJobs: { active, background } });
  assert.deepEqual(Object.keys(initial), ["active"]);
  for (let count = 0; count < 120; count++) {
    assert.equal(select({ genJobs: {
      active: { ...active, turns: turns.map(turn => ({ ...turn, images: [...turn.images], submitId: String(count) })), progress: { stage: "queued", queue_position: count }, streaming: String(count) },
      background: { ...background, turns: [...turns, { turnKey: String(count) }] },
    } }), initial);
  }
  const delivered = select({ genJobs: { active: { ...active, running: false, turns: [{ ...turns[0], images: ["a.png"] }] } } });
  assert.notEqual(delivered, initial);
  assert.deepEqual(delivered.active.turns[0].images, ["a.png"]);
  const retry = select({ genJobs: { active: { ...active, turns: [...delivered.active.turns, { turnKey: "retry", images: [] }] } } });
  assert.equal(retry.active.running, true);
  assert.equal(retry.active.turns.length, 2);
  assert.deepEqual(select({ genJobs: { background } }), {});
});

test("an exact node or checkpoint restores an unowned job only for its board", () => {
  const node = (projectId, job_id) => ({ projectId, kind: "prompt", payloadJson: JSON.stringify({ job_id }) });
  const select = createCanvasProjectJobsSelector("open", [node("open", "old"), node("open", "moved"), node("other", "unrelated")]);
  const checkpoints = workflowCheckpointJobIds([{ steps: { image: { jobId: "checkpoint" } } }]);
  const unowned = { projectId: null, turns: [], running: true };
  const genJobs = { old: unowned, checkpoint: unowned, unrelated: unowned, moved: { ...unowned, projectId: "other" } };
  const restored = select({ genJobs }, checkpoints);
  assert.deepEqual(Object.keys(restored).sort(), ["checkpoint", "old"]);
  assert.equal(select({ genJobs }, new Set(checkpoints)), restored);
  assert.deepEqual(Object.keys(select({ genJobs }, new Set())), ["old"]);
  const hydrated = select({ genJobs: { ...genJobs, old: { ...unowned, projectId: "open" } } }, checkpoints);
  assert.equal(hydrated.old.projectId, "open");
  const reassigned = select({ genJobs: { ...genJobs, old: { ...unowned, projectId: "other" } } }, checkpoints);
  assert.deepEqual(Object.keys(reassigned), ["checkpoint"]);
});
