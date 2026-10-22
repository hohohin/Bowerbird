import { useId, type CSSProperties } from "react";
import displacement from "../assets/library-glass-displacement.png";

/** One static edge-refraction map per library viewport; no scroll/pointer rendering loop. */
export function useLibraryGlass() {
  const id = `library-glass-${useId().replace(/:/g, "")}`;
  return {
    style: { "--library-glass-filter": `url("#${id}")` } as CSSProperties,
    definition: <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: "absolute", pointerEvents: "none" }}>
      <defs><filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feImage href={displacement} width="100%" height="100%" preserveAspectRatio="none" result="edge-map" />
        <feDisplacementMap in="SourceGraphic" in2="edge-map" scale="14" xChannelSelector="R" yChannelSelector="G" />
      </filter></defs>
    </svg>,
  };
}
