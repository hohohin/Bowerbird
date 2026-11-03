import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pause, Play } from "lucide-react";
import { audioPreviewKey, audioPreviewPosition, audioPreviewSnapshot, observeAudioPreviewSource, playAudioPreview,
  stopAudioPreview, stopTemporaryAudioPreview, subscribeAudioPreview } from "../lib/audioPreview";
import { peekAudioWaveform, requestAudioWaveform, type AudioWaveformData } from "../lib/audioPreviewPeaks";
import { userErrorMessage } from "../lib/userError";
import { videoDurationLabel } from "./VideoHoverPreview";
import "./AudioWaveform.css";

export interface AudioWaveformProps {
  assetId: string;
  path: string;
  name: string;
  version: string | number;
  expectedVersion?: string;
  duration?: number | null;
  interactive?: boolean;
  className?: string;
  onDuration?: (duration: number) => void;
}
type Loaded = { key: string; assetId: string; path: string; data?: AudioWaveformData; error?: unknown };
const timeLabel = (time: number) => time < 1 ? "0:00" : videoDurationLabel(time) || "0:00";

function paint(canvas: HTMLCanvasElement, data: AudioWaveformData) {
  const width = canvas.clientWidth, height = canvas.clientHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  const context = canvas.getContext("2d");
  if (!context || !width || !height) return;
  context.scale(dpr, dpr);
  context.strokeStyle = getComputedStyle(canvas).getPropertyValue("--bb-muted").trim() || "#949494";
  context.lineWidth = 1; context.beginPath();
  const amplitude = Math.max(0, height - 48) / 2 * data.displayGain;
  for (let x = 0; x < width; x += 2) {
    const start = Math.floor(x / width * data.totalFrames / data.framesPerPeak);
    const end = Math.min(data.peaks.length / 2, Math.ceil((x + 2) / width * data.totalFrames / data.framesPerPeak));
    let low = 0, high = 0;
    for (let i = start; i < end; i++) { low = Math.min(low, data.peaks[i * 2]); high = Math.max(high, data.peaks[i * 2 + 1]); }
    context.moveTo(x + .5, Math.min(height / 2 - high * amplitude, height / 2 - .5));
    context.lineTo(x + .5, Math.max(height / 2 - low * amplitude, height / 2 + .5));
  }
  context.stroke();
}

/** Original-file audio preview. File names and total duration belong to the parent card. */
export function AudioWaveform({ assetId, path, name, version, expectedVersion, duration, interactive = true, className = "", onDuration }: AudioWaveformProps) {
  const host = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), progress = useRef<HTMLSpanElement>(null);
  const hover = useRef<HTMLSpanElement>(null), position = useRef<HTMLSpanElement>(null), owner = useRef({});
  const selectedRatio = useRef(0), durationCallback = useRef(onDuration);
  durationCallback.current = onDuration;
  const requestKey = JSON.stringify([assetId, path, version, expectedVersion]);
  const [visible, setVisible] = useState(false), [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>(() => ({ key: requestKey, assetId, path, data: peekAudioWaveform(requestKey) }));
  const data = loaded.key === requestKey ? loaded.data : undefined;
  const known = loaded.assetId === assetId && loaded.path === path ? loaded.data : undefined;
  const sourceVersion = data?.sourceVersion ?? known?.sourceVersion;
  const sourceKey = sourceVersion ? audioPreviewKey({ assetId, path, sourceVersion }) : "";
  const subscribe = useCallback((listener: () => void) => subscribeAudioPreview(sourceKey, listener), [sourceKey]);
  const getSnapshot = useCallback(() => audioPreviewSnapshot(sourceKey), [sourceKey]);
  const playback = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const playing = playback.phase === "playing", pending = playback.phase === "loading";
  const failure = playback.error || (loaded.key === requestKey && loaded.error ? userErrorMessage(loaded.error, "波形暂不可用，请重试。") : "");

  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)));
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (expectedVersion) observeAudioPreviewSource(assetId, path, expectedVersion);
    return () => stopTemporaryAudioPreview(owner.current);
  }, [assetId, path, expectedVersion]);
  useEffect(() => {
    if (!visible || !interactive) stopTemporaryAudioPreview(owner.current);
  }, [visible, interactive]);
  useEffect(() => {
    if (!visible) return;
    return requestAudioWaveform({ key: requestKey, assetId, expectedVersion }, result => {
      setLoaded({ key: requestKey, assetId, path, ...result });
      if (result.data) {
        observeAudioPreviewSource(assetId, path, result.data.sourceVersion);
        if (duration !== result.data.duration) durationCallback.current?.(result.data.duration);
      }
    });
  }, [requestKey, assetId, path, expectedVersion, visible, retry, duration]);
  useEffect(() => {
    const target = canvas.current;
    if (!target || !visible || !data) return;
    const draw = () => paint(target, data);
    draw();
    const resize = new ResizeObserver(draw); resize.observe(target);
    const theme = new MutationObserver(draw); theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { resize.disconnect(); theme.disconnect(); target.width = 0; target.height = 0; };
  }, [data, visible]);
  useEffect(() => {
    if (!playing || !visible) return;
    let frame = 0;
    const tick = () => {
      frame = 0;
      if (document.hidden || !host.current?.isConnected) return;
      const value = audioPreviewPosition(sourceKey);
      if (!value || !progress.current) return;
      progress.current.style.left = `${Math.min(1, value.time / value.duration) * 100}%`;
      frame = requestAnimationFrame(tick);
    };
    const visibility = () => { cancelAnimationFrame(frame); frame = 0; if (!document.hidden) tick(); };
    tick(); document.addEventListener("visibilitychange", visibility);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("visibilitychange", visibility); };
  }, [playing, visible, sourceKey]);

  function showPointer(ratio: number) {
    selectedRatio.current = Math.max(0, Math.min(1, ratio));
    if (hover.current) hover.current.style.left = `${selectedRatio.current * 100}%`;
    if (position.current) position.current.textContent = timeLabel(selectedRatio.current * (data?.duration ?? duration ?? 0));
  }
  function pointerRatio(element: HTMLElement, clientX: number) {
    const rect = element.getBoundingClientRect();
    return (clientX - rect.left) / rect.width;
  }
  function start(ratio: number, continuous: boolean) {
    if (!data || !interactive) return;
    playAudioPreview({ assetId, path, sourceVersion: data.sourceVersion, duration: data.duration }, ratio, continuous, owner.current);
  }
  return <div ref={host} className={`audio-waveform ${className}`} data-audio-preview="true" data-asset-id={assetId}
    data-wave-ready={!!data} data-playing={playing} data-interactive={interactive} aria-busy={!data && !failure}
    onPointerLeave={() => stopTemporaryAudioPreview(owner.current)}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) stopTemporaryAudioPreview(owner.current); }}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape") stopAudioPreview(); }}>
    <button type="button" className="audio-waveform-wave" disabled={!interactive || !data} aria-label={`试听 ${name}`}
      onPointerEnter={event => { if (event.pointerType !== "touch") showPointer(pointerRatio(event.currentTarget, event.clientX)); }}
      onPointerMove={event => { if (event.pointerType !== "touch") showPointer(pointerRatio(event.currentTarget, event.clientX)); }}
      onClick={event => { const ratio = event.detail === 0 ? selectedRatio.current : pointerRatio(event.currentTarget, event.clientX); showPointer(ratio); start(selectedRatio.current, false); }}
      onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        showPointer(event.key === "Home" ? 0 : event.key === "End" ? 1 : selectedRatio.current + (event.key === "ArrowRight" ? .05 : -.05));
      }}>
      <canvas ref={canvas} aria-hidden="true" />
      <span ref={progress} className="audio-waveform-progress" aria-hidden="true" />
      <span ref={hover} className="audio-waveform-hover" aria-hidden="true" />
      <span ref={position} className="audio-waveform-time" aria-hidden="true">0:00</span>
    </button>
    <button type="button" className="audio-waveform-play" aria-label={`${playing || pending ? "暂停" : "从头播放"} ${name}`}
      title={playing || pending ? "暂停" : "从头播放"} aria-pressed={playing || pending} disabled={!playing && !pending && (!interactive || !data)}
      onClick={event => { event.stopPropagation(); if (playing || pending) stopAudioPreview(assetId); else start(0, true); }}>
      {playing || pending ? <Pause size={12} fill="currentColor" aria-hidden="true" /> : <Play size={12} fill="currentColor" aria-hidden="true" />}
    </button>
    {failure && <span className="audio-waveform-error" role="status">{failure}{!data && <button type="button" onClick={() => setRetry(value => value + 1)}>重试</button>}</span>}
  </div>;
}
