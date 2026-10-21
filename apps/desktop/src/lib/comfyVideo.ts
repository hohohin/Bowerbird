import { invoke } from "@tauri-apps/api/core";
import type { Asset } from "./types";

export interface ComfyVideoOptions {
  endpoint: string;
  seconds: number;
  ratio: "9:16" | "16:9" | "4:3";
  resolution: 0.6 | 0.8 | 1;
}
export const DEFAULT_COMFY_VIDEO: ComfyVideoOptions = { endpoint: "http://127.0.0.1:8000", seconds: 8, ratio: "9:16", resolution: 0.8 };
export function comfyVideoSize(options: ComfyVideoOptions) {
  const [w, h] = options.ratio.split(":").map(Number);
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
export function comfyEnvironment(action: "detect" | "status" | "prepare" | "install" | "cancel" | "select_existing" | "start_existing", endpoint: string, directory?: string, existingDirectory?: string) {
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
