import type { DrawShape } from "./annotation";
import type { AnnotationShape } from "./types";

function shapeBounds(shape: DrawShape) {
  const points = [...(shape.points ?? []), { x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }];
  return points.reduce((bounds, point) => ({
    x1: Math.min(bounds.x1, point.x), y1: Math.min(bounds.y1, point.y),
    x2: Math.max(bounds.x2, point.x), y2: Math.max(bounds.y2, point.y),
  }), { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity });
}

// The final image uses 0–999 coordinates, including its right and bottom edges.
const v999 = (value: number) => Math.max(0, Math.min(999, Math.round(value * 1000)));

function shapeToken(shape: DrawShape): string {
  if (shape.type === "arrow") {
    return `<point>${v999(shape.x1)} ${v999(shape.y1)}</point> → <point>${v999(shape.x2)} ${v999(shape.y2)}</point>`;
  }
  const bounds = shapeBounds(shape);
  const prefix = shape.type === "ellipse" ? "椭圆区域 " : shape.type === "pencil" ? "手绘线条所在区域 "
    : shape.type === "text" ? `文字 ${JSON.stringify(shape.text)} 所在区域 `
    : shape.type === "line" ? "线条所在区域 " : shape.type === "marker" ? "荧光标记区域 "
    : shape.type === "mosaic" ? "马赛克区域 " : shape.type === "blur" ? "模糊区域 " : shape.type === "eraser" ? "擦除标注区域 " : "";
  return `${prefix}<bbox>${v999(bounds.x1)} ${v999(bounds.y1)} ${v999(bounds.x2)} ${v999(bounds.y2)}</bbox>`;
}

export function toAnnotationShapes(shapes: DrawShape[], width: number): AnnotationShape[] {
  return shapes.map(shape => {
    const box = shape.type === "rect" || shape.type === "ellipse";
    return {
      type: shape.type,
      x1: v999(box ? Math.min(shape.x1, shape.x2) : shape.x1),
      y1: v999(box ? Math.min(shape.y1, shape.y2) : shape.y1),
      x2: v999(box ? Math.max(shape.x1, shape.x2) : shape.x2),
      y2: v999(box ? Math.max(shape.y1, shape.y2) : shape.y2),
      color: shape.color,
      width: Math.max(1, Math.round(shape.strokeRatio * width)),
      token: shapeToken(shape),
      ...(shape.filled && box ? { filled: true } : {}),
      ...(shape.points ? { points: shape.points.map(point => ({ x: v999(point.x), y: v999(point.y) })) } : {}),
      ...(shape.type === "text" ? { text: shape.text, fontSize: shape.fontRatio! * width,
        fontFamily: shape.fontFamily, fontWeight: shape.fontWeight, rotation: shape.rotation,
        ...(shape.mirrored ? { mirrored: true } : {}) } : {}),
    };
  });
}

/** Convert full-frame shapes to coordinates on the exported selection. */
export function cropAnnotationShapes(shapes: DrawShape[], sourceWidth: number, sourceHeight: number,
  crop: { x: number; y: number; width: number; height: number }): DrawShape[] {
  const x = (value: number) => (value * sourceWidth - crop.x) / crop.width;
  const y = (value: number) => (value * sourceHeight - crop.y) / crop.height;
  const widthScale = sourceWidth / crop.width;
  return shapes.filter(shape => {
    const bounds = shapeBounds(shape);
    return x(bounds.x2) >= 0 && x(bounds.x1) <= 1 && y(bounds.y2) >= 0 && y(bounds.y1) <= 1;
  }).map(shape => ({
    ...shape, x1: x(shape.x1), y1: y(shape.y1), x2: x(shape.x2), y2: y(shape.y2),
    strokeRatio: shape.strokeRatio * widthScale,
    ...(shape.points ? { points: shape.points.map(point => ({ x: x(point.x), y: y(point.y) })) } : {}),
    ...(shape.fontRatio !== undefined ? { fontRatio: shape.fontRatio * widthScale } : {}),
  }));
}
