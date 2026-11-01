import { invoke } from "@tauri-apps/api/core";

export interface AudioWaveformData {
  sourceVersion: string;
  duration: number;
  sampleRate: number;
  channels: number;
  peaks: Float32Array;
  framesPerPeak: number;
  totalFrames: number;
  displayGain: number;
}
type Result = { data: AudioWaveformData; error?: never } | { data?: never; error: unknown };
type Request = { key: string; assetId: string; expectedVersion?: string };
type Job = { request: Request; started: boolean; listeners: Set<(result: Result) => void> };
const jobs = new Map<string, Job>();
const cache = new Map<string, AudioWaveformData>();
let running = 0;
let scheduled = false;

function parseWaveform(input: unknown, expectedVersion?: string): AudioWaveformData {
  const value = input as Record<string, unknown>;
  const number = (key: string) => typeof value?.[key] === "number" && Number.isFinite(value[key]) && (value[key] as number) > 0;
  if (!value || typeof value.sourceVersion !== "string" || !value.sourceVersion ||
    !["duration", "sampleRate", "channels", "framesPerPeak", "totalFrames"].every(number) ||
    !Array.isArray(value.peaks) || !value.peaks.length || value.peaks.length > 2048 ||
    Math.ceil((value.totalFrames as number) / (value.framesPerPeak as number)) !== value.peaks.length) throw new Error("波形数据暂不可用，请重试。");
  if (expectedVersion && expectedVersion !== value.sourceVersion) throw new Error("素材已变化，请刷新后重试。");
  const peaks = new Float32Array(value.peaks.length * 2);
  let maximum = 0;
  value.peaks.forEach((pair: unknown, index: number) => {
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(n => typeof n === "number" && Number.isFinite(n)) ||
      pair[0] < -1 || pair[1] > 1 || pair[0] > pair[1]) throw new Error("波形数据暂不可用，请重试。");
    peaks[index * 2] = pair[0]; peaks[index * 2 + 1] = pair[1];
    maximum = Math.max(maximum, Math.abs(pair[0]), Math.abs(pair[1]));
  });
  return { sourceVersion: value.sourceVersion, duration: value.duration as number, sampleRate: value.sampleRate as number,
    channels: value.channels as number, framesPerPeak: value.framesPerPeak as number, totalFrames: value.totalFrames as number,
    peaks, displayGain: maximum > 0 ? .8 / maximum : 1 };
}

function remember(key: string, data: AudioWaveformData) {
  cache.delete(key); cache.set(key, data);
  if (cache.size > 64) cache.delete(cache.keys().next().value!);
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    while (running < 2) {
      const job = [...jobs.values()].find(item => !item.started && item.listeners.size);
      if (!job) break;
      job.started = true; running++;
      const { key, assetId, expectedVersion } = job.request;
      void invoke<unknown>("audio_waveform", expectedVersion ? { assetId, expectedVersion } : { assetId })
        .then(value => {
          const data = parseWaveform(value, expectedVersion);
          remember(key, data);
          for (const done of job.listeners) done({ data });
        }).catch(error => { for (const done of job.listeners) done({ error }); })
        .finally(() => { jobs.delete(key); running--; schedule(); });
    }
  });
}

export function peekAudioWaveform(key: string) {
  const data = cache.get(key);
  if (data) remember(key, data);
  return data;
}

/** Only visible components subscribe. Unstarted jobs disappear on release;
 * the two already-running native jobs may finish into the bounded cache. */
export function requestAudioWaveform(request: Request, done: (result: Result) => void) {
  const cached = peekAudioWaveform(request.key);
  if (cached) {
    let alive = true;
    queueMicrotask(() => { if (alive) done({ data: cached }); });
    return () => { alive = false; };
  }
  let job = jobs.get(request.key);
  if (!job) { job = { request, started: false, listeners: new Set() }; jobs.set(request.key, job); }
  job.listeners.add(done); schedule();
  return () => {
    job.listeners.delete(done);
    if (!job.started && !job.listeners.size && jobs.get(request.key) === job) jobs.delete(request.key);
  };
}
