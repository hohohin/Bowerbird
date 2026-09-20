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
  download_done: number;
  download_total: number;
  message: string;
  last_error: string;
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
  enable: (enabled: boolean) => invoke<void>("local_classification_enable", { enabled }),
  save: (id: string | null, name: string, description: string, enabled: boolean) =>
    invoke<string>("local_classification_save_label", { id, name, description, enabled }),
  example: (tagId: string, assetIds: string[], positive: boolean) =>
    invoke<void>("local_classification_example", { tagId, assetIds, positive }),
  jevConfig: async (): Promise<{ enabled: boolean; apiKey: string }> => {
    const settings = await invoke<AppSettings>("get_settings");
    return { enabled: settings.jev_verify_enabled, apiKey: settings.jev_api_key ?? "" };
  },
  saveJevConfig: async (enabled: boolean, apiKey: string) => {
    const settings = await invoke<AppSettings>("get_settings");
    settings.jev_verify_enabled = enabled;
    settings.jev_api_key = apiKey.trim() ? apiKey.trim() : null;
    await invoke<void>("update_settings", { settings });
  },
};
