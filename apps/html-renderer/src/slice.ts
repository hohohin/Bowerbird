/**
 * 确定性纵向切片计划 —— HTML-RENDER-PLAN.md §2.3 / H1-T4。
 *
 * 固定规则（全部为整数运算，dsf ∈ {1,2} 时 css→device 恒为整数，无舍入歧义）：
 *   - devicePx = cssPx × dsf；
 *   - 切片高 sliceHeightDev = sliceHeightCssPx × dsf，重叠 overlapDev = overlapCssPx × dsf；
 *   - 第 i 片 y = i × (sliceHeightDev − overlapDev)，x=0，宽 = 文档设备宽；
 *   - 每片高 = min(sliceHeightDev, docHeightDev − y)：最后一片允许不足高，但至少 1px；
 *   - overlap=0 时各片高度之和恰等于 docHeightDev（逐像素复原验收的依据）；
 *   - 超过 maxSliceCount → render_document_too_large（不降级为滚动拼接）。
 */
import { RENDER_LIMITS } from "./limits.ts";
import type { DeviceRect, RenderCaptureMode } from "./contracts.ts";
import type { RenderErrorDetail } from "./errors.ts";

export type SlicePlanClip = {
  role: "viewport_screenshot" | "full_page_screenshot" | "slice_screenshot";
  index?: number;
  rect: DeviceRect;
};

export type SlicePlan = {
  mode: RenderCaptureMode;
  clips: SlicePlanClip[];
};

export function cssToDevicePx(cssPx: number, deviceScaleFactor: 1 | 2): number {
  return cssPx * deviceScaleFactor;
}

/**
 * 依据**实际整页 PNG 的设备像素尺寸**计算截图/切片计划。
 *
 * viewport 模式：单 clip 固定视口区域。
 * full_page：单 clip 覆盖整页。
 * full_page_and_slices：1 个整页 clip + N 个切片 clip（同一像素结果的裁切窗口）。
 */
export function computeCapturePlan(params: {
  mode: RenderCaptureMode;
  deviceScaleFactor: 1 | 2;
  viewportWidthCssPx: number;
  viewportHeightCssPx: number;
  documentWidthDevicePx: number;
  documentHeightDevicePx: number;
  sliceHeightCssPx?: number;
  overlapCssPx?: number;
}): SlicePlan | RenderErrorDetail {
  const { mode, deviceScaleFactor } = params;
  const documentWidthDevicePx = params.documentWidthDevicePx;
  const documentHeightDevicePx = params.documentHeightDevicePx;
  if (!Number.isInteger(documentWidthDevicePx) || !Number.isInteger(documentHeightDevicePx) || documentWidthDevicePx <= 0 || documentHeightDevicePx <= 0) {
    return { code: "render_output_invalid", reason: "document_device_px_not_positive_integer" };
  }
  if (documentWidthDevicePx * documentHeightDevicePx > RENDER_LIMITS.maxDevicePixels) {
    return { code: "render_document_too_large", reason: "device_pixels_exceed_limit" };
  }

  if (mode === "viewport") {
    const rect: DeviceRect = {
      x: 0,
      y: 0,
      width: cssToDevicePx(params.viewportWidthCssPx, deviceScaleFactor),
      height: cssToDevicePx(params.viewportHeightCssPx, deviceScaleFactor),
    };
    return { mode, clips: [{ role: "viewport_screenshot", rect }] };
  }

  const fullClip: SlicePlanClip = {
    role: "full_page_screenshot",
    rect: { x: 0, y: 0, width: documentWidthDevicePx, height: documentHeightDevicePx },
  };
  if (mode === "full_page") {
    return { mode, clips: [fullClip] };
  }

  // full_page_and_slices
  if (typeof params.sliceHeightCssPx !== "number") {
    return { code: "render_input_invalid", reason: "slice_height_missing" };
  }
  const overlapCssPx = params.overlapCssPx ?? 0;
  const sliceHeightDev = cssToDevicePx(params.sliceHeightCssPx, deviceScaleFactor);
  const overlapDev = cssToDevicePx(overlapCssPx, deviceScaleFactor);
  const step = sliceHeightDev - overlapDev;
  if (step <= 0) return { code: "render_input_invalid", reason: "slice_step_not_positive" };

  const clips: SlicePlanClip[] = [fullClip];
  let index = 1;
  let y = 0;
  while (y < documentHeightDevicePx) {
    const height = Math.min(sliceHeightDev, documentHeightDevicePx - y);
    if (height <= 0) break;
    clips.push({
      role: "slice_screenshot",
      index,
      rect: { x: 0, y, width: documentWidthDevicePx, height },
    });
    index += 1;
    if (clips.length - 1 > RENDER_LIMITS.maxSliceCount) {
      return { code: "render_document_too_large", reason: "slice_count_exceeds_limit" };
    }
    // 固定的最后一片规则：本片已覆盖到文档底部即停止（overlap>0 时不产冗余尾巴片）。
    if (y + height >= documentHeightDevicePx) break;
    y += step;
  }
  return { mode, clips };
}

/** 验收辅助：overlap=0 时切片高度之和应恰等于整页高。 */
export function sumSliceHeights(plan: SlicePlan): number {
  let sum = 0;
  for (const clip of plan.clips) {
    if (clip.role === "slice_screenshot") sum += clip.rect.height;
  }
  return sum;
}
