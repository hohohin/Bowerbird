import { convertFileSrc } from "@tauri-apps/api/core";
import { userErrorMessage } from "./userError";

export interface AudioPreviewSource { assetId: string; path: string; sourceVersion: string; duration: number }
type Snapshot = { phase: "idle" | "loading" | "playing" | "error"; continuous: boolean; error: string };
type AudioPlaybackSettings = { rate: number; volume: number };
type AudioPlaybackRange = { end: number; onEnd: () => void };
type AudioPlaybackOptions = AudioPlaybackSettings & { range?: AudioPlaybackRange };
const idle: Snapshot = { phase: "idle", continuous: false, error: "" };
const listeners = new Map<string, Set<() => void>>();
const lockedAssets = new Set<string>();
let media: HTMLAudioElement | undefined;
let active: { source: AudioPreviewSource; key: string; owner: object; continuous: boolean; range?: AudioPlaybackRange } | undefined;
let snapshot = idle;
let failure: { key: string; snapshot: Snapshot } | undefined;
let generation = 0;
let rangeTimer: number | undefined;

export function audioPreviewKey(source: Pick<AudioPreviewSource, "assetId" | "path" | "sourceVersion">) {
  return JSON.stringify([source.assetId, source.path, source.sourceVersion]);
}
function emit(key?: string) { if (key) listeners.get(key)?.forEach(listener => listener()); }
export function subscribeAudioPreview(key: string, listener: () => void) {
  let set = listeners.get(key);
  if (!set) { set = new Set(); listeners.set(key, set); }
  set.add(listener);
  return () => { set.delete(listener); if (!set.size) listeners.delete(key); };
}
export function audioPreviewSnapshot(key: string): Snapshot {
  return active?.key === key ? snapshot : failure?.key === key ? failure.snapshot : idle;
}

/** Explicit deletion/disconnection calls this; ordinary React unmount does not. */
export function stopAudioPreview(assetId?: string) {
  if (!active || (assetId && active.source.assetId !== assetId)) return;
  const key = active.key;
  generation++; active = undefined; snapshot = idle;
  clearTimeout(rangeTimer);
  media?.pause(); media?.removeAttribute("src"); media?.load();
  emit(key);
}
/** Keep card and detail playback from reopening the original during an overwrite. */
export async function withAudioPreviewReleased<T>(assetId: string, write: () => Promise<T>) {
  if (lockedAssets.has(assetId)) throw new Error("正在覆盖原音频，请稍后重试。");
  lockedAssets.add(assetId);
  try {
    stopAudioPreview(assetId);
    return await write();
  } finally {
    lockedAssets.delete(assetId);
  }
}
/** Release a file handle before mutating its directory, without stopping other audio. */
export function stopAudioPreviewInFolder(path: string) {
  if (!active || !path) return;
  const normalize = (value: string) => {
    const windows = /^[a-z]:[/\\]|^[/\\]{2}/i.test(value);
    const normalized = value.replace(/\\/g, "/").replace(/^\/\/\?\/UNC\//i, "//")
      .replace(/^\/\/\?\/(?=[a-z]:\/)/i, "").replace(/\/+$/, "") || "/";
    return windows ? normalized.toLowerCase() : normalized;
  };
  const folder = normalize(path), source = normalize(active.source.path);
  if (source === folder || source.startsWith(folder === "/" ? folder : `${folder}/`)) stopAudioPreview();
}
export function stopTemporaryAudioPreview(owner?: object) {
  if (active && !active.continuous && (!owner || active.owner === owner)) stopAudioPreview();
}
export function stopAudioRangePreview(owner?: object) {
  if (active?.range && (!owner || active.owner === owner)) stopAudioPreview();
}
/** UI revisions are not passed here; only a verified fingerprint can invalidate. */
export function observeAudioPreviewSource(assetId: string, path: string, sourceVersion: string) {
  if (active?.source.assetId === assetId && (active.source.path !== path || active.source.sourceVersion !== sourceVersion)) stopAudioPreview(assetId);
}
function fail(error: unknown) {
  if (!active) return;
  const key = active.key;
  stopAudioPreview();
  failure = { key, snapshot: { phase: "error", continuous: false,
    error: userErrorMessage(error, "暂时无法播放，请检查原文件后重试。") } };
  emit(key);
}
function finishRange() {
  const range = active?.range;
  if (!range) return;
  stopAudioPreview();
  range.onEnd();
}
function checkRange() {
  if (media && active?.range && media.currentTime >= active.range.end) finishRange();
}
function scheduleRangeEnd() {
  clearTimeout(rangeTimer);
  if (!media || media.paused || !active?.range) return;
  checkRange();
  if (!active?.range) return;
  const delay = (active.range.end - media.currentTime) / media.playbackRate * 1000;
  rangeTimer = window.setTimeout(scheduleRangeEnd, Math.max(4, delay));
}
function player() {
  if (media) return media;
  media = new Audio(); media.preload = "none"; media.hidden = true;
  media.dataset.audioPreview = "true"; document.body.append(media);
  media.addEventListener("ended", () => { if (active?.range) finishRange(); else stopAudioPreview(); });
  media.addEventListener("error", () => { if (media?.error) fail(media.error); });
  media.addEventListener("timeupdate", checkRange);
  media.addEventListener("ratechange", scheduleRangeEnd);
  const leaveWindow = () => { stopTemporaryAudioPreview(); stopAudioRangePreview(); };
  window.addEventListener("blur", leaveWindow);
  window.addEventListener("scroll", () => stopTemporaryAudioPreview(), { capture: true, passive: true });
  window.addEventListener("pagehide", () => stopAudioPreview());
  document.addEventListener("visibilitychange", () => { if (document.hidden) leaveWindow(); });
  document.addEventListener("keydown", event => { if (event.key === "Escape") stopAudioPreview(); });
  return media;
}

export function playAudioPreview(source: AudioPreviewSource, ratio: number, continuous: boolean, owner: object,
  options?: AudioPlaybackOptions) {
  if (lockedAssets.has(source.assetId) || (options?.range && document.hidden)) return;
  const element = player();
  const key = audioPreviewKey(source);
  const reuse = active?.key === key && element.hasAttribute("src");
  if (!reuse) stopAudioPreview();
  const previousFailure = failure?.key; failure = undefined;
  clearTimeout(rangeTimer);
  active = { source, key, continuous, owner, range: options?.range };
  snapshot = { phase: "loading", continuous, error: "" };
  const request = ++generation;
  emit(previousFailure); emit(key);
  try {
    if (!reuse) {
      const url = convertFileSrc(source.path);
      element.src = `${url}${url.includes("?") ? "&" : "?"}audioVersion=${encodeURIComponent(source.sourceVersion)}`;
    }
    element.playbackRate = options?.rate ?? 1;
    element.volume = options?.volume ?? 1;
    const latestStart = options?.range ? source.duration : Math.max(0, source.duration - .01);
    element.currentTime = Math.min(latestStart, Math.max(0, ratio) * source.duration);
    void element.play().then(() => {
      if (generation !== request || active?.key !== key) return;
      snapshot = { phase: "playing", continuous, error: "" }; emit(key);
      scheduleRangeEnd();
    }).catch(error => { if (generation === request && active?.key === key) fail(error); });
  } catch (error) { if (generation === request) fail(error); }
}

export function setAudioPreviewSettings(key: string, { rate, volume }: AudioPlaybackSettings) {
  if (!media || active?.key !== key) return;
  media.playbackRate = rate;
  media.volume = volume;
}
export function audioPreviewPosition(key: string) {
  if (!media || active?.key !== key || media.paused) return null;
  return { time: media.currentTime, duration: Number.isFinite(media.duration) && media.duration > 0 ? media.duration : active.source.duration };
}
