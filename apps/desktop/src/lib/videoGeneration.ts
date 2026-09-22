import type { Asset } from "./types";

export type GenerationMedia = "image" | "video";
export interface VideoOptions {
  kind: "text2video" | "image2video" | "frames2video" | "multimodal2video";
  model_version: "seedance2.5";
  duration: number;
  video_resolution: "480p" | "720p" | "1080p";
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
  if (options.model_version !== "seedance2.5") return "视频仅支持 Seedance 2.5";
  if (!Number.isInteger(options.duration) || options.duration < 4 || options.duration > 30) return "视频时长须为 4–30 秒的整数";
  if (!(cloud ? ["480p", "720p", "1080p"] : ["480p", "720p"]).includes(options.video_resolution)) return "当前视频渠道不支持此分辨率";
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
      if (images.length > 30 || videos.length > 10) return "多参考模式最多使用 30 张图片和 10 个视频";
      if (videos.some((asset) => asset.duration != null && (asset.duration < 2 || asset.duration > 30))) return "每段参考视频须为 2–30 秒";
      if (videos.reduce((total, asset) => total + (asset.duration ?? 0), 0) > 30) return "参考视频总时长不能超过 30 秒";
      return null;
    }
    default: return "不支持此视频生成模式";
  }
}
