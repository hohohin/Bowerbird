import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AudioLines, CircleAlert, Images, X } from "lucide-react";
import type { Asset } from "../../lib/types";
import { comfyAudioHint, comfyAudioLabel, type ComfyVideoMode } from "../../lib/comfyVideo";

/** Read-only projection of editor references; deletion stays in ProseMirror. */
export function LocalVideoFrames({ frames, audio, ignored, mode }: { frames: Asset[]; audio: Asset[]; ignored: number; mode: ComfyVideoMode }) {
  const reference = mode === "reference";
  const text = mode === "text";
  const title = text ? "录音引导预览" : reference ? "参考图预览" : "首尾帧预览";
  const triggerLabel = text ? "检视录音引导" : reference ? "检视参考图" : "检视首尾帧";
  const label = (index: number) => reference ? "参考图" : index === 0 ? "首帧" : "尾帧";
  const [open, setOpen] = useState(true);
  const [position, setPosition] = useState<{ left: number; bottom: number; width: number; maxHeight: number }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const anchor = trigger.current?.closest(".composer-glass")?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(338, window.innerWidth - 24);
      setPosition({ left: Math.max(12, Math.min(anchor.left + 18, window.innerWidth - width - 12)), bottom: window.innerHeight - anchor.top + 8, width, maxHeight: Math.max(100, anchor.top - 20) });
    }
    place();
    const observer = new ResizeObserver(place);
    const composer = trigger.current?.closest(".composer-glass");
    if (composer) observer.observe(composer);
    window.addEventListener("resize", place);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.closest(".composer-glass")?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  function close() { setOpen(false); trigger.current?.focus(); }
  return <>
    <button ref={trigger} type="button" className="composer-frames-trigger" aria-label={triggerLabel} title={triggerLabel} aria-haspopup="dialog" aria-controls={id} aria-expanded={open} onClick={() => setOpen(value => !value)}>{text ? <AudioLines size={15} aria-hidden="true" /> : <Images size={15} aria-hidden="true" />}</button>
    {open && createPortal(<div ref={panel} id={id} role="dialog" aria-label={title} className="app-popover composer-local-frames"
      style={{ position: "fixed", ...position, visibility: position ? "visible" : "hidden" }} onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <header><span>{title}</span><button type="button" aria-label={`关闭${title}`} onClick={close}><X size={14} aria-hidden="true" /></button></header>
      {!text && <div className="composer-frame-pair">{(reference ? [0] : [0, 1]).map(index => <figure key={index}>
        {frames[index] ? <img src={convertFileSrc(frames[index].store_path!)} alt={`${label(index)}：${frames[index].name}`} /> : <span className="composer-frame-empty">{reference ? "请填入参考图" : index === 0 ? "请填入首帧图片" : "未填入尾帧"}</span>}
        <figcaption><span>{label(index)}</span><span>{frames[index] ? reference ? "<Picture 1>" : `图片 ${index + 1}` : ""}</span></figcaption>
      </figure>)}</div>}
      {reference && <p className="text-xs text-muted">用 &lt;Picture 1&gt; 指代主体，不固定首尾画面</p>}
      {audio.length === 1 && <div className="composer-h3-audio">
        <div><AudioLines size={14} aria-hidden="true" /><strong>{comfyAudioLabel(mode)}</strong><span title={audio[0].name}>{audio[0].name}</span></div>
        <small>{comfyAudioHint(mode)}</small>
      </div>}
      {audio.length > 1 && <div className="composer-frames-warning" role="status"><CircleAlert size={13} aria-hidden="true" />本地 H3 每次可使用一段录音，请移除多余录音。</div>}
      {ignored > 0 && <div className="composer-frames-warning" role="status"><CircleAlert size={13} aria-hidden="true" /><span>其余 {ignored} 个参考素材不参与生成</span></div>}
    </div>, document.body)}
  </>;
}
