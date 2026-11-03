// All annotation geometry is relative to the current image; widths and fonts use image width.
export const ANNOTATION_COLORS = ["#ff4d4d", "#ffd21e", "#3ddc84", "#4d9fff", "#ffffff", "#111111"];
export const ANNOTATION_FONT = '"Microsoft YaHei", "PingFang SC", sans-serif';
export type AnnotationTool = "rect" | "arrow" | "ellipse" | "pencil" | "text" | "line" | "marker" | "mosaic" | "blur" | "eraser";

export type DrawShape<T extends AnnotationTool = AnnotationTool> = {
  type: T;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  strokeRatio: number;
  points?: Array<{ x: number; y: number }>;
  text?: string;
  textSource?: string;
  textWidthRatio?: number;
  fontRatio?: number;
  fontFamily?: string;
  fontWeight?: number;
  rotation?: number;
  mirrored?: boolean;
  filled?: boolean;
};

export function arrowWings(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  w: number
): [[number, number], [number, number]] {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.max(w * 3, w + 6);
  const wing = (offset: number): [number, number] => [
    x2 + Math.cos(ang + offset) * len,
    y2 + Math.sin(ang + offset) * len,
  ];
  return [wing(Math.PI * 0.82), wing(-Math.PI * 0.82)];
}


function drawText(ctx: CanvasRenderingContext2D, shape: DrawShape, w: number, h: number) {
  const size = shape.fontRatio! * w;
  ctx.translate(shape.x1 * w, shape.y1 * h);
  ctx.rotate((shape.rotation ?? 0) * Math.PI / 180);
  ctx.scale(shape.mirrored ? -1 : 1, 1);
  ctx.font = `${shape.fontWeight} ${size}px ${shape.fontFamily}`;
  ctx.textBaseline = "alphabetic";
  shape.text!.split("\n").forEach((line, index) => ctx.fillText(line, 0, size * (1 + index * 1.25)));
}

/** The raster renderer and both editors' hit testing use this exact stroke geometry. */
export function annotationStrokePath(shape: DrawShape, w: number, h: number): Path2D {
  const path = new Path2D();
  const x1 = shape.x1 * w, y1 = shape.y1 * h, x2 = shape.x2 * w, y2 = shape.y2 * h;
  switch (shape.type) {
    case "rect": path.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); break;
    case "ellipse": path.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2); break;
    case "arrow": {
      const [p1, p2] = arrowWings(x1, y1, x2, y2, Math.max(1, shape.strokeRatio * w));
      path.moveTo(x1, y1); path.lineTo(x2, y2);
      path.moveTo(p1[0], p1[1]); path.lineTo(x2, y2); path.lineTo(p2[0], p2[1]); break;
    }
    default:
      path.moveTo(x1, y1);
      for (const p of shape.points ?? []) path.lineTo(p.x * w, p.y * h);
      path.lineTo(x2, y2);
  }
  return path;
}

const STROKE_TOOLS = new Set<AnnotationTool>(["rect", "ellipse", "arrow", "pencil", "line", "marker"]);
function isFilledShape(shape: DrawShape) { return !!shape.filled && (shape.type === "rect" || shape.type === "ellipse"); }
export function hitAnnotationStroke(shapes: DrawShape[], point: { x: number; y: number }, w: number, h: number): number {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.lineCap = ctx.lineJoin = "round";
  for (let i = shapes.length - 1; i >= 0; i--) {
    const shape = shapes[i];
    if (!STROKE_TOOLS.has(shape.type) || isFilledShape(shape)) continue;
    ctx.lineWidth = Math.max(1, shape.strokeRatio * w) * (shape.type === "marker" ? 6 : 1) + 6;
    if (ctx.isPointInStroke(annotationStrokePath(shape, w, h), point.x, point.y)) return i;
  }
  return -1;
}

export function annotationStrokeWidth(value: number) { return Math.max(1, Math.min(32, value)); }

function drawStroke(ctx: CanvasRenderingContext2D, shape: DrawShape, w: number, h: number) {
  if (shape.type === "marker") { ctx.globalAlpha = .3; ctx.lineWidth *= 6; ctx.lineCap = "butt"; }
  const path = annotationStrokePath(shape, w, h);
  if (isFilledShape(shape)) ctx.fill(path); else ctx.stroke(path);
}

function pixelRect(shape: DrawShape, w: number, h: number) {
  const x = Math.round(Math.min(shape.x1, shape.x2) * w), y = Math.round(Math.min(shape.y1, shape.y2) * h);
  return { x, y, width: Math.round(Math.max(shape.x1, shape.x2) * w) - x, height: Math.round(Math.max(shape.y1, shape.y2) * h) - y };
}

function drawRegionEffect(ctx: CanvasRenderingContext2D, shape: DrawShape, w: number, h: number, background: HTMLCanvasElement) {
  const box = pixelRect(shape, w, h);
  if (!box.width || !box.height) return;
  const sample = document.createElement("canvas");
  if (shape.type === "mosaic") {
    const cell = Math.max(10, ctx.lineWidth * 5);
    sample.width = Math.max(1, Math.ceil(box.width / cell)); sample.height = Math.max(1, Math.ceil(box.height / cell));
    sample.getContext("2d")!.drawImage(background, box.x, box.y, box.width, box.height, 0, 0, sample.width, sample.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sample, 0, 0, sample.width, sample.height, box.x, box.y, box.width, box.height);
    return;
  }
  const radius = Math.max(2, ctx.lineWidth * 2), padding = Math.ceil(radius * 3);
  const x = Math.max(0, box.x - padding), y = Math.max(0, box.y - padding);
  sample.width = Math.min(background.width, box.x + box.width + padding) - x;
  sample.height = Math.min(background.height, box.y + box.height + padding) - y;
  sample.getContext("2d")!.drawImage(background, x, y, sample.width, sample.height, 0, 0, sample.width, sample.height);
  ctx.beginPath(); ctx.rect(box.x, box.y, box.width, box.height); ctx.clip();
  ctx.filter = `blur(${radius}px)`; ctx.drawImage(sample, x, y);
}

function erase(ctx: CanvasRenderingContext2D, shape: DrawShape, w: number, h: number, original: CanvasImageSource) {
  const points = [{ x: shape.x1, y: shape.y1 }, ...(shape.points ?? []), { x: shape.x2, y: shape.y2 }];
  const radius = ctx.lineWidth * 4;
  ctx.beginPath();
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1], to = points[i];
    const dx = (to.x - from.x) * w, dy = (to.y - from.y) * h;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / radius));
    for (let n = 0; n <= steps; n++) {
      const x = from.x * w + dx * n / steps, y = from.y * h + dy * n / steps;
      ctx.moveTo(x + radius, y); ctx.arc(x, y, radius, 0, Math.PI * 2);
    }
  }
  ctx.clip(); ctx.clearRect(0, 0, w, h); ctx.drawImage(original, 0, 0);
}

/** Common renderer for image annotation, screenshot previews and all raster exports. */
export function drawShapeCanvas(ctx: CanvasRenderingContext2D, shape: DrawShape, w: number, h: number,
  background: HTMLCanvasElement = ctx.canvas, original: CanvasImageSource = background) {
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = shape.color;
  ctx.lineWidth = Math.max(1, shape.strokeRatio * w);
  ctx.lineCap = ctx.lineJoin = "round";
  if (shape.type === "text") drawText(ctx, shape, w, h);
  else if (shape.type === "mosaic" || shape.type === "blur") drawRegionEffect(ctx, shape, w, h, background);
  else if (shape.type === "eraser") erase(ctx, shape, w, h, original);
  else drawStroke(ctx, shape, w, h);
  ctx.restore();
}

export function drawShapes(ctx: CanvasRenderingContext2D, shapes: DrawShape[], width: number, height: number,
  background: HTMLCanvasElement = ctx.canvas, original: CanvasImageSource = background) {
  for (const shape of shapes) drawShapeCanvas(ctx, shape, width, height, background, original);
}

function wrapText(source: string, context: CanvasRenderingContext2D, boxWidth: number): string[] {
  return source.split("\n").flatMap(paragraph => {
    const wrapped: string[] = [];
    let line = "";
    for (const char of Array.from(paragraph)) {
      if (line && context.measureText(line + char).width > boxWidth) {
        wrapped.push(line);
        line = "";
      }
      line += char;
    }
    return [...wrapped, line];
  });
}

/** Both editors create complete text drafts; persisted metadata is not restored as editable shapes. */
export function annotationTextLayout(shape: DrawShape, width: number) {
  return {
    source: shape.textSource!,
    size: shape.fontRatio! * width,
    boxWidth: shape.textWidthRatio! * width,
  };
}

export function finishTextShape<T extends AnnotationTool>(shape: DrawShape<T>, width: number, height: number): DrawShape<T> | null {
  const { source, size, boxWidth } = annotationTextLayout(shape, width);
  if (!source.trim()) return null;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return null;
  context.font = `${shape.fontWeight} ${size}px ${shape.fontFamily}`;
  const lines = wrapText(source, context, boxWidth);
  const angle = (shape.rotation ?? 0) * Math.PI / 180;
  const textWidth = Math.max(...lines.map(line => context.measureText(line).width));
  const textHeight = size * lines.length * 1.25;
  const points = [[0, 0], [textWidth, 0], [textWidth, textHeight], [0, textHeight]].map(([x, y]) => {
    const dx = shape.mirrored ? -x : x;
    return { x: shape.x1 + (dx * Math.cos(angle) - y * Math.sin(angle)) / width,
      y: shape.y1 + (dx * Math.sin(angle) + y * Math.cos(angle)) / height };
  });
  return { ...shape, textSource: source, text: lines.join("\n"), points,
    x2: points[2].x, y2: points[2].y };
}

export type TextEdit<T extends AnnotationTool = AnnotationTool> = { index: number | null; shape: DrawShape<T> };

/** Commit to one immutable snapshot so keyboard and pointer exports share the same result. */
export function applyTextEdit<T extends AnnotationTool>(shapes: DrawShape<T>[], edit: TextEdit<T> | null, width: number, height: number): DrawShape<T>[] {
  if (!edit) return shapes;
  const shape = finishTextShape(edit.shape, width, height);
  if (edit.index === null) return shape ? [...shapes, shape] : shapes;
  return shapes.flatMap((item, index) => index === edit.index ? (shape ? [shape] : []) : [item]);
}
