import assert from "node:assert/strict";
import test from "node:test";
import { appendDraftLassoPoint, combineDraftSelection, createDraftLasso, DRAFT_SELECTION_MAX_POINTS, DRAFT_SELECTION_MAX_RUNS, draftSelectionBounds,
  draftSelectionContains, draftSelectionMask, draftSelectionSvgPath, draftSelectionToLayer } from "../src/lib/draftSelection.ts";

const p = (x, y) => ({ x, y });
const concave = () => createDraftLasso([p(1, 1), p(7, 1), p(7, 3), p(3, 3), p(3, 7), p(1, 7)]);
function assertMaskMatches(selection, bounds) {
  const mask = draftSelectionMask(selection, bounds);
  for (let y = 0; y < bounds.height; y++) for (let x = 0; x < bounds.width; x++) {
    assert.equal(mask[y * bounds.width + x], draftSelectionContains(selection, bounds.x + x + .5, bounds.y + y + .5) ? 255 : 0, `mask at ${x},${y}`);
  }
  return mask;
}

test("legacy rectangular selections retain fractional half-open pixel-centre semantics", () => {
  const rect = { x: -.5, y: 1.5, width: 4, height: 3 };
  assert.deepEqual(draftSelectionBounds(rect), rect);
  assert.equal(draftSelectionContains(rect, -.5, 1.5), true);
  assert.equal(draftSelectionContains(rect, 3.5, 2), false);
  assert.equal(draftSelectionContains(rect, 0, 4.5), false);
  assert.equal(assertMaskMatches(rect, { x: -2, y: -1, width: 8, height: 8 }).filter(value => value === 255).length, 12);
  assert.throws(() => draftSelectionMask(rect, { x: 0, y: 0, width: 4097, height: 1 }));
  assert.throws(() => draftSelectionMask(rect, { x: .5, y: 0, width: 1, height: 1 }));
});

test("concave and self-crossing paths use actual even-odd interiors, never their bounding box", () => {
  const lasso = concave();
  assert.deepEqual(draftSelectionBounds(lasso), { x: 1, y: 1, width: 6, height: 6 });
  assert.equal(draftSelectionContains(lasso, 2, 5), true);
  assert.equal(draftSelectionContains(lasso, 5, 5), false);
  assert.equal(assertMaskMatches(lasso, { x: 0, y: 0, width: 9, height: 9 }).filter(Boolean).length, 20);
  const bow = createDraftLasso([p(1, 1), p(7, 7), p(1, 7), p(7, 1)]);
  assert.ok(bow, "zero signed area must not reject a self-crossing lasso");
  assert.equal(draftSelectionContains(bow, 4, 2), true);
  assert.equal(draftSelectionContains(bow, 1.5, 4), false);
  assertMaskMatches(bow, { x: -1, y: -1, width: 11, height: 11 });
  const twice = createDraftLasso([p(1, 1), p(7, 1), p(7, 7), p(1, 7), p(1, 1), p(7, 1), p(7, 7), p(1, 7)]);
  assert.equal(draftSelectionContains(twice, 4, 4), false, "a twice-traced contour cancels under even-odd");
  assert.equal(assertMaskMatches(twice, { x: 0, y: 0, width: 9, height: 9 }).some(Boolean), false);
});

test("empty gestures and collinear lines cancel while closure and inputs remain immutable", () => {
  for (const points of [[], [p(2, 2)], [p(0, 0), p(8, 8)], [p(0, 0), p(4, 4), p(8, 8), p(0, 0)], [p(NaN, 2)]]) assert.equal(createDraftLasso(points), null);
  const points = [p(1, 1), p(1, 1), p(7, 1), p(4, 7), p(1, 1)];
  const saved = structuredClone(points), lasso = createDraftLasso(points);
  assert.deepEqual(points, saved); assert.equal(lasso.points.length, 3);
  points[0].x = 999;
  assert.equal(lasso.points[0].x, 1, "closed selection owns its samples");
  assert.equal(draftSelectionSvgPath(lasso), "M1 1 L7 1 L4 7 Z");
});

test("long gestures cap sample/path size while retaining their origin and terminal sample", () => {
  let samples = [];
  for (let index = 0; index < 12000; index++) {
    samples = appendDraftLassoPoint(samples, p(index, Math.sin(index / 40) * 200));
    assert.ok(samples.length <= DRAFT_SELECTION_MAX_POINTS);
  }
  assert.deepEqual(samples[0], p(0, 0)); assert.equal(samples.at(-1).x, 11999);
  const before = structuredClone(samples);
  appendDraftLassoPoint(samples, p(13000, 100));
  assert.deepEqual(samples, before, "sampling does not mutate a previous preview array");
  const large = Array.from({ length: 12000 }, (_, index) => p(index, Math.sin(index / 40) * 200));
  const selection = createDraftLasso(large);
  assert.equal(selection.points.length, DRAFT_SELECTION_MAX_POINTS);
  assert.equal(selection.points.at(-1).x, 11999);
  assert.equal((draftSelectionSvgPath(selection).match(/L/g) ?? []).length, DRAFT_SELECTION_MAX_POINTS - 1);
});

test("document selection maps through translated/non-uniformly scaled layers without clamping vertices", () => {
  const selection = createDraftLasso([p(8, -4), p(16, -4), p(16, -1), p(12, -1), p(12, 3), p(8, 3)]);
  const layer = { x: 10, y: -3, width: 8, height: 4, canvas: { width: 32, height: 24 } };
  const local = draftSelectionToLayer(selection, layer);
  assert.deepEqual(draftSelectionBounds(local), { x: -8, y: -6, width: 32, height: 42 });
  assert.deepEqual(local.points[0], p(-8, -6));
  assertMaskMatches(local, { x: 0, y: 0, width: 32, height: 24 });
  assert.equal(draftSelectionContains(local, 4, 20), true);
  assert.equal(draftSelectionContains(local, 20, 20), false);
  assert.deepEqual(draftSelectionToLayer({ x: 8, y: -4, width: 8, height: 7 }, layer), { x: -8, y: -6, width: 32, height: 42 });
});


test("add is a true union with disconnected islands and subtract preserves holes", () => {
  const a = { x: 1, y: 1, width: 8, height: 8 }, b = { x: 5, y: 3, width: 8, height: 4 };
  const saved = structuredClone(a), union = combineDraftSelection(a, b, "add");
  assert.deepEqual(a, saved);
  const expected = (x, y) => draftSelectionContains(a, x, y) || draftSelectionContains(b, x, y);
  const mask = assertMaskMatches(union, { x: 0, y: 0, width: 16, height: 12 });
  for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) assert.equal(mask[y * 16 + x] > 0, expected(x + .5, y + .5));
  assert.equal(draftSelectionContains(union, 7, 4), true, "overlap remains selected rather than XOR");
  const island = combineDraftSelection(union, { x: 20, y: 2, width: 2, height: 3 }, "add");
  assert.equal(draftSelectionContains(island, 21, 3), true);
  assert.equal(draftSelectionContains(island, 17, 3), false);
  const holed = combineDraftSelection(island, { x: 3, y: 3, width: 3, height: 3 }, "subtract");
  assert.equal(draftSelectionContains(holed, 4, 4), false); assert.equal(draftSelectionContains(holed, 2, 4), true);
  assert.equal(draftSelectionContains(holed, 21, 3), true);
  const restored = combineDraftSelection(holed, { x: 3, y: 3, width: 3, height: 3 }, "add");
  assert.deepEqual(draftSelectionMask(restored, { x: 0, y: 0, width: 24, height: 12 }), draftSelectionMask(island, { x: 0, y: 0, width: 24, height: 12 }));
});

test("rectangle/lasso combinations use actual interiors and expose an explicit empty selection", () => {
  const lasso = concave(), rect = { x: 2, y: 2, width: 4, height: 4 }, bounds = { x: 0, y: 0, width: 9, height: 9 };
  for (const mode of ["add", "subtract"]) {
    const result = combineDraftSelection(lasso, rect, mode, bounds), mask = assertMaskMatches(result, bounds);
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
      const a = draftSelectionContains(lasso, x + .5, y + .5), b = draftSelectionContains(rect, x + .5, y + .5);
      assert.equal(mask[y * 9 + x] > 0, mode === "add" ? a || b : a && !b);
    }
  }
  const empty = combineDraftSelection(lasso, bounds, "subtract", bounds);
  assert.ok(empty, "no selected pixels is not the unrestricted null state");
  assert.equal(empty.width, 0); assert.equal(empty.height, 0);
  assert.equal(draftSelectionSvgPath(empty), ""); assert.equal(draftSelectionMask(empty, bounds).some(Boolean), false);
  assert.equal(draftSelectionContains(empty, 1, 1), false);
  assert.equal(combineDraftSelection(null, rect, "add"), rect);
  assert.ok(combineDraftSelection(null, rect, "subtract"));
  assert.equal(combineDraftSelection(lasso, null, "add"), lasso);
  assert.equal(combineDraftSelection(lasso, rect, "replace"), rect);
  assert.equal(combineDraftSelection(lasso, null, "replace"), null);
});

test("combined contours map to layer pixels and omit every internal scanline edge", () => {
  const outer = { x: 2, y: 2, width: 8, height: 6 }, hole = { x: 4, y: 3, width: 2, height: 2 };
  const selection = combineDraftSelection(outer, hole, "subtract");
  const saved = structuredClone(selection);
  const local = draftSelectionToLayer(selection, { x: 1, y: -1, width: 10, height: 10, canvas: { width: 20, height: 30 } });
  assert.deepEqual(draftSelectionBounds(local), { x: 2, y: 9, width: 16, height: 18 });
  assert.equal(draftSelectionContains(local, 8, 15), false);
  assert.equal(draftSelectionContains(local, 4, 15), true);
  assertMaskMatches(local, { x: 0, y: 0, width: 25, height: 30 });
  assert.deepEqual(selection, saved, "coordinate mapping does not mutate original region");
  const path = draftSelectionSvgPath(selection);
  assert.equal((path.match(/M/g) ?? []).length, 8, "rectangle with a rectangular hole has exactly eight boundary segments");
  assert.equal(path.includes("M2 4 H10"), false, "middle scanline is not drawn across a selected region");
});

test("combination work is bounded by the document and region complexity budget", () => {
  const huge = { x: -1e9, y: -1e9, width: 2e9, height: 2e9 }, bounds = { x: 0, y: 0, width: 4096, height: 4096 };
  const cut = { x: 1000, y: 1000, width: 2000, height: 2000 }, result = combineDraftSelection(huge, cut, "subtract", bounds);
  assert.deepEqual(draftSelectionBounds(result), bounds);
  assert.ok(result.region.rows.length <= 4096);
  assert.equal(draftSelectionContains(result, 2000, 2000), false);
  assert.equal(draftSelectionContains(result, 500, 500), true);
  assert.throws(() => combineDraftSelection(huge, cut, "add"), /选区像素范围无效/);
  const row = Array.from({ length: 2048 }, (_, index) => index * 2);
  const complicated = { ...bounds, region: { x: 0, y: 0, pixelWidth: 1, pixelHeight: 1,
    rows: Array.from({ length: DRAFT_SELECTION_MAX_RUNS / 1024 + 1 }, () => row) } };
  assert.throws(() => combineDraftSelection(complicated, { x: 0, y: 4095, width: 1, height: 1 }, "add", bounds), /选区轮廓过于复杂/);
});
