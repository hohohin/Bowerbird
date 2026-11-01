import { useLayoutEffect, useRef } from "react";
import "./LibraryHoverMark.css";

/** Mounted only over the hovered media; bounds follow the painted image, not its letterbox. */
export function LibraryHoverMark({ previewKey }: { previewKey: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const mark = ref.current!;
    const preview = mark.parentElement!.querySelector<HTMLElement>(".folder-media-preview")!;
    const image = preview.querySelector("img");
    const measure = () => {
      const style = getComputedStyle(preview);
      const boxWidth = parseFloat(style.width), boxHeight = parseFloat(style.height);
      let width = boxWidth, height = boxHeight;
      if (image?.naturalWidth && image.naturalHeight) {
        const imageStyle = getComputedStyle(image);
        width = parseFloat(imageStyle.width); height = parseFloat(imageStyle.height);
        if (imageStyle.objectFit === "contain") {
          const fit = Math.min(width / image.naturalWidth, height / image.naturalHeight);
          width = image.naturalWidth * fit; height = image.naturalHeight * fit;
        }
      }
      Object.assign(mark.style, { left: `${(boxWidth - width) / 2}px`, top: `${(boxHeight - height) / 2}px`, width: `${width}px`, height: `${height}px` });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(preview);
    if (image) observer.observe(image);
    preview.addEventListener("load", measure, true);
    return () => { observer.disconnect(); preview.removeEventListener("load", measure, true); };
  }, [previewKey]);
  return <span ref={ref} className="library-hover-mark" aria-hidden="true">
    <svg viewBox="0 0 100 100" preserveAspectRatio="none">
      <path d="M50 50L100 0" pathLength="1"/><path d="M50 50L0 100" pathLength="1"/>
    </svg>
  </span>;
}
