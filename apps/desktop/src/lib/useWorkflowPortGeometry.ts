import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { CanvasNode } from "./types";

export type WorkflowPortTarget = { node: CanvasNode; kind: "output" | "input" | "cell"; port: string; image?: boolean };
type Rect = { x: number; y: number; width: number; height: number };
const targetKey = (target: Pick<WorkflowPortTarget, "node" | "kind" | "port" | "image">) =>
  JSON.stringify([target.node.id, target.kind, target.port, !!target.image]);

/** Cache only connected sockets, relative to their card; camera and card translation need no DOM reads. */
export function useWorkflowPortGeometry(root: RefObject<SVGSVGElement>, targets: WorkflowPortTarget[]) {
  const geometry = useRef(new Map<string, Rect>());
  const previous = useRef<WorkflowPortTarget[]>([]);
  const cleanup = useRef<() => void>();
  const measureChanged = useRef<(ids: Set<string>) => void>();
  const [, redraw] = useState(0);
  useLayoutEffect(() => {
    const unique = [...new Map(targets.map(target => [targetKey(target), target])).values()];
    if (unique.length === previous.current.length && unique.every((target, index) => targetKey(target) === targetKey(previous.current[index]))) {
      const changed = new Set<string>();
      unique.forEach(({ node }, i) => {
        const old = previous.current[i].node;
        if (node.payloadJson !== old.payloadJson || node.width !== old.width || node.height !== old.height) changed.add(node.id);
      });
      previous.current = unique;
      if (changed.size) measureChanged.current?.(changed);
      return;
    }
    previous.current = unique;
    cleanup.current?.();
    const plane = root.current?.parentElement;
    const cards = new Map(Array.from(plane?.querySelectorAll<HTMLElement>("[data-canvas-node-id]") ?? [])
      .map(card => [card.dataset.canvasNodeId!, card]));
    const wanted = new Map(unique.map(target => [targetKey(target), target]));
    const nodeIds = new Set(unique.map(target => target.node.id));
    const elements = new Map<string, { card: HTMLElement; port: HTMLElement }>();
    for (const id of nodeIds) {
      const card = cards.get(id);
      if (!card) continue;
      for (const port of card.querySelectorAll<HTMLElement>("[data-workflow-cell],[data-workflow-text-input],[data-canvas-cell]")) {
        const kind = port.hasAttribute("data-workflow-cell") ? "output" : port.hasAttribute("data-workflow-text-input") ? "input" : "cell";
        const key = JSON.stringify([id, kind, port.dataset.workflowCell ?? port.dataset.workflowTextInput ?? port.dataset.canvasCell,
          kind === "input" && port.dataset.contentInputType === "image"]);
        if (wanted.has(key) && !elements.has(key)) elements.set(key, { card, port });
      }
      // Old whole-card bindings keep their identity while sharing the new socket.
      for (const [key, target] of wanted) {
        if (target.node.id !== id || elements.has(key) || target.kind === "cell") continue;
        if (target.kind === "output" && !["*", "*text", "*latest", "*latest-image", "*auto"].includes(target.port)) continue;
        if (target.kind === "input" && !["", "*auto"].includes(target.port)) continue;
        const port = card.querySelector<HTMLElement>(`[data-canvas-connect-side="${target.kind}"]`);
        if (port) elements.set(key, { card, port });
      }
    }
    let frame = 0;
    const measure = (changedIds?: Set<string>) => {
      const next = changedIds ? new Map(geometry.current) : new Map<string, Rect>();
      const bounds = new Map<HTMLElement, DOMRect>();
      const transform = root.current?.getScreenCTM();
      const scale = transform ? Math.hypot(transform.a, transform.b) : 0;
      for (const [key, { card, port }] of elements) {
        if (changedIds && !changedIds.has(card.dataset.canvasNodeId!)) continue;
        next.delete(key);
        if (!card.isConnected || !port.isConnected) continue;
        let cardRect = bounds.get(card);
        if (!cardRect) { cardRect = card.getBoundingClientRect(); bounds.set(card, cardRect); }
        if (!scale || !Number.isFinite(scale)) continue;
        if (port.hasAttribute("data-canvas-connect-side")) {
          next.set(key, { x: port.dataset.canvasConnectSide === "output" ? card.offsetWidth : 0, y: card.offsetHeight / 2, width: 0, height: 0 });
          continue;
        }
        const rect = port.getBoundingClientRect();
        next.set(key, { x: (rect.left - cardRect.left) / scale, y: (rect.top - cardRect.top) / scale,
          width: rect.width / scale, height: rect.height / scale });
      }
      // Subpixel rounding changes under zoom are not changes to the board geometry.
      const changed = next.size !== geometry.current.size || [...next].some(([key, rect]) => {
        const old = geometry.current.get(key);
        return !old || Math.abs(old.x - rect.x) > .01 || Math.abs(old.y - rect.y) > .01
          || Math.abs(old.width - rect.width) > .01 || Math.abs(old.height - rect.height) > .01;
      });
      if (changed) { geometry.current = next; redraw(value => value + 1); }
    };
    measureChanged.current = measure;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); }); };
    const observer = new ResizeObserver(schedule);
    const observed = new Set<HTMLElement>();
    for (const { card, port } of elements.values()) {
      observed.add(port);
      if (observed.has(card)) continue;
      observed.add(card);
      // Resizing a preceding row can move a socket without resizing that socket.
      for (const cell of card.querySelectorAll<HTMLElement>("[data-canvas-cell]")) observed.add(cell);
    }
    for (const element of observed) observer.observe(element);
    // Child-local state may replace a socket while this memoized layer receives identical props.
    // Watch identity/children only; card position styles, camera transforms and SVG paths are irrelevant.
    let refreshFrame = 0;
    const mutations = new MutationObserver(records => {
      const relevant = records.some(record => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        const card = target?.closest<HTMLElement>("[data-canvas-node-id]");
        if (card && nodeIds.has(card.dataset.canvasNodeId!)) {
          if (record.type === "attributes") return true;
          return [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element
            && (node.matches("[data-workflow-cell],[data-workflow-text-input],[data-canvas-cell]")
              || node.querySelector("[data-workflow-cell],[data-workflow-text-input],[data-canvas-cell]")));
        }
        return [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element
          && [node, ...node.querySelectorAll<HTMLElement>("[data-canvas-node-id]")]
            .some(element => nodeIds.has((element as HTMLElement).dataset.canvasNodeId ?? "")));
      });
      if (relevant && !refreshFrame) refreshFrame = requestAnimationFrame(() => {
        refreshFrame = 0; previous.current = []; redraw(value => value + 1);
      });
    });
    if (plane && nodeIds.size) mutations.observe(plane, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["data-canvas-node-id", "data-workflow-cell", "data-workflow-text-input", "data-content-input-type", "data-canvas-cell"] });
    plane?.addEventListener("scroll", schedule, true);
    measure();
    cleanup.current = () => {
      measureChanged.current = undefined;
      observer.disconnect(); mutations.disconnect(); cancelAnimationFrame(frame); cancelAnimationFrame(refreshFrame);
      plane?.removeEventListener("scroll", schedule, true);
    };
  });
  useLayoutEffect(() => () => { cleanup.current?.(); previous.current = []; }, []);
  return (node: CanvasNode | undefined, kind: WorkflowPortTarget["kind"], port: string, image = false) => {
    if (!node) return undefined;
    const rect = geometry.current.get(targetKey({ node, kind, port, image }));
    return rect && { ...rect, x: node.x + rect.x, y: node.y + rect.y };
  };
}
