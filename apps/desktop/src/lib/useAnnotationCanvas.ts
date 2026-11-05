import { useLayoutEffect, type RefObject } from "react";
import { drawShapes, type DrawShape } from "./annotation";

/** Full-resolution committed pixels plus a transient layer shared by both editors. */
export function useAnnotationCanvas(canvas: RefObject<HTMLCanvasElement>, draftCanvas: RefObject<HTMLCanvasElement>,
  source: CanvasImageSource | null, width: number, height: number, shapes: DrawShape[], draft: DrawShape | null, enabled = true) {
  const replacesBase = !!draft && ["eraser", "mosaic", "blur"].includes(draft.type);
  useLayoutEffect(() => {
    const target = canvas.current;
    if (!source || !target || !enabled) return;
    if (target.width !== width || target.height !== height) { target.width = width; target.height = height; }
    const ctx = target.getContext("2d")!;
    ctx.clearRect(0, 0, width, height); ctx.drawImage(source, 0, 0);
    drawShapes(ctx, shapes, width, height, target, source);
  }, [source, width, height, shapes, enabled]);
  useLayoutEffect(() => {
    const target = draftCanvas.current;
    if (!target || !source || !enabled) return;
    if (!draft) { target.width = target.height = 0; return; }
    // Repaint only the transient layer during pointer movement. Region effects
    // replace the composition so alpha/eraser previews match the saved pixels.
    const frame = requestAnimationFrame(() => {
      if (target.width !== width || target.height !== height) { target.width = width; target.height = height; }
      const ctx = target.getContext("2d")!;
      ctx.clearRect(0, 0, width, height);
      if (replacesBase) ctx.drawImage(canvas.current!, 0, 0);
      drawShapes(ctx, [draft], width, height, canvas.current!, source);
    });
    return () => cancelAnimationFrame(frame);
  }, [source, width, height, shapes, draft, enabled, replacesBase]);
  return replacesBase;
}
