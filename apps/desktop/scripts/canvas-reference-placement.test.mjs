import test from "node:test";
import assert from "node:assert/strict";
import { trackNewCanvasReferences, newReferencesForCanvasCard, placeNewCanvasReferences } from "../src/lib/canvasReferencePlacement.ts";
import { canvasPlacementForNewCard } from "../src/lib/canvasLogic.ts";

const card = { id: "gen-prompt:job:turn:0", kind: "prompt", projectId: "p", threadId: "t", x: 20264, y: 70, width: 260, height: 148 };
const ref = (index) => ({ id: `gen-reference:job:turn:${index}`, kind: "asset", role: "reference", projectId: "p", threadId: "t",
  x: 20002, y: 88 + index * 42, width: 190, height: 272, hiddenAt: null, positionLocked: false });
const edge = (source, target, ordinal = 0) => ({ fromNodeId: source.id, toNodeId: target.id, projectId: "p", threadId: "t", kind: "input", ordinal });

test("first snapshot references follow actual viewport card placement without moving old inputs or view", () => {
  const old = { ...ref(9), x: 9000, y: 1500 };
  const refs = [ref(1), ref(2), ref(3), ref(4)];
  const nodes = [card, old, ...refs];
  const edges = [edge(old, card), ...refs.map((r, i) => edge(r, card, i + 1))];
  const pending = trackNewCanvasReferences(new Map(), [old], nodes, new Set());
  assert.equal(pending.size, 4);
  const selected = newReferencesForCanvasCard(card, nodes, edges, pending);
  const pan = { x: 340, y: -120 };
  const zoom = 0.8;
  const moved = { ...card, ...canvasPlacementForNewCard(card, { x: 24, y: 72, width: 800, height: 620 }, pan, zoom, [old]) };
  const placed = placeNewCanvasReferences(moved, selected, [old]);
  assert.deepEqual(placed.map(n => n.id), refs.map(n => n.id));
  assert.equal(placed[0].x, moved.x);
  assert.equal(placed[0].y, moved.y + card.height + 40);
  assert.equal(placed[3].x, moved.x);
  assert.equal(placed[3].y, placed[0].y + 312);
  assert.deepEqual(pan, { x: 340, y: -120 });
  assert.equal(old.x, 9000);
  console.log("FRONTEND_COORDS", JSON.stringify({ card: moved, references: placed.map(({ x, y }) => ({ x, y })), pan, zoom }));
});

test("Agent prompt then Run card snapshots carry only untouched new references once", () => {
  const prompt = { ...card, id: "agent-prompt:launch:0:0" };
  const reference = { ...ref(0), id: "agent-reference:launch:0:0" };
  const edges = [edge(reference, prompt)];
  let pending = trackNewCanvasReferences(new Map(), [], [prompt, reference], new Set());
  const [placed] = placeNewCanvasReferences({ ...prompt, x: 50, y: 80 }, [reference], []);
  pending.set(placed.id, placed);
  const group = { ...card, id: "agent-group:run:0:0", kind: "agent_group", x: -2000, y: -1000 };
  const next = [prompt, placed, group];
  pending = trackNewCanvasReferences(pending, [prompt, placed], next, new Set());
  const selected = newReferencesForCanvasCard(group, next, [...edges, edge(prompt, group)], pending);
  assert.equal(selected.length, 1);
  const [final] = placeNewCanvasReferences(group, selected, []);
  assert.equal(final.x, group.x);
  pending.delete(final.id);
  assert.equal(trackNewCanvasReferences(pending, next, [prompt, final, group], new Set()).size, 0);
  assert.equal(trackNewCanvasReferences(new Map(), next, next, new Set()).size, 0, "reload must not re-layout");
});

test("manual moves, grouping, locking, hidden nodes and cross-project events are never carried", () => {
  const original = ref(0);
  const pending = new Map([[original.id, original]]);
  for (const changed of [{ ...original, x: 777 }, { ...original, hiddenAt: 1 }, { ...original, positionLocked: true }, { ...original, projectId: "other" }]) {
    assert.equal(trackNewCanvasReferences(pending, [original], [changed], new Set()).size, 0);
  }
  assert.equal(trackNewCanvasReferences(pending, [original], [original], new Set([original.id])).size, 0);
  assert.deepEqual(newReferencesForCanvasCard(card, [original], [{ ...edge(original, card), projectId: "other" }], pending), []);
});

test("new references avoid occupied slots and preserve input order", () => {
  const anchor = { ...card, x: -1600, y: -800 };
  const obstacle = { x: -1600, y: -612, width: 190, height: 272 };
  const placed = placeNewCanvasReferences(anchor, [ref(0), ref(1)], [obstacle]);
  assert.deepEqual(placed.map(({ x, y }) => [x, y]), [[-1370, -612], [-1140, -612]]);
});
