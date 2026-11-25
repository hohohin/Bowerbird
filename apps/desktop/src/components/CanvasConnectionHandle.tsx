import { forwardRef, memo, useCallback, useEffect, useRef, type ButtonHTMLAttributes, type RefObject, type PointerEvent } from "react";
import "./CanvasConnectionHandle.css";

export interface CanvasConnectionHandleProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  side: "input" | "output";
  active?: boolean;
}

type HandleController = { follow: (event: globalThis.PointerEvent, rect: DOMRect, width: number) => void; reset: () => void; press: (event: PointerEvent<HTMLButtonElement>) => void };
const handles = new Map<HTMLButtonElement, { current: HandleController }>();
const widths = new WeakMap<Element, number>();
let sizes: ResizeObserver | undefined;
let motionQuery: MediaQueryList | undefined;
let hoverFrame = 0;
let hoverEvent: globalThis.PointerEvent | undefined;
let hovered: HTMLButtonElement | null = null;
function resetHovered() {
  if (hovered) { hovered.removeAttribute("data-connection-hover"); handles.get(hovered)?.current.reset(); }
  hovered = null;
}
function cancelHover() {
  cancelAnimationFrame(hoverFrame);
  hoverFrame = 0;
  hoverEvent = undefined;
  resetHovered();
}
function nearestHandle(event: globalThis.PointerEvent) {
  // Existing wires can cross a socket; the socket's hot zone wins there.
  if (!(event.target instanceof Element) || !event.target.closest(".canvas-connection-handle,.workflow-wires")) return null;
  let nearest: { element: HTMLButtonElement; rect: DOMRect; distance: number } | null = null;
  const visited = new Set<Element>();
  for (const hit of document.elementsFromPoint(event.clientX, event.clientY)) {
    const element = hit.closest<HTMLButtonElement>(".canvas-connection-handle");
    if (!element || visited.has(element) || element.disabled || !handles.has(element)) continue;
    visited.add(element);
    const rect = element.getBoundingClientRect();
    const distance = Math.hypot(event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
    if (!nearest || distance < nearest.distance) nearest = { element, rect, distance };
  }
  return nearest;
}
function delegatedMove(event: globalThis.PointerEvent) {
  hoverEvent = event;
  if (!hoverFrame) hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0;
    const sample = hoverEvent;
    hoverEvent = undefined;
    if (!sample) return;
    const nearest = nearestHandle(sample);
    if (hovered !== nearest?.element) resetHovered();
    if (!nearest) return;
    hovered = nearest.element;
    hovered.setAttribute("data-connection-hover", "true");
    handles.get(hovered)?.current.follow(sample, nearest.rect, widths.get(hovered) ?? 0);
  });
}
function delegatedDown(event: globalThis.PointerEvent) {
  const nearest = nearestHandle(event);
  cancelHover();
  if (!nearest || event.button !== 0 || (event.target as Element).closest(".canvas-connection-handle") === nearest.element) return;
  event.preventDefault();
  event.stopPropagation();
  // Route the real pointer event to the nearest socket's callback. No synthetic
  // DOM click is dispatched, so a drag still has exactly one start and one end.
  const routed = new Proxy(event, { get(target, key) {
    if (key === "currentTarget" || key === "target") return nearest.element;
    if (key === "nativeEvent") return event;
    if (key === "isDefaultPrevented") return () => event.defaultPrevented;
    if (key === "isPropagationStopped") return () => true;
    if (key === "persist") return () => {};
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } }) as unknown as PointerEvent<HTMLButtonElement>;
  handles.get(nearest.element)?.current.press(routed);
}
function registerHandle(element: HTMLButtonElement, controller: { current: HandleController }) {
  if (!handles.size) {
    motionQuery ??= window.matchMedia("(prefers-reduced-motion: reduce)");
    sizes = new ResizeObserver(entries => {
      for (const { target, borderBoxSize, contentRect } of entries) widths.set(target, borderBoxSize[0]?.inlineSize ?? contentRect.width);
    });
    document.addEventListener("pointermove", delegatedMove, true);
    document.addEventListener("pointerdown", delegatedDown, true);
    document.addEventListener("pointercancel", cancelHover, true);
    window.addEventListener("blur", cancelHover);
  }
  handles.set(element, controller);
  sizes?.observe(element);
}
function unregisterHandle(element: HTMLButtonElement) {
  if (hovered === element) resetHovered();
  handles.delete(element);
  sizes?.unobserve(element);
  widths.delete(element);
  if (!handles.size) {
    sizes?.disconnect();
    sizes = undefined;
    cancelHover();
    document.removeEventListener("pointermove", delegatedMove, true);
    document.removeEventListener("pointerdown", delegatedDown, true);
    document.removeEventListener("pointercancel", cancelHover, true);
    window.removeEventListener("blur", cancelHover);
  }
}

export const CanvasConnectionDefinitions = memo(function CanvasConnectionDefinitions() {
  return <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: "absolute" }}>
    <defs>
      <pattern id="canvas-connection-hatch" width="2" height="2" patternUnits="userSpaceOnUse">
        <path d="M-1 1l2-2M0 2l2-2M1 3l2-2" stroke="white" strokeWidth=".5" />
      </pattern>
      <mask id="canvas-connection-hatch-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="28" height="28">
        <rect width="28" height="28" fill="url(#canvas-connection-hatch)" />
      </mask>
    </defs>
  </svg>;
});

const ConnectionGlyph = memo(function ConnectionGlyph({ glyphRef }: { glyphRef: RefObject<HTMLSpanElement> }) {
  return <span ref={glyphRef} className="canvas-connection-glyph" aria-hidden="true">
    <svg width="28" height="28" viewBox="0 0 28 28" focusable="false">
      <rect x="1.5" y="1.5" width="25" height="25" stroke="currentColor" strokeWidth=".6" opacity=".35" />
      <path d="M1.5 7v14M26.5 7v14" stroke="currentColor" strokeWidth="1" />
      <path d="M.5.5h2v2h-2zM25.5.5h2v2h-2zM.5 25.5h2v2h-2zM25.5 25.5h2v2h-2z" fill="currentColor" />
      <path d="M12.25 5h3.5v7.25H23v3.5h-7.25V23h-3.5v-7.25H5v-3.5h7.25z" fill="currentColor" mask="url(#canvas-connection-hatch-mask)" />
    </svg>
  </span>;
});

/** The hit area stays still; only the small visible socket follows the pointer. */
export const CanvasConnectionHandle = memo(forwardRef<HTMLButtonElement, CanvasConnectionHandleProps>(function CanvasConnectionHandle({
  side, active = false, className = "", disabled, onPointerEnter, onPointerMove, onPointerLeave,
  onPointerDown, onPointerUp, onPointerCancel, onBlur, children: _children, ...props
}, forwardedRef) {
  const glyph = useRef<HTMLSpanElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const frame = useRef(0);
  const offset = useRef({ x: 0, y: 0 });
  function move(x = 0, y = 0) {
    offset.current = { x, y };
    if (!frame.current) frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      glyph.current?.style.setProperty("--connection-magnet-x", `${offset.current.x}px`);
      glyph.current?.style.setProperty("--connection-magnet-y", `${offset.current.y}px`);
    });
  }
  function follow(event: globalThis.PointerEvent, rect: DOMRect, width: number) {
    if (disabled || active || event.buttons || event.pointerType === "touch" || motionQuery?.matches) { move(); return; }
    // The pointer and hit rect are in screen pixels; translate the glyph in canvas units.
    if (!button.current || rect.width <= 0 || width <= 0) return;
    const unitsPerPixel = width / rect.width;
    const x = (event.clientX - rect.left - rect.width / 2) * unitsPerPixel;
    const y = (event.clientY - rect.top - rect.height / 2) * unitsPerPixel;
    const distance = Math.hypot(x, y);
    const strength = distance ? Math.min(0.3, 8 / distance) : 0;
    // Keep the frame outside the card's clipped content boundary.
    move(side === "output" ? Math.max(-4, x * strength) : Math.min(4, x * strength), y * strength);
  }
  const controller = useRef<HandleController>({ follow, reset: move, press: event => onPointerDown?.(event) });
  controller.current = { follow, reset: move, press: event => { move(); onPointerDown?.(event); } };
  const setRef = useCallback((node: HTMLButtonElement | null) => {
    if (button.current) unregisterHandle(button.current);
    button.current = node;
    if (node) registerHandle(node, controller);
    if (typeof forwardedRef === "function") forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  }, [forwardedRef]);
  useEffect(() => {
    if (active || disabled) move();
  }, [active, disabled]);
  useEffect(() => () => { cancelAnimationFrame(frame.current); frame.current = 0; }, []);
  return <button {...props} ref={setRef} type={props.type ?? "button"} disabled={disabled}
    aria-label={props["aria-label"] ?? (side === "input" ? "添加上游" : "添加下游")}
    title={props.title ?? (side === "input" ? "添加上游" : "添加下游")}
    data-canvas-connect-side={side} data-connection-active={active || undefined}
    className={`canvas-connection-handle is-${side}${active ? " is-active" : ""} ${className}`}
    onPointerEnter={onPointerEnter}
    onPointerMove={onPointerMove}
    onPointerLeave={event => { if (hovered === event.currentTarget) resetHovered(); onPointerLeave?.(event); }}
    onPointerDown={event => { move(); onPointerDown?.(event); }}
    onPointerUp={event => { move(); onPointerUp?.(event); }}
    onPointerCancel={event => { move(); onPointerCancel?.(event); }}
    onBlur={event => { move(); onBlur?.(event); }}>
    <ConnectionGlyph glyphRef={glyph} />
  </button>;
}));
