import type { Asset } from "./types";

export interface VoiceCardSettings {
  id?: string;
  sampleText?: string;
  seed?: number;
  language?: string;
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
export const VOICE_LANGUAGE_GROUPS = [
  { label: "中文与方言", options: [
    { code: "zh", label: "普通话" },
    { code: "yue", label: "粤语" },
    { code: "zh-sc", label: "四川话" },
    { code: "zh-db", label: "东北话" },
    { code: "zh-wu", label: "吴语" },
    { code: "zh-hn", label: "河南话" },
    { code: "zh-sx", label: "陕西话" },
    { code: "zh-sd", label: "山东话" },
    { code: "zh-tj", label: "天津话" },
    { code: "zh-mn", label: "闽南话" },
  ] },
  { label: "常用外语", options: [
    { code: "en", label: "英语" },
    { code: "ja", label: "日语" },
    { code: "ko", label: "韩语" },
    { code: "fr", label: "法语" },
    { code: "de", label: "德语" },
    { code: "es", label: "西班牙语" },
    { code: "ru", label: "俄语" },
    { code: "it", label: "意大利语" },
    { code: "pt", label: "葡萄牙语" },
    { code: "ar", label: "阿拉伯语" },
    { code: "th", label: "泰语" },
    { code: "vi", label: "越南语" },
  ] },
  { label: "其他语种", options: [
    { code: "id", label: "印尼语" },
    { code: "ms", label: "马来语" },
    { code: "hi", label: "印地语" },
    { code: "tr", label: "土耳其语" },
    { code: "nl", label: "荷兰语" },
    { code: "pl", label: "波兰语" },
    { code: "sv", label: "瑞典语" },
    { code: "da", label: "丹麦语" },
    { code: "no", label: "挪威语" },
    { code: "fi", label: "芬兰语" },
    { code: "el", label: "希腊语" },
    { code: "he", label: "希伯来语" },
    { code: "sw", label: "斯瓦希里语" },
    { code: "km", label: "高棉语" },
    { code: "lo", label: "老挝语" },
    { code: "my", label: "缅甸语" },
    { code: "tl", label: "他加禄语" },
  ] },
] as const;

export function voiceLanguageLabel(code?: string | null) {
  for (const group of VOICE_LANGUAGE_GROUPS) {
    const option = group.options.find(option => option.code === code);
    if (option) return option.label;
  }
  return "自动（随台词）";
}

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
  if (settings.language) fields.push(settings.language);
  return JSON.stringify(fields);
}
