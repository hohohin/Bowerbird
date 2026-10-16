import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Keep the library mounted while another source occupies its workspace. */
export function PreservedWorkspace({ suspended, children }: { suspended: boolean; children: ReactNode }) {
  const element = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<HTMLElement, number>());
  const width = useRef<number>();
  const inactive = useRef(suspended);
  inactive.current = suspended;
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const measure = () => { if (!inactive.current) width.current = node.clientWidth; };
    measure(); const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    node.inert = suspended;
    if (suspended) node.querySelectorAll("video").forEach(video => video.pause());
    else {
      const restore = () => positions.current.forEach((top, target) => { if (target.isConnected) target.scrollTop = top; });
      restore(); const frame = requestAnimationFrame(restore);
      return () => cancelAnimationFrame(frame);
    }
  }, [suspended]);
  return <div ref={element} className="flex min-h-0 min-w-0 flex-1 flex-col" style={suspended ? { visibility: "hidden", pointerEvents: "none", width: width.current, maxWidth: "100%" } : undefined}
    aria-hidden={suspended || undefined} onScrollCapture={event => {
      if (!suspended && event.target instanceof HTMLElement) positions.current.set(event.target, event.target.scrollTop);
    }}>{children}</div>;
}
