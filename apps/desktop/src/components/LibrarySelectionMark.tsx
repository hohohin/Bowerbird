import { useLayoutEffect, useRef } from "react";
import "./LibrarySelectionMark.css";

/** Shared decoration; selection, keyboard input and masonry geometry stay with the card. */
export function LibrarySelectionMark({ selected, previewKey }: { selected: boolean; previewKey: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const wasSelected = useRef(selected);
  useLayoutEffect(() => {
    const mark = ref.current;
    const entering = selected && !wasSelected.current;
    wasSelected.current = selected;
    if (!mark) return;
    if (entering && !matchMedia("(prefers-reduced-motion: reduce)").matches
      && !mark.closest('[data-library-motion-paused="true"], [data-library-dragging="true"]')) mark.classList.add("is-entering");
    const preview = mark.parentElement!.querySelector<HTMLElement>(".folder-media-preview")!;
    const measure = () => {
      // Layout dimensions ignore hover tilt and the preview's selection scale.
      const style = getComputedStyle(preview);
      let width = parseFloat(style.width), height = parseFloat(style.height);
      if (!width || !height) return;
      let left = 0, top = 0;
      const image = preview.querySelector("img");
      if (image?.naturalWidth && image.naturalHeight) {
        const imageStyle = getComputedStyle(image);
        const boxWidth = parseFloat(imageStyle.width), boxHeight = parseFloat(imageStyle.height);
        width = boxWidth; height = boxHeight;
        if (imageStyle.objectFit === "contain") {
          const fit = Math.min(boxWidth / image.naturalWidth, boxHeight / image.naturalHeight);
          width = image.naturalWidth * fit; height = image.naturalHeight * fit;
        }
        left = (parseFloat(style.width) - width) / 2;
        top = (parseFloat(style.height) - height) / 2;
      }
      const shortSide = Math.min(width, height);
      const inset = Math.max(0, Math.min(2, shortSide * .02, width * .02 - .9));
      // Follow the painted image, including contain/min-height letterboxing.
      Object.assign(mark.style, { left: `${left + inset}px`, top: `${top + inset}px`, width: `${Math.max(0, width - inset * 2)}px`, height: `${Math.max(0, height - inset * 2)}px` });
      mark.style.setProperty("--selection-angle", `${Math.atan2(height, width) * 180 / Math.PI}deg`);
      mark.style.setProperty("--selection-tick", `${Math.min(6, shortSide * .06)}px`);
      // Scale the central motif together on very short panoramas, retaining its gap.
      mark.style.setProperty("--selection-aim-scale", String(Math.min(1, shortSide / 96)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(preview);
    const image = preview.querySelector("img");
    if (image) observer.observe(image);
    preview.addEventListener("load", measure, true);
    return () => { observer.disconnect(); preview.removeEventListener("load", measure, true); };
  }, [selected, previewKey]);

  if (!selected) return null;
  return <span ref={ref} className="library-selection-mark" aria-hidden="true" onAnimationEnd={event => {
    if (event.animationName === "library-select-center") event.currentTarget.classList.remove("is-entering");
  }}>
    <span className="library-selection-signal">
      <svg className="library-selection-bracket is-left" viewBox="0 0 100 100" preserveAspectRatio="none"><path d="M4 0H0V100H4"/></svg>
      <svg className="library-selection-bracket is-right" viewBox="0 0 100 100" preserveAspectRatio="none"><path d="M96 0H100V100H96"/></svg>
      <span className="library-selection-aim">
        <i className="library-selection-ray is-top-right"/><i className="library-selection-ray is-bottom-right"/>
        <i className="library-selection-ray is-bottom-left"/><i className="library-selection-ray is-top-left"/>
        <span className="library-selection-center"><svg viewBox="0 0 22 22"><path d="M2 2H20V20H2ZM7 11H15M11 7V15"/></svg></span>
      </span>
      <span className="library-selection-tick is-left"><i/></span><span className="library-selection-tick is-right"><i/></span>
      <span className="library-selection-tick is-top"><i/></span><span className="library-selection-tick is-bottom"><i/></span>
    </span>
  </span>;
}
