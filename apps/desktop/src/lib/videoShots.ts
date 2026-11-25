import type { VideoTranscript } from "./videoTranscript";

export type Cut = { at: number; kind: "scene" | "manual" | "long" };
export type ShotTexts = [string, string, string];
export type ShotPlan = {
  sourceHash: string; revision: number; durationMs: number; threshold: number;
  cuts: Cut[]; selected: string[]; results: Record<string, ShotTexts>; canUndo: boolean; undoCuts: Cut[] | null;
};
export type ShotChange =
  | { type: "cuts"; cuts: Cut[]; threshold?: number; confirmed: string[]; suppressedAt?: number }
  | { type: "undo"; confirmed: string[] }
  | { type: "select"; selected: string[] }
  | { type: "edit"; id: string; texts: ShotTexts };
export type Shot = { id: string; start: number; end: number; index: number };
export const shotStamp = (ms: number) => Math.floor(ms / 60_000) + ":" + ((ms % 60_000) / 1000).toFixed(3).padStart(6, "0");

export function segments(cuts: Cut[], duration: number): Shot[] {
  return [0, ...cuts.map(c => c.at)].map((start,index) => {
    const end = cuts[index]?.at ?? duration;
    return { start, end, index, id: start + "-" + end };
  });
}

export function affectedShots(plan: ShotPlan, next: Cut[]) {
  const retained = new Set(segments(next, plan.durationMs).map(s => s.id));
  return segments(plan.cuts, plan.durationMs).filter(s => !retained.has(s.id) && plan.results[s.id]);
}

export function alignShotSpeech(shots: Shot[], transcript?: VideoTranscript | null) {
  const speech = new Map<string, { text: string; legacy: boolean }>();
  function assign(start: number, end: number) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return;
    let lo = 0, hi = shots.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (shots[mid].end <= start) lo = mid + 1;
      else hi = mid;
    }
    if (start === end) return shots[lo]?.id;
    let longest = 0;
    let id: string | undefined;
    for (let i = lo; i < shots.length && shots[i].start < end; i++) {
      const overlap = Math.min(shots[i].end, end) - Math.max(shots[i].start, start);
      if (overlap > longest) { longest = overlap; id = shots[i].id; }
    }
    return id;
  }
  for (const line of transcript?.utterances ?? []) {
    const timed = line.words?.filter(w => Number.isFinite(w.startMs) && Number.isFinite(w.endMs) && w.startMs >= 0 && w.endMs >= w.startMs);
    const byShot = new Map<string, string[]>();
    for (const piece of timed?.length ? timed : [line]) {
      const id = assign(piece.startMs, piece.endMs);
      if (!id) continue;
      const parts = byShot.get(id) ?? [];
      parts.push(piece.text);
      byShot.set(id, parts);
    }
    for (const [id,parts] of byShot) {
      const previous = speech.get(id);
      speech.set(id,{ text: (previous ? previous.text + "\n" : "") + parts.join(""), legacy: !!previous?.legacy || !timed?.length });
    }
  }
  return speech;
}
