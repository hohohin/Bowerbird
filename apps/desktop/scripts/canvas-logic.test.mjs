import test from "node:test";
import assert from "node:assert/strict";
import {
  clampCanvasZoom,
  exceedsCanvasDragThreshold,
  findCanvasHoverTarget,
  isCanvasPanGesture,
  mergeCanvasAssetsIntoTarget,
  mergeCanvasNodesIntoFolder,
  snapCanvasRect,
} from "../src/lib/canvasLogic.ts";

test("new material snaps to the stationary material edge", () => {
  const result = snapCanvasRect(
    { x: 109, y: 20, width: 80, height: 60 },
    [{ id: "first", order: 1, rect: { x: 0, y: 0, width: 100, height: 100 } }],
  );
  assert.equal(result.x, 100);
  assert.deepEqual(result.guides, [{ axis: "x", position: 100 }]);
});

test("adjacent material can snap both the touching edge and the aligned top", () => {
  const result = snapCanvasRect(
    { x: 109, y: 5, width: 80, height: 60 },
    [{ id: "first", order: 1, rect: { x: 0, y: 0, width: 100, height: 100 } }],
  );
  assert.deepEqual({ x: result.x, y: result.y }, { x: 100, y: 0 });
  assert.deepEqual(result.guides, [
    { axis: "x", position: 100 },
    { axis: "y", position: 0 },
  ]);
});

test("equal-distance snap prefers the material that entered first", () => {
  const result = snapCanvasRect(
    { x: 102, y: 10, width: 60, height: 60 },
    [
      { id: "later", order: 2, rect: { x: 0, y: 0, width: 100, height: 80 } },
      { id: "earlier", order: 1, rect: { x: 104, y: 0, width: 60, height: 80 } },
    ],
  );
  assert.equal(result.x, 104);
});

test("material outside the threshold is not pulled across the canvas", () => {
  const result = snapCanvasRect(
    { x: 130, y: 10, width: 60, height: 60 },
    [{ id: "first", order: 1, rect: { x: 0, y: 0, width: 100, height: 80 } }],
  );
  assert.equal(result.x, 130);
  assert.deepEqual(result.guides, []);
});

test("hover grouping chooses the topmost visible target", () => {
  const target = findCanvasHoverTarget(
    { x: 50, y: 50 },
    [
      { id: "older", order: 1, rect: { x: 0, y: 0, width: 100, height: 100 } },
      { id: "newer", order: 2, rect: { x: 20, y: 20, width: 100, height: 100 } },
    ],
  );
  assert.equal(target?.id, "newer");
});

test("infinite-canvas zoom remains inside usable bounds", () => {
  assert.equal(clampCanvasZoom(0.1), 0.35);
  assert.equal(clampCanvasZoom(3), 2.4);
  assert.equal(clampCanvasZoom(1.25), 1.25);
});

test("canvas pans only with middle button or space plus left button", () => {
  assert.equal(isCanvasPanGesture(0, false), false);
  assert.equal(isCanvasPanGesture(0, true), true);
  assert.equal(isCanvasPanGesture(1, false), true);
  assert.equal(isCanvasPanGesture(2, true), false);
});

test("a small pointer wobble remains a click instead of moving the node", () => {
  assert.equal(exceedsCanvasDragThreshold({ x: 10, y: 10 }, { x: 12, y: 12 }), false);
  assert.equal(exceedsCanvasDragThreshold({ x: 10, y: 10 }, { x: 14, y: 10 }), true);
});

test("one-second internal hover creates a folder at the stationary target", () => {
  const nodes = [
    { kind: "asset", id: "fixed", asset: { id: "a" }, x: 20, y: 30, width: 100, height: 90, order: 1 },
    { kind: "asset", id: "moving", asset: { id: "b" }, x: 200, y: 220, width: 100, height: 90, order: 2 },
  ];
  const grouped = mergeCanvasNodesIntoFolder(nodes, "moving", "fixed", "folder", { width: 204, height: 178 });
  assert.equal(grouped.length, 1);
  assert.deepEqual(grouped[0], {
    kind: "folder",
    id: "folder",
    x: 20,
    y: 30,
    width: 204,
    height: 178,
    order: 1,
    assets: [{ id: "a" }, { id: "b" }],
  });
});

test("direct drop into a folder adds material without waiting or duplicating items", () => {
  const nodes = [
    {
      kind: "folder",
      id: "folder",
      assets: [{ id: "a" }],
      x: 20,
      y: 30,
      width: 204,
      height: 178,
      order: 1,
    },
  ];
  const grouped = mergeCanvasAssetsIntoTarget(
    nodes,
    "folder",
    [{ id: "a" }, { id: "b" }],
    "unused",
    { width: 204, height: 178 },
  );
  assert.deepEqual(grouped[0].assets, [{ id: "a" }, { id: "b" }]);
});

test("direct internal drop moves the material into the existing folder", () => {
  const nodes = [
    {
      kind: "folder",
      id: "folder",
      assets: [{ id: "a" }],
      x: 20,
      y: 30,
      width: 204,
      height: 178,
      order: 1,
    },
    { kind: "asset", id: "moving", asset: { id: "b" }, x: 200, y: 220, width: 100, height: 90, order: 2 },
  ];
  const grouped = mergeCanvasNodesIntoFolder(nodes, "moving", "folder", "unused", { width: 204, height: 178 });
  assert.equal(grouped.length, 1);
  assert.deepEqual(grouped[0].assets, [{ id: "a" }, { id: "b" }]);
});
