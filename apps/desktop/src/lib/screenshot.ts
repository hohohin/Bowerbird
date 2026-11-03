export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };
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
