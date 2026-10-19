export type ThumbnailScope = "library" | "canvas" | "projects";
export const MIN_THUMBNAIL_WIDTH = 96;
export const MAX_THUMBNAIL_WIDTH = 320;

export function minThumbnailWidth(scope: ThumbnailScope): number {
  return scope === "canvas" ? 48 : MIN_THUMBNAIL_WIDTH;
}

export function clampThumbnailWidth(value: number, scope: ThumbnailScope): number {
  return Math.min(MAX_THUMBNAIL_WIDTH, Math.max(minThumbnailWidth(scope), Math.round(value)));
}

export function thumbnailZoomFromWidth(value: number, scope: ThumbnailScope): number {
  const min = minThumbnailWidth(scope);
  return Math.round((clampThumbnailWidth(value, scope) - min) / (MAX_THUMBNAIL_WIDTH - min) * 100);
}

export function thumbnailWidthFromZoom(value: number, scope: ThumbnailScope): number {
  const min = minThumbnailWidth(scope);
  const zoom = Math.max(0, Math.min(100, Math.round(value)));
  return clampThumbnailWidth(min + (MAX_THUMBNAIL_WIDTH - min) * zoom / 100, scope);
}

export function readThumbnailWidth(scope: ThumbnailScope): number {
  const fallback = scope === "canvas" ? 160 : 200;
  try {
    const stored = Number(localStorage.getItem(`bowerbird.${scope}ThumbnailWidth`));
    if (Number.isFinite(stored) && stored > 0) return clampThumbnailWidth(stored, scope);
    if (scope === "canvas") {
      const legacyScale = Number(localStorage.getItem("bowerbird.canvasSourceThumbnailScale"));
      if (legacyScale >= 1 && legacyScale <= 3) return [104, 160, 208][Math.round(legacyScale) - 1];
    }
  } catch { /* Keep the default when local preferences are unavailable. */ }
  return fallback;
}

export function saveThumbnailWidth(scope: ThumbnailScope, value: number): number {
  const width = Number.isFinite(value) ? clampThumbnailWidth(value, scope) : readThumbnailWidth(scope);
  try { localStorage.setItem(`bowerbird.${scope}ThumbnailWidth`, String(width)); }
  catch { /* The slider remains usable without persistent storage. */ }
  return width;
}
