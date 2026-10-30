import { useEffect, useState, type RefObject } from "react";

type ImageBounds = { key: string; x: number; y: number; width: number; height: number };

/** Decorative only. Measure the hovered image on geometry changes, never poll every frame. */
export function CanvasTacticalOverlay({ stageRef, active }: { stageRef: RefObject<HTMLDivElement>; active: boolean }) {
  const [visible, setVisible] = useState(!document.hidden);
  const [bounds, setBounds] = useState<ImageBounds | null>(null);
  useEffect(() => {
    const update = () => setVisible(!document.hidden && !stageRef.current?.closest('[inert],[aria-hidden="true"]'));
    const visibility = new MutationObserver(update);
    for (let parent = stageRef.current?.parentElement; parent; parent = parent.parentElement) {
      visibility.observe(parent, { attributes: true, attributeFilter: ["inert", "aria-hidden"] });
    }
    update();
    document.addEventListener("visibilitychange", update);
    return () => { visibility.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, [stageRef]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !active || !visible) { setBounds(null); return; }
    let card: HTMLElement | null = null;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const media = card?.querySelector<HTMLImageElement>(":scope > img");
      if (!card?.isConnected || !media?.naturalWidth || !media.naturalHeight) { setBounds(null); return; }
      const rect = media.getBoundingClientRect(), parent = stage.getBoundingClientRect();
      const scale = Math.min(rect.width / media.naturalWidth, rect.height / media.naturalHeight);
      const width = media.naturalWidth * scale, height = media.naturalHeight * scale;
      if (width <= 0 || height <= 0) { setBounds(null); return; }
      const next = { key: card.dataset.canvasNodeId!, x: rect.x - parent.x + (rect.width - width) / 2,
        y: rect.y - parent.y + (rect.height - height) / 2, width, height };
      setBounds(previous => previous?.key === next.key && previous.x === next.x && previous.y === next.y
        && previous.width === next.width && previous.height === next.height ? previous : next);
    };
    const schedule = () => { if (card && !frame) frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    const geometry = new MutationObserver(schedule);
    const leave = () => {
      cancelAnimationFrame(frame); frame = 0; card = null;
      resize.disconnect(); geometry.disconnect(); setBounds(null);
    };
    const enter = (event: PointerEvent) => {
      const next = event.target instanceof Element ? event.target.closest<HTMLElement>(".canvas-node.is-asset") : null;
      if (next === card) return;
      leave();
      if (!next || !stage.contains(next)) return;
      card = next;
      resize.observe(card); resize.observe(stage);
      const media = card.querySelector(":scope > img");
      if (media) resize.observe(media);
      geometry.observe(card, { attributes: true, attributeFilter: ["style", "class"], childList: true });
      geometry.observe(stage, { attributes: true, attributeFilter: ["style"] });
      const plane = card.closest(".canvas-plane");
      if (plane) geometry.observe(plane, { attributes: true, attributeFilter: ["style"], childList: true });
      schedule();
    };
    stage.addEventListener("pointerover", enter);
    stage.addEventListener("pointerleave", leave);
    stage.addEventListener("load", schedule, true);
    return () => {
      leave();
      stage.removeEventListener("pointerover", enter);
      stage.removeEventListener("pointerleave", leave);
      stage.removeEventListener("load", schedule, true);
    };
  }, [stageRef, active, visible]);
  if (!active || !visible) return null;
  return <>
    <div className="canvas-tactical-telemetry" aria-hidden="true"><div><i /><i /><i /><i /><i /></div><span>CANVAS / 01</span><small>CREATIVE WORKSPACE</small></div>
    {bounds && <div key={bounds.key} className="canvas-tactical-image-pixels" aria-hidden="true"
      style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}><i /><i /><i /><i /></div>}
  </>;
}
