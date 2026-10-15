import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "./types";

export interface LocalClassificationStatus {
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
      dimensions: {
        dimension: "type" | "style" | "subject"; title: string;
        confidence: number | null; no_match: boolean | null;
        labels: { key: string; name: string; description: string; probability: number | null; selected: boolean | null }[];
        error: string | null;
      }[];
      error: string | null; response: unknown;
    } | null;
  } | null;
  model: string;
  acceleration: string;
  vector_supported: boolean;
  vector_installed: boolean;
}
export interface ClassificationLabel {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  count: number;
  has_examples: boolean;
}
export const localClassification = {
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
  jevConfig: async (): Promise<{ enabled: boolean; apiKey: string }> => {
    const settings = await invoke<AppSettings>("get_settings");
    return { enabled: settings.jev_image_classification_enabled, apiKey: settings.jev_api_key ?? "" };
  },
  saveJevConfig: async (enabled: boolean, apiKey: string) => {
    const settings = await invoke<AppSettings>("get_settings");
    settings.jev_image_classification_enabled = enabled;
    settings.jev_api_key = apiKey.trim() ? apiKey.trim() : null;
    await invoke<void>("update_settings", { settings });
  },
};
