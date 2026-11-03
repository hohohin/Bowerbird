import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { PreviewAsset } from './domain';
import './audio.css';

type Playback = {
  assetId: string | null;
  url: string;
  playing: boolean;
  loading: boolean;
  time: number;
  duration: number;
  mode: 'persistent' | 'temporary';
  error: string;
};
let playback: Playback = { assetId: null, url: '', playing: false, loading: false, time: 0, duration: 0, mode: 'persistent', error: '' };
let player: HTMLAudioElement | undefined;
let currentOwner: object | undefined;
let request = 0;
let seekWhenReady: number | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => playback;
function update(next: Partial<Playback>) {
  playback = { ...playback, ...next };
  listeners.forEach(listener => listener());
}
function pause() {
  request++;
  seekWhenReady = undefined;
  player?.pause();
  update({ playing: false, loading: false });
}
function stopTemporary(owner?: object) {
  if (playback.mode === 'temporary' && (!owner || currentOwner === owner)) pause();
}
function getPlayer() {
  if (player) return player;
  const audio = new Audio();
  audio.preload = 'none';
  audio.addEventListener('loadedmetadata', () => {
    if (seekWhenReady !== undefined) {
      audio.currentTime = Math.min(seekWhenReady, Math.max(0, audio.duration - 0.01));
      seekWhenReady = undefined;
    }
    update({ duration: Number.isFinite(audio.duration) ? audio.duration : 0 });
  });
  audio.addEventListener('timeupdate', () => update({ time: audio.currentTime }));
  audio.addEventListener('playing', () => update({ playing: true, loading: false }));
  audio.addEventListener('pause', () => update({ playing: false }));
  audio.addEventListener('ended', () => update({ playing: false, loading: false }));
  audio.addEventListener('error', () => update({ playing: false, loading: false, error: '音频暂时无法播放，请换一个文件重试。' }));
  window.addEventListener('keydown', event => { if (event.key === 'Escape') pause(); });
  window.addEventListener('scroll', () => stopTemporary(), true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopTemporary(); });
  window.addEventListener('pagehide', () => { pause(); audio.removeAttribute('src'); audio.load(); });
  player = audio;
  return audio;
}
async function play(asset: PreviewAsset, time: number, mode: Playback['mode'], owner: object) {
  const audio = getPlayer();
  const ticket = ++request;
  currentOwner = owner;
  const changedSource = playback.url !== asset.url;
  if (changedSource) audio.pause();
  const duration = !changedSource && Number.isFinite(audio.duration) ? audio.duration : asset.duration ?? 0;
  update({ assetId: asset.id, url: asset.url, mode, time, loading: true, error: '', duration });
  if (changedSource) audio.src = asset.url;
  if (audio.readyState > 0) audio.currentTime = Math.min(time, Math.max(0, audio.duration - 0.01));
  else seekWhenReady = time;
  try {
    await audio.play();
    if (ticket === request) update({ playing: true, loading: false });
  } catch {
    if (ticket === request) update({ playing: false, loading: false, error: '音频暂时无法播放，请点击重试。' });
  }
}

type PeakData = { duration: number; peaks: number[] };
let peakRequest: Promise<PeakData> | undefined;
function loadPeaks() {
  if (!peakRequest) peakRequest = fetch('/pulse-peaks.json').then(async response => {
    if (!response.ok) throw new Error('peaks unavailable');
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || !('duration' in value) || typeof value.duration !== 'number'
      || !('peaks' in value) || !Array.isArray(value.peaks) || value.peaks.length !== 512
      || !value.peaks.every(item => typeof item === 'number' && Number.isFinite(item))) throw new Error('invalid peaks');
    return { duration: value.duration, peaks: value.peaks };
  }).catch(error => { peakRequest = undefined; throw error; });
  return peakRequest;
}
const label = (time: number) => `${Math.floor(time / 60)}:${Math.floor(time % 60).toString().padStart(2, '0')}`;

/** Isolated preview: one shared player, measured fixture peaks, no in-browser audio decoding. */
export function SampleAudio({ asset }: { asset: PreviewAsset }) {
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const owner = useRef({});
  const host = useRef<HTMLDivElement>(null);
  const [peaks, setPeaks] = useState<PeakData>();
  const [hover, setHover] = useState<number | null>(null);
  const selected = useRef(0);
  const active = state.assetId === asset.id && state.url === asset.url;
  const duration = (active && state.duration) || peaks?.duration || asset.duration || 0;
  const playing = active && state.playing;
  const progress = active && duration ? Math.min(1, state.time / duration) : 0;
  useEffect(() => {
    setPeaks(undefined);
    if (asset.id !== 'audio-demo' || !host.current) return;
    let alive = true;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void loadPeaks().then(data => { if (alive) setPeaks(data); }).catch(() => {});
    });
    observer.observe(host.current);
    return () => { alive = false; observer.disconnect(); };
  }, [asset.id]);
  useEffect(() => () => stopTemporary(owner.current), [asset.id, asset.url]);
  const path = useMemo(() => {
    if (!peaks) return '';
    const maximum = Math.max(...peaks.peaks.map(Math.abs), 0.01);
    return Array.from({ length: peaks.peaks.length / 2 }, (_, index) => {
      const x = (index + 0.5) * 1000 / (peaks.peaks.length / 2);
      const top = 32 - peaks.peaks[index * 2 + 1] / maximum * 27;
      const bottom = 32 - peaks.peaks[index * 2] / maximum * 27;
      return `M${x.toFixed(1)},${top.toFixed(1)}V${bottom.toFixed(1)}`;
    }).join(' ');
  }, [peaks]);
  const locate = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    selected.current = ratio;
    setHover(ratio);
    return ratio;
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); event.stopPropagation();
      const step = event.key === 'ArrowRight' ? 0.05 : -0.05;
      selected.current = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : Math.max(0, Math.min(1, selected.current + step));
      setHover(selected.current);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); event.stopPropagation();
      void play(asset, selected.current * duration, 'temporary', owner.current);
    }
  };
  return <div ref={host} className="document-audio" contentEditable={false} data-audio-id={asset.id}
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
    <div className="document-audio-wave" role="slider" tabIndex={0} aria-label={`${asset.name} 试听位置`}
      aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round((hover ?? progress) * duration)}
      aria-valuetext={label((hover ?? progress) * duration)}
      onPointerMove={locate} onPointerLeave={() => { setHover(null); stopTemporary(owner.current); }}
      onClick={event => {
        const box = event.currentTarget.getBoundingClientRect();
        selected.current = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
        void play(asset, selected.current * duration, 'temporary', owner.current);
      }}
      onBlur={() => { setHover(null); stopTemporary(owner.current); }} onKeyDown={keyboard}>
      {path ? <svg viewBox="0 0 1000 64" preserveAspectRatio="none" aria-hidden="true"><path d={path} /></svg>
        : <span className="document-audio-track" aria-hidden="true" />}
      <span className="document-audio-progress" style={{ width: `${progress * 100}%` }} aria-hidden="true" />
      {hover !== null && <span className="document-audio-needle" style={{ left: `${hover * 100}%` }} aria-hidden="true">
        <span>{label(hover * duration)}</span>
      </span>}
    </div>
    <div className="document-audio-controls">
      <button type="button" aria-label={`${playing ? '暂停' : '从头播放'} ${asset.name}`}
        onClick={() => { if (playing) pause(); else void play(asset, 0, 'persistent', owner.current); }}>
        {playing ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3v10M11 3v10" /></svg>
          : <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 3 8 5-8 5z" /></svg>}
      </button>
      <span className="document-audio-name">{asset.name}</span>
      <span className="document-audio-duration">{active && state.loading ? '加载中' : `${label(active ? state.time : 0)} / ${label(duration)}`}</span>
    </div>
    {active && state.error && <div className="document-audio-error" role="alert">{state.error}</div>}
  </div>;
}
