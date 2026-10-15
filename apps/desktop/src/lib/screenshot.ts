export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type SnipTool = "select" | "rect" | "ellipse" | "arrow" | "pen" | "text" | "mosaic";
export type Mark = { tool: Exclude<SnipTool, "select">; start: Point; end: Point; color: string; size: number; points: Point[]; text: string };
export const DEFAULT_SCREENSHOT_SHORTCUTS = { capture: "F1", paste: "F3" };
export function rectBetween(a: Point, b: Point): Rect {
  const x = Math.round(Math.min(a.x, b.x)), y = Math.round(Math.min(a.y, b.y));
  return { x, y, width: Math.round(Math.max(a.x, b.x)) - x, height: Math.round(Math.max(a.y, b.y)) - y };
}
export function moveRect(rect: Rect, dx: number, dy: number, width: number, height: number): Rect {
  return { ...rect, x: Math.max(0, Math.min(width - rect.width, Math.round(rect.x + dx))), y: Math.max(0, Math.min(height - rect.height, Math.round(rect.y + dy))) };
}
// All adjustments use source pixels, independently of the webview's display scale.
export function nudgeRect(rect: Rect, direction: Point, mode: 'move' | 'expand' | 'shrink', width: number, height: number): Rect {
  if (mode === 'move') return moveRect(rect, direction.x, direction.y, width, height);
  let { x, y } = rect;
  let right = x + rect.width, bottom = y + rect.height;
  const step = mode === 'expand' ? 1 : -1;
  if (direction.x < 0) x = Math.max(0, Math.min(right - 1, x - step));
  if (direction.x > 0) right = Math.min(width, Math.max(x + 1, right + step));
  if (direction.y < 0) y = Math.max(0, Math.min(bottom - 1, y - step));
  if (direction.y > 0) bottom = Math.min(height, Math.max(y + 1, bottom + step));
  return { x, y, width: right - x, height: bottom - y };
}
export function samplePixel(source: HTMLCanvasElement, point: Point): string {
  const sample = document.createElement('canvas'); sample.width = sample.height = 1;
  const ctx = sample.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, Math.max(0, Math.min(source.width - 1, Math.floor(point.x))), Math.max(0, Math.min(source.height - 1, Math.floor(point.y))), 1, 1, 0, 0, 1, 1);
  return '#' + [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('');
}
export function shortcutFromEvent(event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): string | null {
  if (!/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Space|PrintScreen)$/.test(event.code)) return null;
  if (!event.metaKey && !event.ctrlKey && !event.altKey && !/^F\d+$/.test(event.code) && event.code !== "PrintScreen") return null;
  return [event.metaKey && "Super", event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift", event.code].filter(Boolean).join("+");
}
export function displayShortcut(value: string): string {
  return value ? value.replace(/Super/g, "⌘").replace(/Control/g, "Ctrl").replace(/Key([A-Z])/g, "$1").replace(/Digit(\d)/g, "$1").replace(/\+/g, " + ") : "未设置";
}
export function drawMarks(ctx: CanvasRenderingContext2D, marks: Mark[], background: HTMLCanvasElement = ctx.canvas) {
  for (const mark of marks) {
    const { start: a, end: b, size } = mark;
    const box = rectBetween(a, b);
    ctx.save(); ctx.strokeStyle = mark.color; ctx.fillStyle = mark.color; ctx.lineWidth = size; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath();
    if (mark.tool === "rect") ctx.strokeRect(box.x, box.y, box.width, box.height);
    if (mark.tool === "ellipse") { ctx.ellipse(box.x + box.width / 2, box.y + box.height / 2, box.width / 2, box.height / 2, 0, 0, Math.PI * 2); ctx.stroke(); }
    if (mark.tool === "pen") { ctx.moveTo(a.x, a.y); for (const p of mark.points) ctx.lineTo(p.x, p.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    if (mark.tool === "arrow") {
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const angle = Math.atan2(b.y - a.y, b.x - a.x), length = Math.max(12, size * 4);
      ctx.beginPath(); ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - length * Math.cos(angle - .45), b.y - length * Math.sin(angle - .45));
      ctx.lineTo(b.x - length * Math.cos(angle + .45), b.y - length * Math.sin(angle + .45)); ctx.closePath(); ctx.fill();
    }
    if (mark.tool === "text") {
      const fontSize = Math.max(16, size * 6); ctx.font = `600 ${fontSize}px sans-serif`; ctx.textBaseline = "top";
      mark.text.split("\n").forEach((line, i) => ctx.fillText(line, a.x, a.y + i * fontSize * 1.3));
    }
    if (mark.tool === "mosaic" && box.width && box.height) {
      const sample = document.createElement("canvas"), cell = Math.max(10, size * 5);
      sample.width = Math.max(1, Math.ceil(box.width / cell)); sample.height = Math.max(1, Math.ceil(box.height / cell));
      sample.getContext("2d")!.drawImage(background, box.x, box.y, box.width, box.height, 0, 0, sample.width, sample.height);
      ctx.imageSmoothingEnabled = false; ctx.drawImage(sample, 0, 0, sample.width, sample.height, box.x, box.y, box.width, box.height);
    }
    ctx.restore();
  }
}
