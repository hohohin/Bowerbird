import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Asset } from "./types";

export interface VoiceConfig { python: string; model: string }
export interface VoiceProfile { id: string; name: string; asset_id: string; reference: string; transcript: string; duration?: number }
export interface VoiceJob { id: string; project: string; text: string; description: string; voice_id: string | null;
  status: "running" | "succeeded" | "cancelled" | "failed" | "interrupted"; message: string; asset_id: string | null;
  recoverable?: boolean; voice_name?: string; purpose?: string; request_key?: string | null; draft_key?: string;
  stage?: string | null; progress?: number | null; error_code?: string | null; has_diagnostic?: boolean;
  warning?: string | null; seed?: number | null; language?: string | null }
export interface VoiceEnvironment { phase: string; message: string; directory: string; gpu: string; free_bytes: number; required_bytes: number; completed_bytes: number; total_bytes: number; can_install: boolean;
  install_step?: "resources" | "python" | "pytorch" | "voxcpm" | "cuda_check" | null; progress_percent?: number | null; active_seconds?: number | null }
export interface VoiceSnapshot { config: VoiceConfig; voices: VoiceProfile[]; jobs: VoiceJob[]; assets: Asset[];
  has_more?: boolean; has_history?: boolean }
type VoiceJobUpdate = Pick<VoiceJob, "project" | "id" | "request_key" | "purpose" | "status">;
type VoiceJobLookup = { id: string; requestKey?: never } | { id?: never; requestKey: string };

export function voiceScope({ settings, cloudAuth }: {
  settings?: { library_root?: string | null } | null;
  cloudAuth?: { logged_in: boolean; user_id?: string | null } | null;
}) {
  return JSON.stringify([settings?.library_root ?? "", cloudAuth?.logged_in ? cloudAuth.user_id : null]);
}

export function voiceJobDetail(job: VoiceJob) {
  switch (job.stage) {
    case "preparing_reference": return "正在准备参考录音";
    case "loading_model": return "正在加载模型";
    case "synthesizing": return job.progress == null ? "正在合成音频" : `正在合成音频 · ${Math.round(job.progress)}%`;
    case "saving": return "正在保存配音";
    default: return job.message;
  }
}

export const voiceApi = {
  snapshot: (project: string, options?: { before?: string; historyLimit?: number }) => invoke<VoiceSnapshot>("voice_snapshot", { project, ...options }),
  job: (project: string, lookup: VoiceJobLookup) => invoke<{ job: VoiceJob; asset: Asset | null } | null>("voice_job", { project, ...lookup }),
  onJobUpdated: (updated: (job: VoiceJobUpdate) => void) => listen<VoiceJobUpdate>("voice://job-updated", event => updated(event.payload)),
  diagnostic: (project: string, id: string) => invoke<void>("voice_diagnostic", { project, id }),
  configure: (config: VoiceConfig) => invoke<void>("voice_configure", { config }),
  save: (name: string, assetId: string, transcript: string, start: number, end: number) => invoke<VoiceProfile>("voice_save", { name, assetId, transcript, start, end }),
  start: (project: string, text: string, voiceId: string | null, preview?: { assetId: string; start?: number; end?: number; transcript?: string; draftKey: string }, requestKey?: string, seed?: number, language?: string) =>
    invoke<string>("voice_start", { project, text, voiceId, requestKey: requestKey ?? null, preview: preview ?? null, seed: seed ?? null, language: language || null }),
  cancel: (id: string) => invoke<void>("voice_cancel", { id }),
  recover: (id: string) => invoke<void>("voice_recover", { id }),
  rename: (id: string, name: string) => invoke<void>("voice_manage", { id, name }),
  remove: (id: string) => invoke<void>("voice_manage", { id, name: null }),
  environment: (action = "status", directory?: string) => invoke<VoiceEnvironment>("voice_environment", { action, directory: directory ?? null }),
  export: (assetId: string) => invoke<void>("voice_export", { assetId }),
};
