import { forwardRef, useCallback, useEffect, useId, useRef, type ButtonHTMLAttributes, type CSSProperties, type PointerEvent } from "react";
import "./CanvasConnectionHandle.css";

export interface CanvasConnectionHandleProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  side: "input" | "output";
  active?: boolean;
  zoom?: number;
}

type HandleController = { follow: (event: globalThis.PointerEvent, rect: DOMRect) => void; reset: () => void; press: (event: PointerEvent<HTMLButtonElement>) => void };
const handles = new Map<HTMLButtonElement, { current: HandleController }>();
let hovered: HTMLButtonElement | null = null;
function resetHovered() {
  if (hovered) { hovered.removeAttribute("data-connection-hover"); handles.get(hovered)?.current.reset(); }
  hovered = null;
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
  const nearest = nearestHandle(event);
  if (hovered !== nearest?.element) resetHovered();
  if (!nearest) return;
  hovered = nearest.element;
  hovered.setAttribute("data-connection-hover", "true");
  handles.get(hovered)?.current.follow(event, nearest.rect);
}
function delegatedDown(event: globalThis.PointerEvent) {
  const nearest = nearestHandle(event);
  resetHovered();
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
    document.addEventListener("pointermove", delegatedMove, true);
    document.addEventListener("pointerdown", delegatedDown, true);
    document.addEventListener("pointercancel", resetHovered, true);
    window.addEventListener("blur", resetHovered);
  }
  handles.set(element, controller);
}
function unregisterHandle(element: HTMLButtonElement) {
  if (hovered === element) resetHovered();
  handles.delete(element);
  if (!handles.size) {
    document.removeEventListener("pointermove", delegatedMove, true);
    document.removeEventListener("pointerdown", delegatedDown, true);
    document.removeEventListener("pointercancel", resetHovered, true);
    window.removeEventListener("blur", resetHovered);
  }
}

/** The hit area stays still; only the small visible socket follows the pointer. */
export const CanvasConnectionHandle = forwardRef<HTMLButtonElement, CanvasConnectionHandleProps>(function CanvasConnectionHandle({
  side, active = false, zoom, className = "", style, disabled, onPointerEnter, onPointerMove, onPointerLeave,
  onPointerDown, onPointerUp, onPointerCancel, onBlur, children: _children, ...props
}, forwardedRef) {
  const hatchId = `connection-hatch-${useId().replaceAll(":", "")}`;
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
  function follow(event: globalThis.PointerEvent, rect: DOMRect) {
    if (disabled || active || event.buttons || event.pointerType === "touch" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { move(); return; }
    const x = event.clientX - rect.left - rect.width / 2;
    const y = event.clientY - rect.top - rect.height / 2;
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
    style={{ ...(zoom ? { "--canvas-connection-zoom": zoom } : {}), ...style } as CSSProperties}
    onPointerEnter={onPointerEnter}
    onPointerMove={onPointerMove}
    onPointerLeave={event => { if (hovered === event.currentTarget) resetHovered(); onPointerLeave?.(event); }}
    onPointerDown={event => { move(); onPointerDown?.(event); }}
    onPointerUp={event => { move(); onPointerUp?.(event); }}
    onPointerCancel={event => { move(); onPointerCancel?.(event); }}
    onBlur={event => { move(); onBlur?.(event); }}>
    <span ref={glyph} className="canvas-connection-glyph" aria-hidden="true">
      <svg width="28" height="28" viewBox="0 0 28 28" focusable="false">
        <defs>
          <pattern id={hatchId} width="2" height="2" patternUnits="userSpaceOnUse">
            <path d="M-1 1l2-2M0 2l2-2M1 3l2-2" stroke="currentColor" strokeWidth=".5" />
          </pattern>
        </defs>
        <rect x="1.5" y="1.5" width="25" height="25" stroke="currentColor" strokeWidth=".6" opacity=".35" />
        <path d="M1.5 7v14M26.5 7v14" stroke="currentColor" strokeWidth="1" />
        <path d="M.5.5h2v2h-2zM25.5.5h2v2h-2zM.5 25.5h2v2h-2zM25.5 25.5h2v2h-2z" fill="currentColor" />
        <path d="M12.25 5h3.5v7.25H23v3.5h-7.25V23h-3.5v-7.25H5v-3.5h7.25z" fill={`url(#${hatchId})`} />
      </svg>
    </span>
  </button>;
});
