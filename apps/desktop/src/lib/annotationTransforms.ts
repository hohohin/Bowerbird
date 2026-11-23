import type { DrawShape } from "./annotation";
import type { AnnotationTransformOp } from "./types";

/** 单点过 op：rotate CW (x,y)→(1-y,x)、CCW →(y,1-x)；crop 平移+按跨度缩放。 */
function opPoint(op: AnnotationTransformOp, x: number, y: number): [number, number] {
  if (op.kind === "rotate") {
    return op.dir === 1 ? [1 - y, x] : [y, 1 - x];
  }
  if (op.kind === "flip") return op.axis === "horizontal" ? [1 - x, y] : [x, 1 - y];
  const sx = Math.max(1e-6, op.x2 - op.x1);
  const sy = Math.max(1e-6, op.y2 - op.y1);
  return [(x - op.x1) / sx, (y - op.y1) / sy];
}

/** 像素尺寸过 op：rotate 宽高互换；crop 按跨度缩放。 */
export function opDims(op: AnnotationTransformOp, w: number, h: number): { w: number; h: number } {
  if (op.kind === "rotate") return { w: h, h: w };
  if (op.kind === "flip") return { w, h };
  const sx = Math.max(1e-6, op.x2 - op.x1);
  const sy = Math.max(1e-6, op.y2 - op.y1);
  return { w: Math.max(1, Math.round(w * sx)), h: Math.max(1, Math.round(h * sy)) };
}

/** 形状过 op：端点随内容走；线宽像素不变、基准宽变化 → 比例 = 旧比例 * 旧宽 / 新宽。 */
export function mapShape(s: DrawShape, op: AnnotationTransformOp, oldW: number, oldH: number): DrawShape {
  const [x1, y1] = opPoint(op, s.x1, s.y1);
  const [x2, y2] = opPoint(op, s.x2, s.y2);
  const d = opDims(op, oldW, oldH);
  return {
    ...s, x1, y1, x2, y2, strokeRatio: (s.strokeRatio * oldW) / d.w,
    ...(s.points ? { points: s.points.map((point) => {
      const [x, y] = opPoint(op, point.x, point.y);
      return { x, y };
    }) } : {}),
    ...(s.type === "text" ? {
      fontRatio: (s.fontRatio! * oldW) / d.w,
      ...(s.textWidthRatio ? { textWidthRatio: s.textWidthRatio * oldW / d.w } : {}),
      // 反射作用于已旋转的文字：翻转角度并切换局部 X 轴镜像。
      rotation: ((op.kind === "flip"
        ? (op.axis === "horizontal" ? 0 : 180) - (s.rotation ?? 0)
        : (s.rotation ?? 0) + (op.kind === "rotate" ? op.dir * 90 : 0)) + 360) % 360,
      ...(op.kind === "flip" ? { mirrored: !s.mirrored } : {}),
    } : {}),
  };
}

/** pristine 原图按序应用 ops → 当前底图 canvas（步进像素变换；显示与导出共用）。空序列返回 null（直接用原图）。 */
export function buildBaseCanvas(img: HTMLImageElement, ops: AnnotationTransformOp[]): HTMLCanvasElement | null {
  if (ops.length === 0) return null;
  let src: HTMLCanvasElement | HTMLImageElement = img;
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  for (const op of ops) {
    const d = opDims(op, w, h);
    const canvas = document.createElement("canvas");
    canvas.width = d.w;
    canvas.height = d.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    if (op.kind === "rotate") {
      // CW：translate(新宽,0)+rotate(90°)；CCW：translate(0,新高)+rotate(-90°)。
      if (op.dir === 1) {
        ctx.translate(d.w, 0);
        ctx.rotate(Math.PI / 2);
      } else {
        ctx.translate(0, d.h);
        ctx.rotate(-Math.PI / 2);
      }
      ctx.drawImage(src, 0, 0);
    } else if (op.kind === "flip") {
      const horizontal = op.axis === "horizontal";
      ctx.translate(horizontal ? w : 0, horizontal ? 0 : h);
      ctx.scale(horizontal ? -1 : 1, horizontal ? 1 : -1);
      ctx.drawImage(src, 0, 0);
    } else {
      ctx.drawImage(
        src,
        op.x1 * w,
        op.y1 * h,
        (op.x2 - op.x1) * w,
        (op.y2 - op.y1) * h,
        0,
        0,
        d.w,
        d.h
      );
    }
    src = canvas;
    w = d.w;
    h = d.h;
  }
  return src as HTMLCanvasElement;
}
