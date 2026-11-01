import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { ArrowUpRight, Check, ChevronDown, Folder, Grid2X2, Layers, Maximize2, MousePointer2, Play, Plus, Search, Sun } from "lucide-react";
import { createCanvasDragHold } from "../../../src/lib/canvasDragHold";
import { exceedsCanvasDragThreshold } from "../../../src/lib/canvasLogic";
import "../../../src/styles.css";
import "../../../src/components/IndustrialTheme.css";
import "./preview.css";

type Item = { id: string; name: string; kind: "image" | "video" };
type Point = { x: number; y: number };
type Press = { item: Item; source: "canvas" | "library"; element: HTMLElement; pointerId: number; start: Point; origin: Point; moved: boolean; carrying: boolean };
const items: Item[] = [{ id: "image", name: "青色立面.jpg", kind: "image" }, { id: "video", name: "街景镜头.mp4", kind: "video" }];
function Artwork({ item }: { item: Item }) {
  return <div className={`material-art material-art-${item.kind}`} aria-hidden><i/><b/>{item.kind === "video" && <Play className="art-play" size={23}/>}</div>;
}
function Preview() {
  const [dark, setDark] = useState(true), [carrying, setCarrying] = useState<{ item: Item; source: Press["source"] } | null>(null);
  const [offsets, setOffsets] = useState<Record<string, Point>>({ image: { x: 0, y: 0 }, video: { x: 0, y: 0 } });
  const [received, setReceived] = useState<Item[]>([]), [over, setOver] = useState(false);
  const [blurBounds, setBlurBounds] = useState<DOMRect | null>(null);
  const press = useRef<Press | null>(null), ghost = useRef<HTMLDivElement>(null), cursor = useRef<Point>({ x: 0, y: 0 });
  const app = useRef<HTMLElement>(null), hold = useRef(createCanvasDragHold());
  const offsetsRef = useRef(offsets); offsetsRef.current = offsets;
  const targetAt = (point: Point) => !!document.elementFromPoint(point.x, point.y)?.closest(".receiver-target");
  function carry(current: Press) {
    if (press.current !== current || current.moved) return;
    current.carrying = true;
    setCarrying({ item: current.item, source: current.source });
  }
  function begin(event: ReactPointerEvent<HTMLElement>, item: Item, source: Press["source"]) {
    if (event.button !== 0 || press.current) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    const start = { x: event.clientX, y: event.clientY };
    cursor.current = start;
    const current: Press = { item, source, element: event.currentTarget, pointerId: event.pointerId, start, origin: offsetsRef.current[item.id], moved: false, carrying: false };
    press.current = current;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (source === "canvas") hold.current.start(event.pointerId, start, () => carry(current));
  }
  useEffect(() => {
    function end(cancelled = false, point?: Point) {
      const current = press.current; if (!current) return;
      press.current = null; hold.current.cancel();
      if (current.carrying && !cancelled && point && targetAt(point)) setReceived(items => [...items.filter(item => item.id !== current.item.id), current.item]);
      if (cancelled && current.moved) setOffsets(value => ({ ...value, [current.item.id]: current.origin }));
      if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
      setCarrying(null); setOver(false);
    }
    function move(event: PointerEvent) {
      cursor.current = { x: event.clientX, y: event.clientY };
      hold.current.move(event.pointerId, cursor.current, event.buttons);
      const current = press.current; if (!current || current.pointerId !== event.pointerId) return;
      if (!(event.buttons & 1)) { end(true); return; }
      if (current.carrying) {
        if (ghost.current) ghost.current.style.transform = `translate3d(${event.clientX + 18}px,${event.clientY + 18}px,0)`;
        setOver(targetAt(cursor.current)); return;
      }
      const dx = event.clientX - current.start.x, dy = event.clientY - current.start.y;
      if (!current.moved && !exceedsCanvasDragThreshold(current.start, cursor.current)) return;
      if (current.source === "library") { carry(current); return; }
      current.moved = true;
      setOffsets(value => ({ ...value, [current.item.id]: { x: current.origin.x + dx, y: current.origin.y + dy } }));
    }
    const up = (event: PointerEvent) => { if (press.current?.pointerId === event.pointerId) end(false, { x: event.clientX, y: event.clientY }); };
    const cancel = () => end(true);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); cancel(); } };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", escape); window.addEventListener("blur", cancel);
    return () => { cancel(); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", cancel); window.removeEventListener("keydown", escape); window.removeEventListener("blur", cancel); };
  }, []);
  useLayoutEffect(() => {
    if (carrying?.source !== "canvas") { setBlurBounds(null); return; }
    const measure = () => setBlurBounds(app.current?.getBoundingClientRect() ?? null);
    measure(); window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [carrying]);
  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; }, [dark]);
  return <main className={`long-press-preview${carrying ? " is-carrying" : ""}`} data-carrying={carrying?.source}>
    <section ref={app} className={`mock-bowerbird${carrying?.source === "canvas" ? " is-blurred" : ""}`} aria-label="Bowerbird 演示界面">
      <header className="mock-topbar"><span className="mock-brand">Bowerbird</span><button className="project-name">城市视觉 <ChevronDown size={13}/></button><div className="mock-topbar-actions"><button aria-label="搜索" title="搜索"><Search size={16}/></button><button aria-label="切换明暗主题" title="切换明暗主题" onClick={() => setDark(value => !value)}><Sun size={16}/></button></div></header>
      <div className="mock-workspace">
        <aside className="mock-sidebar"><div className="mock-nav"><button><Grid2X2 size={15}/>素材库</button><button className="is-active"><Layers size={15}/>画布</button></div>
          <div className="library-heading"><strong>素材库</strong><button aria-label="建立连接" title="建立连接"><Plus size={14}/></button></div>
          <div className="library-items">{items.map(item => <button key={item.id} className="library-material" data-library-asset={item.id} aria-label={`素材库 ${item.name}`} title="直接拖出" onPointerDown={event => begin(event, item, "library")}><Artwork item={item}/><span>{item.name}</span></button>)}</div>
          <div className="mock-folder"><Folder size={14}/><span>城市参考</span><span>2</span></div>
        </aside>
        <section className="mock-canvas"><div className="canvas-heading"><h1>画布</h1><button aria-label="画布选项" title="画布选项"><Maximize2 size={14}/></button></div>
          <div className="canvas-stage">{items.map((item, index) => <div role="button" tabIndex={0} key={item.id} className={`canvas-material canvas-material-${index}`} data-canvas-asset={item.id} aria-label={item.name} title="按住原地拖出" style={{ transform: `translate(${offsets[item.id].x}px,${offsets[item.id].y}px)` }} onPointerDown={event => begin(event, item, "canvas")} onContextMenu={event => event.preventDefault()}><Artwork item={item}/><span>{item.name}</span></div>)}
            <div className="canvas-tools"><MousePointer2 size={16}/><span/><Plus size={17}/><span className="canvas-zoom">100%</span></div>
          </div>
        </section>
      </div>
    </section>
    <section className="external-demo" role="region" aria-label="外部应用演示"><header><h2>对话</h2><span className="demo-badge">接收演示</span></header>
      <div className="receiver-target" data-ready={over}><div className="chat-lines" aria-hidden><i/><i/><i/></div>
        <div className="receiver-composer">{received.map(item => <div className="received-material" data-received={item.id} key={item.id}><div><Artwork item={item}/></div><span>{item.name}</span><Check size={13}/></div>)}<span className="composer-placeholder">添加消息</span><button aria-label="发送演示" disabled><ArrowUpRight size={15}/></button></div>
      </div>
    </section>
    {createPortal(<>{carrying?.source === "canvas" && blurBounds && <div className="app-drag-blur" aria-hidden style={{ left: blurBounds.left, top: blurBounds.top, width: blurBounds.width, height: blurBounds.height }}/>} {carrying && <div ref={ghost} className="carried-material" aria-label={`已抓起 ${carrying.item.name}`} style={{ transform: `translate3d(${cursor.current.x + 18}px,${cursor.current.y + 18}px,0)` }}><Artwork item={carrying.item}/><span className="carried-plus">+</span></div>}</>, document.body)}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview/>);
