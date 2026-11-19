import { VideoTrimTimeline } from "./VideoTrimTimeline";
import { TacticalSelect } from "./TacticalSelect";
import { VideoExportMenu } from "./VideoExportMenu";
import { createVideoAudioExport } from "../lib/videoAudio";
import { useStore } from "../store";
import { startScrub, moveScrub } from "../lib/videoFineScrub";
import { userErrorMessage } from "../lib/userError";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ImagePlus, Music2, Maximize, Minimize, Pause, Play, Scissors, Volume2, VolumeX } from "lucide-react";
import { api } from "../lib/api";
import type { SaveVideoTrim } from "../lib/videoTrim";
import { captureVideoFrame, invalidateVideoStrip, loadVideoStrip, seekVideoLastFrame, videoTime, type VideoFrame } from "../lib/videoFrame";
import "./VideoPlayer.css";

export function VideoPlayer({ path, sourceKey, seekRequest, onAddFrame, onAddFrameToCanvas, onReferenceFrame, onSaveTrim, embedded = false, fitContainer = false, showTrim = !embedded, frameTarget = "canvas" }: { path: string; sourceKey?: string; seekRequest?: { time: number; revision: number }; onAddFrame?: (frame: VideoFrame) => Promise<void>; onAddFrameToCanvas?: (frame: VideoFrame) => Promise<void>; onReferenceFrame?: (frame: VideoFrame) => Promise<void>; onSaveTrim?: SaveVideoTrim; embedded?: boolean; fitContainer?: boolean; showTrim?: boolean; frameTarget?: "canvas" | "reference" | "library" }) {
  const playerRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !seekRequest || !Number.isFinite(seekRequest.time)) return;
    const seek = () => { if (Number.isFinite(video.duration) && video.duration > 0) {
      video.pause(); video.currentTime = Math.max(0, Math.min(seekRequest.time, video.duration - 0.001));
    } };
    if (video.readyState >= 1) seek();
    else video.addEventListener("loadedmetadata", seek, { once: true });
    return () => video.removeEventListener("loadedmetadata", seek);
  }, [path, seekRequest]);

  const [dimensions, setDimensions] = useState({ width: 720, height: 405 });
  const [controlsHeight, setControlsHeight] = useState(230);
  const [controlsWidth, setControlsWidth] = useState(1000);
  const drag = useRef<{ id: number; time: number; moved: boolean; gesture: ReturnType<typeof startScrub> } | null>(null);
  const savingRef = useRef(false);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [paused, setPaused] = useState(true);
  const [ready, setReady] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fine, setFine] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [playbackFailure, setPlaybackFailure] = useState<{ message: string; diagnostic: string } | null>(null);
  const [reload, setReload] = useState(0);
  const retryTime = useRef(0);
  const [savingTarget, setSavingTarget] = useState<"current" | "last" | "canvas" | "copy" | "overwrite" | "reference" | "audio" | null>(null);
  const projectId = useStore(state => state.activeProjectId);
  const audioExports = useRef(new Map<string, () => Promise<void>>());
  const [savedAudioTargets, setSavedAudioTargets] = useState<string[]>([]);
  const saving = savingTarget !== null;
  const [savedLastFrame, setSavedLastFrame] = useState(false);
  const [savedTime, setSavedTime] = useState<number | null>(null);
  const [savedCanvasTime, setSavedCanvasTime] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [strip, setStrip] = useState<{ key: string; images: string[] }>({ key: "", images: [] });
  const [trimming, setTrimming] = useState(false);
  const [inPoint, setInPoint] = useState(0);
  const [outPoint, setOutPoint] = useState(0);
  const [savedMessage, setSavedMessage] = useState("");
  const [revision, setRevision] = useState(0);
  const trimRestoreRef = useRef<{ start: number; end: number } | null>(null);
  const fileSrc = convertFileSrc(path);
  const mediaRevision = [sourceKey, revision || ""].filter(Boolean).join(":");
  const src = fileSrc + (mediaRevision ? `${fileSrc.includes("?") ? "&" : "?"}media=${encodeURIComponent(mediaRevision)}` : "");
  const trimChanged = duration > 0 && (inPoint > 0 || outPoint < duration) && outPoint > inPoint;
  const length = Math.max(720, Math.min(4800, duration * 48)) * (fine ? 4 : 1);
  const pixelsPerSecond = duration > 0 ? length / duration : 1;
  // Quarter-window steps keep nearby timeupdates on the same cached strip.
  // Keep two visible widths in a fine window, including contained/fullscreen players.
  const stripSpan = fine && !trimming && !dragging ? Math.min(duration, Math.max(12, Math.ceil(controlsWidth * 2 / pixelsPerSecond))) : duration;
  const stripStep = stripSpan / 4;
  const stripStart = fine && stripStep ? Math.max(0, Math.min(duration - stripSpan, Math.floor(time / stripStep) * stripStep - stripStep)) : 0;
  const stripEnd = stripStart + stripSpan;
  const stripKey = `${src}|${duration}|${stripStart}:${stripEnd}`;
  const thumbnails = strip.key === stripKey ? strip.images : [];

  useEffect(() => {
    const cancel = () => { drag.current=null; setDragging(false); setFine(false); };
    const hidden = () => { if (document.hidden) cancel(); };
    window.addEventListener("blur",cancel); document.addEventListener("visibilitychange",hidden);
    return () => { window.removeEventListener("blur",cancel); document.removeEventListener("visibilitychange",hidden); };
  }, []);

  useEffect(() => {
    if (!duration || !ready || dragging) return;
    let current = true;
    let dispose: (() => void) | undefined;
    const load = () => {
      dispose = loadVideoStrip(src, duration, (index, url) => {
        if (!current) return;
        setStrip(previous => {
          const images = previous.key === stripKey ? [...previous.images] : [];
          images[index] = url;
          return { key: stripKey, images };
        });
      }, { start: stripStart, end: stripEnd });
    };
    const timer = fine ? window.setTimeout(load, 160) : undefined;
    if (!fine) load();
    return () => { current = false; clearTimeout(timer); dispose?.(); };
  }, [src, duration, ready, dragging, fine, stripStart, stripEnd, stripKey]);
  useEffect(() => {
    const video = videoRef.current;
    // StrictMode and Fast Refresh replay cleanup/setup on the same DOM node.
    // Restore the source that cleanup removed so the opened preview loads its first frame.
    if (video && video.getAttribute("src") !== src) video.src = src;
    return () => { video?.pause(); video?.removeAttribute("src"); video?.load(); };
  }, [src]);
  useEffect(() => {
    const video = videoRef.current;
    if (video) { video.volume = volume; video.playbackRate = speed; }
  }, [volume, speed, src]);
  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === playerRef.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  const failPlayback = useCallback((message: string, cause?: unknown) => {
    const video = videoRef.current;
    setBuffering(false);
    setPlaybackFailure({ message, diagnostic: JSON.stringify({ path, code: video?.error?.code,
      message: video?.error?.message, cause: cause instanceof Error ? cause.message : cause,
      readyState: video?.readyState, networkState: video?.networkState }, null, 2) });
  }, [path]);
  useEffect(() => {
    if ((ready && !buffering) || playbackFailure || saving) return;
    const timeout = window.setTimeout(() => failPlayback("视频加载等待过久，请重新加载或检查原文件是否可访问。", "media load timed out"), 15000);
    return () => clearTimeout(timeout);
  }, [src, reload, ready, buffering, playbackFailure, saving, failPlayback]);

  function retryPlayback() {
    const video = videoRef.current;
    if (!video || savingRef.current) return;
    retryTime.current = video.currentTime;
    video.pause(); setReady(false); setSeeking(false); setBuffering(false); setPlaybackFailure(null); setError("");
    setReload(value => value + 1); video.load();
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === playerRef.current) await document.exitFullscreen();
      else await playerRef.current?.requestFullscreen();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  const seek = useCallback((value: number) => {
    const video = videoRef.current;
    if (!video || !duration || savingRef.current) return;
    video.pause();
    const next = Math.max(0, Math.min(duration, value));
    setTime(next);
    if (Math.abs(video.currentTime - next) > 0.00001) { setSeeking(true); video.currentTime = next; }
  }, [duration]);
  const togglePlay = useCallback(async () => {
    const video = videoRef.current;
    if (!video || savingRef.current) return;
    setError("");
    if (!video.paused) video.pause();
    else {
      if (trimming && (video.currentTime < inPoint || video.currentTime >= outPoint)) video.currentTime = inPoint;
      try { await video.play(); } catch (cause) { failPlayback("视频暂时无法播放，请重新加载后再试。", cause); }
    }
  }, [trimming, inPoint, outPoint, failPlayback]);
  useEffect(() => {
    function onPlaybackKey(event: KeyboardEvent) {
      const space = event.code === "Space";
      if ((!space && !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      const target = event.target;
      if (target instanceof Element && target.closest('[role="combobox"], [role="listbox"], [role="menu"]')) return;
      if (target instanceof HTMLElement && (embedded || target.closest(".video-player"))
        && (target.isContentEditable || target.closest("input, textarea, select"))) return;
      if (embedded && (!(target instanceof HTMLElement) || !videoRef.current?.closest(".video-player")?.contains(target))) return;
      if (!space && target instanceof Element && target.closest('[role="slider"]')) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.type !== "keydown") return;
      if (space) { if (!event.repeat) void togglePlay(); }
      else seek(event.key === "Home" ? 0 : event.key === "End" ? duration : (videoRef.current?.currentTime ?? 0) + (event.key === "ArrowLeft" ? -1 : 1) * (fine ? 0.01 : 0.1));
    }
    window.addEventListener("keydown", onPlaybackKey, true);
    window.addEventListener("keyup", onPlaybackKey, true);
    return () => {
      window.removeEventListener("keydown", onPlaybackKey, true);
      window.removeEventListener("keyup", onPlaybackKey, true);
    };
  }, [togglePlay, embedded, fine, duration, seek]);
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const observer = new ResizeObserver(() => {
      const bounds = controls.getBoundingClientRect();
      setControlsHeight(bounds.height); setControlsWidth(bounds.width);
    });
    observer.observe(controls);
    return () => observer.disconnect();
  }, []);
  function endDrag(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    setFine(false);
    if (!cancelled && !current.moved) {
      const bounds = event.currentTarget.getBoundingClientRect();
      seek(current.time + (event.clientX - bounds.left - bounds.width / 2) / pixelsPerSecond);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  async function addFrame(last = false, toCanvas = false) {
    const video = videoRef.current;
    const save = toCanvas ? onAddFrameToCanvas : onAddFrame;
    if (!video || !save || savingRef.current || (last && savedLastFrame)) return;
    savingRef.current = true;
    setSavingTarget(toCanvas ? "canvas" : last ? "last" : "current"); setError(""); setSavedMessage("");
    try {
      if (last) {
        await seekVideoLastFrame(video);
        if (videoRef.current !== video) return;
        setTime(video.currentTime);
      }
      const frame = captureVideoFrame(video, path);
      await save(frame);
      if (toCanvas) setSavedCanvasTime(frame.time); else setSavedTime(frame.time);
      if (last) setSavedLastFrame(true);
      setSavedMessage(last ? "尾帧已添加" : toCanvas || frameTarget === "canvas" ? "已添加到画板" : frameTarget === "library" ? "已保存到素材库" : "已选作参考图");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { savingRef.current = false; setSavingTarget(null); }
  }

  async function exportAudio(target: "canvas" | "library") {
    if (savingRef.current) return;
    savingRef.current = true; setSavingTarget("audio"); setError(""); setSavedMessage("");
    videoRef.current?.pause();
    const key = `${src}:${target}`;
    let save = audioExports.current.get(key);
    if (!save) { save = createVideoAudioExport(path, target === "canvas" ? projectId : null, target); audioExports.current.set(key, save); }
    try { await save(); setSavedAudioTargets(previous => [...previous, key]); setSavedMessage(target === "canvas" ? "音轨已添加到画板" : "音轨已保存到素材库"); }
    catch (cause) { setError(String(cause)); }
    finally { savingRef.current = false; setSavingTarget(null); }
  }

  function changeTrim(edge: "in" | "out", value: number) {
    if (savingRef.current || !Number.isFinite(value)) return;
    const gap = Math.min(0.01, duration / 2);
    const next = edge === "in" ? Math.max(0, Math.min(outPoint - gap, value)) : Math.min(duration, Math.max(inPoint + gap, value));
    if (edge === "in") setInPoint(next); else setOutPoint(next);
    setSavedMessage(""); seek(next);
  }
  async function referenceFrame() {
    const video = videoRef.current;
    if (!video || !onReferenceFrame || savingRef.current || !video.paused || !ready || seeking || dragging) return;
    savingRef.current = true; setSavingTarget("reference"); setError("");
    try { await onReferenceFrame(captureVideoFrame(video, path)); setSavedMessage("已选作参考图"); }
    catch (cause) { setError(String(cause)); }
    finally { savingRef.current = false; setSavingTarget(null); }
  }
  async function saveTrim(overwrite: boolean) {
    const video = videoRef.current;
    if (!video || savingRef.current || !trimChanged) return;
    savingRef.current = true;
    setSavingTarget(overwrite ? "overwrite" : "copy"); setError(""); setSavedMessage("");
    video.pause();
    if (overwrite) {
      // Release both decoders before replacing a file held by the native WebView.
      setReady(false);
      video.removeAttribute("src"); video.load();
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
    try {
      await (onSaveTrim ?? api.trimVideo)({ sourcePath: path, start: inPoint, end: outPoint, overwrite });
      setSavedMessage(overwrite ? "原视频已覆盖" : onSaveTrim ? "新视频已保存到画板" : "新视频已保存到素材库");
      if (overwrite) { invalidateVideoStrip(fileSrc); setSavedLastFrame(false); setSavedTime(null); setSavedCanvasTime(null); setTime(0); setStrip({ key: "", images: [] }); setTrimming(false); }
    } catch (cause) {
      if (overwrite) trimRestoreRef.current = { start: inPoint, end: outPoint };
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (overwrite) setRevision(value => value + 1);
      savingRef.current = false; setSavingTarget(null);
    }
  }

  return <section ref={playerRef} className={`video-player${trimming ? " is-trimming" : ""}${fitContainer ? " is-contained" : embedded ? " is-embedded" : ""}`} aria-label="视频播放器" onClick={event => event.stopPropagation()}
    style={{ "--video-width": `${dimensions.width}px`, "--video-ratio": dimensions.width / dimensions.height,
      "--video-controls-height": `${controlsHeight}px` } as CSSProperties}
    onPointerDown={event => event.stopPropagation()} tabIndex={0}>
    <div className="video-player-screen">
      <video ref={videoRef} crossOrigin="anonymous" src={src} preload="auto" playsInline muted={muted}
        aria-label="视频画面" onClick={() => void togglePlay()}
        onLoadedMetadata={event => {
          const video = event.currentTarget;
          setDuration(Number.isFinite(video.duration) ? video.duration : 0);
          const restored = trimRestoreRef.current;
          setInPoint(restored && restored.start < video.duration ? restored.start : 0);
          setOutPoint(Number.isFinite(video.duration) ? Math.min(restored?.end ?? video.duration, video.duration) : 0);
          trimRestoreRef.current = null;
          if (video.videoWidth && video.videoHeight) setDimensions({ width: video.videoWidth, height: video.videoHeight });
          video.volume = volume; video.playbackRate = speed;
          if (retryTime.current) { video.currentTime = Math.min(retryTime.current, video.duration); retryTime.current = 0; }
        }}
        onLoadedData={() => { setReady(true); setPlaybackFailure(null); setBuffering(false); }} onPlay={() => setPaused(false)} onPause={() => setPaused(true)}
        onWaiting={() => setBuffering(true)} onStalled={() => setBuffering(true)} onCanPlay={() => setBuffering(false)} onPlaying={() => setBuffering(false)}
        onEnded={() => setPaused(true)} onSeeking={() => setSeeking(true)}
        onSeeked={event => { setSeeking(false); if (!drag.current) setTime(event.currentTarget.currentTime); }}
        onTimeUpdate={event => {
          const video = event.currentTarget;
          if (trimming && !video.paused && video.currentTime >= outPoint) { video.pause(); video.currentTime = outPoint; }
          if (!drag.current) setTime(video.currentTime);
        }}
        onError={event => {
          setReady(false);
          const code = event.currentTarget.error?.code;
          failPlayback(code === 3 ? "视频解码失败，请检查文件是否完整，或尝试兼容的编码格式。"
            : code === 4 ? "当前视频格式无法播放，或原文件不可访问，请检查原文件。"
            : code === 2 ? "视频读取中断，请检查原文件或连接后重新加载。" : "视频加载中断，请重新加载后再试。");
        }} />
      {(!ready || buffering) && !playbackFailure && <div className="video-player-start" role="status">{ready ? "正在缓冲…" : "正在加载视频…"}</div>}
    </div>
    <div ref={controlsRef} className="video-player-controls">
      <div className="video-player-toolbar">
        <button aria-label={paused ? "播放" : "暂停"} title={paused ? "播放（空格）" : "暂停（空格）"} aria-keyshortcuts="Space" disabled={saving} onClick={() => void togglePlay()}>{paused ? <Play size={18} /> : <Pause size={18} />}</button>
        <output className="video-player-time" aria-label="当前播放时间">{videoTime(time)} <span>/ {videoTime(duration)}</span></output>
        <button aria-label={muted ? "取消静音" : "静音"} onClick={() => setMuted(!muted)}>{muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
        <input className="video-player-volume" aria-label="音量" type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume}
          onChange={event => { setVolume(event.target.valueAsNumber); setMuted(event.target.valueAsNumber === 0); }} />
        <TacticalSelect className="video-speed-trigger" menuClassName="video-speed-menu" portalContainer={fullscreen ? playerRef.current : undefined} aria-label="播放速度" value={speed} onValueChange={value => setSpeed(Number(value))}>
          {[0.5,0.75,1,1.25,1.5,2].map(value => <option key={value} value={value}>{value}×</option>)}
        </TacticalSelect>
        <button aria-label={fullscreen ? "退出全屏" : "全屏"} onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize size={17} /> : <Maximize size={17} />}</button>

      </div>
      {trimming && <VideoTrimTimeline duration={duration} start={inPoint} end={outPoint} time={time} images={thumbnails} disabled={saving || !ready} change={changeTrim} seek={seek} />}
      <div className={`video-player-timeline ${dragging ? "is-dragging" : ""} ${fine ? "is-fine" : ""}`} role="slider" tabIndex={0}
        title="拖动定位 · 长按后轻拖细调 · Shift + 方向键微调"
        aria-label="视频时间轴" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={time} aria-valuetext={videoTime(time)}
        aria-disabled={!ready || saving} onPointerDown={event => {
          if (event.button !== 0 || !ready || saving) return;
          event.preventDefault(); event.currentTarget.focus(); videoRef.current?.pause();
          drag.current = { id: event.pointerId, time, moved: false, gesture: startScrub(event.clientX, performance.now()) };
          setDragging(true); event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerMove={event => {
          const current = drag.current;
          if (!current || current.id !== event.pointerId) return;
          const delta = moveScrub(current.gesture, event.clientX, performance.now());
          if (Math.abs(event.clientX - current.gesture.origin) >= 3) current.moved = true;
          setFine(current.gesture.fine);
          if (current.moved) {
            const basePixels = Math.max(720, Math.min(4800, duration * 48)) / duration;
            current.time = Math.max(0, Math.min(duration, current.time - delta / basePixels));
            seek(current.time);
          }
        }} onPointerUp={event => endDrag(event)} onPointerCancel={event => endDrag(event, true)}
        onLostPointerCapture={event => endDrag(event, true)} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          seek(event.key === "Home" ? 0 : event.key === "End" ? duration : time + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 0.01 : 0.1));
        }}>
        <div className="video-player-film" style={{ width: stripSpan * pixelsPerSecond, transform: `translateX(${(stripStart - time) * pixelsPerSecond}px)` }} aria-hidden="true">
          {Array.from({ length: 12 }, (_, index) => <div key={index}>{thumbnails[index] && <img src={thumbnails[index]} alt="" draggable={false} />}</div>)}
        </div>
        <div className="video-player-playhead" aria-hidden="true" />
      </div>
      <div className="video-player-footer">
        <div className="video-player-tools">
          {showTrim && <button aria-label="裁剪视频" title="调整入点和出点" aria-pressed={trimming} disabled={!ready || saving || dragging}
            onClick={() => { videoRef.current?.pause(); setTrimming(!trimming); setSavedMessage(""); }}><Scissors size={16} />{trimming ? "结束裁剪" : "裁剪"}</button>}
        </div>
        {trimming && <div className="video-trim-actions" aria-label="视频裁剪范围">
          <div className="video-player-frame-actions">
            <button className="video-player-add" disabled={!trimChanged || saving} onClick={() => void saveTrim(false)}>{savingTarget === "copy" ? "正在保存…" : "另存为新视频"}</button>
            <button title="覆盖会同步影响此视频的其他引用" disabled={!trimChanged || saving} onClick={() => void saveTrim(true)}>{savingTarget === "overwrite" ? "正在覆盖…" : "覆盖原视频"}</button>
            <button disabled={saving} onClick={() => { setInPoint(0); setOutPoint(duration); setSavedMessage(""); }}>重置</button>
          </div>
        </div>}
        {!trimming && <>
          {(onAddFrame || onReferenceFrame || onAddFrameToCanvas) && <VideoExportMenu label="导出帧" icon={<ImagePlus size={16} />}
            portal={playerRef.current} disabled={saving || !ready || seeking || dragging}
            items={[
              ...(onReferenceFrame ? [{ label: "添加该帧为参考图", disabled: !paused, run: () => void referenceFrame() }] : []),
              ...(onAddFrame ? [{ label: frameTarget === "reference" ? "截取当前帧作参考" : frameTarget === "library" ? "保存该帧到素材库" : "添加该帧到画板",
                disabled: !paused || savedTime === time, run: () => void addFrame() }] : []),
              ...(onAddFrame && frameTarget === "canvas" ? [{ label: "添加尾帧到画板", disabled: !duration || savedLastFrame, run: () => void addFrame(true) }] : []),
              ...(frameTarget === "library" && onAddFrameToCanvas ? [{ label: "添加该帧到画板", disabled: !paused || savedCanvasTime === time, run: () => void addFrame(false, true) }] : []),
            ]} />}
          <VideoExportMenu label="提取视频音轨" icon={<Music2 size={16} />} portal={playerRef.current}
            disabled={saving || !ready || dragging} items={[
              { label: "添加到画板", disabled: !projectId || savedAudioTargets.includes(`${src}:canvas`), run: () => void exportAudio("canvas") },
              { label: "保存到素材库", disabled: savedAudioTargets.includes(`${src}:library`), run: () => void exportAudio("library") },
            ]} />
        </>}
      </div>
      {savingTarget === "audio" && <p className="video-player-saved" role="status">正在提取音轨…</p>}
      {savingTarget && ["current", "last", "canvas", "reference"].includes(savingTarget) && <p className="video-player-saved" role="status">正在导出帧…</p>}
      {error && <p className="video-player-error" role="alert">{userErrorMessage(error, "视频操作未完成，请检查原文件和保存位置后重试。")}</p>}
      {playbackFailure && <div className="video-player-error" role="alert">
        <p>{playbackFailure.message}</p>
        <button disabled={saving} onClick={retryPlayback}>重新加载视频</button>
        <button onClick={() => void navigator.clipboard.writeText(playbackFailure.diagnostic).catch(cause => setError(String(cause)))}>复制诊断</button>
      </div>}
      {savedMessage && <p className="video-player-saved" role="status">{savedMessage}</p>}
    </div>
  </section>;
}
