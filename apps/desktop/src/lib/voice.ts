import { invoke } from "@tauri-apps/api/core";
import type { Asset } from "./types";

export interface VoiceConfig { python: string; model: string }
export interface VoiceProfile { id: string; name: string; asset_id: string; reference: string; transcript: string; duration?: number }
export interface VoiceJob { id: string; project: string; text: string; description: string; voice_id: string | null;
  status: "running" | "succeeded" | "cancelled" | "failed" | "interrupted"; message: string; asset_id: string | null;
  recoverable?: boolean; voice_name?: string; purpose?: string; request_key?: string | null; draft_key?: string }
export interface VoiceEnvironment { phase: string; message: string; directory: string; gpu: string; free_bytes: number; required_bytes: number; completed_bytes: number; total_bytes: number; can_install: boolean }
export interface VoiceSnapshot { config: VoiceConfig; voices: VoiceProfile[]; jobs: VoiceJob[]; assets: Asset[] }
export const voiceApi = {
  snapshot: (project: string) => invoke<VoiceSnapshot>("voice_snapshot", { project }),
  configure: (config: VoiceConfig) => invoke<void>("voice_configure", { config }),
  save: (name: string, assetId: string, transcript: string, start: number, end: number) => invoke<VoiceProfile>("voice_save", { name, assetId, transcript, start, end }),
  start: (project: string, text: string, voiceId: string | null, preview?: { assetId: string; start?: number; end?: number; transcript?: string; draftKey: string }, requestKey?: string) => invoke<string>("voice_start", { project, text, voiceId, requestKey: requestKey ?? null, preview: preview ?? null }),
  cancel: (id: string) => invoke<void>("voice_cancel", { id }),
  recover: (id: string) => invoke<void>("voice_recover", { id }),
  rename: (id: string, name: string) => invoke<void>("voice_manage", { id, name }),
  remove: (id: string) => invoke<void>("voice_manage", { id, name: null }),
  environment: (action = "status", directory?: string) => invoke<VoiceEnvironment>("voice_environment", { action, directory: directory ?? null }),
  export: (assetId: string) => invoke<void>("voice_export", { assetId }),
};
