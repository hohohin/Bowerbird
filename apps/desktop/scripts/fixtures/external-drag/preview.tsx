import { useEffect, useRef, useState, type DragEvent } from "react";
import { createRoot } from "react-dom/client";
import { ArrowUpRight, Check, Image, MoreHorizontal, Music2, Play, Sun, X } from "lucide-react";
import { ContextMenu } from "../../../src/components/ContextMenu";
import "../../../src/styles.css";
import "../../../src/components/IndustrialTheme.css";
import "../../../src/components/IndustrialMenus.css";
import "./preview.css";

type Item = { id: string; name: string; kind: "image" | "video" | "audio"; note: string };
const items: Item[] = [
  { id: "image", name: "青色立面.jpg", kind: "image", note: "2400 × 1600" },
  { id: "video", name: "街景镜头.mp4", kind: "video", note: "0:18" },
  { id: "audio", name: "雨声.flac", kind: "audio", note: "0:24" },
];
function Artwork({ item }: { item: Item }) {
  if (item.kind === "audio") return <div className="demo-audio" aria-hidden><svg viewBox="0 0 240 100" preserveAspectRatio="none">{Array.from({ length: 80 }, (_, i) => {
    const h = 8 + (Math.sin(i * .7) ** 2 * .55 + Math.cos(i * .19) ** 2 * .45) * 68;
    return <line key={i} x1={i * 3} x2={i * 3} y1={50 - h / 2} y2={50 + h / 2}/>;
  })}</svg><Music2 size={16}/></div>;
  return <div className={`demo-art demo-art-${item.kind}`} aria-hidden><i/><b/>{item.kind === "video" && <Play className="demo-play" size={22}/>}</div>;
}
function Preview() {
  const [selected, setSelected] = useState<string[]>([]), [received, setReceived] = useState<Item[]>([]);
  const [carried, setCarried] = useState<Item[] | null>(null), [dragging, setDragging] = useState<Item[] | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null), [target, setTarget] = useState<"chat" | "timeline">("chat");
  const [hoverTarget, setHoverTarget] = useState(false), [cancelled, setCancelled] = useState(false);
  const [canvasOffset, setCanvasOffset] = useState({ x: 0, y: 0 });
  const moving = useRef<{ x: number; y: number; left: number; top: number } | null>(null), ghost = useRef<HTMLDivElement>(null);
  const cursor = useRef({ x: 600, y: 250 });
  const active = carried ?? dragging;
  useEffect(() => {
    const move = (event: PointerEvent) => {
      cursor.current = { x: event.clientX, y: event.clientY };
      if (ghost.current) ghost.current.style.transform = `translate3d(${event.clientX + 18}px,${event.clientY + 18}px,0)`;
      if (moving.current) setCanvasOffset({ x: moving.current.left + event.clientX - moving.current.x, y: moving.current.top + event.clientY - moving.current.y });
    };
    const end = () => { moving.current = null; };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setCarried(null); setDragging(null); setHoverTarget(false); setCancelled(true); } };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("keydown", escape); };
  }, []);
  useEffect(() => { document.body.classList.toggle("is-carrying", !!carried); return () => document.body.classList.remove("is-carrying"); }, [carried]);
  function receive(value: Item[] | null) {
    if (!value?.length) return;
    setReceived(previous => [...new Map([...previous, ...value].map(item => [item.id, item])).values()]);
    setCarried(null); setDragging(null); setHoverTarget(false); setCancelled(false);
  }
  function start(event: DragEvent, item: Item) {
    const value = selected.includes(item.id) ? items.filter(item => selected.includes(item.id)) : [item];
    event.dataTransfer.effectAllowed = "copy"; event.dataTransfer.setData("text/plain", value.map(item => item.name).join("\n"));
    setDragging(value); setCancelled(false);
  }
  function pickup() { setMenu(null); setCarried([items[0]]); setCancelled(false); }
  return <div className="drag-demo">
    <header className="drag-demo-header"><span className="demo-brand">Bowerbird</span><h1>拖出素材</h1><div className="demo-header-actions">
      <button title="切换主题" aria-label="切换主题" onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "light" ? "dark" : "light"; }}><Sun size={16}/></button>
    </div></header>
    <main className="drag-demo-columns">
      <section className="drag-library"><h2>素材库</h2><div className="demo-library-list">{items.map(item => <button key={item.id} data-id={item.id} aria-label={item.name} aria-pressed={selected.includes(item.id)}
        className={`demo-material ${selected.includes(item.id) ? "is-selected" : ""}`} draggable onDragStart={event => start(event, item)} onDragEnd={() => { setDragging(null); setHoverTarget(false); }}
        onClick={event => { setSelected(previous => event.ctrlKey || event.metaKey ? previous.includes(item.id) ? previous.filter(id => id !== item.id) : [...previous, item.id] : [item.id]); }}>
        <Artwork item={item}/><span className="demo-material-meta"><span>{item.name}</span><small>{item.note}</small></span>{selected.includes(item.id) && <Check className="demo-selected" size={14}/>}
      </button>)}</div></section>
      <section className="drag-canvas"><h2>画布</h2><div className="demo-canvas-workspace">
        <article className="demo-canvas-card" data-id="image" style={{ transform: `translate(${canvasOffset.x}px,${canvasOffset.y}px)` }} tabIndex={0}
          onPointerDown={event => { if (event.button === 0 && !(event.target as HTMLElement).closest("button") && !carried) { event.preventDefault(); moving.current = { x: event.clientX, y: event.clientY, left: canvasOffset.x, top: canvasOffset.y }; } }}
          onContextMenu={event => { event.preventDefault(); moving.current = null; setMenu({ x: event.clientX, y: event.clientY }); }}
          onKeyDown={event => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left + 48, y: rect.top + 48 }); } }}>
          <Artwork item={items[0]}/><div className="demo-canvas-card-name"><span>青色立面.jpg</span><button aria-label="素材更多操作" onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ x: box.right, y: box.bottom }); }}><MoreHorizontal size={16}/></button></div>
        </article>
      </div></section>
      <section className="demo-receiver-shell"><header><h2>外部应用 <small>演示</small></h2><button aria-label="清空接收区" title="清空接收区" onClick={() => setReceived([])}><X size={15}/></button></header>
        <div className="demo-receiver-tabs"><button aria-pressed={target === "chat"} onClick={() => setTarget("chat")}>对话框</button><button aria-pressed={target === "timeline"} onClick={() => setTarget("timeline")}>剪辑时间线</button></div>
        <div role="region" aria-label="外部应用演示" className={`demo-receiver ${target} ${hoverTarget && active ? "is-ready" : ""}`} tabIndex={0}
          onPointerEnter={() => setHoverTarget(true)} onPointerLeave={() => setHoverTarget(false)} onClick={() => receive(carried)}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); receive(carried); } }}
          onDragOver={event => { if (dragging) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setHoverTarget(true); } }}
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHoverTarget(false); }}
          onDrop={event => { event.preventDefault(); receive(dragging); }}>
          {target === "chat" ? <><div className="demo-chat-empty" aria-hidden><i/><i/><i/></div><div className="demo-chat-composer">
            {received.map(item => <div className="received-item" key={item.id}><span className="received-preview"><Artwork item={item}/></span><span>{item.name}</span><Check size={13}/></div>)}
            <span className="demo-receiver-placeholder">{active ? carried ? "点击放下" : "松开放下" : received.length ? "已添加附件" : "将素材放到这里"}</span><span className="demo-send" aria-hidden>↑</span>
          </div></> : <><div className="demo-monitor">{received.length ? <Artwork item={received[0]}/> : <Image size={28}/>}</div><div className="demo-timeline"><div className="demo-timeline-ruler"><span>00:00</span><span>00:05</span><span>00:10</span></div>
            {received.map(item => <div className="received-item timeline-clip" key={item.id}><span>{item.name}</span></div>)}<i className="demo-timeline-needle"/>{!received.length && <span className="demo-receiver-placeholder">{active ? carried ? "点击放下" : "松开放下" : "将素材放到这里"}</span>}
          </div></>}
        </div>
      </section>
    </main>
    <footer className="demo-footer" role="status">{carried ? <><span>已抓起 1 项素材</span><button onClick={() => { setCarried(null); setHoverTarget(false); }}>取消 <kbd>Esc</kbd></button></> : cancelled ? <span>已取消</span> : <span>独立交互示意 · 不会向其他应用发送文件</span>}</footer>
    {menu && <ContextMenu x={menu.x} y={menu.y} label="素材操作" onClose={() => setMenu(null)}><button role="menuitem" className="app-context-item" onClick={pickup}><ArrowUpRight size={14}/>拖入到其他应用</button></ContextMenu>}
    {carried && <div ref={ghost} className="carried-preview" aria-hidden style={{ transform: `translate3d(${cursor.current.x + 18}px,${cursor.current.y + 18}px,0)` }}><Artwork item={carried[0]}/><span className="carried-count">{carried.length}</span><span className="carried-plus">+</span></div>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview/>);
