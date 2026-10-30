import test from "node:test";
import assert from "node:assert/strict";
import { prepareCanvasSnapAnchors, snapCanvasRectPrepared, snapCanvasRect, findCanvasHoverTarget } from "../src/lib/canvasLogic.ts";

// Frozen pre-optimization algorithm: keep independent of the prepared implementation.
function oldSnap(moving, anchors, options = {}) {
  if (options.enabled === false) return { x: moving.x, y: moving.y, guides: [] };
  const zoom = options.zoom ?? 1, threshold = 24 / zoom, range = 600 / zoom;
  const ordered = [...anchors].sort((a, b) => a.order - b.order);
  let bestX = null, bestY = null;
  function overlaps(aStart, aLength, bStart, bLength, tolerance) {
    return Math.min(aStart + aLength, bStart + bLength) - Math.max(aStart, bStart) >= -tolerance;
  }
  function takeX(value, rect) {
    const distance = Math.abs(moving.x - value);
    if (distance > threshold) return;
    if (!bestX || distance < bestX.distance) bestX = { distance, value, rect };
  }
  function takeY(value, rect) {
    const distance = Math.abs(moving.y - value);
    if (distance > threshold) return;
    if (!bestY || distance < bestY.distance) bestY = { distance, value, rect };
  }
  for (const anchor of ordered) {
    const rect = anchor.rect;
    if (overlaps(moving.y, moving.height, rect.y, rect.height, threshold)) {
      takeX(rect.x + rect.width, rect);
      takeX(rect.x - moving.width, rect);
    }
    if (overlaps(moving.y, moving.height, rect.y, rect.height, range)) {
      takeX(rect.x, rect);
      takeX(rect.x + rect.width - moving.width, rect);
    }
    if (overlaps(moving.x, moving.width, rect.x, rect.width, threshold)) {
      takeY(rect.y + rect.height, rect);
      takeY(rect.y - moving.height, rect);
    }
    if (overlaps(moving.x, moving.width, rect.x, rect.width, range)) {
      takeY(rect.y, rect);
      takeY(rect.y + rect.height - moving.height, rect);
    }
  }
  function guides(axis, snap) {
    if (!snap) return [];
    const dimension = axis === "x" ? "width" : "height";
    const ends = [snap.value, snap.value + moving[dimension]];
    return [snap.rect[axis], snap.rect[axis] + snap.rect[dimension]]
      .filter(position => ends.some(end => Math.abs(end - position) < 0.001))
      .map(position => ({ axis, position }));
  }
  return { x: bestX?.value ?? moving.x, y: bestY?.value ?? moving.y,
    guides: [...guides("x", bestX), ...guides("y", bestY)] };
}

function oldHover(point, anchors, excludedId) {
  return [...anchors].sort((a, b) => b.order - a.order).find(anchor => anchor.id !== excludedId
    && point.x >= anchor.rect.x && point.x <= anchor.rect.x + anchor.rect.width
    && point.y >= anchor.rect.y && point.y <= anchor.rect.y + anchor.rect.height) ?? null;
}

function random(seed) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
}

test("prepared snaps match the original over randomized drag paths and stable order ties", () => {
  const next = random(0x1433abcd);
  for (let scene = 0; scene < 50; scene++) {
    const anchors = Array.from({ length: scene * 3 }, (_, index) => ({ id: `node-${index}`,
      order: Math.floor(next() * 9) - 4,
      rect: { x: next() * 2400 - 1200, y: next() * 2400 - 1200, width: next() * 300, height: next() * 300 } }));
    const original = structuredClone(anchors);
    const prepared = prepareCanvasSnapAnchors(anchors);
    for (let frame = 0; frame < 50; frame++) {
      const moving = { x: next() * 2400 - 1200, y: next() * 2400 - 1200, width: next() * 300, height: next() * 300 };
      const options = { zoom: [0.1, 0.25, 0.5, 1, 1.75, 2.4][frame % 6], enabled: frame % 11 !== 0 };
      const expected = oldSnap(moving, anchors, options);
      assert.deepEqual(snapCanvasRectPrepared(moving, prepared, options), expected);
      assert.deepEqual(snapCanvasRect(moving, anchors, options), expected);
      const excluded = frame % 3 === 0 ? anchors[Math.floor(next() * anchors.length)]?.id : undefined;
      assert.equal(findCanvasHoverTarget(moving, anchors, excluded), oldHover(moving, anchors, excluded));
    }
    assert.deepEqual(anchors, original);
  }
});

test("prepared snapping preserves exact capture, range and guide boundaries at every zoom", () => {
  const anchors = [{ id: "a", order: 1, rect: { x: -50, y: -40, width: 100, height: 80 } }];
  const prepared = prepareCanvasSnapAnchors(anchors);
  for (const zoom of [0.1, 0.5, 1, 2.4]) {
    for (const epsilon of [-0.001, 0, 0.001]) {
      for (const offset of [0, 24 / zoom, 600 / zoom]) {
        for (const direction of [-1, 1]) {
          const x = 50 + direction * (offset + epsilon);
          for (const moving of [{ x, y: -35, width: 100, height: 80 }, { x: -45, y: x, width: 100, height: 80 },
            { x, y: -40 + 24 / zoom + epsilon, width: 0, height: 0 }]) {
            assert.deepEqual(snapCanvasRectPrepared(moving, prepared, { zoom }), oldSnap(moving, anchors, { zoom }));
          }
        }
      }
    }
  }
});

test("prepared snapshot keeps equal-order precedence and is unaffected by later source edits", () => {
  const moving = { x: 102, y: 10, width: 60, height: 60 };
  const anchors = [
    { id: "first", order: 4, rect: { x: 104, y: 0, width: 60, height: 80 } },
    { id: "second", order: 4, rect: { x: 0, y: 0, width: 100, height: 80 } },
  ];
  const prepared = prepareCanvasSnapAnchors(anchors);
  const expected = oldSnap(moving, anchors);
  assert.equal(expected.x, 104);
  anchors.reverse(); anchors[1].rect.x = 900; anchors[1].order = -50;
  assert.deepEqual(snapCanvasRectPrepared(moving, prepared), expected);
  assert.deepEqual(snapCanvasRectPrepared(moving, prepared, { enabled: false }), { x: moving.x, y: moving.y, guides: [] });
  assert.deepEqual(snapCanvasRectPrepared(moving, prepareCanvasSnapAnchors([])), { x: moving.x, y: moving.y, guides: [] });
});

test("hover keeps top order, input identity, inclusive edges and first equal-order match", () => {
  const rect = Object.freeze({ x: 0, y: 0, width: 100, height: 80 });
  const anchors = Object.freeze([
    Object.freeze({ id: "first", order: 2, rect }),
    Object.freeze({ id: "second", order: 2, rect }),
    Object.freeze({ id: "lower", order: -1, rect }),
    Object.freeze({ id: "upper", order: 3, rect }),
  ]);
  for (const point of [{ x: 0, y: 0 }, { x: 100, y: 80 }, { x: -0.001, y: 0 }, { x: 100.001, y: 80 }]) {
    for (const excluded of [undefined, "upper", "first", "absent"]) {
      assert.equal(findCanvasHoverTarget(point, anchors, excluded), oldHover(point, anchors, excluded));
    }
  }
  assert.equal(findCanvasHoverTarget({ x: 50, y: 50 }, anchors, "upper"), anchors[0]);
  assert.deepEqual(prepareCanvasSnapAnchors(anchors).ordered.map(anchor => anchor.id), ["lower", "first", "second", "upper"]);
});
