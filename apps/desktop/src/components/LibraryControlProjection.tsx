import { useLayoutEffect, useRef } from "react";
import "./LibraryProjection.css";

/** Local optical field; shares the library's visibility/motion lifecycle. */
export function LibraryControlProjection() {
  const field = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const layer = field.current!;
    const library = layer.closest<HTMLElement>(".library-motion-root") ?? layer.closest<HTMLElement>(".file-view-heading")?.parentElement;
    if (!library) return;
    const measure = () => {
      const width = layer.getBoundingClientRect().width;
      const mask = '<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="148"><defs><filter id="f" x="-10%" y="-20%" width="120%" height="140%"><feGaussianBlur stdDeviation="1"/></filter></defs><path d="M-10 -10 H'+(width+10)+' V26 H'+width+' Q'+width/2+' 106 0 26 H-10Z" fill="white" filter="url(#f)"/></svg>';
      layer.style.setProperty('--control-mask', 'url("data:image/svg+xml,'+encodeURIComponent(mask)+'")');
    };
    const resize = new ResizeObserver(measure); resize.observe(layer); measure();
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    const reset = () => {
      cancelAnimationFrame(frame);
      layer.style.removeProperty("--control-drift-x");
      layer.style.removeProperty("--control-drift-y");
    };
    const move = (event: PointerEvent) => {
      if (reduced.matches || document.hidden || library.dataset.libraryMotionPaused === "true" || event.pointerType === "touch") return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = library.getBoundingClientRect();
        layer.style.setProperty("--control-drift-x", `${((event.clientX - box.left) / box.width - .5) * 6}px`);
        layer.style.setProperty("--control-drift-y", `${((event.clientY - box.top) / box.height - .5) * 4}px`);
      });
    };
    library.addEventListener("pointermove", move, { passive: true });
    library.addEventListener("pointerleave", reset);
    reduced.addEventListener("change", reset);
    return () => {
      reset(); resize.disconnect();
      library.removeEventListener("pointermove", move);
      library.removeEventListener("pointerleave", reset);
      reduced.removeEventListener("change", reset);
    };
  }, []);
  return <div ref={field} className="library-control-projection" aria-hidden="true">
    <i className="library-control-field"/>
    <i className="library-control-dust"/>
    <svg className="library-control-arc" viewBox="0 0 900 120" preserveAspectRatio="none"><path d="M 0 26 Q 450 106 900 26"/></svg>
    <span className="library-control-crosses">{"+ + + +\n+ + + +"}</span>
    <span className="library-control-crosses is-far">{"+ + +\n+ + +"}</span>
  </div>;
}
