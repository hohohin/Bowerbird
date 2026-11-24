import type { DraftRect } from "./draftDocument";

export type DraftCropHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "move";
const MAX_SIDE = 4096;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function checkedRect(rect: DraftRect): DraftRect {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width < 1 || rect.height < 1) {
    throw new Error("裁剪范围无效");
  }
  return { x: Math.round(rect.x), y: Math.round(rect.y),
    width: clamp(Math.round(rect.width), 1, MAX_SIDE), height: clamp(Math.round(rect.height), 1, MAX_SIDE) };
}

function checkedRatio(ratio: number | null): number | null {
  if (ratio !== null && (!Number.isFinite(ratio) || ratio < 1 / MAX_SIDE || ratio > MAX_SIDE)) {
    throw new Error("裁剪比例无效");
  }
  return ratio;
}

function sizeFromWidth(width: number, ratio: number): { width: number; height: number } {
  const limited = clamp(width, Math.max(1, ratio), Math.min(MAX_SIDE, MAX_SIDE * ratio));
  return { width: clamp(Math.round(limited), 1, MAX_SIDE), height: clamp(Math.round(limited / ratio), 1, MAX_SIDE) };
}

/** Fit a ratio inside the existing box, retaining its centre to the nearest document pixel. */
export function fitDraftCropRatio(rect: DraftRect, ratio: number | null): DraftRect {
  const start = checkedRect(rect); checkedRatio(ratio);
  if (ratio === null) return start;
  const width = Math.max(1, Math.floor(Math.min(start.width, start.height * ratio)));
  const height = Math.max(1, Math.floor(Math.min(start.height, start.width / ratio)));
  return { x: Math.round(start.x + (start.width - width) / 2), y: Math.round(start.y + (start.height - height) / 2), width, height };
}

/** Resize around the opposite corner/edge centre; crossing an anchor stops at one pixel. */
export function resizeDraftCrop(rect: DraftRect, handle: DraftCropHandle, dx: number, dy: number, ratio: number | null): DraftRect {
  const start = checkedRect(rect); checkedRatio(ratio);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error("裁剪位置无效");
  if (handle === "move") return { ...start, x: Math.round(start.x + dx), y: Math.round(start.y + dy) };
  const west = handle.includes("w"), east = handle.includes("e"), north = handle.includes("n"), south = handle.includes("s");
  const horizontal = west || east, vertical = north || south;
  let width = start.width + (west ? -dx : east ? dx : 0);
  let height = start.height + (north ? -dy : south ? dy : 0);
  if (ratio !== null) {
    const widthDrives = horizontal && (!vertical || Math.abs(dx) >= Math.abs(dy * ratio));
    ({ width, height } = sizeFromWidth(widthDrives ? width : height * ratio, ratio));
  } else {
    width = clamp(Math.round(width), 1, MAX_SIDE); height = clamp(Math.round(height), 1, MAX_SIDE);
  }
  return { x: Math.round(west ? start.x + start.width - width : east ? start.x : start.x + (start.width - width) / 2),
    y: Math.round(north ? start.y + start.height - height : south ? start.y : start.y + (start.height - height) / 2), width, height };
}

/** Numeric size edits keep the top-left anchor; a locked ratio follows the edited dimension. */
export function setDraftCropSize(rect: DraftRect, axis: "width" | "height", value: number, ratio: number | null): DraftRect {
  const start = checkedRect(rect); checkedRatio(ratio);
  if (!Number.isFinite(value)) throw new Error("裁剪尺寸无效");
  const size = ratio === null ? { width: start.width, height: start.height, [axis]: clamp(Math.round(value), 1, MAX_SIDE) }
    : sizeFromWidth(axis === "width" ? value : value * ratio, ratio);
  return { x: start.x, y: start.y, ...size };
}
