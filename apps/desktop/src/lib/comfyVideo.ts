import { invoke } from "@tauri-apps/api/core";
import type { Asset, AuthSnapshot, EntitlementSnapshot } from "./types";

export function hasComfyEntitlement(entitlement: EntitlementSnapshot | null) {
  return !!entitlement?.user_id && (entitlement.offline_state === "fresh" || entitlement.offline_state === "grace")
    && (entitlement.is_test_account === true || entitlement.tier === "pro" || entitlement.tier === "studio");
}

export function canUseComfyVideo(auth: AuthSnapshot | null, entitlement: EntitlementSnapshot | null) {
  return auth?.logged_in === true && !!auth.user_id && entitlement?.user_id === auth.user_id && hasComfyEntitlement(entitlement);
}

export const H3_VIDEO_MODES = [
  { value: "frames", label: "首尾帧" },
  { value: "reference", label: "单图" },
  { value: "text", label: "文生视频" },
  { value: "r2v", label: "多素材参考（R2V）" },
] as const;
export type ComfyVideoMode = typeof H3_VIDEO_MODES[number]["value"];
export const H3_R2V_LIMITS = { image: 9, video: 3, audio: 3 } as const;
export const H3_R2V_REFERENCE_HINT = `用 <Picture 1>、<Video 1>、<Audio 1> 指代素材。音频先编视频原声，再编独立录音。${comfyAudioHint("r2v")}`;
export interface ComfyVideoOptions {
  mode?: ComfyVideoMode;
  endpoint: string;
  seconds: number;
  ratio: "9:16" | "16:9" | "4:3" | "3:4" | "1:1" | "auto";
  resolution: 0.6 | 0.8 | 0.98 | 1;
}
export const DEFAULT_COMFY_VIDEO: ComfyVideoOptions = { endpoint: "http://127.0.0.1:8000", seconds: 8, ratio: "auto", resolution: 0.8 };
export const H3_IMAGE_ENDPOINT = "http://127.0.0.1:18190";
export const H3_VIDEO_RESOLUTIONS = [{ value: 0.6, label: "低" }, { value: 0.8, label: "中" }, { value: 0.98, label: "高" }] as const;
export function comfyVideoMode(options?: ComfyVideoOptions): ComfyVideoMode { return options?.mode ?? "frames"; }
export function comfyVideoOptionsForMode(options: ComfyVideoOptions, mode: ComfyVideoMode): ComfyVideoOptions {
  if (comfyVideoMode(options) === mode) return options;
  return { ...options, mode, seconds: mode === "frames" ? 8 : 5, resolution: mode === "frames" ? 0.8 : 0.98,
    ratio: mode === "text" ? "9:16" : DEFAULT_COMFY_VIDEO.ratio };
}
export interface H3VideoReferences { referenceImages?: string[]; referenceVideos?: string[]; referenceAudios?: string[] }
export interface ComposerLocalVideoRequest extends H3VideoReferences { prompt: string; firstFrame: string; lastFrame?: string; audioAssetId?: string; options: ComfyVideoOptions }
/** Match the editor's ordered image references. */
export function localVideoFrames(references: Asset[]) {
  return references.filter(asset => /\.(png|jpe?g|webp|bmp)(?:[?#].*)?$/i.test(asset.store_path ?? ""));
}
export function comfyAudioLabel(mode: ComfyVideoMode) {
  return mode === "frames" || mode === "text" ? "原声引导" : "参考音频";
}
export function comfyAudioHint(mode: ComfyVideoMode) {
  if (mode === "reference") return "可借用 <Audio 1> 的音色和语调说新台词。";
  if (mode === "r2v") return "角色可借用参考音频的音色和语调说新台词。";
  return "从第 0 秒沿用录音内容与节奏。仅借音色说新台词，请切换到单图或 R2V。";
}
export function h3R2VInputError(images: number, videos: number, audios: number, requireReference = true): string | null {
  if (images > H3_R2V_LIMITS.image || videos > H3_R2V_LIMITS.video || audios > H3_R2V_LIMITS.audio)
    return "H3 多素材参考最多接收 9 张图片、3 段视频和 3 段录音。";
  if (requireReference && images + videos + audios === 0) return "请添加至少一个参考图片、视频或录音。";
  return null;
}
export function localVideoInputError(prompt: string, frames: Asset[], options: ComfyVideoOptions, audio: Asset[] = [], videos: Asset[] = []): string | null {
  const mode = comfyVideoMode(options);
  if (mode === "r2v") {
    const error = h3R2VInputError(frames.length, videos.length, audio.length);
    if (error) return error;
  } else {
    if (mode !== "text" && !frames.length) return mode === "reference" ? "请在创作描述中添加一张参考图。" : "请在创作描述中添加首帧图片。";
    if (audio.length > 1) return "本地 H3 每次可使用一段录音，请移除多余录音。";
  }
  if (!prompt.trim() || prompt.length > 16000) return "请填写 1–16000 字创作描述。";
  if (!Number.isInteger(options.seconds) || options.seconds < 1 || options.seconds > 15) return "本地视频时长须为 1–15 秒的整数。";
  if (![0.6, 0.8, 0.98, 1].includes(options.resolution) || !["auto", "9:16", "16:9", "4:3", "3:4", "1:1"].includes(options.ratio)) return "请选择本地视频支持的比例和分辨率。";
  if (mode === "text" && options.ratio === "auto") return "文生视频需要指定画面比例。";
  return null;
}
export function comfyVideoSize(options: ComfyVideoOptions, firstFrame?: { width?: number | null; height?: number | null }) {
  const [w, h] = options.ratio === "auto" ? [firstFrame?.width, firstFrame?.height] : options.ratio.split(":").map(Number);
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const scale = Math.sqrt(options.resolution * 1024 * 1024 / (w * h));
  return { width: Math.round(w * scale / 32) * 32, height: Math.round(h * scale / 32) * 32,
    frames: Math.max(5, Math.ceil((options.seconds * 24 - 5) / 17) * 17 + 5) };
}
export interface ComfyVideoInput extends ComfyVideoOptions, H3VideoReferences { firstFrame: string; lastFrame?: string; audioAssetId?: string; prompt: string }
export interface ComfyVideoProgress { label: string; value?: number | null; max?: number | null }
export interface ComfyVideoStatus { status: "queued" | "running" | "offline" | "unknown" | "failed" | "done" | "cancelled"; originalService?: [string, ComfyVideoMode, (string | null)?]; message: string; asset?: Asset; progress?: ComfyVideoProgress | null; elapsedMs?: number | null }
export function comfyVideo(action: "start" | "status" | "cancel", projectId: string, requestId: string, input?: ComfyVideoInput) {
  return invoke<ComfyVideoStatus>("comfy_video", { action, projectId, requestId, input: input ?? null });
}
export async function copyComfyDiagnostic(report: string) {
  const log = await invoke<string>("comfy_video_log_tail").catch(() => "");
  await navigator.clipboard.writeText(report + (log || ""));
}

export function checkComfyVideo(endpoint: string, mode: ComfyVideoMode = "frames") { return invoke<string>("comfy_video_check", { endpoint, mode }); }

export type ComfyEnvironmentMode = ComfyVideoMode | "image" | "edit";
export interface ComfyEnvironment {
  mode?: ComfyEnvironmentMode; modelsRequired?: number; canAddModels?: boolean;
  phase: "missing" | "ready" | "installing" | "starting" | "stopped" | "unavailable" | "recoverable" | "failed" | "cancelled";
  message: string; endpoint: string; directory: string; canInstall: boolean; installed: boolean;
  downloadBytes: number; requiredBytes: number; completedBytes: number; totalBytes: number;
  existing?: { path: string; name: string; endpoint: string; canStart: boolean; modelsFound: number }[];
  hardware?: { gpus: { name: string; driver?: string | null; memoryMib?: number | null }[]; driverRequired: boolean; issue?: string | null } | null;
  driverDownload?: { url: string; message: string } | null;
}
// Readiness means Run can proceed without user setup, even when the service is stopped.
export function comfyEnvironmentReady(environment?: ComfyEnvironment) {
  if (!environment) return false;
  if (environment.phase === "ready" || environment.phase === "recoverable") return true;
  if (!["stopped", "missing", "starting"].includes(environment.phase)) return false;
  const instance = environment.existing?.[0];
  return instance ? instance.canStart && instance.modelsFound === (environment.modelsRequired ?? 5) : environment.installed && environment.canInstall;
}
// Multiple visible cards share a read-only detection request; installation is singleton in native code.
const detections = new Map<string, Promise<ComfyEnvironment>>();
export function comfyEnvironment(action: "detect" | "status" | "prepare" | "recover" | "install" | "cancel" | "select_existing" | "start_existing" | "driver", endpoint: string, directory?: string, existingDirectory?: string, mode: ComfyEnvironmentMode = "frames") {
  const key = JSON.stringify([endpoint, directory, existingDirectory, mode]);
  if (action === "detect" && detections.has(key)) return detections.get(key)!;
  const request = invoke<ComfyEnvironment>("comfy_video_environment", { action, endpoint, directory: directory ?? null, existingDirectory: existingDirectory ?? null, mode });
  if (action === "detect") {
    detections.set(key, request);
    void request.finally(() => detections.delete(key)).catch(() => {});
  }
  return request;
}

export function comfyVideoElapsed(milliseconds?: number | null) {
  if (milliseconds == null || !Number.isFinite(milliseconds) || milliseconds < 0) return "";
  const seconds = Math.round(milliseconds / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
