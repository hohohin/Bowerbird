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
export interface ComfyVideoStatus { status: "queued" | "running" | "unknown" | "failed" | "done"; message: string; asset?: Asset }
export function comfyVideo(action: "start" | "status", projectId: string, requestId: string, input?: ComfyVideoInput) {
  return invoke<ComfyVideoStatus>("comfy_video", { action, projectId, requestId, input: input ?? null });
}
export function checkComfyVideo(endpoint: string) { return invoke<string>("comfy_video_check", { endpoint }); }

export interface ComfyEnvironment {
  phase: "missing" | "ready" | "installing" | "failed" | "cancelled";
  message: string; endpoint: string; directory: string; canInstall: boolean; installed: boolean;
  downloadBytes: number; requiredBytes: number; completedBytes: number; totalBytes: number;
}
// Multiple visible cards share a read-only detection request; installation is singleton in native code.
const detections = new Map<string, Promise<ComfyEnvironment>>();
export function comfyEnvironment(action: "detect" | "status" | "install" | "cancel", endpoint: string, directory?: string) {
  const key = JSON.stringify([endpoint, directory]);
  if (action === "detect" && detections.has(key)) return detections.get(key)!;
  const request = invoke<ComfyEnvironment>("comfy_video_environment", { action, endpoint, directory: directory ?? null });
  if (action === "detect") {
    detections.set(key, request);
    void request.finally(() => detections.delete(key)).catch(() => {});
  }
  return request;
}
