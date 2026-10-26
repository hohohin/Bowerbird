import { useLayoutEffect, useRef, useState } from "react";
import "./ExplorerClassificationDock.css";

export interface ExplorerClassificationItem {
  id: string;
  imageUrl: string;
  origin: { x: number; y: number };
  labels?: string[];
  outcome?: "matched" | "unmatched" | "failed";
  completedOrder?: number;
}

type Stage = "enter" | "pending" | "ready" | "extract" | "settle" | "reveal" | "hold" | "exit" | "gone";
type Point = { x: number; y: number };
type Card = { id: string; serial: number; slot: number | null; stage: Stage; at: number; from: Point; pose: Point; reduced: boolean };
const SCALE = .6;
const ease = (t: number) => 1 - Math.pow(1 - t, 3);
const blend = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const resultText = (item: ExplorerClassificationItem) => item.outcome === "failed" ? ["标签识别未完成"]
  : item.outcome === "unmatched" || !item.labels?.length ? ["暂无匹配标签"] : item.labels;

function Preview({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  return <div className="explorer-classification-image" data-image-unavailable={failed || undefined}>
    {failed ? <span className="explorer-classification-image-placeholder">图片</span>
      : <img src={url} alt="" draggable={false} onError={() => setFailed(true)} />}
  </div>;
}

export function ExplorerClassificationDock({ items, onDone }: { items: ExplorerClassificationItem[]; onDone: (id: string) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLDivElement>());
  const latest = useRef(items);
  const done = useRef(onDone);
  const sync = useRef<() => void>(() => {});
  latest.current = items;
  done.current = onDone;

  useLayoutEffect(() => {
    const dock = root.current!;
    const floor = dock.querySelector<HTMLElement>(".explorer-classification-floor")!;
    const overflow = dock.querySelector<HTMLElement>("[data-classification-overflow]")!;
    const announcement = dock.querySelector<HTMLElement>("[data-classification-announcement]")!;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const cards = new Map<string, Card>();
    let serial = 0, clock = 0, previous = 0, frame = 0, disposed = false, painting = false;
    let presenting: string | null = null;
    let width = 510, hostWidth = 510, bounds = dock.getBoundingClientRect();

    const slotPoint = (slot: number): Point => {
      const radius = width * 1.6, x = 42 + slot * (width * .72 / 5), dx = x + 60;
      return { x, y: 134 + radius - Math.sqrt(Math.max(0, radius * radius - dx * dx)) };
    };
    const frontPoint = (): Point => ({ x: hostWidth < 510 ? 108 : 176, y: -12 });
    const stage = (card: Card, next: Stage) => { card.stage = next; card.at = clock; };
    const measure = () => {
      width = dock.clientWidth || 510;
      hostWidth = dock.parentElement?.clientWidth || width;
      bounds = dock.getBoundingClientRect();
      const radius = width * 1.6;
      Object.assign(floor.style, { left: `${-60 - radius}px`, top: "134px", width: `${2 * radius}px`, height: `${2 * radius}px` });
      dock.style.setProperty("--classification-label-width", `${Math.max(48, Math.min(146, (hostWidth - 8) / SCALE - (frontPoint().x - 104 + 190)))}px`);
    };
    const allocate = () => {
      const used = new Set([...cards.values()].filter(card => card.stage !== "gone" && card.slot !== null).map(card => card.slot));
      for (const card of cards.values()) {
        if (card.slot !== null || card.stage !== "enter") continue;
        const free = [0, 1, 2, 3, 4, 5].filter(slot => !used.has(slot));
        if (!free.length) break;
        card.slot = free[Math.floor(Math.random() * free.length)];
        used.add(card.slot);
        card.at = clock;
      }
    };
    const paint = () => {
      const byId = new Map(latest.current.map(item => [item.id, item]));
      if (!presenting) {
        const next = [...cards.values()].filter(card => card.stage === "ready")
          .sort((a, b) => (byId.get(a.id)?.completedOrder ?? a.serial) - (byId.get(b.id)?.completedOrder ?? b.serial))[0];
        if (next) {
          presenting = next.id;
          next.from = next.pose;
          next.reduced = motion.matches;
          stage(next, next.reduced ? "reveal" : "extract");
          const item = byId.get(next.id)!;
          announcement.textContent = `第 ${next.serial} 张素材：${resultText(item).join("、")}`;
        }
      }
      let moving = false;
      for (const card of cards.values()) {
        const element = elements.current.get(card.id);
        if (!element) continue;
        const active = card.id === presenting;
        const visible = card.stage !== "gone" && (card.slot !== null || active);
        element.hidden = !visible;
        element.dataset.stage = card.stage;
        element.dataset.slot = card.slot === null ? "queue" : String(card.slot);
        if (!visible) continue;
        const elapsed = clock - card.at;
        const front = frontPoint(), raised = { ...front, y: front.y - 10 };
        let pose = card.slot === null ? card.pose : slotPoint(card.slot), opacity = 1, tilt = -16, labelOpacity = 0;
        if (card.stage === "enter") {
          const t = Math.min(1, elapsed / (motion.matches ? 120 : 580));
          pose = motion.matches ? pose : blend(card.from, pose, ease(t));
          opacity = motion.matches ? t : 1;
          if (t === 1) stage(card, "pending");
          else moving = true;
        }
        if (active) {
          moving = true;
          if (card.stage === "extract") {
            const t = Math.min(1, elapsed / 400);
            pose = blend(card.from, raised, ease(t));
            if (t === 1) stage(card, "settle");
          } else if (card.stage === "settle") {
            const t = Math.min(1, elapsed / 320);
            pose = blend(raised, front, ease(t)); tilt = -16 * (1 - ease(t));
            if (t === 1) stage(card, "reveal");
          } else {
            pose = front; tilt = 0;
            if (card.stage === "reveal") {
              const t = Math.min(1, elapsed / (card.reduced ? 120 : 250));
              labelOpacity = card.reduced ? t : t < .2 ? t / .2 : t < .52 ? 1 : t < .72 ? .18 : 1;
              opacity = card.reduced ? t : 1;
              if (t === 1) stage(card, "hold");
            } else if (card.stage === "hold") {
              labelOpacity = 1;
              if (elapsed >= 1000) stage(card, "exit");
            } else if (card.stage === "exit") {
              const t = Math.min(1, elapsed / (card.reduced ? 160 : 420));
              labelOpacity = 1;
              if (!card.reduced) pose = { ...front, x: front.x - (front.x + 350) * t * t };
              opacity = card.reduced ? 1 - t : 1 - Math.max(0, (t - .5) / .5);
              if (t === 1) {
                stage(card, "gone"); card.slot = null; presenting = null;
                element.hidden = true; element.dataset.stage = "gone";
                done.current(card.id);
                allocate();
                continue;
              }
            }
          }
        }
        card.pose = pose;
        element.style.transform = `translate3d(${pose.x - 104}px,${pose.y - 78}px,0)`;
        element.style.opacity = String(opacity);
        element.style.zIndex = active ? "30" : String(card.slot ?? 0);
        element.style.setProperty("--classification-card-tilt", `${motion.matches && !active ? 0 : tilt}deg`);
        element.style.setProperty("--classification-label-opacity", String(labelOpacity));
        element.dataset.stage = card.stage;
      }
      const waiting = [...cards.values()].filter(card => card.slot === null && card.stage !== "gone" && card.id !== presenting).length;
      overflow.hidden = !waiting;
      const count = `另有 ${waiting} 张排队`;
      if (overflow.textContent !== count) overflow.textContent = count;
      return moving || [...cards.values()].some(card => card.stage === "ready");
    };
    const tick = (now: number) => {
      if (disposed || document.hidden) { frame = 0; previous = 0; return; }
      if (previous) clock += now - previous;
      previous = now;
      // Keep ownership of this RAF through onDone: a synchronous parent update
      // must not start another loop while this frame is still being painted.
      painting = true;
      const moving = paint();
      painting = false;
      frame = 0;
      if (!disposed && !document.hidden && moving) frame = requestAnimationFrame(tick);
      else previous = 0;
    };
    const start = () => {
      if (!disposed && !document.hidden && !frame && !painting) {
        previous = performance.now();
        frame = requestAnimationFrame(tick);
      }
    };
    sync.current = () => {
      measure();
      const ids = new Set(latest.current.map(item => item.id));
      for (const id of cards.keys()) if (!ids.has(id)) { cards.delete(id); if (presenting === id) presenting = null; }
      for (const item of latest.current) {
        let card = cards.get(item.id);
        if (!card) {
          const from = { x: (item.origin.x - bounds.left) / SCALE, y: (item.origin.y - bounds.top) / SCALE };
          card = { id: item.id, serial: ++serial, slot: null, stage: item.outcome ? "ready" : "enter", at: clock, from, pose: from, reduced: motion.matches };
          cards.set(item.id, card);
        } else if (item.outcome && ["enter", "pending"].includes(card.stage)) {
          if (card.slot === null) card.pose = slotPoint(0);
          stage(card, "ready");
        }
        const label = elements.current.get(item.id)?.querySelector("[data-classification-serial]");
        if (label) label.textContent = String(card.serial).padStart(2, "0");
      }
      allocate();
      if (!painting) paint();
      start();
    };
    const resize = new ResizeObserver(() => { measure(); paint(); start(); });
    resize.observe(dock);
    if (dock.parentElement) resize.observe(dock.parentElement);
    const visibility = () => {
      cancelAnimationFrame(frame); frame = 0; previous = 0;
      if (!document.hidden) start();
    };
    const motionChanged = () => {
      const active = presenting ? cards.get(presenting) : undefined;
      if (motion.matches && active) {
        active.reduced = true;
        if (active.stage === "extract" || active.stage === "settle") stage(active, "reveal");
      }
      paint(); start();
    };
    document.addEventListener("visibilitychange", visibility);
    motion.addEventListener("change", motionChanged);
    sync.current();
    return () => {
      disposed = true; cancelAnimationFrame(frame); resize.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      motion.removeEventListener("change", motionChanged);
      sync.current = () => {};
    };
  }, []);
  useLayoutEffect(() => sync.current(), [items]);

  return <div ref={root} className="explorer-classification-dock" data-explorer-classification-dock hidden={!items.length} aria-label="分类暂存区">
    <div className="explorer-classification-floor" aria-hidden="true"><div /></div>
    {items.map(item => <div key={item.id} ref={element => { if (element) elements.current.set(item.id, element); else elements.current.delete(item.id); }}
      className="explorer-classification-card" data-classification-id={item.id} data-outcome={item.outcome} hidden>
      <div className="explorer-classification-sheet">
        <Preview key={item.imageUrl} url={item.imageUrl} />
        <div className="explorer-classification-marks" aria-hidden="true">
          <span className="explorer-classification-serial" data-classification-serial />
          <span className="explorer-classification-status" /><span className="explorer-classification-axis" /><span className="explorer-classification-register" />
        </div>
      </div>
      <div className="explorer-classification-labels" data-classification-labels aria-hidden="true">
        {item.outcome && resultText(item).map((label, index) => <span key={`${index}:${label}`}>{label}</span>)}
      </div>
    </div>)}
    <span className="explorer-classification-overflow" data-classification-overflow hidden />
    <span className="explorer-classification-announcement" data-classification-announcement role="status" aria-live="polite" aria-atomic="true" />
  </div>;
}
