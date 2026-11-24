export const DRAFT_BRUSH_MIN_SIZE = .5;
export const DRAFT_BRUSH_MAX_SIZE = 500;
export const DRAFT_BRUSH_SIZE_STEP = .5;

export function normalizeDraftBrushSize(value: number, fallback = 16): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(DRAFT_BRUSH_MAX_SIZE, Math.max(DRAFT_BRUSH_MIN_SIZE, Math.round(value / DRAFT_BRUSH_SIZE_STEP) * DRAFT_BRUSH_SIZE_STEP));
}

/** Half-pixel changes for fine work; keep the existing proportional shortcuts for larger tips. */
export function stepDraftBrushSize(value: number, direction: -1 | 1): number {
  const current = normalizeDraftBrushSize(value);
  return normalizeDraftBrushSize(current <= 4 ? current + direction * DRAFT_BRUSH_SIZE_STEP : current * (direction < 0 ? .8 : 1.25));
}
