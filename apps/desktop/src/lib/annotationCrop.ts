export type CropRect = { x1: number; y1: number; x2: number; y2: number };
type Point = { x: number; y: number };
type CropMinimum = { mw: number; mh: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function fitCropRatio(rect: CropRect, ratio: number, min: CropMinimum): CropRect {
  const maxWidth = Math.min(1, ratio);
  const width = clamp(Math.min(rect.x2 - rect.x1, (rect.y2 - rect.y1) * ratio),
    Math.max(min.mw, min.mh * ratio), maxWidth);
  const height = width / ratio;
  const x1 = clamp((rect.x1 + rect.x2 - width) / 2, 0, 1 - width);
  const y1 = clamp((rect.y1 + rect.y2 - height) / 2, 0, 1 - height);
  return { x1, y1, x2: x1 + width, y2: y1 + height };
}

function cropFromCorner(anchor: Point, p: Point, ratio: number, sx: number, sy: number, minWidth: number): CropRect {
  const maxWidth = Math.min(sx > 0 ? 1 - anchor.x : anchor.x, (sy > 0 ? 1 - anchor.y : anchor.y) * ratio);
  const width = clamp(Math.max((p.x - anchor.x) * sx, (p.y - anchor.y) * sy * ratio), minWidth, maxWidth);
  return { x1: anchor.x, y1: anchor.y, x2: anchor.x + sx * width, y2: anchor.y + sy * width / ratio };
}

export function drawLockedCrop(anchor: Point, p: Point, ratio: number) {
  return cropFromCorner(anchor, p, ratio, p.x < anchor.x ? -1 : 1, p.y < anchor.y ? -1 : 1, 0);
}

/** Resizing an edge keeps its opposite edge and the perpendicular center fixed. */
export function resizeLockedCrop(rect: CropRect, handle: string, p: Point, ratio: number, min: CropMinimum): CropRect {
  const sx = handle.includes("w") ? -1 : handle.includes("e") ? 1 : 0;
  const sy = handle.includes("n") ? -1 : handle.includes("s") ? 1 : 0;
  const minWidth = Math.max(min.mw, min.mh * ratio);
  const x = sx < 0 ? rect.x2 : rect.x1;
  const y = sy < 0 ? rect.y2 : rect.y1;
  if (sx && sy) {
    const raw = cropFromCorner({ x, y }, p, ratio, sx, sy, minWidth);
    return { x1: Math.min(raw.x1, raw.x2), y1: Math.min(raw.y1, raw.y2), x2: Math.max(raw.x1, raw.x2), y2: Math.max(raw.y1, raw.y2) };
  }
  if (sx) {
    const cy = (rect.y1 + rect.y2) / 2;
    const maxWidth = Math.min(sx > 0 ? 1 - x : x, 2 * Math.min(cy, 1 - cy) * ratio);
    const width = clamp((p.x - x) * sx, minWidth, maxWidth);
    const halfHeight = width / ratio / 2;
    return { x1: sx < 0 ? x - width : x, x2: sx > 0 ? x + width : x, y1: cy - halfHeight, y2: cy + halfHeight };
  }
  const cx = (rect.x1 + rect.x2) / 2;
  const maxHeight = Math.min(sy > 0 ? 1 - y : y, 2 * Math.min(cx, 1 - cx) / ratio);
  const height = clamp((p.y - y) * sy, minWidth / ratio, maxHeight);
  const halfWidth = height * ratio / 2;
  return { x1: cx - halfWidth, x2: cx + halfWidth, y1: sy < 0 ? y - height : y, y2: sy > 0 ? y + height : y };
}
