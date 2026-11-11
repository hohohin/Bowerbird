import type { Asset } from "./types";

export interface VoiceCardSettings {
  id?: string;
  sampleText?: string;
  clip?: { assetId: string; start: number; end: number; name: string; transcript: string };
}
export interface VoiceCardRequest {
  key: string;
  jobId?: string;
  previewKey?: string;
  assetId?: string;
}
export const defaultVoiceSample = "欢迎回来，我们可以开始今天的创作了。";
export function voiceCardClip(settings: VoiceCardSettings, asset: Asset) {
  return settings.clip?.assetId === asset.id ? settings.clip : {
    assetId: asset.id, start: 0, end: Math.min(12, asset.duration ?? 0),
    name: asset.name.replace(/\.[^.]+$/, ""), transcript: "",
  };
}
export function voiceCardPreviewKey(settings: VoiceCardSettings, asset: Asset) {
  const { start, end, transcript } = voiceCardClip(settings, asset);
  return JSON.stringify([asset.id, start, end, transcript, (settings.sampleText ?? defaultVoiceSample).trim()]);
}
