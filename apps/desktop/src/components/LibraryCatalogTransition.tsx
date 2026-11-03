import { useCallback, useLayoutEffect, useRef, useState, type ComponentProps, type RefObject } from "react";
import { CategorizedLibrary } from "./CategorizedLibrary";
import { ConnectedCollections } from "./ConnectedCollections";
import type { CatalogKind } from "../lib/materialCatalog";
import "./LibraryCatalogTransition.css";

type Props = ComponentProps<typeof CategorizedLibrary>;
const DURATION = 790;
const EASE = "cubic-bezier(.65,0,.35,1)";
const at = (time: number, values: Keyframe, easing = EASE): Keyframe => ({ ...values, offset: time / DURATION, easing });

export function LibraryCatalogTransition(props: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ kind: props.kind, previous: null as CatalogKind | null, sequence: 0 });
  if (view.kind !== props.kind) {
    const animate = view.kind !== "all" && props.kind !== "all" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    setView({ kind: props.kind, previous: animate ? view.kind : null, sequence: view.sequence + 1 });
  }
  const finish = useCallback(() => setView(value => ({ ...value, previous: null })), []);
  return <div ref={root} className="library-catalog-transition" aria-busy={view.previous !== null}>
    {(["all", "tags", "collections"] as const).filter(kind => kind === view.kind || kind === view.previous).map(kind => {
      const outgoing = kind === view.previous;
      return <div key={kind} className="library-catalog-layer" data-outgoing={outgoing || undefined} aria-hidden={outgoing || undefined}
        ref={element => { if (element) element.inert = outgoing; }}>
        {kind === "collections" ? <ConnectedCollections {...props} kind={kind} onAssetsChange={outgoing ? undefined : props.onAssetsChange}/> : <CategorizedLibrary {...props} kind={kind} onAssetsChange={outgoing ? undefined : props.onAssetsChange}/>}
      </div>;
    })}
    {view.previous && <SidebarInstall key={view.sequence} root={root} onFinish={finish}/>}
  </div>;
}

/** Promote the real sidebar, preserving React state and late-loading rows, above clipping ancestors. */
function floatSidebar(sidebar: HTMLElement, direction: "incoming" | "outgoing") {
  const originalStyle = sidebar.getAttribute("style");
  const originalInert = sidebar.inert;
  const slot = sidebar.cloneNode(false) as HTMLElement;
  slot.removeAttribute("id"); slot.removeAttribute("aria-label");
  slot.dataset.sidebarSlot = ""; slot.setAttribute("aria-hidden", "true"); slot.inert = true;
  sidebar.before(slot);
  sidebar.dataset.sidebarMotion = direction;
  sidebar.setAttribute("popover", "manual"); sidebar.inert = true;
  const measure = () => {
    const rect = slot.getBoundingClientRect();
    Object.assign(sidebar.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  };
  measure(); sidebar.showPopover();
  const observer = new ResizeObserver(measure); observer.observe(slot);
  window.addEventListener("resize", measure);
  window.addEventListener("scroll", measure, true);
  return () => {
    observer.disconnect(); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true);
    if (sidebar.isConnected && sidebar.matches(":popover-open")) sidebar.hidePopover();
    sidebar.removeAttribute("popover"); delete sidebar.dataset.sidebarMotion;
    if (originalStyle === null) sidebar.removeAttribute("style"); else sidebar.setAttribute("style", originalStyle);
    sidebar.inert = originalInert; slot.remove();
  };
}

function animateSidebars(old: HTMLElement, next: HTMLElement) {
  const play = (element: HTMLElement, frames: Keyframe[]) => element.animate(frames, { duration: DURATION, fill: "both" });
  const shadow = "0 12px 22px -8px rgb(0 0 0 / .336), inset 0 1px 0 rgb(128 128 128 / .18)";
  const move = (x: number, y: number) => ({ transform: `translate(${x}px,${y}px)`, clipPath: `inset(-32px -32px -32px ${-x}px)` });
  return [
    play(old, [at(0, { filter: "blur(0px)" }), at(180, { filter: "blur(3px)" }), at(790, { filter: "blur(3px)" })]),
    play(old, [at(0, { visibility: "visible" }, "steps(1,end)"), at(390, { visibility: "hidden" }), at(790, { visibility: "hidden" })]),
    play(next, [at(0, move(-48,-20)), at(90, move(-48,-20)), at(330, move(0,-20)), at(390, move(0,-20)), at(590, move(0,0)), at(790, move(0,0))]),
    play(next, [at(0, { opacity: 0 }), at(90, { opacity: 0 }), at(330, { opacity: 1 }, "steps(1,end)"),
      ...[[590,.58],[640,1],[690,.58],[740,1],[790,1]].map(([time, opacity]) => at(time, { opacity }, "steps(1,end)"))]),
    play(next, [at(0, { boxShadow: shadow }), at(390, { boxShadow: shadow }), at(590, { boxShadow: "none" }), at(790, { boxShadow: "none" })]),
  ];
}

function SidebarInstall({ root, onFinish }: { root: RefObject<HTMLDivElement>; onFinish: () => void }) {
  useLayoutEffect(() => {
    const old = root.current?.querySelector<HTMLElement>('[data-outgoing] .catalog-sidebar');
    const next = root.current?.querySelector<HTMLElement>('.library-catalog-layer:not([data-outgoing]) .catalog-sidebar');
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    if (!old || !next || !next.showPopover || reduced.matches || root.current?.closest('[inert], [aria-hidden="true"]')) { onFinish(); return; }
    const restoreOld = floatSidebar(old, "outgoing"), restoreNext = floatSidebar(next, "incoming");
    const animations = animateSidebars(old, next);
    let disposed = false;
    void animations[0].finished.then(() => { if (!disposed) onFinish(); }, () => {});
    const preferenceChanged = () => { if (reduced.matches) onFinish(); };
    reduced.addEventListener("change", preferenceChanged);
    // A collapsed canvas drawer remains mounted; it must not leave a top-layer sidebar behind.
    const hidden = new MutationObserver(() => { if (root.current?.closest('[inert], [aria-hidden="true"]')) onFinish(); });
    for (let ancestor: HTMLElement | null = root.current; ancestor; ancestor = ancestor.parentElement) {
      hidden.observe(ancestor, { attributes: true, attributeFilter: ["inert", "aria-hidden"] });
    }
    return () => {
      disposed = true; hidden.disconnect(); reduced.removeEventListener("change", preferenceChanged);
      animations.forEach(animation => animation.cancel()); restoreNext(); restoreOld();
    };
  }, [root, onFinish]);
  return null;
}
