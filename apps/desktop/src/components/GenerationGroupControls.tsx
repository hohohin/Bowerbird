import { ChevronLeft, ChevronRight } from "lucide-react";
import "./GenerationGroupControls.css";

/** Browsing changes the displayed asset only; it never changes saved outputs. */
export function GenerationGroupControls({ index, count, onSelect }: { index: number; count: number; onSelect: (index: number) => void }) {
  if (count < 2) return null;
  return <>
    <span className="generation-group-count" aria-live="polite">{index + 1}/{count}</span>
    {([-1, 1] as const).map(direction => <button key={direction} type="button"
      className={`generation-group-arrow ${direction < 0 ? "previous" : "next"}`}
      aria-label={direction < 0 ? "上一张生成素材" : "下一张生成素材"}
      disabled={index + direction < 0 || index + direction >= count}
      onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); onSelect(index + direction); }}>
      {direction < 0 ? <ChevronLeft size={16} aria-hidden="true"/> : <ChevronRight size={16} aria-hidden="true"/>}
    </button>)}
  </>;
}
