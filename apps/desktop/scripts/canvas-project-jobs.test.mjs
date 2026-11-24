import assert from "node:assert/strict";
import { test } from "node:test";
import { createCanvasProjectJobsSelector } from "../src/lib/canvasProjectJobs.ts";

test("canvas projections stay stable through progress chunks and update on delivery, retry and removal", () => {
  const select = createCanvasProjectJobsSelector("open");
  const turns = [{ turnKey: "first", images: [] }];
  const active = { projectId: "open", conversationId: "chat", running: true, turns };
  const background = { projectId: "other", turns, running: true };
  const initial = select({ genJobs: { active, background } });
  assert.deepEqual(Object.keys(initial), ["active"]);
  for (let count = 0; count < 120; count++) {
    assert.equal(select({ genJobs: {
      active: { ...active, progress: { stage: "queued", queue_position: count }, streaming: String(count) },
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
