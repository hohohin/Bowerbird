import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { ArrowUpRight, Circle, Copy, Crop, Maximize, Minus, Pencil, Pin, Plus, Redo2, Save, Square, Type, Undo2, X, Grid2X2 } from "lucide-react";
import { moveRect, rectBetween, renderSnip, type Mark, type Point, type Rect, type SnipTool } from "../lib/screenshot";
import "./ScreenshotWindow.css";

type Gesture = { kind: "select" | "move" | "resize" | "draw"; start: Point; rect: Rect | null; anchor?: Point; mark?: Mark };
const TOOLS = [
  ["select", "调整选区", Crop], ["rect", "矩形", Square], ["ellipse", "椭圆", Circle],
  ["arrow", "箭头", ArrowUpRight], ["pen", "画笔", Pencil], ["text", "文字", Type], ["mosaic", "马赛克", Grid2X2],
] as const;
const COLORS = ["#ff4d4f", "#ffc53d", "#52c41a", "#4096ff", "#ffffff", "#171717"];

export function ScreenshotWindow({ pinned = false }: { pinned?: boolean }) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [selection, setSelection] = useState<Rect | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [redo, setRedo] = useState<Mark[]>([]);
  const [draft, setDraft] = useState<Mark | null>(null);
  const [tool, setTool] = useState<SnipTool>("select");
  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState(3);
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState<Point | null>(null);
  const [zoom, setZoom] = useState(1);
  const canvas = useRef<HTMLCanvasElement>(null);
  const loupe = useRef<HTMLCanvasElement>(null);
  const source = useRef<HTMLCanvasElement | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const [viewport, setViewport] = useState({ width: innerWidth, height: innerHeight });
  useEffect(() => {
    let disposed = false;
    const show = () => getCurrentWindow().show().then(() => getCurrentWindow().setFocus());
    void invoke<string>("screenshot_image").then(data => {
      const loaded = new Image();
      loaded.onload = () => {
        if (disposed) return;
        source.current = renderSnip(loaded, []); setImage(loaded);
        void show().catch(e => setError(String(e)));
      };
      loaded.onerror = () => { if (!disposed) { setError("截图加载失败，请关闭后重试"); void show(); } };
      loaded.src = data;
    }).catch(e => { if (!disposed) { setError(String(e)); void show(); } });
    const resize = () => setViewport({ width: innerWidth, height: innerHeight });
    window.addEventListener('resize', resize);
    return () => { disposed = true; window.removeEventListener('resize', resize); };
  }, []);
  useEffect(() => {
    if (!image || pinned || !canvas.current) return;
    const target = canvas.current; target.width = image.naturalWidth; target.height = image.naturalHeight;
    const ctx = target.getContext("2d")!;
    ctx.drawImage(renderSnip(image, draft ? [...marks, draft] : marks), 0, 0);
  }, [image, marks, draft, pinned]);
  useEffect(() => {
    if (pinned && image) setZoom(Math.min(viewport.width / image.naturalWidth, (viewport.height - 40) / image.naturalHeight));
  }, [pinned, image, viewport]);
  const ratio = image ? image.naturalWidth / viewport.width : 1;
  useEffect(() => {
    if (!cursor || !source.current || !loupe.current) return;
    const ctx = loupe.current.getContext('2d')!;
    ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, 108, 108);
    ctx.drawImage(source.current, cursor.x - 9, cursor.y - 9, 18, 18, 0, 0, 108, 108);
    ctx.strokeStyle = '#52c41a'; ctx.lineWidth = 1; ctx.strokeRect(48.5, 48.5, 6, 6);
  }, [cursor]);
  async function close() {
    if (busyRef.current) return;
    try { if (pinned) await getCurrentWindow().close(); else await invoke("screenshot_cancel"); }
    catch (e) { setError(String(e)); }
  }
  function undo() { if (!marks.length) return; setRedo([...redo, marks[marks.length - 1]]); setMarks(marks.slice(0, -1)); }
  function redoMark() { if (!redo.length) return; setMarks([...marks, redo[redo.length - 1]]); setRedo(redo.slice(0, -1)); }
  async function output(action: "copy" | "save" | "pin") {
    if (!image || busyRef.current || (!pinned && !selection)) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const data = pinned ? image.src : renderSnip(image, marks, selection).toDataURL("image/png");
      await invoke<boolean>("screenshot_output", { data, action });
    } catch (e) { setError(String(e)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function changeZoom(next: number) {
    if (!image) return;
    const value = Math.max(.1, Math.min(4, next));
    try { await getCurrentWindow().setSize(new LogicalSize(Math.max(180, image.naturalWidth * value), Math.max(120, image.naturalHeight * value + 40))); setZoom(value); }
    catch (e) { setError(String(e)); }
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || busyRef.current) return;
      if (event.key === "Escape") { event.preventDefault(); void close(); return; }
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && key === "z") { event.preventDefault(); if (event.shiftKey) redoMark(); else undo(); }
      if (mod && key === "y") { event.preventDefault(); redoMark(); }
      if ((mod && key === "c") || event.key === "Enter") { event.preventDefault(); void output("copy"); }
      if (mod && key === "s") { event.preventDefault(); void output("save"); }
      if (!mod && key === "p" && selection) { event.preventDefault(); void output("pin"); }
      if (!pinned && !mod && key === 'c' && cursor && source.current) {
        const pixel = source.current.getContext('2d')!.getImageData(Math.min(source.current.width - 1, Math.floor(cursor.x)), Math.min(source.current.height - 1, Math.floor(cursor.y)), 1, 1).data;
        setColor('#' + [...pixel].slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join(''));
      }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  });
  function point(event: ReactPointerEvent): Point {
    return { x: Math.max(0, Math.min(image!.naturalWidth, event.clientX * ratio)), y: Math.max(0, Math.min(image!.naturalHeight, event.clientY * image!.naturalHeight / viewport.height)) };
  }
  function down(event: ReactPointerEvent<HTMLDivElement>) {
    if (!image || busy || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = point(event);
    if (tool === "select" || !selection) {
      const handle = (event.target as HTMLElement).dataset.handle;
      if (handle && selection) {
        const anchor = { x: handle.includes('w') ? selection.x + selection.width : selection.x, y: handle.includes('n') ? selection.y + selection.height : selection.y };
        gesture.current = { kind: 'resize', start: p, rect: selection, anchor };
      } else if (selection && p.x >= selection.x && p.x <= selection.x + selection.width && p.y >= selection.y && p.y <= selection.y + selection.height) {
        gesture.current = { kind: 'move', start: p, rect: selection };
      } else { gesture.current = { kind: 'select', start: p, rect: selection }; setSelection(null); }
    } else {
      if (p.x < selection.x || p.x > selection.x + selection.width || p.y < selection.y || p.y > selection.y + selection.height) return;
      const mark: Mark = { tool, start: p, end: p, color, size: size * ratio, points: [p], text };
      if (tool === 'text') {
        if (!text.trim()) { setError('先在工具栏输入文字，再点击选区放置。'); return; }
        setMarks([...marks, mark]); setRedo([]); setError(''); return;
      }
      gesture.current = { kind: 'draw', start: p, rect: selection, mark }; setDraft(mark);
    }
  }
  function move(event: ReactPointerEvent<HTMLDivElement>) {
    if (!image) return;
    const p = point(event); setCursor(p);
    const current = gesture.current; if (!current) return;
    if (current.kind === 'select' || current.kind === 'resize') setSelection(rectBetween(current.anchor ?? current.start, p));
    if (current.kind === 'move' && current.rect) setSelection(moveRect(current.rect, p.x - current.start.x, p.y - current.start.y, image.naturalWidth, image.naturalHeight));
    if (current.mark) {
      const mark = { ...current.mark, end: p, points: [...current.mark.points, p] };
      if (event.shiftKey && mark.tool === 'ellipse') {
        const d = Math.min(Math.abs(p.x - mark.start.x), Math.abs(p.y - mark.start.y));
        mark.end = { x: mark.start.x + Math.sign(p.x - mark.start.x) * d, y: mark.start.y + Math.sign(p.y - mark.start.y) * d };
      }
      current.mark = mark; setDraft(mark);
    }
  }
  function up() {
    const current = gesture.current; gesture.current = null;
    if (current?.mark) { setMarks([...marks, current.mark]); setRedo([]); }
    if (selection && (selection.width < 2 || selection.height < 2)) setSelection(null);
    setDraft(null);
  }
  const s = selection && image ? { left: selection.x / image.naturalWidth * 100 + '%', top: selection.y / image.naturalHeight * 100 + '%', width: selection.width / image.naturalWidth * 100 + '%', height: selection.height / image.naturalHeight * 100 + '%' } : null;
  if (pinned) return <main className="snip-pin" onWheel={event => { event.preventDefault(); void changeZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)); }}>
    <div className="snip-pin-bar"><span onPointerDown={() => void getCurrentWindow().startDragging()}>贴图</span>
      <button title="缩小" onClick={() => void changeZoom(zoom / 1.2)}><Minus size={14} /></button>
      <button title="原始尺寸" onClick={() => void changeZoom(1)}><Maximize size={14} /></button>
      <button title="放大" onClick={() => void changeZoom(zoom * 1.2)}><Plus size={14} /></button>
      <button title="复制" disabled={busy} onClick={() => void output('copy')}><Copy size={14} /></button>
      <button title="保存" disabled={busy} onClick={() => void output('save')}><Save size={14} /></button>
      <button title="关闭贴图" disabled={busy} onClick={() => void close()}><X size={14} /></button>
    </div>
    {image && <img draggable={false} src={image.src} alt="置顶截图" onPointerDown={event => { if (event.button === 0) void getCurrentWindow().startDragging(); }} onDoubleClick={() => void close()} />}
    {error && <p className="snip-error" role="alert">{error}</p>}
  </main>;
  return <main className="snip-root">
    <div className={`snip-stage ${tool === 'select' ? 'is-select' : ''}`} onPointerDown={down} onPointerMove={move} onPointerUp={up}
      onPointerCancel={() => { if (gesture.current) setSelection(gesture.current.rect); gesture.current = null; setDraft(null); }}
      onContextMenu={event => { event.preventDefault(); if (selection) { setSelection(null); setMarks([]); setRedo([]); setTool('select'); } else void close(); }}
      onDoubleClick={() => { if (selection && tool === 'select') void output('copy'); }}>
      <canvas ref={canvas} />
      {s ? <div className="snip-selection" style={s}><span className="snip-dimensions">{selection!.width} × {selection!.height}</span>
        {tool === 'select' && ['nw', 'ne', 'sw', 'se'].map(handle => <i key={handle} data-handle={handle} className={`snip-handle ${handle}`} />)}
      </div> : <div className="snip-shade" />}
    </div>
    {!selection && <div className="snip-hint">拖动选择截图区域 · C 取色 · Esc 退出<button title="取消截图" onClick={() => void close()}><X size={16} /></button></div>}
    {!selection && cursor && <div className="snip-loupe" style={{ left: Math.min(viewport.width - 128, cursor.x / ratio + 24), top: Math.min(viewport.height - 145, cursor.y / ratio + 24) }}>
      <canvas ref={loupe} width={108} height={108} /><span>{Math.round(cursor.x)}, {Math.round(cursor.y)}</span>
    </div>}
    {selection && <div className="snip-toolbar" role="toolbar" aria-label="截图工具">
      <div className="snip-tools">{TOOLS.map(([value, label, Icon]) => <button key={value} title={label} aria-label={label} aria-pressed={tool === value} disabled={busy} className={tool === value ? 'active' : ''} onClick={() => setTool(value)}><Icon size={18} /></button>)}
        <span className="snip-divider" />
        <button title="撤销（Ctrl/⌘ Z）" aria-label="撤销" disabled={!marks.length || busy} onClick={undo}><Undo2 size={18} /></button>
        <button title="重做" aria-label="重做" disabled={!redo.length || busy} onClick={redoMark}><Redo2 size={18} /></button>
        <span className="snip-divider" />
        <button title="置顶贴图（P）" aria-label="置顶贴图" disabled={busy} onClick={() => void output('pin')}><Pin size={18} /></button>
        <button title="保存（Ctrl/⌘ S）" aria-label="保存截图" disabled={busy} onClick={() => void output('save')}><Save size={18} /></button>
        <button title="复制（Enter）" aria-label="复制截图" disabled={busy} className="snip-confirm" onClick={() => void output('copy')}><Copy size={18} /></button>
        <button title="取消（Esc）" aria-label="取消截图" disabled={busy} onClick={() => void close()}><X size={18} /></button>
      </div>
      {tool !== 'select' && <div className="snip-options">
        {COLORS.map(value => <button key={value} aria-label={`颜色 ${value}`} className={color === value ? 'selected' : ''} style={{ background: value }} onClick={() => setColor(value)} />)}
        <input aria-label="自定义颜色" type="color" value={color} onChange={event => setColor(event.target.value)} />
        <label>{tool === 'text' ? '字号' : '粗细'} <input aria-label="标注粗细" type="range" min="1" max="12" value={size} onChange={event => setSize(+event.target.value)} /></label>
        {tool === 'text' && <textarea aria-label="标注文字" placeholder="输入文字，再点击选区放置" value={text} onChange={event => setText(event.target.value)} rows={2} />}
      </div>}
      <p className="snip-tip">{tool === 'select' ? '拖动选区或四角调整 · 双击复制' : tool === 'text' ? '点击选区放置文字' : '在选区中拖动标注'}{busy ? ' · 正在处理…' : ''}</p>
    </div>}
    {error && <p className="snip-error" role="alert">{error}</p>}
  </main>;
}
