import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";
import { Pause, Play, Scissors, Volume2, VolumeX } from "lucide-react";
import type { Asset } from "../lib/types";
import type { SaveVideoTrim } from "../lib/videoTrim";
import {
  audioPreviewKey, audioPreviewPosition, audioPreviewSnapshot, observeAudioPreviewSource, playAudioPreview,
  setAudioPreviewSettings, stopAudioPreview, stopAudioRangePreview, subscribeAudioPreview, withAudioPreviewReleased,
} from "../lib/audioPreview";
import { peekAudioWaveform, requestAudioWaveform, type AudioWaveformData } from "../lib/audioPreviewPeaks";
import { startScrub, moveScrub } from "../lib/videoFineScrub";
import { videoTime } from "../lib/videoFrame";
import { userErrorMessage } from "../lib/userError";
import { paintAudioWaveform } from "./AudioWaveform";
import { MediaTrimTimeline } from "./MediaTrimTimeline";
import { ModalShell } from "./ModalShell";
import { TacticalSelect } from "./TacticalSelect";
import "./VideoPlayer.css";
import "./AudioDetailPlayer.css";

interface AudioDetailPlayerProps {
  asset: Asset;
  path: string;
  sourceKey: string;
  duration?: number | null;
  onDuration?: (seconds: number) => void;
  seekRequest?: { time: number; revision: number };
  onSaveTrim?: SaveVideoTrim;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function WaveformCanvas({ data, inset }: { data: AudioWaveformData; inset: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const draw = () => paintAudioWaveform(target, data, inset);
    draw();
    const resize = new ResizeObserver(draw);
    resize.observe(target);
    const theme = new MutationObserver(draw);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { resize.disconnect(); theme.disconnect(); };
  }, [data, inset]);
  return <canvas ref={canvas} aria-hidden="true" />;
}

export function AudioDetailPlayer({ asset, path, sourceKey, duration, onDuration, seekRequest, onSaveTrim }: AudioDetailPlayerProps) {
  const waveformKey = JSON.stringify([asset.id, path, sourceKey, undefined]);
  const [waveform, setWaveform] = useState(() => ({ key: waveformKey, data: peekAudioWaveform(waveformKey), error: "" }));
  const [retry, setRetry] = useState(0);
  const data = waveform.key === waveformKey ? waveform.data : undefined;
  const seconds = data?.duration ?? duration ?? 0;
  const source = useMemo(() => data ? { assetId: asset.id, path, sourceVersion: data.sourceVersion, duration: data.duration } : null,
    [asset.id, path, data]);
  const playbackKey = source ? audioPreviewKey(source) : "";
  const subscribe = useCallback((listener: () => void) => subscribeAudioPreview(playbackKey, listener), [playbackKey]);
  const snapshot = useCallback(() => audioPreviewSnapshot(playbackKey), [playbackKey]);
  const playback = useSyncExternalStore(subscribe, snapshot, snapshot);
  const playing = playback.phase === "playing" || playback.phase === "loading";
  const owner = useRef({});
  const reportedDuration = useRef(onDuration);
  reportedDuration.current = onDuration;

  const [time, setTime] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [trimming, setTrimming] = useState(false);
  const [range, setRange] = useState<{ start: number; end: number }>();
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState<"copy" | "overwrite" | null>(null);
  const savingRef = useRef(false);
  const [status, setStatus] = useState<{ message: string; error?: boolean }>();
  const [fine, setFine] = useState(false);
  const drag = useRef<{ id: number; time: number; secondsPerPixel: number; gesture: ReturnType<typeof startScrub> }>();
  const handledSeek = useRef<AudioDetailPlayerProps["seekRequest"]>();
  const start = range?.start ?? 0;
  const end = range?.end ?? seconds;
  const changed = start > 0 || end < seconds;
  const bounded = trimming && changed;
  const minimum = bounded ? start : 0;
  const maximum = bounded ? end : seconds;
  const enabled = !!source && !saving && !confirming;
  const effectiveVolume = muted ? 0 : volume;
  const position = clamp(time, minimum, maximum);
  const percent = (value: number) => seconds > 0 ? value / seconds * 100 : 0;

  useEffect(() => requestAudioWaveform({ key: waveformKey, assetId: asset.id }, result => {
    if (result.data) {
      observeAudioPreviewSource(asset.id, path, result.data.sourceVersion);
      reportedDuration.current?.(result.data.duration);
      setWaveform({ key: waveformKey, data: result.data, error: "" });
    } else {
      setWaveform({ key: waveformKey, data: undefined, error: userErrorMessage(result.error, "波形暂不可用，请重试。") });
    }
  }), [asset.id, path, waveformKey, retry]);
  useEffect(() => {
    const ownerToken = owner.current;
    return () => stopAudioRangePreview(ownerToken);
  }, [playbackKey]);
  useEffect(() => { setAudioPreviewSettings(playbackKey, { rate, volume: effectiveVolume }); }, [playbackKey, rate, effectiveVolume]);
  useEffect(() => {
    if (playback.phase !== "playing") return;
    let frame: number;
    const update = () => {
      if (document.hidden) return;
      const position = audioPreviewPosition(playbackKey);
      if (!position) return;
      setTime(position.time);
      frame = requestAnimationFrame(update);
    };
    const refresh = () => { cancelAnimationFrame(frame); update(); };
    update();
    document.addEventListener("visibilitychange", refresh);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("visibilitychange", refresh); };
  }, [playback.phase, playbackKey]);

  const playFrom = useCallback((value: number, stopAt?: number) => {
    if (!source || savingRef.current) return;
    setTime(value);
    playAudioPreview(source, value / source.duration, true, owner.current, {
      rate, volume: effectiveVolume,
      range: stopAt === undefined ? undefined : { end: stopAt, onEnd: () => setTime(stopAt) },
    });
  }, [source, rate, effectiveVolume]);
  useEffect(() => {
    if (!enabled || !seekRequest || !Number.isFinite(seekRequest.time) || handledSeek.current === seekRequest) return;
    handledSeek.current = seekRequest;
    const target = clamp(seekRequest.time, 0, Math.max(0, seconds - .001));
    if (bounded && target >= end) {
      stopAudioPreview(asset.id);
      setTime(end);
    } else {
      playFrom(bounded ? Math.max(start, target) : target, bounded ? end : undefined);
    }
  }, [enabled, seconds, seekRequest, bounded, start, end, playFrom, asset.id]);

  function pause() {
    if (!playing) return;
    const current = audioPreviewPosition(playbackKey);
    if (current) setTime(current.time);
    stopAudioPreview(asset.id);
  }
  function seek(value: number) {
    if (!enabled || savingRef.current) return;
    pause();
    setTime(clamp(value, minimum, maximum));
  }
  function togglePlayback() {
    if (!enabled || savingRef.current) return;
    if (playing) { pause(); return; }
    playFrom(bounded ? start : time >= seconds - .001 ? 0 : position, bounded ? end : undefined);
  }
  function changeTrim(edge: "in" | "out", value: number) {
    if (!enabled || savingRef.current) return;
    const gap = Math.min(.01, seconds / 2);
    const next = edge === "in" ? clamp(value, 0, end - gap) : clamp(value, start + gap, seconds);
    pause();
    setRange(edge === "in" ? { start: next, end } : { start, end: next });
    setTime(next);
    setStatus(undefined);
  }
  function finishDrag(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (current?.id !== event.pointerId) return;
    drag.current = undefined;
    setFine(false);
  }
  function playbackShortcut(event: KeyboardEvent<HTMLElement>) {
    const target = event.target;
    if (event.code !== "Space" || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing
      || !(target instanceof HTMLElement) || !event.currentTarget.contains(target)
      || target.isContentEditable
      || target.closest('button:not([role="slider"]),input:not([type="number"]),textarea,select,[role="combobox"],[role="menu"]')) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "keydown" && !event.repeat) togglePlayback();
  }
  async function saveTrim(overwrite: boolean) {
    if (!onSaveTrim || !changed || savingRef.current) return;
    setConfirming(false);
    savingRef.current = true;
    setSaving(overwrite ? "overwrite" : "copy");
    setStatus(undefined);
    pause();
    const save = () => onSaveTrim({ sourcePath: path, start, end, overwrite });
    try {
      if (overwrite) await withAudioPreviewReleased(asset.id, save);
      else await save();
      if (overwrite) {
        setTrimming(false);
        setRange(undefined);
        setTime(0);
      }
      setStatus({ message: overwrite ? "已覆盖原音频" : "新音频已保存到素材库" });
    } catch (error) {
      setStatus({ message: userErrorMessage(error, "音频裁剪未保存，请检查原文件和保存位置后重试。"), error: true });
    } finally {
      savingRef.current = false;
      setSaving(null);
    }
  }
  function confirmOverwrite() {
    if (asset.source === "external") {
      setStatus({ message: "外部音频无法覆盖，请选择「另存为新音频」。", error: true });
    } else {
      pause();
      setConfirming(true);
    }
  }

  return <section className={`audio-detail-player video-player is-contained${trimming ? " is-trimming" : ""}`} aria-label="音频播放器"
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
    onKeyDown={playbackShortcut} onKeyUp={playbackShortcut} tabIndex={0}>
    <div className="audio-detail-stage">
      <div className={`audio-detail-track${fine ? " is-fine" : ""}`} role="slider" tabIndex={0} aria-label="音频进度"
        aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={position} aria-valuetext={videoTime(position)} aria-disabled={!enabled}
        onPointerDown={event => {
          if (event.button !== 0 || !enabled) return;
          event.preventDefault();
          event.currentTarget.focus();
          const bounds = event.currentTarget.getBoundingClientRect();
          const secondsPerPixel = seconds / bounds.width;
          const target = clamp((event.clientX - bounds.left) * secondsPerPixel, minimum, maximum);
          seek(target);
          drag.current = { id: event.pointerId, time: target, secondsPerPixel, gesture: startScrub(event.clientX, performance.now()) };
          event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerMove={event => {
          const current = drag.current;
          if (current?.id !== event.pointerId) return;
          const delta = moveScrub(current.gesture, event.clientX, performance.now());
          setFine(current.gesture.fine);
          current.time = clamp(current.time + delta * current.secondsPerPixel, minimum, maximum);
          seek(current.time);
        }} onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}
        onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          seek(event.key === "Home" ? minimum : event.key === "End" ? maximum
            : position + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? .01 : .1));
        }}>
        {data && <WaveformCanvas data={data} inset={20} />}
        {bounded && <><span className="audio-detail-range-mask" style={{ width: `${percent(start)}%`, left: 0 }} aria-hidden="true" />
          <span className="audio-detail-range-mask" style={{ width: `${100 - percent(end)}%`, right: 0 }} aria-hidden="true" /></>}
        {data && <i className="audio-detail-cursor" style={{ left: `${percent(position)}%` }} aria-hidden="true" />}
      </div>
      <div className="audio-detail-ruler" aria-hidden="true">{[0, .25, .5, .75, 1].map(fraction =>
        <span key={fraction}>{videoTime(seconds * fraction).split(".")[0]}</span>)}</div>
      {!data && waveform.key === waveformKey && (waveform.error ? <div className="audio-detail-load" role="status">
        <span>{waveform.error}</span><button type="button" disabled={!!saving} onClick={() => setRetry(value => value + 1)}>重试</button>
      </div> : <span className="audio-detail-load" role="status">正在读取波形…</span>)}
    </div>
    <div className="video-player-controls">
      {trimming && data && <MediaTrimTimeline duration={seconds} start={start} end={end} time={position}
        disabled={!enabled} change={changeTrim} seek={seek}><WaveformCanvas data={data} inset={8} /></MediaTrimTimeline>}
      <div className="video-player-toolbar">
        <button type="button" aria-label={playing ? "暂停" : "播放"} aria-keyshortcuts="Space"
          title={playing ? "暂停（空格）" : bounded ? "从入点播放（空格）" : "播放（空格）"} disabled={!enabled} onClick={togglePlayback}>
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <output className="video-player-time" aria-label="当前播放时间" aria-live="off">{videoTime(position)} <span>/ {videoTime(seconds)}</span></output>
        <button type="button" aria-label={effectiveVolume > 0 ? "静音" : "取消静音"} disabled={!!saving || confirming}
          onClick={() => { if (volume === 0) setVolume(1); setMuted(effectiveVolume > 0); }}>
          {effectiveVolume > 0 ? <Volume2 size={17} /> : <VolumeX size={17} />}
        </button>
        <input type="range" className="video-player-volume" aria-label="音量" min={0} max={1} step={.05} value={effectiveVolume}
          disabled={!!saving || confirming} onChange={event => { setVolume(event.target.valueAsNumber); setMuted(false); }} />
        <TacticalSelect className="video-speed-trigger" menuClassName="video-speed-menu" aria-label="播放速度" value={rate}
          disabled={!!saving || confirming} onValueChange={value => setRate(Number(value))}>
          {[.5, .75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}
        </TacticalSelect>
      </div>
      {onSaveTrim && <div className="video-player-footer">
        <div className="video-player-tools">
          <button type="button" aria-label="裁剪音频" aria-pressed={trimming} disabled={!enabled}
            onClick={() => { pause(); setTrimming(!trimming); setStatus(undefined); }}>
            <Scissors size={16} />{trimming ? "结束裁剪" : "裁剪"}
          </button>
        </div>
        {trimming && <div className="audio-detail-trim-actions">
          <button type="button" className="video-player-add" disabled={!changed || !enabled} onClick={() => void saveTrim(false)}>
            {saving === "copy" ? "正在保存…" : "另存为新音频"}
          </button>
          <button type="button" disabled={!changed || !enabled} onClick={confirmOverwrite}>{saving === "overwrite" ? "正在覆盖…" : "覆盖原音频"}</button>
          <button type="button" disabled={!changed || !enabled} onClick={() => { pause(); setRange(undefined); setStatus(undefined); }}>重置</button>
        </div>}
      </div>}
      {playback.error && <p className="video-player-error" role="alert">{playback.error}</p>}
      {status && <p className={status.error ? "video-player-error" : "video-player-saved"} role={status.error ? "alert" : "status"}>{status.message}</p>}
    </div>
    {confirming && <ModalShell title="覆盖原音频？" onClose={() => setConfirming(false)} footer={<>
      <button type="button" className="btn" data-modal-autofocus onClick={() => setConfirming(false)}>取消</button>
      <button type="button" className="btn btn-primary" onClick={() => void saveTrim(true)}>确认覆盖</button>
    </>}>
      <p>裁剪会应用到引用此原件的位置。当前版本的转录文稿会失效。</p>
    </ModalShell>}
  </section>;
}
