export interface VoiceDraft {
  text: string; voiceId: string; sourceId: string;
  name: string; transcript: string; start: number; end: number;
}
export const emptyVoiceDraft = (): VoiceDraft => ({ text: "", voiceId: "", sourceId: "", name: "", transcript: "", start: 0, end: 0 });
const key = (project: string) => `bowerbird.voice.draft.v1:${project}`;
export function readVoiceDraft(project: string): VoiceDraft {
  try {
    const value = JSON.parse(localStorage.getItem(key(project)) || "null");
    if (!value || typeof value !== "object") return emptyVoiceDraft();
    const result = emptyVoiceDraft();
    for (const field of ["text", "voiceId", "sourceId", "name", "transcript"] as const) if (typeof value[field] === "string") result[field] = value[field];
    for (const field of ["start", "end"] as const) if (typeof value[field] === "number" && Number.isFinite(value[field]) && value[field] >= 0) result[field] = value[field];
    if (value.mode === "design") Object.assign(result, { sourceId: "", name: "", transcript: "", start: 0, end: 0 });
    return result;
  } catch { return emptyVoiceDraft(); }
}
export function voiceClipRange(duration: number, start: number, end: number, edge: "in" | "out", value: number) {
  if (!Number.isFinite(value)) return { start, end };
  return edge === "in" ? { start: Math.max(0, end - 30, Math.min(end - 1, value)), end }
    : { start, end: Math.min(duration, start + 30, Math.max(start + 1, value)) };
}
