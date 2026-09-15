import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/** 滚动条叠在内容上，仅在滚动、右缘悬停或键盘聚焦时显示。 */
export function CollectionScrollArea({ children }: { children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ y: number; scrollTop: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const id = useId();
  const [scrolling, setScrolling] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [metrics, setMetrics] = useState({ height: 0, max: 0, top: 0 });
  function measure() {
    const view = viewportRef.current;
    if (view) setMetrics({ height: view.clientHeight, max: Math.max(0, view.scrollHeight - view.clientHeight), top: view.scrollTop });
  }
  function showTemporarily() {
    setScrolling(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setScrolling(false), 800);
  }
  useEffect(() => {
    const observer = new ResizeObserver(measure);
    if (viewportRef.current) observer.observe(viewportRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    measure();
    return () => { observer.disconnect(); clearTimeout(timer.current); };
  }, []);
  const overflowing = metrics.max > 0;
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    function onWheel(event: WheelEvent) {
      const view = viewportRef.current;
      if (!view) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.clientHeight : 1;
      view.scrollTop += event.deltaY * unit;
    }
    rail.addEventListener("wheel", onWheel, { passive: false });
    return () => rail.removeEventListener("wheel", onWheel);
  }, [overflowing]);
  const trackHeight = Math.max(0, metrics.height - 8);
  const thumbHeight = Math.min(trackHeight, Math.max(28, trackHeight * metrics.height / (metrics.height + metrics.max || 1)));
  const travel = trackHeight - thumbHeight;

  return <div className="collection-scroll-area">
    <div id={id} ref={viewportRef} className="collection-scroll-viewport" onScroll={() => { measure(); showTemporarily(); }}>
      <div ref={contentRef} className="collection-scroll-content">{children}</div>
    </div>
    {overflowing && <div ref={railRef} className="collection-scroll-rail" data-visible={scrolling || dragging}
      role="scrollbar" tabIndex={0} aria-label="集合素材滚动条" aria-controls={id} aria-orientation="vertical"
      aria-valuemin={0} aria-valuemax={metrics.max} aria-valuenow={Math.round(metrics.top)}
      onKeyDown={(event) => {
        const view = viewportRef.current;
        if (!view) return;
        const steps: Record<string, number> = { ArrowDown: 40, ArrowUp: -40, PageDown: metrics.height, PageUp: -metrics.height,
          Home: -metrics.max, End: metrics.max };
        if (!(event.key in steps)) return;
        event.preventDefault();
        view.scrollTop += steps[event.key];
      }}
      onPointerDown={(event) => {
        const view = viewportRef.current;
        if (event.button !== 0 || !view || travel <= 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        if (event.target === event.currentTarget) {
          view.scrollTop = (event.clientY - event.currentTarget.getBoundingClientRect().top - thumbHeight / 2) / travel * metrics.max;
        }
        dragRef.current = { y: event.clientY, scrollTop: view.scrollTop };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (dragRef.current && viewportRef.current && travel > 0) {
          viewportRef.current.scrollTop = dragRef.current.scrollTop + (event.clientY - dragRef.current.y) / travel * metrics.max;
        }
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        dragRef.current = null; setDragging(false); showTemporarily();
      }}
      onLostPointerCapture={() => { dragRef.current = null; setDragging(false); }}>
      <div className="collection-scroll-thumb" style={{ height: thumbHeight, transform: `translateY(${metrics.max ? metrics.top / metrics.max * travel : 0}px)` }} />
    </div>}
  </div>;
}
