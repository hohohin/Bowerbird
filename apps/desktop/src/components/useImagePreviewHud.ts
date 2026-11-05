import { useCallback, useEffect, useLayoutEffect, type RefObject } from "react";

type Rect = { left: number; top: number; right: number; bottom: number };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
const gap = 12;

/** Private to the image preview: keep screen-sized controls attached to an unbounded image. */
function placeRow(row: HTMLElement, image: Rect, safe: Rect, obstacles: Rect[], bottom: boolean) {
  const children = Array.from(row.children) as HTMLElement[];
  const heights = children.map(child => child.offsetHeight);
  const singleHeight = Math.max(...heights);
  const stackedHeight = bottom ? heights.reduce((sum, height) => sum + height, 8) : singleHeight;
  const minimumWidth = bottom ? children[1].offsetWidth : children[1].offsetWidth + 64;
  const fullWidth = children.reduce((sum, child) => sum + child.offsetWidth, gap);
  let best: { left: number; top: number; width: number; height: number; score: number } | undefined;

  for (const height of new Set([singleHeight, stackedHeight])) {
    const desiredY = bottom ? image.bottom + gap : image.top - gap - height;
    const candidates = [desiredY, safe.top, safe.bottom - height,
      ...obstacles.flatMap(rect => [rect.top - gap - height, rect.bottom + gap])];
    for (const candidate of candidates) {
      const top = clamp(candidate, safe.top, safe.bottom - height);
      let spans = [[safe.left, safe.right]];
      for (const rect of obstacles) {
        if (top + height <= rect.top || top >= rect.bottom) continue;
        spans = spans.flatMap(([left, right]) => rect.left >= right || rect.right <= left ? [[left, right]]
          : [[left, Math.min(right, rect.left - gap)], [Math.max(left, rect.right + gap), right]]);
      }
      for (const [left, right] of spans) {
        if (right - left < minimumWidth) continue;
        const width = clamp(image.right - image.left, minimumWidth, right - left);
        if ((bottom && width < fullWidth ? stackedHeight : singleHeight) !== height) continue;
        const x = clamp(image.left, left, right - width);
        const score = Math.abs(top - desiredY) * 3 + Math.abs(x - image.left) + Math.abs(x + width - image.right);
        if (!best || score < best.score) best = { left: x, top, width, height, score };
      }
    }
  }
  // Extremely short windows still retain reachable close/fit controls.
  const width = clamp(image.right - image.left, Math.min(minimumWidth, safe.right - safe.left), safe.right - safe.left);
  const height = bottom && width < fullWidth ? stackedHeight : singleHeight;
  const result = best ?? { left: clamp(image.left, safe.left, safe.right - width),
    top: clamp(bottom ? image.bottom + gap : image.top - gap - height, safe.top, safe.bottom - height), width, height };
  row.style.left = `${result.left}px`;
  row.style.top = `${result.top}px`;
  row.style.width = `${result.width}px`;
  return result;
}

export function useImagePreviewHud(surface: RefObject<HTMLDivElement>, image: RefObject<HTMLDivElement>,
  layout: RefObject<HTMLDivElement>, hud: RefObject<HTMLDivElement>) {
  const update = useCallback(() => {
    if (!surface.current || !image.current || !hud.current || !layout.current) return;
    const stage = layout.current;
    // Express one viewport-centered rotation/perspective origin in each panel's local coordinates.
    // This is the same projection as one shared parent, without tilting the image or its hit area.
    const panels = Array.from(stage.querySelectorAll<HTMLElement>('.creation-image-preview-conversation'));
    for (const panel of panels) {
      panel.style.setProperty('--preview-origin-x', `${stage.clientWidth / 2 + stage.scrollLeft - panel.offsetLeft}px`);
      panel.style.setProperty('--preview-origin-y', `${stage.clientHeight / 2 + stage.scrollTop - panel.offsetTop}px`);
    }
    const host = surface.current.getBoundingClientRect(), picture = image.current.getBoundingClientRect();
    const relative = (rect: DOMRect, margin = 0): Rect => ({ left: rect.left - host.left - margin,
      top: rect.top - host.top - margin, right: rect.right - host.left + margin, bottom: rect.bottom - host.top + margin });
    const bounds = relative(picture);
    const obstacles = panels.filter(panel => panel.matches('.is-ready:not(.is-leaving)'))
      .map(panel => relative(panel.getBoundingClientRect(), 12));
    const head = hud.current.children[0] as HTMLElement, foot = hud.current.children[1] as HTMLElement;
    const safe = { left: 16, right: host.width - 16, top: 16, bottom: host.height - 16 };
    const header = placeRow(head, bounds, { ...safe, bottom: safe.bottom - 52 }, obstacles, false);
    placeRow(foot, bounds, { ...safe, top: Math.max(safe.top, header.top + header.height + 8) }, obstacles, true);
    hud.current.dataset.positioned = "true";
  }, [surface, image, hud, layout]);

  // Zoom/pan commits run before paint; the labels never inherit the image's scale.
  useLayoutEffect(update);
  useEffect(() => {
    const observer = new ResizeObserver(update);
    for (const element of [surface.current, image.current, ...(hud.current?.children ?? [])]) if (element) observer.observe(element);
    const scroll = layout.current;
    scroll?.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    // Follow the initial image expansion, then stop scheduling frames when idle.
    let frame = 0;
    const start = performance.now();
    const enter = () => { update(); if (performance.now() - start < 260) frame = requestAnimationFrame(enter); };
    frame = requestAnimationFrame(enter);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); scroll?.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, [update, layout]);
}
