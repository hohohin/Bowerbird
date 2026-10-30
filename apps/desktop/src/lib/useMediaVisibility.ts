import { useEffect, useRef, useState } from "react";

type MediaBounds = { visible: boolean; width: number; height: number };
type Listener = { intersect: (entry: IntersectionObserverEntry) => void; resize: (rect: DOMRectReadOnly) => void; visibility: () => void };
const observers = new Map<Element | null, { observer: IntersectionObserver; resize: ResizeObserver; visibility: MutationObserver; listeners: Map<Element, Listener> }>();

/** Keep card geometry mounted; only the media resource follows the viewport. */
export function useMediaVisibility<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [bounds, setBounds] = useState<MediaBounds>({ visible: false, width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const root = element.closest(".canvas-stage");
    let pool = observers.get(root);
    if (!pool) {
      const listeners = new Map<Element, Listener>();
      const observer = new IntersectionObserver(entries => {
        for (const entry of entries) listeners.get(entry.target)?.intersect(entry);
      }, { root, rootMargin: "240px" });
      const resize = new ResizeObserver(entries => {
        for (const entry of entries) listeners.get(entry.target)?.resize(entry.contentRect);
      });
      let hidden = root?.classList.contains("is-view-hidden");
      const visibility = new MutationObserver(() => {
        const next = root?.classList.contains("is-view-hidden");
        if (hidden === next) return;
        hidden = next;
        for (const listener of listeners.values()) listener.visibility();
      });
      if (root) visibility.observe(root, { attributes: true, attributeFilter: ["class"] });
      pool = { observer, resize, visibility, listeners };
      observers.set(root, pool);
    }
    let intersecting = false;
    const updateVisibility = () => {
      const visible = intersecting && !root?.classList.contains("is-view-hidden");
      setBounds(previous => previous.visible === visible ? previous : { ...previous, visible });
    };
    pool.listeners.set(element, {
      intersect: entry => { intersecting = entry.isIntersecting; updateVisibility(); },
      visibility: updateVisibility,
      resize: ({ width, height }) => setBounds(previous => previous.width === width && previous.height === height ? previous : { ...previous, width, height }),
    });
    pool.observer.observe(element);
    pool.resize.observe(element);
    return () => {
      pool!.resize.unobserve(element);
      pool!.observer.unobserve(element);
      pool!.listeners.delete(element);
      if (!pool!.listeners.size) { pool!.observer.disconnect(); pool!.resize.disconnect(); pool!.visibility.disconnect(); observers.delete(root); }
    };
  }, []);
  return { ref, ...bounds };
}
