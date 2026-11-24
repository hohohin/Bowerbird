import { useEffect, useId, useRef, type CSSProperties } from "react";
import displacement from "../assets/library-glass-displacement.png";

/** Static refraction; pointer lighting updates only the hovered surface, without React renders. */
export function useLibraryGlass() {
  const id = `library-glass-${useId().replace(/:/g, "")}`;
  const definitionRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const root = definitionRef.current?.parentElement;
    if (!root) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce), (prefers-reduced-transparency: reduce), (forced-colors: active)");
    let surface: HTMLElement | null = null;
    const reset = () => {
      surface?.style.removeProperty("--glass-light-x");
      surface?.style.removeProperty("--glass-light-y");
      surface = null;
    };
    const move = (event: PointerEvent) => {
      if (reduced.matches || event.pointerType === "touch") return;
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>(".library-view-switch, .composer-mode-picker, .composer-glass") : null;
      if (target !== surface) reset();
      if (!target || !root.contains(target)) return;
      surface = target;
      const rect = target.getBoundingClientRect();
      target.style.setProperty("--glass-light-x", `${event.clientX - rect.left}px`);
      target.style.setProperty("--glass-light-y", `${event.clientY - rect.top}px`);
    };
    root.addEventListener("pointermove", move, { passive: true });
    root.addEventListener("pointerleave", reset);
    reduced.addEventListener("change", reset);
    return () => {
      reset();
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerleave", reset);
      reduced.removeEventListener("change", reset);
    };
  }, []);
  return {
    style: { "--library-glass-filter": `url("#${id}")` } as CSSProperties,
    definition: <svg ref={definitionRef} width="0" height="0" aria-hidden="true" focusable="false" style={{ position: "absolute", pointerEvents: "none" }}>
      <defs><filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feImage href={displacement} width="100%" height="100%" preserveAspectRatio="none" result="edge-map" />
        <feDisplacementMap in="SourceGraphic" in2="edge-map" scale="24" xChannelSelector="R" yChannelSelector="G" />
      </filter></defs>
    </svg>,
  };
}
