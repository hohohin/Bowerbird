type DockAnchor = { top: number; right: number; bottom: number };
export type ToolbarSize = { width: number; height: number };

const GAP = 8;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/** Dock in viewport coordinates. The caller owns measurement and visibility. */
export function floatingToolbarPosition(anchor: DockAnchor, toolbar: ToolbarSize, viewport: ToolbarSize) {
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - toolbar.height;
  const maxTop = viewport.height - GAP - toolbar.height;
  const fitsBelow = below <= maxTop;
  const fitsAbove = above >= GAP;
  const left = anchor.right - toolbar.width - (fitsBelow || fitsAbove ? 0 : GAP);
  return {
    left: clamp(left, GAP, viewport.width - GAP - toolbar.width),
    top: clamp(fitsBelow ? below : fitsAbove ? above : anchor.bottom - GAP - toolbar.height, GAP, maxTop),
  };
}
