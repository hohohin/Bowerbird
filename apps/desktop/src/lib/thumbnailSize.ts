export type ThumbnailScope = "library" | "canvas";
export const MIN_THUMBNAIL_WIDTH = 96;
export const MAX_THUMBNAIL_WIDTH = 320;

export function clampThumbnailWidth(value: number): number {
  return Math.min(MAX_THUMBNAIL_WIDTH, Math.max(MIN_THUMBNAIL_WIDTH, Math.round(value / 8) * 8));
}

export function readThumbnailWidth(scope: ThumbnailScope): number {
  const fallback = scope === "library" ? 200 : 160;
  try {
    const stored = Number(localStorage.getItem(`bowerbird.${scope}ThumbnailWidth`));
    if (Number.isFinite(stored) && stored > 0) return clampThumbnailWidth(stored);
    if (scope === "canvas") {
      const legacyScale = Number(localStorage.getItem("bowerbird.canvasSourceThumbnailScale"));
      if (legacyScale >= 1 && legacyScale <= 3) return [104, 160, 208][Math.round(legacyScale) - 1];
    }
  } catch { /* Keep the default when local preferences are unavailable. */ }
  return fallback;
}

export function saveThumbnailWidth(scope: ThumbnailScope, value: number): number {
  const width = Number.isFinite(value) ? clampThumbnailWidth(value) : readThumbnailWidth(scope);
  try { localStorage.setItem(`bowerbird.${scope}ThumbnailWidth`, String(width)); }
  catch { /* The slider remains usable without persistent storage. */ }
  return width;
}
