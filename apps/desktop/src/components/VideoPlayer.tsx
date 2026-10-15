import { useEffect, useRef, useState, type PointerEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Check, ImagePlus, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { captureVideoFrame, loadVideoStrip, videoTime, type VideoFrame } from "../lib/videoFrame";
import "./VideoPlayer.css";

export function VideoPlayer({ path, onAddFrame }: { path: string; onAddFrame?: (frame: VideoFrame) => Promise<void> }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const drag = useRef<{ id: number; x: number; time: number; moved: boolean } | null>(null);
  const savingRef = useRef(false);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [paused, setPaused] = useState(true);
  const [ready, setReady] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fine, setFine] = useState(false);
  const [muted, setMuted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedTime, setSavedTime] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const src = convertFileSrc(path);
  const length = Math.max(720, Math.min(4800, duration * 48)) * (fine ? 4 : 1);
  const pixelsPerSecond = duration > 0 ? length / duration : 1;

  useEffect(() => {
    if (!duration || !ready) return;
    return loadVideoStrip(src, duration, (index, url) => setThumbnails(current => {
      const next = [...current]; next[index] = url; return next;
    }));
  }, [src, duration, ready]);
  useEffect(() => {
    const video = videoRef.current;
    // StrictMode and Fast Refresh replay cleanup/setup on the same DOM node.
    // Restore the source that cleanup removed, without preloading the video.
    if (video && video.getAttribute("src") !== src) video.src = src;
    return () => { video?.pause(); video?.removeAttribute("src"); video?.load(); };
  }, [src]);

  function seek(value: number) {
    const video = videoRef.current;
    if (!video || !duration || savingRef.current) return;
    video.pause();
    const next = Math.max(0, Math.min(duration, value));
    setTime(next);
    if (Math.abs(video.currentTime - next) > 0.00001) { setSeeking(true); video.currentTime = next; }
  }
  async function togglePlay() {
    const video = videoRef.current;
    if (!video || savingRef.current) return;
    setError("");
    if (!video.paused) video.pause();
    else {
      try { await video.play(); } catch { setError("视频暂时无法播放，请检查文件或编码格式"); }
    }
  }
  function endDrag(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (!cancelled && !current.moved) {
      const bounds = event.currentTarget.getBoundingClientRect();
      seek(current.time + (event.clientX - bounds.left - bounds.width / 2) / pixelsPerSecond);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  async function addFrame() {
    if (!videoRef.current || !onAddFrame || savingRef.current) return;
    savingRef.current = true;
    setSaving(true); setError("");
    try {
      const frame = captureVideoFrame(videoRef.current, path);
      await onAddFrame(frame);
      setSavedTime(frame.time);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { savingRef.current = false; setSaving(false); }
  }

  return <section className="video-player" aria-label="视频播放器" onClick={event => event.stopPropagation()}
    onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
      if (event.code === "Space" && event.target === event.currentTarget) { event.preventDefault(); void togglePlay(); }
    }} tabIndex={0}>
    <div className="video-player-screen">
      <video ref={videoRef} crossOrigin="anonymous" src={src} preload="none" playsInline muted={muted}
        aria-label="视频画面" onClick={() => void togglePlay()}
        onLoadedMetadata={event => { const value = event.currentTarget.duration; setDuration(Number.isFinite(value) ? value : 0); }}
        onLoadedData={() => setReady(true)} onPlay={() => setPaused(false)} onPause={() => setPaused(true)}
        onEnded={() => setPaused(true)} onSeeking={() => setSeeking(true)}
        onSeeked={event => { setSeeking(false); if (!drag.current) setTime(event.currentTarget.currentTime); }}
        onTimeUpdate={event => { if (!drag.current) setTime(event.currentTarget.currentTime); }}
        onError={() => { setReady(false); setError("视频无法读取，请检查文件或编码格式"); }} />
      {!ready && <button className="video-player-start" aria-label="播放视频" onClick={() => void togglePlay()}><Play size={32} />播放视频</button>}
    </div>
    <div className="video-player-controls">
      <div className="video-player-toolbar">
        <button aria-label={paused ? "播放" : "暂停"} disabled={saving} onClick={() => void togglePlay()}>{paused ? <Play size={18} /> : <Pause size={18} />}</button>
        <output className="video-player-time" aria-label="当前播放时间">{videoTime(time)} <span>/ {videoTime(duration)}</span></output>
        <button aria-label={muted ? "取消静音" : "静音"} onClick={() => setMuted(!muted)}>{muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
        <button className="video-player-fine" aria-pressed={fine} disabled={saving || dragging} onClick={() => setFine(!fine)}>细调</button>
      </div>
      <div className={`video-player-timeline ${dragging ? "is-dragging" : ""}`} role="slider" tabIndex={0}
        aria-label="视频时间轴" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={time} aria-valuetext={videoTime(time)}
        aria-disabled={!ready || saving} onPointerDown={event => {
          if (event.button !== 0 || !ready || saving) return;
          event.preventDefault(); event.currentTarget.focus(); videoRef.current?.pause();
          drag.current = { id: event.pointerId, x: event.clientX, time, moved: false };
          setDragging(true); event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerMove={event => {
          const current = drag.current;
          if (!current || current.id !== event.pointerId) return;
          const delta = event.clientX - current.x;
          if (Math.abs(delta) > 3) current.moved = true;
          if (current.moved) seek(current.time - delta / pixelsPerSecond);
        }} onPointerUp={event => endDrag(event)} onPointerCancel={event => endDrag(event, true)}
        onLostPointerCapture={event => endDrag(event, true)} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          seek(event.key === "Home" ? 0 : event.key === "End" ? duration : time + (event.key === "ArrowLeft" ? -1 : 1) * (fine ? 0.01 : 0.1));
        }}>
        <div className="video-player-film" style={{ width: length, transform: `translateX(${-time * pixelsPerSecond}px)` }} aria-hidden="true">
          {Array.from({ length: 12 }, (_, index) => <div key={index}>{thumbnails[index] && <img src={thumbnails[index]} alt="" draggable={false} />}</div>)}
        </div>
        <div className="video-player-playhead" aria-hidden="true" />
      </div>
      <div className="video-player-footer">
        <span>左右拖动选画面 · {fine ? "细调已开启 · 方向键 0.01 秒" : "方向键 0.1 秒"}</span>
        {onAddFrame && <button className="video-player-add" disabled={!paused || !ready || seeking || dragging || saving || savedTime === time}
          onClick={() => void addFrame()}>{savedTime === time ? <Check size={16} /> : <ImagePlus size={16} />}{saving ? "正在添加…" : savedTime === time ? "已添加到画板" : "添加该帧到画板"}</button>}
      </div>
      {error && <p className="video-player-error" role="alert">{error}</p>}
    </div>
  </section>;
}
