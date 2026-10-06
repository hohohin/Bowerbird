import type { Asset } from "./types";

export type GenerationMedia = "image" | "video";
export interface VideoOptions {
  kind: "text2video" | "image2video" | "frames2video" | "multimodal2video";
  model_version: string;
  duration: number;
  video_resolution: "480p" | "720p" | "1080p" | "4k";
}
export interface GenerationSettings {
  videoChannel?: "jimeng" | "cloud";
  media?: GenerationMedia;
  videoOptions?: VideoOptions | null;
  ratio?: string | null;
  /** 图片生成张数（仅即梦 / Cloud 生图引擎支持；1–4）。 */
  count?: number;
  /** 透明图层：生图请求带 background: transparent（仅即梦 / Cloud 生图引擎支持）。 */
  transparent?: boolean;
}
export function videoProvider(channel: "jimeng" | "cloud" | undefined, options: VideoOptions): string {
  return channel === "cloud" ? `bowerbird-cloud-video_seedance25_${options.video_resolution}` : "jimeng";
}
export const DEFAULT_VIDEO_OPTIONS: VideoOptions = {
  kind: "text2video", model_version: "seedance2.5", duration: 5, video_resolution: "720p",
};
export const VIDEO_RATIOS = ["16:9", "9:16", "1:1", "3:4", "4:3", "21:9"];
export const VIDEO_MODELS = ["seedance2.5", "seedance2.0", "seedance2.0fast", "seedance2.0_vip", "seedance2.0fast_vip", "seedance2.0mini", "seedance1.5pro", "seedance1.0fast"];
export interface VideoModelCapability {
  model_version: string;
  resolutions: VideoOptions["video_resolution"][];
  min_duration: number;
  max_duration: number;
}
export function videoDurationRange(model: string): [number, number] {
  return model === "seedance2.5" ? [4, 30] : model === "seedance1.5pro" ? [5, 12] : model === "seedance1.0fast" ? [5, 10] : [4, 15];
}
export function videoResolutions(model: string): VideoOptions["video_resolution"][] {
  return model === "seedance2.5" ? ["480p", "720p", "1080p"] : model === "seedance2.0_vip" ? ["720p", "1080p", "4k"] : ["720p"];
}
export function cloudVideoOptions(options: VideoOptions): VideoOptions {
  return { ...options, model_version: "seedance2.5", video_resolution: options.video_resolution === "4k" ? "720p" : options.video_resolution };
}
export function isVideoPath(path?: string | null): boolean {
  return !!path && /\.(mp4|mov|webm|m4v|avi|mkv)(?:[?#].*)?$/i.test(path);
}
export function videoSupportsRatio(options: VideoOptions): boolean {
  return options.kind === "text2video" || options.kind === "multimodal2video";
}
export function videoRatio(options: VideoOptions, ratio?: string | null): string | null {
  return videoSupportsRatio(options) ? ratio || "16:9" : null;
}
/** Validate explicit inputs without dropping, reordering, or borrowing a previous output. */
export function videoInputError(options: VideoOptions, references: readonly Pick<Asset, "store_path" | "duration">[], ratio?: string | null, provider = "jimeng"): string | null {
  const cloud = provider.startsWith("bowerbird-cloud-video_seedance25_");
  if (!VIDEO_MODELS.includes(options.model_version) || (cloud && options.model_version !== "seedance2.5")) return "当前视频渠道不支持此模型";
  if (options.model_version === "seedance1.0fast" && options.kind !== "image2video"
    || options.model_version === "seedance1.5pro" && !["image2video", "frames2video"].includes(options.kind)) return "当前生成模式不支持此模型";
  const [min, max] = videoDurationRange(options.model_version);
  if (!Number.isInteger(options.duration) || options.duration < min || options.duration > max) return `视频时长须为 ${min}–${max} 秒的整数`;
  if (!videoResolutions(options.model_version).includes(options.video_resolution)) return "当前视频模型不支持此分辨率";
  if (videoSupportsRatio(options) && ratio && !VIDEO_RATIOS.includes(ratio)) return "请选择支持的视频比例";
  if (references.some((asset) => !asset.store_path)) return "参考素材尚未就绪，请重新选择";
  const videos = references.filter((asset) => isVideoPath(asset.store_path));
  if (cloud && videos.some(asset => !/\.(mp4|mov)$/i.test(asset.store_path ?? ""))) return "方舟视频参考仅支持 MP4 / MOV";
  const images = references.filter((asset) => /\.(png|jpe?g|webp|bmp)(?:[?#].*)?$/i.test(asset.store_path ?? ""));
  if (images.length + videos.length !== references.length) return "视频参考仅支持 PNG、JPEG、WebP、BMP 图片及视频，不支持音频";
  switch (options.kind) {
    case "text2video": return references.length ? "文生视频不使用参考素材，请移除素材或切换生成模式" : null;
    case "image2video": return images.length === 1 && !videos.length ? null : "单图生视频需要且只能选择 1 张图片";
    case "frames2video": return images.length === 2 && !videos.length ? null : "首尾帧模式需要 2 张图片，按编辑框顺序分别作为首帧、尾帧";
    case "multimodal2video": {
      if (!references.length) return "多参考模式至少需要 1 张图片或 1 个视频";
      const is25 = options.model_version === "seedance2.5";
      if (images.length > (is25 ? 30 : 9) || videos.length > (is25 ? 10 : 3)) return `多参考模式最多使用 ${is25 ? 30 : 9} 张图片和 ${is25 ? 10 : 3} 个视频`;
      if (videos.some((asset) => asset.duration != null && (asset.duration < 2 || asset.duration > max))) return `每段参考视频须为 2–${max} 秒`;
      if (videos.reduce((total, asset) => total + (asset.duration ?? 0), 0) > max) return `参考视频总时长不能超过 ${max} 秒`;
      return null;
    }
    default: return "不支持此视频生成模式";
  }
}
