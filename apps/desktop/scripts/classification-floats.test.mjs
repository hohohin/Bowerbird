import assert from "node:assert/strict";
import { test } from "node:test";
import { appendClassificationFloats } from "../src/lib/classificationFloats.ts";

const result = sequence => ({ sequence, asset: { id: String(sequence), name: "素材", thumb_path: null, position: sequence }, tags: ["海报"], error: null });
test("immediate bursts stay bounded and distribute horizontal occupancy", () => {
  let items = [];
  for (let i = 1; i <= 200; i++) {
    items = appendClassificationFloats(items, [result(i)], 1000 + i * 10);
    assert.ok(items.length <= 10);
    const counts = [0, 0, 0, 0, 0, 0, 0];
    items.forEach(item => counts[item.lane]++);
    assert.ok(Math.max(...counts) <= 2);
    assert.ok(items.every(item => item.x >= 0 && item.x <= 1));
    assert.equal(items.at(-1).result.sequence, i, "new results enter immediately");
  }
  assert.equal(items.length, 10);
  assert.ok(new Set(items.map(item => item.startY)).size > 5, "not a regular row");
});
test("new completions preserve older lifetime and expiry works without animation events", () => {
  const first = appendClassificationFloats([], [result(1)], 100);
  const next = appendClassificationFloats(first, [result(2)], 600);
  assert.equal(next[0], first[0]);
  assert.equal(next[0].expiresAt, first[0].expiresAt);
  const expired = appendClassificationFloats(next, [], 12000);
  assert.deepEqual(expired, []);
  const burst = appendClassificationFloats([], Array.from({length:50}, (_, i) => result(i + 1)), 0);
  assert.equal(burst.length, 10);
  assert.equal(burst[0].result.sequence, 41);
});

test("Cloud handoffs exit without labels and tagged completion replaces them", () => {
  const pending = result(1).asset;
  const handoff = appendClassificationFloats([], [], 0, [pending]);
  assert.equal(handoff[0].motion, "exit");
  assert.equal(handoff[0].duration, 1100);
  assert.deepEqual(handoff[0].result.tags, []);
  const finished = appendClassificationFloats(handoff, [result(1)], 500);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].motion, "rise");
  const empty = appendClassificationFloats([], [{...result(2),tags:[]}], 0);
  assert.equal(empty[0].motion, "exit");
  assert.deepEqual(appendClassificationFloats(empty, [], 1200), []);
  const sameSnapshot=appendClassificationFloats([], [result(1)], 0, [pending]);
  assert.equal(sameSnapshot.length,1);
  assert.equal(sameSnapshot[0].motion,"rise");
});
