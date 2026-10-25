import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "./types";

export interface LocalClassificationStatus {
  run_id?: string;
  recent_results?: ClassificationResult[];
  recent_cloud_handoffs?: ClassificationResult["asset"][];
  diagnostics?: ClassificationDiagnostic[];
  folder_root?: string | null;
  global_scope?: boolean;
  project_id?: string | null;
  supported: boolean;
  installed: boolean;
  enabled: boolean;
  busy: boolean;
  phase: string;
  done: number;
  total: number;
  failed: number;
  jev_done: number;
  cloud_running: number;
  cloud_queued: number;
  download_done: number;
  download_total: number;
  message: string;
  last_error: string;
  current_asset: { id: string; name: string; thumb_path: string | null; position: number } | null;
  jev_progress: {
    asset: NonNullable<LocalClassificationStatus["current_asset"]>;
    message: string;
    report: {
      model: string;
      confidence: number | null; no_match: boolean | null;
      labels: { key: string; name: string; description: string; probability: number | null; selected: boolean | null }[];
      error: string | null; response: unknown;
    } | null;
  } | null;
  model: string;
  acceleration: string;
  vector_supported: boolean;
  vector_installed: boolean;
}
export interface ClassificationDiagnostic {
  id: string;
  name: string;
  elapsed_ms: number;
  finished: boolean;
  steps: { stage: string; at_ms: number; detail: string }[];
}

// Progress events contain task state; these fields are populated only by the status RPC.
export function mergeClassificationProgress(snapshot: LocalClassificationStatus, progress: LocalClassificationStatus): LocalClassificationStatus {
  return { ...progress, enabled: snapshot.enabled, supported: snapshot.supported, installed: snapshot.installed,
    vector_supported: snapshot.vector_supported, vector_installed: snapshot.vector_installed,
    model: progress.model || snapshot.model, download_total: progress.download_total || snapshot.download_total };
}
export interface ClassificationResult {
  sequence: number;
  asset: NonNullable<LocalClassificationStatus["current_asset"]>;
  tags: string[];
  error: string | null;
}
export interface ClassificationLabel {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  count: number;
  has_examples: boolean;
  provenance?: { kind: string; asset_id: string | null; asset_name: string | null; reason: string | null; created_at: number } | null;
}
export interface GlobalClassificationView {
  labels: ClassificationLabel[];
  pictures: { id: string; path: string; tags: string[] }[];
}
export const globalClassification = {
  view: (paths: string[]) => invoke<GlobalClassificationView>("global_classification_view", { paths }),
  start: (options: { install?: boolean; tagId?: string; pendingOnly?: boolean } = {}) => options.install
    ? localClassification.start(options)
    : invoke<void>("global_classification_start", { tagId: null, pendingOnly: true, ...options }),
};
export const localClassification = {
  source: (tagId: string, root: string | null = null) => invoke<string | null>("local_classification_source", { tagId, root }),
  status: () => invoke<LocalClassificationStatus>("local_classification_status"),
  labels: () => invoke<ClassificationLabel[]>("local_classification_labels"),
  start: (options: { install?: boolean; tagId?: string; pendingOnly?: boolean } = {}) =>
    invoke<void>("local_classification_start", { install: false, tagId: null, pendingOnly: true, ...options }),
  stop: () => invoke<void>("local_classification_stop"),
  vectorInstall: () => invoke<void>("local_classification_vector_install"),
  vectorUninstall: () => invoke<void>("local_classification_vector_uninstall"),
  enable: (enabled: boolean) => invoke<void>("local_classification_enable", { enabled }),
  save: (id: string | null, name: string, description: string, enabled: boolean) =>
    invoke<string>("local_classification_save_label", { id, name, description, enabled }),
  example: (tagId: string, assetIds: string[], positive: boolean) =>
    invoke<void>("local_classification_example", { tagId, assetIds, positive }),
  deleteLabels: (tagIds: string[]) => invoke<void>("local_classification_delete_labels", { tagIds }),
  jevConfig: async (): Promise<{ enabled: boolean }> => {
    const settings = await invoke<AppSettings>("get_settings");
    return { enabled: settings.jev_image_classification_enabled };
  },
  saveJevConfig: async (enabled: boolean) => {
    const settings = await invoke<AppSettings>("get_settings");
    settings.jev_image_classification_enabled = enabled;
    await invoke<void>("update_settings", { settings });
  },
};

export const projectClassification = (projectId: string) => ({
  ...localClassification,
  labels: () => invoke<ClassificationLabel[]>("project_classification_labels", { projectId }),
  start: (options: { tagId?: string; pendingOnly?: boolean } = {}) =>
    invoke<void>("project_classification_start", { projectId, tagId: null, pendingOnly: true, ...options }),
  example: (tagId: string, assetIds: string[], positive: boolean) =>
    invoke<void>("local_classification_example", { projectId, tagId, assetIds, positive }),
});
