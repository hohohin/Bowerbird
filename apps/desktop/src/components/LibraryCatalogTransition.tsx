import { useCallback, useId, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { CategorizedLibrary } from "./CategorizedLibrary";
import { ConnectedCollections } from "./ConnectedCollections";
import type { CatalogKind } from "../lib/materialCatalog";
import "./LibraryCatalogTransition.css";

type Props = ComponentProps<typeof CategorizedLibrary>;
const DURATION = 600;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const easeOut = (value: number) => 1 - Math.pow(1 - clamp(value), 3);
const ease = (value: number) => {
  const t = clamp(value);
  return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

/** Keep the outgoing view until the wipe covers it; load the destination immediately underneath. */
export function LibraryCatalogTransition(props: Props) {
  const [view, setView] = useState({ kind: props.kind, previous: null as CatalogKind | null, covered: true, running: false, sequence: 0 });
  if (view.kind !== props.kind) {
    const visible = view.covered ? view.kind : view.previous!;
    const animate = visible !== props.kind && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    setView({ kind: props.kind, previous: animate ? visible : null, covered: !animate, running: animate, sequence: view.sequence + 1 });
  }
  const cover = useCallback(() => setView(value => ({ ...value, previous: null, covered: true })), []);
  const finish = useCallback(() => setView(value => ({ ...value, previous: null, covered: true, running: false })), []);
  return <div className="library-catalog-transition" aria-busy={view.running}>
    {(["all", "tags", "collections"] as const).filter(kind => kind === view.kind || kind === view.previous).map(kind => {
      const outgoing = kind === view.previous;
      return <div key={kind} className="library-catalog-layer" data-outgoing={outgoing || undefined}
        style={{ visibility: !outgoing && !view.covered ? "hidden" : undefined }} aria-hidden={outgoing || !view.covered || undefined}
        ref={element => { if (element) element.inert = outgoing || !view.covered; }}>
        {kind === "collections" ? <ConnectedCollections {...props} kind={kind} onAssetsChange={outgoing ? undefined : props.onAssetsChange}/> : <CategorizedLibrary {...props} kind={kind} onAssetsChange={outgoing ? undefined : props.onAssetsChange}/>}
      </div>;
    })}
    {view.running && <CatalogWipe key={view.sequence} label={`切换至${view.kind === "all" ? "全部" : view.kind === "collections" ? "集合" : props.media === "videos" ? "平铺" : "标签"}视图`}
      onCovered={cover} onFinish={finish}/>}
  </div>;
}

function CatalogWipe({ label, onCovered, onFinish }: { label: string; onCovered: () => void; onFinish: () => void }) {
  const root = useRef<SVGSVGElement>(null);
  const id = useId().replace(/:/g, "");
  useLayoutEffect(() => {
    const svg = root.current!;
    const ns = "http://www.w3.org/2000/svg";
    function make<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}) {
      const element = document.createElementNS(ns, tag);
      Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
      return element;
    }
    const defs = make("defs"), strips = make("g");
    svg.replaceChildren(defs, strips);
    const tapes = Array.from({ length: 6 }, (_, row) => {
      const group = make("g", { class: "catalog-wipe-tape" });
      const clip = make("clipPath", { id: `${id}-tape-${row}`, clipPathUnits: "userSpaceOnUse" }), shape = make("path");
      clip.append(shape); defs.append(clip); strips.append(group);
      const pieces = ["#293f9c", "#8da6ff", row % 2 ? "#5272ff" : "#4868ff", "#a1b5ff", "#304ab5"].map((fill, index) => {
        const path = make("path", { fill, class: index === 2 ? "catalog-wipe-body" : "catalog-wipe-cap" });
        group.append(path); return path;
      });
      const clipped = make("g", { "clip-path": `url(#${id}-tape-${row})` });
      const text = make("g", { class: "catalog-wipe-text" });
      clipped.append(text); group.append(clipped);
      return { group, shape, pieces, text, row };
    });
    let travel = 0, period = 0, frame = 0, progress = 0, covered = false, disposed = false;
    function draw() {
      // Original approved choreography, scaled uniformly to 600 ms.
      const time = progress * 1100;
      tapes.forEach(({ group, text, row }) => {
        const delay = row * 20;
        const position = -travel * (1 - easeOut((time - delay) / 260)) + travel * ease((time - 650 - delay) / 300);
        group.setAttribute("transform", `translate(${position} 0)`);
        text.setAttribute("transform", `translate(${time * .075 - row * period * .32} 0)`);
      });
    }
    function measure() {
      const { width, height } = svg.getBoundingClientRect();
      if (!width || !height) return;
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      const angle = 22 * Math.PI / 180;
      const length = width * Math.cos(angle) + height * Math.sin(angle), breadth = width * Math.sin(angle) + height * Math.cos(angle);
      const rowHeight = breadth / 6, slant = rowHeight * .28, bodyLength = length + 160, cap = Math.min(100, Math.max(48, width * .11));
      const fontSize = Math.min(38, Math.max(22, rowHeight * .30));
      travel = (length + bodyLength) / 2 + cap * 2 + slant;
      strips.setAttribute("transform", `translate(${width / 2} ${height / 2}) rotate(-22)`);
      const sample = make("text"); sample.textContent = label;
      tapes[0].text.setAttribute("font-size", String(fontSize)); tapes[0].text.append(sample);
      period = sample.getComputedTextLength() * 2; sample.remove();
      tapes.forEach(({ pieces, shape, text, row }) => {
        const y = -breadth / 2 + row * rowHeight, bottom = y + rowHeight + 1;
        const edges = [-bodyLength / 2 - 2 * cap, -bodyLength / 2 - cap, -bodyLength / 2, bodyLength / 2, bodyLength / 2 + cap, bodyLength / 2 + 2 * cap];
        pieces.forEach((path, index) => {
          const d = `M${edges[index]} ${y}H${edges[index + 1]}L${edges[index + 1] + slant} ${bottom}H${edges[index] + slant}Z`;
          path.setAttribute("d", d); if (index === 2) shape.setAttribute("d", d);
        });
        text.setAttribute("font-size", String(fontSize));
        text.replaceChildren(...Array.from({ length: Math.ceil((bodyLength + 1200) / period) + 3 }, (_, index) => {
          const word = make("text", { x: -bodyLength / 2 - 2 * period + index * period, y: y + rowHeight / 2, "dominant-baseline": "central" });
          word.textContent = label; return word;
        }));
      });
      draw();
    }
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const stop = () => { cancelAnimationFrame(frame); onFinish(); };
    const preferenceChanged = () => { if (reduced.matches) stop(); };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(svg);
    reduced.addEventListener("change", preferenceChanged);
    const start = performance.now();
    function tick(now: number) {
      progress = clamp((now - start) / DURATION); draw();
      // All six strips are opaque here, before any strip starts to leave.
      if (!covered && progress >= 400 / 1100) { covered = true; onCovered(); }
      if (progress < 1) frame = requestAnimationFrame(tick); else onFinish();
    }
    if (reduced.matches) stop(); else frame = requestAnimationFrame(tick);
    void document.fonts.ready.then(() => { if (!disposed) measure(); });
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); reduced.removeEventListener("change", preferenceChanged); };
  }, [id, label, onCovered, onFinish]);
  return <svg ref={root} className="catalog-view-wipe" aria-hidden="true"/>;
}
