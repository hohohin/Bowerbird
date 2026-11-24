import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Palette } from "lucide-react";
import "./DraftColorPanel.css";

type HSV = { h: number; s: number; v: number };
const RECENT_KEY = "bowerbird.draft.recentColors";
const COMMON = ["#000000", "#ffffff", "#ef4444", "#f59e0b", "#eab308", "#22c55e", "#3b82f6", "#a855f7"];
const clamp = (value: number, maximum = 100) => Math.max(0, Math.min(maximum, value));
function parseHex(value: string): string | null {
  const hex = value.trim().replace(/^#/, "").toLowerCase();
  if (/^[\da-f]{6}$/.test(hex)) return `#${hex}`;
  if (/^[\da-f]{3}$/.test(hex)) return `#${[...hex].map(char => char + char).join("")}`;
  return null;
}
function fromHex(hex: string): HSV {
  const [r, g, b] = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const h = delta === 0 ? 0 : max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { h: h * 60, s: max === 0 ? 0 : delta / max * 100, v: max * 100 };
}
function toHex({ h, s, v }: HSV): string {
  const c = v / 100 * s / 100, x = c * (1 - Math.abs(h / 60 % 2 - 1)), m = v / 100 - c;
  const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${rgb.map(channel => Math.round((channel + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}
function readRecent(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    if (!Array.isArray(stored)) return [];
    return [...new Set(stored.filter((color): color is string => typeof color === "string").map(parseHex).filter((color): color is string => !!color))].slice(0, 8);
  } catch { return []; }
}

export function DraftColorPanel({ color, onChange, disabled }: { color: string; onChange: (color: string) => void; disabled: boolean }) {
  const current = parseHex(color) ?? "#000000";
  const [hsv, setHsv] = useState<HSV>(() => fromHex(current));
  const latest = useRef(hsv);
  const [hexInput, setHexInput] = useState(current);
  const [invalid, setInvalid] = useState(false);
  const [recent, setRecent] = useState(readRecent);
  const drag = useRef<number | null>(null);
  const helpId = useId(), errorId = useId();
  useEffect(() => {
    // Keep the chosen hue at gray/black, where RGB cannot express it. This also
    // avoids quantization jumps while our own pointer updates round to 8-bit RGB.
    if (toHex(latest.current) !== current) {
      const next = fromHex(current);
      if (next.s === 0) next.h = latest.current.h;
      latest.current = next; setHsv(next);
    }
    setHexInput(current); setInvalid(false);
    const timer = window.setTimeout(() => {
      setRecent(previous => {
        const next = [current, ...previous.filter(value => value !== current)].slice(0, 8);
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* In-memory colors remain available. */ }
        return next;
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [current]);
  useEffect(() => { if (disabled) drag.current = null; }, [disabled]);

  function change(next: HSV) {
    if (disabled) return;
    latest.current = next; setHsv(next);
    const value = toHex(next); setHexInput(value); setInvalid(false); onChange(value);
  }
  function choose(value: string) {
    const next = fromHex(value);
    if (next.s === 0) next.h = latest.current.h;
    change(next);
  }
  function changePoint(event: PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width || !box.height) return;
    change({ ...latest.current, s: clamp((event.clientX - box.left) / box.width * 100), v: clamp(100 - (event.clientY - box.top) / box.height * 100) });
  }
  function planeKey(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled || event.ctrlKey || event.metaKey || event.altKey) return;
    const step = event.shiftKey ? 10 : 1, previous = latest.current;
    let next = previous;
    if (event.key === "ArrowLeft") next = { ...previous, s: clamp(previous.s - step) };
    else if (event.key === "ArrowRight") next = { ...previous, s: clamp(previous.s + step) };
    else if (event.key === "ArrowUp") next = { ...previous, v: clamp(previous.v + step) };
    else if (event.key === "ArrowDown") next = { ...previous, v: clamp(previous.v - step) };
    else if (event.key === "Home") next = { ...previous, s: 0 };
    else if (event.key === "End") next = { ...previous, s: 100 };
    else return;
    event.preventDefault(); event.stopPropagation(); change(next);
  }
  function commitHex() {
    if (disabled) return;
    const value = parseHex(hexInput);
    if (!value) { setInvalid(true); return; }
    choose(value);
  }
  function swatches(colors: string[], prefix: string) {
    return <div className="draft-color-swatches" role="group" aria-label={prefix}>{colors.map(value => <button key={value} type="button"
      style={{ backgroundColor: value }} title={value.toUpperCase()} aria-label={`${prefix} ${value.toUpperCase()}`}
      aria-pressed={current === value} onClick={() => choose(value)} />)}
      {!colors.length && <span className="draft-color-empty">选取的颜色会显示在这里</span>}</div>;
  }
  return <fieldset className="draft-color-panel" data-draft-color-panel disabled={disabled} onPointerDown={event => event.stopPropagation()}>
    <legend><Palette size={14} aria-hidden="true"/>颜色</legend>
    <div className="draft-color-plane" role="slider" tabIndex={disabled ? -1 : 0} aria-label="饱和度与明度"
      aria-disabled={disabled} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(hsv.s)}
      aria-valuetext={`饱和度 ${Math.round(hsv.s)}%，明度 ${Math.round(hsv.v)}%`} aria-describedby={helpId}
      style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }} onKeyDown={planeKey}
      onPointerDown={event => { if (disabled || event.button !== 0) return; event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); drag.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); changePoint(event); }}
      onPointerMove={event => { if (drag.current === event.pointerId) changePoint(event); }}
      onPointerUp={event => { if (drag.current !== event.pointerId) return; changePoint(event); drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      <span className="draft-color-point" style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%`, backgroundColor: current }}/>
    </div>
    <span id={helpId} className="draft-color-sr-only">左右方向键调整饱和度，上下方向键调整明度，按住 Shift 加速</span>
    <input className="draft-color-hue" type="range" min="0" max="359" step="1" aria-label="色相" value={Math.round(hsv.h)}
      onChange={event => change({ ...latest.current, h: Number(event.currentTarget.value) })}/>
    <label className="draft-color-hex"><span className="draft-color-current" style={{ backgroundColor: current }} aria-label={`当前颜色 ${current.toUpperCase()}`}/>
      <span>HEX</span><input type="text" aria-label="HEX 颜色" value={hexInput} spellCheck={false} autoComplete="off"
        aria-invalid={invalid} aria-describedby={invalid ? errorId : undefined} onChange={event => { setHexInput(event.target.value); setInvalid(false); }} onBlur={commitHex}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); commitHex(); } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setHexInput(current); setInvalid(false); } }}/></label>
    {invalid && <span id={errorId} className="draft-color-invalid" role="status">请输入 3 或 6 位十六进制颜色</span>}
    <span className="draft-color-label">常用色</span>{swatches(COMMON, "常用色")}
    <span className="draft-color-label">最近颜色</span>{swatches(recent, "最近颜色")}
  </fieldset>;
}
