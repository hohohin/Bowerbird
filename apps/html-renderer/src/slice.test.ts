/**
 * 切片计划单测 —— H1-T4 / §2.3。
 * 覆盖：三种模式、dsf 1/2 整数换算、重叠、最后一片不足高、复原不变量、上限拒绝。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCapturePlan, cssToDevicePx, sumSliceHeights } from "./slice.ts";

test("cssToDevicePx is exact integer for dsf 1/2", () => {
  assert.equal(cssToDevicePx(1000, 1), 1000);
  assert.equal(cssToDevicePx(1000, 2), 2000);
});

test("viewport mode produces single fixed-viewport clip", () => {
  const plan = computeCapturePlan({
    mode: "viewport",
    deviceScaleFactor: 2,
    viewportWidthCssPx: 800,
    viewportHeightCssPx: 600,
    documentWidthDevicePx: 1600,
    documentHeightDevicePx: 4000,
  });
  assert.ok(!("code" in plan));
  const p = plan as { mode: string; clips: Array<{ role: string; rect: { x: number; y: number; width: number; height: number } }> };
  assert.equal(p.mode, "viewport");
  assert.equal(p.clips.length, 1);
  assert.equal(p.clips[0]!.role, "viewport_screenshot");
  assert.deepEqual(p.clips[0]!.rect, { x: 0, y: 0, width: 1600, height: 1200 });
});

test("full_page mode produces single full-document clip", () => {
  const plan = computeCapturePlan({
    mode: "full_page",
    deviceScaleFactor: 1,
    viewportWidthCssPx: 800,
    viewportHeightCssPx: 600,
    documentWidthDevicePx: 800,
    documentHeightDevicePx: 2500,
  });
  const p = plan as { clips: Array<{ role: string; rect: { width: number; height: number } }> };
  assert.equal(p.clips.length, 1);
  assert.equal(p.clips[0]!.role, "full_page_screenshot");
  assert.deepEqual(p.clips[0]!.rect, { width: 800, height: 2500, x: 0, y: 0 });
});

test("slices: overlap 0 reconstructs document height exactly", () => {
  const plan = computeCapturePlan({
    mode: "full_page_and_slices",
    deviceScaleFactor: 1,
    viewportWidthCssPx: 800,
    viewportHeightCssPx: 600,
    documentWidthDevicePx: 800,
    documentHeightDevicePx: 2600,
    sliceHeightCssPx: 1000,
  });
  const p = plan as { clips: Array<{ role: string; index?: number; rect: { x: number; y: number; width: number; height: number } }> };
  const slices = p.clips.filter((c) => c.role === "slice_screenshot");
  assert.equal(slices.length, 3);
  assert.deepEqual(slices.map((s) => s.rect.y), [0, 1000, 2000]);
  assert.deepEqual(slices.map((s) => s.rect.height), [1000, 1000, 600]);
  assert.deepEqual(slices.map((s) => s.index), [1, 2, 3]);
  assert.equal(sumSliceHeights(p as never), 2600);
});

test("slices: exact division leaves no zero-height tail", () => {
  const plan = computeCapturePlan({
    mode: "full_page_and_slices",
    deviceScaleFactor: 1,
    viewportWidthCssPx: 800,
    viewportHeightCssPx: 600,
    documentWidthDevicePx: 800,
    documentHeightDevicePx: 2000,
    sliceHeightCssPx: 1000,
  });
  const p = plan as { clips: Array<{ role: string; rect: { y: number; height: number } }> };
  const slices = p.clips.filter((c) => c.role === "slice_screenshot");
  assert.equal(slices.length, 2);
  assert.equal(sumSliceHeights(p as never), 2000);
});

test("slices: dsf 2 doubles device geometry", () => {
  const plan = computeCapturePlan({
    mode: "full_page_and_slices",
    deviceScaleFactor: 2,
    viewportWidthCssPx: 500,
    viewportHeightCssPx: 400,
    documentWidthDevicePx: 1000,
    documentHeightDevicePx: 2400,
    sliceHeightCssPx: 500,
    overlapCssPx: 0,
  });
  const p = plan as { clips: Array<{ role: string; rect: { y: number; height: number } }> };
  const slices = p.clips.filter((c) => c.role === "slice_screenshot");
  assert.deepEqual(slices.map((s) => s.rect.height), [1000, 1000, 400]);
});

test("slices: overlap shifts window start, last slice clamps", () => {
  const plan = computeCapturePlan({
    mode: "full_page_and_slices",
    deviceScaleFactor: 1,
    viewportWidthCssPx: 800,
    viewportHeightCssPx: 600,
    documentWidthDevicePx: 800,
    documentHeightDevicePx: 2500,
    sliceHeightCssPx: 1000,
    overlapCssPx: 200,
  });
  const p = plan as { clips: Array<{ role: string; rect: { y: number; height: number } }> };
  const slices = p.clips.filter((c) => c.role === "slice_screenshot");
  assert.deepEqual(slices.map((s) => s.rect.y), [0, 800, 1600]);
  assert.deepEqual(slices.map((s) => s.rect.height), [1000, 1000, 900]);
});

test("slices: exceeding max count fails with render_document_too_large", () => {
  const plan = computeCapturePlan({
    mode: "full_page_and_slices",
    deviceScaleFactor: 1,
    viewportWidthCssPx: 800,
    viewportHeightCssPx: 600,
    documentWidthDevicePx: 800,
    documentHeightDevicePx: 100_000,
    sliceHeightCssPx: 200,
  });
  assert.ok("code" in plan);
  assert.equal((plan as { code: string }).code, "render_document_too_large");
});

test("device pixel cap rejects oversized documents", () => {
  const plan = computeCapturePlan({
    mode: "full_page",
    deviceScaleFactor: 1,
    viewportWidthCssPx: 800,
    viewportHeightCssPx: 600,
    documentWidthDevicePx: 16_000,
    documentHeightDevicePx: 16_000, // 256 MP
  });
  assert.ok("code" in plan);
  assert.equal((plan as { code: string }).code, "render_document_too_large");
});
