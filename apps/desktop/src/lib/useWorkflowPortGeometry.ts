import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { CanvasNode } from "./types";

export type WorkflowPortTarget = { node: CanvasNode; kind: "output" | "input" | "cell"; port: string; image?: boolean };
type Rect = { x: number; y: number; width: number; height: number };
type CardTargets = { node: CanvasNode; ports: Map<string, WorkflowPortTarget> };
type CardPorts = { card: HTMLElement; ports: Map<string, HTMLElement>; observed: Set<HTMLElement> };

const cardSelector = "[data-canvas-node-id]";
const cellSelector = "[data-canvas-cell]";
const socketSelector = `[data-workflow-cell],[data-workflow-text-input],${cellSelector}`;
const portSelector = `${socketSelector},[data-canvas-connect-side]`;
const targetKey = (kind: WorkflowPortTarget["kind"], port: string, image = false) => `${kind}:${image ? 1 : 0}:${port}`;

function findCardPorts(card: HTMLElement, wanted: CardTargets["ports"]): CardPorts {
  const ports = new Map<string, HTMLElement>();
  const observed = new Set<HTMLElement>([card]);
  for (const port of card.querySelectorAll<HTMLElement>(socketSelector)) {
    const kind = port.hasAttribute("data-workflow-cell") ? "output" : port.hasAttribute("data-workflow-text-input") ? "input" : "cell";
    const name = port.dataset.workflowCell ?? port.dataset.workflowTextInput ?? port.dataset.canvasCell!;
    const key = targetKey(kind, name, kind === "input" && port.dataset.contentInputType === "image");
    if (wanted.has(key) && !ports.has(key)) ports.set(key, port);
    // Resizing a preceding row can move a socket without resizing that socket.
    if (port.hasAttribute("data-canvas-cell")) observed.add(port);
  }
  for (const [key, { kind, port }] of wanted) {
    if (ports.has(key) || kind === "cell") continue;
    // Older whole-card bindings keep their identity while sharing the new socket.
    if (kind === "output" && !["*", "*text", "*latest", "*latest-image", "*auto"].includes(port)) continue;
    if (kind === "input" && !["", "*auto"].includes(port)) continue;
    const handle = card.querySelector<HTMLElement>(`[data-canvas-connect-side="${kind}"]:not(.canvas-cell-connection)`);
    if (handle) ports.set(key, handle);
  }
  for (const port of ports.values()) observed.add(port);
  if (!ports.size) observed.clear();
  return { card, ports, observed };
}

function measureCard({ card, ports }: CardPorts, zoom: number) {
  const rects = new Map<string, Rect>();
  const measured = new Map<HTMLElement, Rect>();
  let cardRect: DOMRect | undefined;
  for (const [key, port] of ports) {
    if (!card.isConnected || !port.isConnected) continue;
    let rect = measured.get(port);
    if (!rect) {
      if (port.hasAttribute("data-canvas-connect-side")) {
        rect = { x: port.dataset.canvasConnectSide === "output" ? card.offsetWidth : 0, y: card.offsetHeight / 2, width: 0, height: 0 };
      } else {
        cardRect ??= card.getBoundingClientRect();
        const box = port.getBoundingClientRect();
        rect = { x: (box.left - cardRect.left) / zoom, y: (box.top - cardRect.top) / zoom, width: box.width / zoom, height: box.height / zoom };
      }
      measured.set(port, rect);
    }
    rects.set(key, rect);
  }
  return rects;
}

function sameRects(previous: Map<string, Rect> | undefined, next: Map<string, Rect>) {
  if ((previous?.size ?? 0) !== next.size) return false;
  for (const [key, rect] of next) {
    const old = previous?.get(key);
    // Subpixel rounding changes under zoom are not changes to board geometry.
    if (!old || Math.abs(old.x - rect.x) > .01 || Math.abs(old.y - rect.y) > .01
      || Math.abs(old.width - rect.width) > .01 || Math.abs(old.height - rect.height) > .01) return false;
  }
  return true;
}

function observeGeometry(plane: HTMLElement, getZoom: () => number, geometry: Map<string, Map<string, Rect>>, redraw: () => void) {
  const cards = new Map([...plane.querySelectorAll<HTMLElement>(cardSelector)].map(card => [card.dataset.canvasNodeId!, card]));
  const bindings = new Map<string, CardPorts>();
  const owners = new Map<Element, string>();
  const dirty = new Set<string>();
  const changedPorts = new Set<string>();
  let targets = new Map<string, CardTargets>();
  let frame = 0;
  let pausedForZoom = false;

  function schedule(id: string, refreshPorts = false) {
    if (!targets.has(id)) return;
    if (refreshPorts) changedPorts.add(id);
    dirty.add(id);
    if (!frame) frame = requestAnimationFrame(flush);
  }
  const resize = new ResizeObserver(entries => {
    for (const { target } of entries) {
      const id = owners.get(target);
      if (id !== undefined) schedule(id);
    }
  });
  function bind(id: string) {
    const previous = bindings.get(id);
    const card = cards.get(id);
    const wanted = targets.get(id);
    const next = card && wanted && plane.contains(card) ? findCardPorts(card, wanted.ports) : undefined;
    for (const element of previous?.observed ?? []) {
      if (next?.observed.has(element)) continue;
      owners.delete(element);
      resize.unobserve(element);
    }
    for (const element of next?.observed ?? []) {
      if (previous?.observed.has(element)) continue;
      owners.set(element, id);
      resize.observe(element);
    }
    if (next) bindings.set(id, next);
    else bindings.delete(id);
    return next;
  }
  function flush() {
    frame = 0;
    const zoom = getZoom();
    pausedForZoom = !Number.isFinite(zoom) || zoom <= 0;
    if (pausedForZoom) return;
    const deadline = performance.now() + 5;
    let changed = false;
    let count = 0;
    for (const id of dirty) {
      dirty.delete(id);
      const binding = changedPorts.delete(id) ? bind(id) : bindings.get(id);
      const rects = binding ? measureCard(binding, zoom) : new Map<string, Rect>();
      if (!sameRects(geometry.get(id), rects)) {
        if (rects.size) geometry.set(id, rects);
        else geometry.delete(id);
        changed = true;
      }
      // A newly loaded board can have hundreds of ports on first paint.
      if (++count >= 48 || performance.now() >= deadline) break;
    }
    if (dirty.size) frame = requestAnimationFrame(flush);
    if (changed) redraw();
  }
  function trackCard(card: HTMLElement, removedId?: string) {
    if (removedId !== undefined && cards.get(removedId) === card) {
      cards.delete(removedId);
      schedule(removedId, true);
    }
    const id = card.dataset.canvasNodeId;
    if (id !== undefined && plane.contains(card)) {
      cards.set(id, card);
      schedule(id, true);
    }
  }
  const mutations = new MutationObserver(records => {
    for (const { target, attributeName, oldValue, addedNodes, removedNodes } of records) {
      if (!(target instanceof HTMLElement)) continue; // Wire SVG changes do not affect sockets.
      if (attributeName === "data-canvas-node-id") {
        trackCard(target, oldValue ?? undefined);
        continue;
      }
      const card = target.closest<HTMLElement>(cardSelector);
      if (card) {
        if (attributeName || [...addedNodes, ...removedNodes].some(node => node instanceof HTMLElement
          && (node.matches(portSelector) || node.querySelector(portSelector)))) schedule(card.dataset.canvasNodeId!, true);
        continue;
      }
      for (const node of removedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches(cardSelector)) trackCard(node, node.dataset.canvasNodeId);
        for (const child of node.querySelectorAll<HTMLElement>(cardSelector)) trackCard(child, child.dataset.canvasNodeId);
      }
      for (const node of addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches(cardSelector)) trackCard(node);
        for (const child of node.querySelectorAll<HTMLElement>(cardSelector)) trackCard(child);
      }
    }
  });
  mutations.observe(plane, { childList: true, subtree: true, attributes: true, attributeOldValue: true,
    attributeFilter: ["data-canvas-node-id", "data-workflow-cell", "data-workflow-text-input", "data-content-input-type", "data-canvas-cell", "data-canvas-connect-side"] });
  const scroll = (event: Event) => {
    const card = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(cardSelector) : null;
    if (card) schedule(card.dataset.canvasNodeId!);
  };
  plane.addEventListener("scroll", scroll, true);

  return {
    update(nextTargets: WorkflowPortTarget[]) {
      const previous = targets;
      targets = new Map();
      for (const target of nextTargets) {
        const { node, kind, port, image } = target;
        let card = targets.get(node.id);
        if (!card) { card = { node, ports: new Map() }; targets.set(node.id, card); }
        card.ports.set(targetKey(kind, port, image), target);
      }
      let removed = false;
      for (const id of previous.keys()) {
        if (targets.has(id)) continue;
        dirty.delete(id);
        changedPorts.delete(id);
        bind(id);
        removed = geometry.delete(id) || removed;
      }
      for (const [id, { node, ports }] of targets) {
        const old = previous.get(id);
        const refresh = !old || ports.size !== old.ports.size || [...ports.keys()].some(key => !old.ports.has(key));
        if (refresh) {
          const rects = geometry.get(id);
          for (const key of rects?.keys() ?? []) {
            if (!ports.has(key)) { rects?.delete(key); removed = true; }
          }
          schedule(id, true);
        } else if (node !== old.node && (node.payloadJson !== old.node.payloadJson || node.width !== old.node.width || node.height !== old.node.height)) {
          schedule(id);
        }
      }
      if (removed) redraw();
      // A measurement skipped during an invalid camera scale stays queued.
      if (pausedForZoom && dirty.size && !frame) frame = requestAnimationFrame(flush);
    },
    dispose() {
      resize.disconnect();
      mutations.disconnect();
      cancelAnimationFrame(frame);
      plane.removeEventListener("scroll", scroll, true);
      geometry.clear();
    },
  };
}

/** Cache connected sockets in board coordinates without synchronously measuring the SVG transform. */
export function useWorkflowPortGeometry(root: RefObject<SVGSVGElement>, targets: WorkflowPortTarget[], getZoom: () => number) {
  const geometry = useRef(new Map<string, Map<string, Rect>>());
  const observer = useRef<ReturnType<typeof observeGeometry>>();
  const zoom = useRef(getZoom);
  const [, redraw] = useState(0);
  useLayoutEffect(() => {
    const plane = root.current?.parentElement;
    if (!plane) return;
    const active = observeGeometry(plane, () => zoom.current(), geometry.current, () => redraw(value => value + 1));
    observer.current = active;
    return () => { active.dispose(); observer.current = undefined; };
  }, [root]);
  useLayoutEffect(() => {
    zoom.current = getZoom;
    observer.current?.update(targets);
  });
  return (node: CanvasNode | undefined, kind: WorkflowPortTarget["kind"], port: string, image = false) => {
    if (!node) return undefined;
    const rect = geometry.current.get(node.id)?.get(targetKey(kind, port, image));
    return rect && { ...rect, x: node.x + rect.x, y: node.y + rect.y };
  };
}
