import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, LoaderCircle } from "lucide-react";
import "./ExplorerCaptureFeedback.css";

export interface CaptureFeedback {
  id: number;
  assetId: string;
  nodeId?: string;
  x: number;
  y: number;
  projectId: string | null;
  message: string;
  pending: boolean;
}

export function ExplorerCaptureFeedback({ value, onDone }: { value: CaptureFeedback; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: value.x, top: value.y, maxWidth: 340 });
  useEffect(() => {
    if (value.pending) return;
    const timer = window.setTimeout(onDone, 2000);
    return () => window.clearTimeout(timer);
  }, [value, onDone]);
  useLayoutEffect(() => {
    let frame = 0;
    const follow = () => {
      const panel = ref.current?.closest(".explore-main");
      if (!panel || !ref.current) return;
      const selector = value.nodeId ? `[data-canvas-node-id="${CSS.escape(value.nodeId)}"]`
        : `[data-asset-id="${CSS.escape(value.assetId)}"]`;
      const anchor = panel.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
      const bounds = panel.getBoundingClientRect();
      const bubble = ref.current.getBoundingClientRect();
      const maxWidth = Math.max(120, Math.min(340, bounds.width - 16));
      const width = Math.min(bubble.width, maxWidth);
      const x = anchor && anchor.width ? anchor.left + anchor.width / 2 : value.x;
      const y = anchor && anchor.height ? anchor.top - 10 : value.y - 16;
      const left = Math.max(bounds.left + 8 + width / 2, Math.min(bounds.right - 8 - width / 2, x));
      const top = Math.max(bounds.top + bubble.height + 8, Math.min(bounds.bottom - 8, y));
      setPosition(previous => previous.left === left && previous.top === top && previous.maxWidth === maxWidth ? previous : { left, top, maxWidth });
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <div ref={ref} className="explorer-capture-feedback-anchor" style={position}>
    <div key={`${value.id}:${value.message}`} className={`explorer-capture-feedback${value.pending ? " is-pending" : ""}`} role="status" aria-live="polite">
      {value.pending ? <LoaderCircle size={14} className="explorer-feedback-spinner" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
      <span>{value.message}</span>
    </div>
  </div>;
}
