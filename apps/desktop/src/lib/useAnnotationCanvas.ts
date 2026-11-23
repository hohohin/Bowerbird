import { useLayoutEffect, useRef, type RefObject } from "react";
import { drawShapes, type DrawShape } from "./annotation";

type CommittedPixels = {
  target: HTMLCanvasElement;
  source: CanvasImageSource;
  shapes: DrawShape[];
};

/** Full-resolution committed pixels plus a transient layer shared by both editors. */
export function useAnnotationCanvas(canvas: RefObject<HTMLCanvasElement>, draftCanvas: RefObject<HTMLCanvasElement>,
  source: CanvasImageSource | null, width: number, height: number, shapes: DrawShape[], draft: DrawShape | null, enabled = true) {
  const committed = useRef<CommittedPixels | null>(null);
  const replacesBase = !!draft && ["eraser", "mosaic", "blur"].includes(draft.type);
  useLayoutEffect(() => {
    const target = canvas.current;
    if (!source || !target || !enabled) {
      committed.current = null;
      return;
    }
    const resized = target.width !== width || target.height !== height;
    if (resized) { target.width = width; target.height = height; }
    const previous = committed.current;
    // History snapshots and edits preserve shape identity only for the unchanged prefix.
    const append = !resized && previous?.target === target && previous.source === source
      && previous.shapes.length <= shapes.length
      && (previous.shapes === shapes || previous.shapes.every((shape, index) => shapes[index] === shape));
    const added = append ? shapes.slice(previous.shapes.length) : shapes;
    const replay = !append || added.some(shape => shape.type === "eraser");
    const ctx = target.getContext("2d")!;
    if (replay) {
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(source, 0, 0);
    }
    drawShapes(ctx, replay ? shapes : added, width, height, target, source);
    committed.current = { target, source, shapes };
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
