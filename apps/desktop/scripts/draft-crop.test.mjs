import assert from "node:assert/strict";
import test from "node:test";
import { fitDraftCropRatio, resizeDraftCrop, setDraftCropSize } from "../src/lib/draftCrop.ts";

test("free crop handles keep opposite anchors while allowing outward extension", () => {
  const rect = { x: 10, y: 20, width: 100, height: 80 };
  const expected = {
    nw: { x: -10, y: -10, width: 120, height: 110 }, n: { x: 10, y: -10, width: 100, height: 110 },
    ne: { x: 10, y: -10, width: 80, height: 110 }, e: { x: 10, y: 20, width: 80, height: 80 },
    se: { x: 10, y: 20, width: 80, height: 50 }, s: { x: 10, y: 20, width: 100, height: 50 },
    sw: { x: -10, y: 20, width: 120, height: 50 }, w: { x: -10, y: 20, width: 120, height: 80 },
    move: { x: -10, y: -10, width: 100, height: 80 },
  };
  for (const [handle, target] of Object.entries(expected)) assert.deepEqual(resizeDraftCrop(rect, handle, -20, -30, null), target, handle);
  assert.deepEqual(rect, { x: 10, y: 20, width: 100, height: 80 });
  assert.deepEqual(resizeDraftCrop(rect, "nw", 1000, 1000, null), { x: 109, y: 99, width: 1, height: 1 });
});

test("fixed-ratio handles preserve the opposite corner or edge midpoint", () => {
  const rect = { x: 0, y: 0, width: 160, height: 90 }, ratio = 16 / 9;
  assert.deepEqual(resizeDraftCrop(rect, "nw", -160, -90, ratio), { x: -160, y: -90, width: 320, height: 180 });
  assert.deepEqual(resizeDraftCrop(rect, "se", 160, 90, ratio), { x: 0, y: 0, width: 320, height: 180 });
  assert.deepEqual(resizeDraftCrop(rect, "w", -160, 1000, ratio), { x: -160, y: -45, width: 320, height: 180 });
  assert.deepEqual(resizeDraftCrop(rect, "n", 1000, -90, ratio), { x: -80, y: -90, width: 320, height: 180 });
  assert.deepEqual(resizeDraftCrop(rect, "move", -4, 9, ratio), { ...rect, x: -4, y: 9 });
  const inward = resizeDraftCrop(rect, "se", -80, 0, ratio);
  assert.deepEqual(inward, { x: 0, y: 0, width: 80, height: 45 }, "horizontal inward drags can shrink a locked corner");
});

test("ratio presets fit inside the selection and numeric dimensions retain the top-left anchor", () => {
  const rect = { x: -40, y: -20, width: 160, height: 120 };
  assert.deepEqual(fitDraftCropRatio(rect, 1), { x: -20, y: -20, width: 120, height: 120 });
  assert.deepEqual(fitDraftCropRatio(rect, 16 / 9), { x: -40, y: -5, width: 160, height: 90 });
  assert.deepEqual(fitDraftCropRatio(rect, null), rect);
  assert.deepEqual(setDraftCropSize(rect, "width", 320, 4 / 3), { ...rect, width: 320, height: 240 });
  assert.deepEqual(setDraftCropSize(rect, "height", 90, 16 / 9), { ...rect, height: 90 });
  assert.deepEqual(setDraftCropSize(rect, "width", 320, null), { ...rect, width: 320 });
});

test("all handles stay pixel-aligned and bounded across free, portrait, landscape and extreme ratios", () => {
  const rect = { x: -51, y: 17, width: 320, height: 240 };
  for (const ratio of [null, 1, 4 / 3, 9 / 16, 1 / 4096, 4096]) {
    for (const handle of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
      for (const [dx, dy] of [[-10000, 10000], [10000, -10000], [.3, -.7], [-10000, -10000], [10000, 10000]]) {
        const result = resizeDraftCrop(rect, handle, dx, dy, ratio);
        assert.ok(Object.values(result).every(Number.isInteger));
        assert.ok(result.width >= 1 && result.width <= 4096 && result.height >= 1 && result.height <= 4096);
        if (ratio !== null) assert.ok(Math.abs(result.width - result.height * ratio) <= Math.max(1, ratio), "ratio error is bounded by one pixel of rounding");
      }
    }
  }
  assert.deepEqual(resizeDraftCrop(rect, "se", 10000, 10000, null), { ...rect, width: 4096, height: 4096 });
  assert.throws(() => resizeDraftCrop(rect, "se", Infinity, 0, null), /位置无效/);
  for (const ratio of [NaN, 0, -1, Infinity, 5000]) assert.throws(() => fitDraftCropRatio(rect, ratio), /比例无效/);
  assert.throws(() => setDraftCropSize(rect, "width", NaN, null), /尺寸无效/);
});
