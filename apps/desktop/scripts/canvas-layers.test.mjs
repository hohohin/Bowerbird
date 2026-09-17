import assert from "node:assert/strict";
import test from "node:test";
import { stepCanvasLayers } from "../src/lib/canvasLayers.ts";

const cards = [{ id: "note", order: 1 }, { id: "prompt", order: 1 }, { id: "asset", order: 8 }, { id: "group", order: 20 }];
function move(input, ids, direction) {
  const updates = stepCanvasLayers(input, new Set(ids), direction);
  return input.map(card => ({ ...card, order: updates.get(card.id) ?? card.order })).sort((a, b) => a.order - b.order);
}
test("one layer crosses equal z-index ties and gaps", () => {
  const next = move(cards, ["note"], 1);
  assert.deepEqual(next.map(card => card.id), ["prompt", "note", "asset", "group"]);
  assert.deepEqual(next.map(card => card.order), [1, 2, 3, 4]);
  assert.deepEqual(move(next, ["note"], -1).map(card => card.id), cards.map(card => card.id));
});
test("mixed selection keeps relative order and moves by one neighbor", () => {
  assert.deepEqual(move(cards, ["note", "prompt"], 1).map(card => card.id), ["asset", "note", "prompt", "group"]);
  assert.deepEqual(move(cards, ["prompt", "group"], -1).map(card => card.id), ["prompt", "note", "group", "asset"]);
});
test("limits, empty selection and missing nodes do not write", () => {
  for (const [ids, direction] of [[["group"], 1], [["note"], -1], [[], 1], [["missing"], -1], [cards.map(card => card.id), 1]]) {
    assert.equal(stepCanvasLayers(cards, new Set(ids), direction).size, 0);
  }
});
