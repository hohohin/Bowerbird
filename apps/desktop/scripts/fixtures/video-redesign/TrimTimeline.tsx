import React, { useEffect, useRef, useState } from "react";
import { videoTime } from "../../../src/lib/videoFrame";
import { startScrub, moveScrub } from "./fineScrub";

export function TrimTimeline({ duration, start, end, time, images, disabled, change, seek }: {
  duration: number; start: number; end: number; time: number; images: string[]; disabled: boolean;
  change: (edge: "in" | "out", value: number) => void; seek: (value: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; edge: "in" | "out"; value: number; gesture: ReturnType<typeof startScrub> } | null>(null);
  const [fine, setFine] = useState(false);
  const finish = () => { drag.current=null; setFine(false); };
  useEffect(() => { window.addEventListener("blur",finish); return () => window.removeEventListener("blur",finish); }, []);
  const percent = (value: number) => duration ? value / duration * 100 : 0;
  const valueAt = (x: number) => {
    const rect = track.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, (x - rect.left) / rect.width * duration));
  };
  return <div className={`trim-film-editor${fine ? " is-fine" : ""}`}>
    <div className="trim-timecodes">
      <label>入点 <input aria-label="入点秒数" type="number" min={0} max={end - .04} step={.01} value={Number(start.toFixed(2))} disabled={disabled} onChange={e => { if (Number.isFinite(e.target.valueAsNumber)) change("in", e.target.valueAsNumber); }} /></label>
      <output>保留 {videoTime(end - start)}</output>
      <label>出点 <input aria-label="出点秒数" type="number" min={start + .04} max={duration} step={.01} value={Number(end.toFixed(2))} disabled={disabled} onChange={e => { if (Number.isFinite(e.target.valueAsNumber)) change("out", e.target.valueAsNumber); }} /></label>
    </div>
    <div className="trim-film-track" ref={track} onPointerDown={e => { if (!disabled && e.button === 0) seek(valueAt(e.clientX)); }}>
      <div className="trim-film-images" aria-hidden="true">{Array.from({ length:12 }, (_, i) => <div key={i}>{images[i] && <img src={images[i]} alt="" draggable={false} />}</div>)}</div>
      <div className="trim-film-mask" style={{ left:0, width:`${percent(start)}%` }} />
      <div className="trim-film-mask" style={{ right:0, width:`${100 - percent(end)}%` }} />
      <div className="trim-film-selection" style={{ left:`${percent(start)}%`, width:`${percent(end-start)}%` }} />
      <i className="trim-film-cursor" style={{ left:`${percent(time)}%` }} />
      {(["in", "out"] as const).map(edge => <button key={edge} className={`trim-handle ${edge}`} role="slider" aria-label={edge === "in" ? "裁剪起点" : "裁剪终点"}
        aria-valuemin={edge === "in" ? 0 : start + .04} aria-valuemax={edge === "in" ? end - .04 : duration}
        aria-valuenow={edge === "in" ? start : end} aria-valuetext={videoTime(edge === "in" ? start : end)} disabled={disabled}
        style={{ left:`${percent(edge === "in" ? start : end)}%` }}
        title="拖动边界 · 长按后轻拖细调"
        onPointerDown={e => { if (e.button !== 0) return; e.stopPropagation(); e.preventDefault(); e.currentTarget.focus(); drag.current={id:e.pointerId,edge,value:edge === "in" ? start : end,gesture:startScrub(e.clientX,performance.now())}; e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={e => { const current=drag.current; if (current?.id !== e.pointerId) return;
          const delta=moveScrub(current.gesture,e.clientX,performance.now()); setFine(current.gesture.fine);
          const gap=Math.min(.01,duration/2);
          current.value=Math.max(edge === "in" ? 0 : start+gap,Math.min(edge === "in" ? end-gap : duration,current.value+delta/track.current!.getBoundingClientRect().width*duration));
          change(edge,current.value);
        }}
        onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
        onKeyDown={e => { if (!["ArrowLeft","ArrowRight","Home","End"].includes(e.key)) return; e.preventDefault(); e.stopPropagation(); change(edge, e.key === "Home" ? 0 : e.key === "End" ? duration : (edge === "in" ? start : end) + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? .01 : .1)); }}><span aria-hidden="true">{edge === "in" ? "‹" : "›"}</span></button>)}
    </div>
  </div>;
}
