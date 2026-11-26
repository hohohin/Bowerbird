import type { Asset } from "./types";

export interface VoiceCardSettings {
  id?: string;
  sampleText?: string;
  seed?: number;
  clip?: { assetId: string; start: number; end: number; name: string; transcript: string };
}
export interface VoiceCardRequest {
  key: string;
  jobId?: string;
  previewKey?: string;
  videoAudio?: { sourceAssetId: string; assetId: string };
  assetId?: string;
  warning?: string;
  hasDiagnostic?: boolean;
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
  const fields = [asset.id, start, end, transcript, (settings.sampleText ?? defaultVoiceSample).trim()];
  if (settings.seed !== undefined) fields.push(settings.seed);
  return JSON.stringify(fields);
}
