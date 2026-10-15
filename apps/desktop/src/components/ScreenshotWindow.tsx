import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { ArrowUpRight, Circle, Copy, Crop, Maximize, Minus, Pencil, Pin, Plus, Redo2, Save, Square, Type, Undo2, X, Grid2X2 } from "lucide-react";
import { drawMarks, moveRect, nudgeRect, rectBetween, samplePixel, type Mark, type Point, type Rect, type SnipTool } from "../lib/screenshot";
import "./ScreenshotWindow.css";

type Gesture = { kind: "select" | "move" | "resize" | "draw"; start: Point; rect: Rect | null; anchor?: Point; mark?: Mark };
const TOOLS = [
  ["select", "调整选区", Crop], ["rect", "矩形", Square], ["ellipse", "椭圆", Circle],
  ["arrow", "箭头", ArrowUpRight], ["pen", "画笔", Pencil], ["text", "文字", Type], ["mosaic", "马赛克", Grid2X2],
] as const;
const COLORS = ["#ff4d4f", "#ffc53d", "#52c41a", "#4096ff", "#ffffff", "#171717"];
const DIRECTIONS: Record<string, Point> = { arrowleft: { x: -1, y: 0 }, arrowright: { x: 1, y: 0 }, arrowup: { x: 0, y: -1 }, arrowdown: { x: 0, y: 1 }, a: { x: -1, y: 0 }, d: { x: 1, y: 0 }, w: { x: 0, y: -1 }, s: { x: 0, y: 1 } };

function ScreenshotLoupe({ source, cursor, viewport, marks }: { source: HTMLCanvasElement; cursor: Point; viewport: { width: number; height: number }; marks: Mark[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hex, setHex] = useState('');
  const x = Math.max(0, Math.min(source.width - 1, Math.floor(cursor.x)));
  const y = Math.max(0, Math.min(source.height - 1, Math.floor(cursor.y)));
  useEffect(() => {
    const ctx = canvas.current!.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#17191e'; ctx.fillRect(0, 0, 114, 114);
    // 19 source pixels × 6. The exact sampled pixel occupies the central cell.
    ctx.drawImage(source, x - 9, y - 9, 19, 19, 0, 0, 114, 114);
    setHex('#' + [...ctx.getImageData(57, 57, 1, 1).data].slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join(''));
    ctx.lineWidth = 1; ctx.strokeStyle = '#00000030'; ctx.beginPath();
    for (let n = 6; n < 114; n += 6) { ctx.moveTo(n + .5, 0); ctx.lineTo(n + .5, 114); ctx.moveTo(0, n + .5); ctx.lineTo(114, n + .5); }
    ctx.stroke(); ctx.strokeStyle = '#ffffff'; ctx.strokeRect(53.5, 53.5, 7, 7);
    ctx.strokeStyle = '#1677ff'; ctx.strokeRect(54.5, 54.5, 5, 5);
  }, [source, x, y, marks]);
  const px = (x + .5) / source.width * viewport.width, py = (y + .5) / source.height * viewport.height;
  const left = Math.max(8, Math.min(viewport.width - 132, px + 24 + 124 <= viewport.width - 8 ? px + 24 : px - 148));
  const top = Math.max(8, Math.min(viewport.height - 164, py + 24 + 156 <= viewport.height - 8 ? py + 24 : py - 180));
  return <div className="snip-loupe" style={{ left, top }} aria-label="像素放大镜">
    <canvas ref={canvas} width={114} height={114} /><span>{x}, {y} px</span><span className="snip-pixel-color"><i style={{ background: hex }} />{hex.toUpperCase()}</span>
  </div>;
}

export function ScreenshotWindow({ pinned = false }: { pinned?: boolean }) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const activeSession = useRef<string | null>(null);
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
  const cursorRef = useRef<Point | null>(null);
  const cursorFrame = useRef<number | null>(null);
  const [inspect, setInspect] = useState(false);
  const [zoom, setZoom] = useState(1);
  const canvas = useRef<HTMLCanvasElement>(null);
  const draftCanvas = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [viewport, setViewport] = useState({ width: innerWidth, height: innerHeight });
  useEffect(() => {
    let disposed = false, revision = 0;
    let imageUrl: string | null = null;
    let currentSession: string | null = null;
    let unlisten: (() => void) | undefined;
    const reset = () => {
      setImage(null); setSession(null); setError(""); setSelection(null);
      setMarks([]); setRedo([]); setDraft(null); setTool("select");
      setColor(COLORS[0]); setSize(3); setText(""); setCursor(null); setInspect(false);
      gesture.current = null; cursorRef.current = null;
      if (cursorFrame.current !== null) cancelAnimationFrame(cursorFrame.current);
      cursorFrame.current = null;
      if (canvas.current) { canvas.current.width = 0; canvas.current.height = 0; }
      if (draftCanvas.current) { draftCanvas.current.width = 0; draftCanvas.current.height = 0; }
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      imageUrl = null;
    };
    const load = async (next: string | null) => {
      if (disposed || next === currentSession) return;
      currentSession = next; activeSession.current = next;
      busyRef.current = false; setBusy(false);
      const request = ++revision;
      reset();
      if (!next) return;
      setSession(next);
      try {
        const bytes = await invoke<ArrayBuffer | number[]>("screenshot_image", { session: next });
        if (disposed || revision !== request) return;
        const url = URL.createObjectURL(new Blob([bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes)], { type: "image/png" }));
        imageUrl = url;
        const loaded = new Image();
        loaded.src = url;
        await loaded.decode();
        if (disposed || revision !== request) return;
        setViewport({ width: innerWidth, height: innerHeight });
        setSession(next); setImage(loaded);
      } catch (e) {
        if (!disposed && revision === request) {
          setError(`截图加载失败，请关闭后重试：${String(e)}`);
          void invoke("screenshot_show", { session: next }).catch(() => {});
        }
      }
    };
    // Subscribe before reading the snapshot: both warm and newly-created windows
    // must receive the frame even when capture finishes during frontend startup.
    void listen<string | null>("screenshot-session", event => { void load(event.payload); }).then(async off => {
      if (disposed) { off(); return; }
      unlisten = off;
      const request = revision;
      const next = await invoke<string | null>("screenshot_session");
      if (!disposed && revision === request) await load(next);
    }).catch(e => { if (!disposed) setError(String(e)); });
    const resize = () => setViewport({ width: innerWidth, height: innerHeight });
    window.addEventListener('resize', resize);
    return () => {
      disposed = true; unlisten?.();
      if (cursorFrame.current !== null) cancelAnimationFrame(cursorFrame.current);
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      window.removeEventListener('resize', resize);
    };
  }, []);
  useLayoutEffect(() => {
    if (!image || pinned || !canvas.current) return;
    const target = canvas.current;
    if (target.width !== image.naturalWidth || target.height !== image.naturalHeight) { target.width = image.naturalWidth; target.height = image.naturalHeight; }
    const ctx = target.getContext("2d")!;
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(image, 0, 0);
    drawMarks(ctx, marks);
  }, [image, marks, pinned]);
  useLayoutEffect(() => {
    const target = draftCanvas.current;
    if (!target || !image || pinned) return;
    if (!draft) { target.width = target.height = 0; return; }
    // A separate transient layer avoids replaying the frozen frame and every
    // committed annotation on each pointer event. Mosaic samples the base layer.
    const frame = requestAnimationFrame(() => {
      if (target.width !== image.naturalWidth || target.height !== image.naturalHeight) { target.width = image.naturalWidth; target.height = image.naturalHeight; }
      const ctx = target.getContext('2d')!;
      ctx.clearRect(0, 0, target.width, target.height);
      drawMarks(ctx, [draft], canvas.current!);
    });
    return () => cancelAnimationFrame(frame);
  }, [image, draft, pinned]);
  useEffect(() => {
    // Layout effects have painted the fresh frame before the native window appears.
    if (image && session) void invoke("screenshot_show", { session }).catch(e => { if (activeSession.current === session) setError(String(e)); });
  }, [image, session]);
  useEffect(() => {
    if (pinned && image) setZoom(Math.min(viewport.width / image.naturalWidth, (viewport.height - 40) / image.naturalHeight));
  }, [pinned, image, viewport]);
  const ratio = image ? image.naturalWidth / viewport.width : 1;
  const ratioY = image ? image.naturalHeight / viewport.height : 1;
  function updateCursor(p: Point) {
    cursorRef.current = p;
    if (cursorFrame.current === null) cursorFrame.current = requestAnimationFrame(() => { cursorFrame.current = null; setCursor(cursorRef.current); });
  }
  async function close() {
    if (busyRef.current) return;
    try { if (pinned) await getCurrentWindow().close(); else await invoke("screenshot_cancel", { session }); }
    catch (e) { setError(String(e)); }
  }
  function undo() { if (!marks.length) return; setRedo([...redo, marks[marks.length - 1]]); setMarks(marks.slice(0, -1)); }
  function redoMark() { if (!redo.length) return; setMarks([...marks, redo[redo.length - 1]]); setRedo(redo.slice(0, -1)); }
  async function output(action: "copy" | "save" | "pin") {
    if (!image || busyRef.current || gesture.current || (!pinned && !selection)) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      let data: string;
      if (pinned) {
        const blob = await fetch(image.src).then(response => response.blob());
        data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
      } else {
        // The committed canvas already contains the full-resolution composition.
        const crop = document.createElement('canvas'); crop.width = selection!.width; crop.height = selection!.height;
        crop.getContext('2d')!.drawImage(canvas.current!, selection!.x, selection!.y, selection!.width, selection!.height, 0, 0, crop.width, crop.height);
        data = crop.toDataURL('image/png');
      }
      await invoke<boolean>("screenshot_output", { data, action, session });
    } catch (e) { if (activeSession.current === session) setError(String(e)); }
    finally { if (activeSession.current === session) { busyRef.current = false; setBusy(false); } }
  }
  async function changeZoom(next: number) {
    if (!image) return;
    const value = Math.max(.1, Math.min(4, next));
    try { await getCurrentWindow().setSize(new LogicalSize(Math.max(180, image.naturalWidth * value), Math.max(120, image.naturalHeight * value + 40))); setZoom(value); }
    catch (e) { setError(String(e)); }
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || busyRef.current) return;
      if (event.key === "Escape") { event.preventDefault(); void close(); return; }
      if (event.target instanceof HTMLElement && (event.target.closest('input, textarea, select') || event.target.isContentEditable)) return;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (key === 'alt' && !pinned) setInspect(true);
      const direction = DIRECTIONS[key];
      if (!pinned && image && direction && !gesture.current && !event.altKey && (key.startsWith('arrow') || (!mod && !event.shiftKey))) {
        event.preventDefault();
        if (selection && key.startsWith('arrow')) {
          setSelection(rect => rect && nudgeRect(rect, direction, mod ? 'expand' : event.shiftKey ? 'shrink' : 'move', image.naturalWidth, image.naturalHeight));
        } else if (!mod && !event.shiftKey) {
          const p = cursorRef.current ?? { x: image.naturalWidth / 2, y: image.naturalHeight / 2 };
          const next = { x: Math.max(0, Math.min(image.naturalWidth - 1, Math.floor(p.x) + direction.x)), y: Math.max(0, Math.min(image.naturalHeight - 1, Math.floor(p.y) + direction.y)) };
          updateCursor(next);
          // Use the pixel origin: Windows rounds logical coordinates to integer
          // device pixels, so adding half a pixel would skip to the next pixel.
          void getCurrentWindow().setCursorPosition(new LogicalPosition(next.x / ratio, next.y / ratioY)).catch(e => {
            if (activeSession.current === session) setError(`光标微调失败：${String(e)}`);
          });
        }
        return;
      }
      if (event.repeat || gesture.current) return;
      if (event.target instanceof HTMLElement && event.target.closest('button') && (event.key === 'Enter' || event.key === ' ')) return;
      if (mod && key === "z") { event.preventDefault(); if (event.shiftKey) redoMark(); else undo(); }
      if (mod && key === "y") { event.preventDefault(); redoMark(); }
      if ((mod && key === "c") || event.key === "Enter") { event.preventDefault(); void output("copy"); }
      if (mod && key === "s") { event.preventDefault(); void output("save"); }
      if (!mod && key === "p" && selection) { event.preventDefault(); void output("pin"); }
      if (!pinned && !mod && key === 'c' && cursorRef.current && image && canvas.current) {
        event.preventDefault(); setColor(samplePixel(canvas.current, cursorRef.current));
      }
    };
    const onKeyUp = (event: KeyboardEvent) => { if (event.key === 'Alt') setInspect(false); };
    const onBlur = () => setInspect(false);
    window.addEventListener('keydown', onKey); window.addEventListener('keyup', onKeyUp); window.addEventListener('blur', onBlur);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', onBlur); };
  });
  function point(event: ReactPointerEvent): Point {
    // Read the current layout: a pointer event can precede React's resize commit.
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(image!.naturalWidth, (event.clientX - bounds.left) * image!.naturalWidth / bounds.width)), y: Math.max(0, Math.min(image!.naturalHeight, (event.clientY - bounds.top) * image!.naturalHeight / bounds.height)) };
  }
  function down(event: ReactPointerEvent<HTMLDivElement>) {
    if (!image || busy || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = point(event); updateCursor(p);
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
    const p = point(event); updateCursor(p);
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
    if (selection && (!selection.width || !selection.height)) setSelection(null);
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
      <canvas ref={draftCanvas} className="snip-draft" width={0} height={0} />
      {s ? <div className="snip-selection" style={s}><span className="snip-dimensions">{selection!.width} × {selection!.height}</span>
        {tool === 'select' && ['nw', 'ne', 'sw', 'se'].map(handle => <i key={handle} data-handle={handle} className={`snip-handle ${handle}`} />)}
      </div> : <div className="snip-shade" />}
    </div>
    {!selection && <div className="snip-hint">拖动选区 · 方向键 / WASD 微调光标 · C 取色 · Esc 退出<button title="取消截图" onClick={() => void close()}><X size={16} /></button></div>}
    {image && cursor && canvas.current && (!selection || tool === 'select' || inspect) && <ScreenshotLoupe source={canvas.current} cursor={cursor} viewport={viewport} marks={marks} />}
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
      <p className="snip-tip">{tool === 'select' ? '方向键移动 1 px · Ctrl/⌘ 扩边 · Shift 缩边 · 双击复制' : tool === 'text' ? '点击选区放置文字 · Alt 放大镜 · C 取色' : '在选区中拖动标注 · Alt 放大镜 · C 取色'}{busy ? ' · 正在处理…' : ''}</p>
    </div>}
    {error && <p className="snip-error" role="alert">{error}</p>}
  </main>;
}
