import { useRef } from "react";
import { annotationStrokeWidth, hitAnnotationStroke, type AnnotationTool, type DrawShape } from "./annotation";

type WheelEdit<T extends AnnotationTool> = { index: number; time: number; after: DrawShape<T>[] };
function continuesBurst<T extends AnnotationTool>(previous: WheelEdit<T> | null, index: number, shapes: DrawShape<T>[], time: number) {
  return previous !== null && previous.index === index && previous.after === shapes && time - previous.time <= 400;
}

/** A wheel burst edits one hit object and records one undo snapshot in either editor. */
export function useAnnotationStrokeWheel<T extends AnnotationTool>(shapes: DrawShape<T>[],
  setShapes: (shapes: DrawShape<T>[]) => void, record: () => void) {
  const last = useRef<WheelEdit<T> | null>(null);
  return (event: WheelEvent, point: { x: number; y: number }, width: number, height: number): boolean => {
    if (event.ctrlKey || !event.deltaY) return false;
    const index = hitAnnotationStroke(shapes, point, width, height);
    if (index < 0) return false;
    event.preventDefault(); event.stopPropagation();
    const shape = shapes[index];
    const ratio = annotationStrokeWidth(shape.strokeRatio * width + (event.deltaY < 0 ? 1 : -1)) / width;
    if (Math.abs(ratio - shape.strokeRatio) < 1e-9) return true;
    const time = performance.now(), previous = last.current;
    if (!continuesBurst(previous, index, shapes, time)) record();
    const next = shapes.map((item, i) => i === index ? { ...item, strokeRatio: ratio } : item);
    last.current = { index, time, after: next }; setShapes(next);
    return true;
  };
}
