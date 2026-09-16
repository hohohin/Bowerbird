import test from "node:test";
import assert from "node:assert/strict";
import {
  canvasNodeIdsInRect,
  canvasPrimaryMaterialAction,
  canvasViewForNewCard,
  canvasPlacementForNewCard,
  canvasRectFromPoints,
  canStartCanvasMarquee,
  clampCanvasZoom,
  exceedsCanvasDragThreshold,
  findCanvasHoverTarget,
  isCanvasPanGesture,
  mergeCanvasAssetsIntoTarget,
  mergeCanvasNodesIntoFolder,
  snapCanvasRect,
  translateCanvasSelection,
} from "../src/lib/canvasLogic.ts";

test("new material snaps to the stationary material edge", () => {
  const result = snapCanvasRect(
    { x: 109, y: 40, width: 80, height: 20 },
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
    { x: 130, y: 40, width: 60, height: 10 },
    [{ id: "first", order: 1, rect: { x: 0, y: 0, width: 100, height: 80 } }],
  );
  assert.equal(result.x, 130);
  assert.deepEqual(result.guides, []);
});

test("spaced horizontal and vertical cards align both edges without closing the gap", () => {
  const anchors = [{ id: "anchor", order: 1, rect: { x: 0, y: 0, width: 100, height: 80 } }];
  assert.deepEqual(snapCanvasRect({ x: 500, y: 18, width: 100, height: 80 }, anchors), {
    x: 500, y: 0, guides: [{ axis: "y", position: 0 }, { axis: "y", position: 80 }],
  });
  assert.deepEqual(snapCanvasRect({ x: 18, y: 500, width: 100, height: 80 }, anchors), {
    x: 0, y: 500, guides: [{ axis: "x", position: 0 }, { axis: "x", position: 100 }],
  });
});

test("snap toggle preserves free placement and removes all guides", () => {
  const moving = { x: 110, y: 12, width: 100, height: 80 };
  assert.deepEqual(snapCanvasRect(moving, [{ id: "anchor", order: 1, rect: { x: 0, y: 0, width: 100, height: 80 } }], { enabled: false }), {
    x: 110, y: 12, guides: [],
  });
});

test("snap tolerance and alignment search distance remain constant on screen", () => {
  const anchors = [{ id: "anchor", order: 1, rect: { x: 0, y: 0, width: 100, height: 80 } }];
  for (const zoom of [0.1, 0.5, 1, 2.4]) {
    const moving = { x: 500 / zoom, y: 23 / zoom, width: 100, height: 80 };
    assert.equal(snapCanvasRect(moving, anchors, { zoom }).y, 0);
    assert.equal(snapCanvasRect({ ...moving, y: 25 / zoom }, anchors, { zoom }).y, 25 / zoom);
    assert.deepEqual(snapCanvasRect({ ...moving, x: 100 + 601 / zoom }, anchors, { zoom }).guides, []);
  }
});

test("different sizes show only edges that actually align", () => {
  const result = snapCanvasRect({ x: 500, y: 18, width: 100, height: 60 }, [
    { id: "anchor", order: 1, rect: { x: 0, y: 0, width: 100, height: 100 } },
  ]);
  assert.deepEqual(result.guides, [{ axis: "y", position: 0 }]);
});

test("horizontal and vertical alignment can use different stationary cards", () => {
  const result = snapCanvasRect({ x: 18, y: 20, width: 100, height: 80 }, [
    { id: "below", order: 1, rect: { x: 0, y: 500, width: 100, height: 80 } },
    { id: "right", order: 2, rect: { x: 500, y: 0, width: 100, height: 80 } },
  ]);
  assert.deepEqual(result, { x: 0, y: 0, guides: [
    { axis: "x", position: 0 }, { axis: "x", position: 100 },
    { axis: "y", position: 0 }, { axis: "y", position: 80 },
  ] });
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
  assert.equal(clampCanvasZoom(0.01), 0.1);
  assert.equal(clampCanvasZoom(0.1), 0.1);
  assert.equal(clampCanvasZoom(3), 2.4);
  assert.equal(clampCanvasZoom(1.25), 1.25);
});

test("canvas pans only with middle button or space plus left button", () => {
  assert.equal(isCanvasPanGesture(0, false), false);
  assert.equal(isCanvasPanGesture(0, true), true);
  assert.equal(isCanvasPanGesture(1, false), true);
  assert.equal(isCanvasPanGesture(2, true), false);
});

test("canvas primary click follows creation mode and marquee stays browse-only", () => {
  assert.equal(canvasPrimaryMaterialAction(false, false), "preview");
  assert.equal(canvasPrimaryMaterialAction(true, false), "compose");
  assert.equal(canvasPrimaryMaterialAction(false, true), "compose");
  assert.equal(canStartCanvasMarquee(0, false, false, false), true);
  assert.equal(canStartCanvasMarquee(0, true, false, false), false);
  assert.equal(canStartCanvasMarquee(0, false, false, true), false);
  assert.equal(canStartCanvasMarquee(1, false, false, false), false);
});

test("a small pointer wobble remains a click instead of moving the node", () => {
  assert.equal(exceedsCanvasDragThreshold({ x: 10, y: 10 }, { x: 12, y: 12 }), false);
  assert.equal(exceedsCanvasDragThreshold({ x: 10, y: 10 }, { x: 14, y: 10 }), true);
});

test("a reverse-drag marquee selects every intersecting canvas material", () => {
  const selection = canvasRectFromPoints({ x: 180, y: 140 }, { x: 40, y: 20 });
  assert.deepEqual(selection, { x: 40, y: 20, width: 140, height: 120 });
  assert.deepEqual(canvasNodeIdsInRect(selection, [
    { id: "inside", order: 1, rect: { x: 60, y: 40, width: 40, height: 40 } },
    { id: "touching", order: 2, rect: { x: 175, y: 110, width: 30, height: 30 } },
    { id: "outside", order: 3, rect: { x: 220, y: 170, width: 30, height: 30 } },
  ]), ["inside", "touching"]);
});

test("moving a marquee selection preserves its internal layout", () => {
  const nodes = [
    { id: "a", x: 10, y: 20 },
    { id: "b", x: 70, y: 95 },
    { id: "outside", x: 180, y: 40 },
  ];
  const moved = translateCanvasSelection(nodes, new Set(["a", "b"]), 35, -12);
  assert.deepEqual(moved, [
    { id: "a", x: 45, y: 8 },
    { id: "b", x: 105, y: 83 },
    { id: "outside", x: 180, y: 40 },
  ]);
  assert.deepEqual(
    { dx: moved[1].x - moved[0].x, dy: moved[1].y - moved[0].y },
    { dx: 60, dy: 75 },
  );
});

test("confirmed internal grouping creates a folder at the stationary target", () => {
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

test("new control cards preserve the view when fully visible", () => {
  assert.equal(canvasViewForNewCard(
    { x: 100, y: 100, width: 260, height: 148 },
    { x: 24, y: 72, width: 752, height: 504 },
    { x: 0, y: 0 }, 1,
  ), null);
});

test("off-screen control cards center inside the unobscured viewport at current zoom", () => {
  const card = { x: 1800, y: -900, width: 260, height: 148 };
  const viewport = { x: 24, y: 72, width: 420, height: 300 };
  const next = canvasViewForNewCard(card, viewport, { x: -200, y: 80 }, 0.8);
  assert.equal(next.zoom, 0.8);
  assert.equal(next.pan.x + (card.x + card.width / 2) * next.zoom, 234);
  assert.equal(next.pan.y + (card.y + card.height / 2) * next.zoom, 222);
  assert.equal(canvasViewForNewCard(card, viewport, next.pan, next.zoom), null);
});

test("large control cards zoom out to fit and respect the canvas zoom minimum", () => {
  const card = { x: 2000, y: 2000, width: 800, height: 600 };
  const viewport = { x: 24, y: 72, width: 400, height: 300 };
  const next = canvasViewForNewCard(card, viewport, { x: 0, y: 0 }, 2);
  assert.equal(next.zoom, 0.5);
  assert.equal(canvasViewForNewCard(card, viewport, next.pan, next.zoom), null);
  assert.equal(canvasViewForNewCard(card, { ...viewport, width: 50, height: 50 }, { x: 0, y: 0 }, 1).zoom, 0.1);
  assert.equal(canvasViewForNewCard(card, { ...viewport, width: 0 }, { x: 0, y: 0 }, 1), null);
});

test("new cards prefer the current viewport without changing pan or zoom", () => {
  const card = { x: 9000, y: 40, width: 260, height: 148 };
  const viewport = { x: 24, y: 72, width: 752, height: 504 };
  const pan = { x: -500, y: 150 };
  for (const zoom of [0.5, 1, 2]) {
    const position = canvasPlacementForNewCard(card, viewport, pan, zoom, []);
    assert.ok(position);
    assert.equal(canvasViewForNewCard({ ...card, ...position }, viewport, pan, zoom), null);
  }
});

test("new cards preserve an available visible position and avoid existing cards", () => {
  const viewport = { x: 0, y: 0, width: 600, height: 400 };
  const pan = { x: 0, y: 0 };
  const card = { x: 24, y: 24, width: 100, height: 100 };
  assert.deepEqual(canvasPlacementForNewCard(card, viewport, pan, 1, []), { x: 24, y: 24 });
  const obstacle = { x: 0, y: 0, width: 350, height: 400 };
  const position = canvasPlacementForNewCard(card, viewport, pan, 1, [obstacle]);
  assert.ok(position.x >= 366);
  assert.equal(canvasViewForNewCard({ ...card, ...position }, viewport, pan, 1), null);
});

test("repeated generation uses separate visible spaces before falling back to focus", () => {
  const viewport = { x: 24, y: 72, width: 600, height: 350 };
  const pan = { x: 0, y: 0 };
  const card = { x: 10000, y: 10000, width: 200, height: 120 };
  const occupied = [];
  for (let i = 0; i < 20; i++) {
    const position = canvasPlacementForNewCard(card, viewport, pan, 1, occupied);
    if (!position) break;
    const next = { ...card, ...position };
    assert.equal(canvasViewForNewCard(next, viewport, pan, 1), null);
    for (const other of occupied) {
      assert.ok(next.x >= other.x + other.width + 16 || next.x + next.width + 16 <= other.x
        || next.y >= other.y + other.height + 16 || next.y + next.height + 16 <= other.y);
    }
    occupied.push(next);
  }
  assert.ok(occupied.length >= 2);
  assert.equal(canvasPlacementForNewCard(card, viewport, pan, 1, occupied), null);
  assert.equal(canvasPlacementForNewCard({ ...card, width: 700 }, viewport, pan, 1, []), null);
});
