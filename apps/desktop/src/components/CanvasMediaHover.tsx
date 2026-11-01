import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MediaHoverMark } from "./MediaHoverMark";

/** Canvas routing only; the geometry and choreography are shared with the library. */
export function CanvasMediaHover({ root }: { root: RefObject<HTMLDivElement> }) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    const stage = root.current;
    if (!stage) return;
    const clear = () => setImage(null);
    const move = (event: PointerEvent) => {
      const target = event.target;
      const host = target instanceof Element && !target.closest('button, .canvas-node-name') ? target.closest('.canvas-node.is-asset, .canvas-conversation-images, .canvas-folder-grid > div') : null;
      const candidate = host?.querySelector<HTMLImageElement>(":scope > img") ?? null;
      const rect = candidate?.getBoundingClientRect();
      const inside = rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      setImage(!event.buttons && inside && candidate && !candidate.closest('.is-selected, .is-moving, [inert]') ? candidate : null);
    };
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerleave", clear);
    stage.addEventListener("pointerdown", clear);
    return () => { stage.removeEventListener("pointermove", move); stage.removeEventListener("pointerleave", clear); stage.removeEventListener("pointerdown", clear); };
  }, [root]);
  return image?.isConnected && image.parentElement ? createPortal(<MediaHoverMark previewKey={image.src} target={image}/>, image.parentElement) : null;
}
