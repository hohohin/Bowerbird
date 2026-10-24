import { invoke } from "@tauri-apps/api/core";
import type { Asset, AuthSnapshot, EntitlementSnapshot } from "./types";

export function canUseComfyVideo(auth: AuthSnapshot | null, entitlement: EntitlementSnapshot | null) {
  return auth?.logged_in === true && !!auth.user_id && entitlement?.user_id === auth.user_id
    && (entitlement.offline_state === "fresh" || entitlement.offline_state === "grace")
    && (entitlement.is_test_account === true || entitlement.tier === "pro" || entitlement.tier === "studio");
}

export interface ComfyVideoOptions {
  endpoint: string;
  seconds: number;
  ratio: "9:16" | "16:9" | "4:3" | "3:4" | "1:1" | "auto";
  resolution: 0.6 | 0.8 | 1;
}
export const DEFAULT_COMFY_VIDEO: ComfyVideoOptions = { endpoint: "http://127.0.0.1:8000", seconds: 8, ratio: "9:16", resolution: 0.8 };
export interface ComposerLocalVideoRequest { prompt: string; firstFrame: string; lastFrame?: string; options: ComfyVideoOptions }
/** Match the editor's ordered image references; never submit extra images or videos. */
export function localVideoFrames(references: Asset[]) {
  return references.filter(asset => /\.(png|jpe?g|webp|bmp)(?:[?#].*)?$/i.test(asset.store_path ?? ""));
}
export function localVideoInputError(prompt: string, frames: Asset[], options: ComfyVideoOptions): string | null {
  if (!frames.length) return "请在创作描述中添加首帧图片。";
  if (!prompt.trim() || prompt.length > 16000) return "请填写 1–16000 字创作描述。";
  if (!Number.isInteger(options.seconds) || options.seconds < 1 || options.seconds > 15) return "本地视频时长须为 1–15 秒的整数。";
  if (![0.6, 0.8, 1].includes(options.resolution) || !["auto", "9:16", "16:9", "4:3", "3:4", "1:1"].includes(options.ratio)) return "请选择本地视频支持的比例和分辨率。";
  return null;
}
export function comfyVideoSize(options: ComfyVideoOptions, firstFrame?: { width?: number | null; height?: number | null }) {
  const [w, h] = options.ratio === "auto" ? [firstFrame?.width, firstFrame?.height] : options.ratio.split(":").map(Number);
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const scale = Math.sqrt(options.resolution * 1024 * 1024 / (w * h));
  return { width: Math.round(w * scale / 32) * 32, height: Math.round(h * scale / 32) * 32,
    frames: Math.max(5, Math.ceil((options.seconds * 24 - 5) / 17) * 17 + 5) };
}
export interface ComfyVideoInput extends ComfyVideoOptions { firstFrame: string; lastFrame?: string; prompt: string }
export interface ComfyVideoProgress { label: string; value?: number | null; max?: number | null }
export interface ComfyVideoStatus { status: "queued" | "running" | "unknown" | "failed" | "done" | "cancelled"; message: string; asset?: Asset; progress?: ComfyVideoProgress | null; elapsedMs?: number | null }
export function comfyVideo(action: "start" | "status" | "cancel", projectId: string, requestId: string, input?: ComfyVideoInput) {
  return invoke<ComfyVideoStatus>("comfy_video", { action, projectId, requestId, input: input ?? null });
}
export function checkComfyVideo(endpoint: string) { return invoke<string>("comfy_video_check", { endpoint }); }

export interface ComfyEnvironment {
  phase: "missing" | "ready" | "installing" | "starting" | "stopped" | "unavailable" | "failed" | "cancelled";
  message: string; endpoint: string; directory: string; canInstall: boolean; installed: boolean;
  downloadBytes: number; requiredBytes: number; completedBytes: number; totalBytes: number;
  existing?: { path: string; name: string; endpoint: string; canStart: boolean; modelsFound: number }[];
  hardware?: { gpus: { name: string; driver?: string | null; memoryMib?: number | null }[]; driverRequired: boolean; issue?: string | null } | null;
  driverDownload?: { url: string; message: string } | null;
}
// Readiness means Run can proceed without user setup, even when the service is stopped.
export function comfyEnvironmentReady(environment?: ComfyEnvironment) {
  if (!environment) return false;
  if (environment.phase === "ready") return true;
  if (!["stopped", "missing", "starting"].includes(environment.phase)) return false;
  const instance = environment.existing?.[0];
  return instance ? instance.canStart && instance.modelsFound === 5 : environment.installed && environment.canInstall;
}
// Multiple visible cards share a read-only detection request; installation is singleton in native code.
const detections = new Map<string, Promise<ComfyEnvironment>>();
export function comfyEnvironment(action: "detect" | "status" | "prepare" | "install" | "cancel" | "select_existing" | "start_existing" | "driver", endpoint: string, directory?: string, existingDirectory?: string) {
  const key = JSON.stringify([endpoint, directory, existingDirectory]);
  if (action === "detect" && detections.has(key)) return detections.get(key)!;
  const request = invoke<ComfyEnvironment>("comfy_video_environment", { action, endpoint, directory: directory ?? null, existingDirectory: existingDirectory ?? null });
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
