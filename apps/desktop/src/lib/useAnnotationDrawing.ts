import { useRef, useState } from "react";
import type { DrawShape } from "./annotation";

type Point = { x: number; y: number };

function moveShape(shape: DrawShape, point: Point, width: number, height: number, shift: boolean): DrawShape {
  const dx = (point.x - shape.x1) * width, dy = (point.y - shape.y1) * height;
  let end = point;
  if (shift && (shape.type === "rect" || shape.type === "ellipse")) {
    const side = Math.min(Math.abs(dx), Math.abs(dy));
    end = { x: shape.x1 + Math.sign(dx) * side / width, y: shape.y1 + Math.sign(dy) * side / height };
  }
  if (shift && (shape.type === "line" || shape.type === "arrow")) {
    const length = Math.hypot(dx, dy), angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
    end = { x: shape.x1 + length * Math.cos(angle) / width, y: shape.y1 + length * Math.sin(angle) / height };
  }
  return { ...shape, x2: end.x, y2: end.y,
    points: ["pencil", "marker", "eraser"].includes(shape.type) ? [...shape.points!, end] : shape.points };
}

/** Normalized input, shared drag constraints and click-to-build polylines; no host history/state. */
export function useAnnotationDrawing(onCommit: (shape: DrawShape) => void) {
  const [draft, setDraft] = useState<DrawShape | null>(null);
  const active = useRef<DrawShape | null>(null);
  const polyline = useRef<DrawShape | null>(null);
  function cancel() { active.current = null; polyline.current = null; setDraft(null); }
  function pending() {
    const shape = polyline.current;
    if (!shape || shape.points!.length < 2) return null;
    const end = shape.points![shape.points!.length - 1];
    return { ...shape, x2: end.x, y2: end.y };
  }
  function finish() { const shape = pending(); if (shape) onCommit(shape); cancel(); }
  return {
    draft, polyline, cancel, pending, finish,
    begin(shape: DrawShape) {
      const point = { x: shape.x1, y: shape.y1 };
      if (shape.type === "line" && polyline.current) {
        polyline.current = { ...polyline.current, x2: point.x, y2: point.y, points: [...polyline.current.points!, point] };
        setDraft(polyline.current); return;
      }
      active.current = ["line", "pencil", "marker", "eraser"].includes(shape.type) ? { ...shape, points: shape.points ?? [point] } : shape;
      setDraft(active.current);
    },
    move(point: Point, width: number, height: number, shift: boolean) {
      if (polyline.current) { setDraft({ ...polyline.current, x2: point.x, y2: point.y }); return; }
      if (!active.current) return;
      active.current = moveShape(active.current, point, width, height, shift); setDraft(active.current);
    },
    end(width: number, height: number) {
      const shape = active.current; active.current = null;
      if (!shape) return;
      if (shape.type === "line" && Math.hypot((shape.x2 - shape.x1) * width, (shape.y2 - shape.y1) * height) < 3) {
        polyline.current = shape; setDraft(shape); return;
      }
      onCommit(shape); setDraft(null);
    },
  };
}
