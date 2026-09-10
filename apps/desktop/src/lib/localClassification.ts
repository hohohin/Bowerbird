import { invoke } from "@tauri-apps/api/core";

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
}
export interface ClassificationLabel {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  count: number;
}
export const localClassification = {
  status: () => invoke<LocalClassificationStatus>("local_classification_status"),
  labels: () => invoke<ClassificationLabel[]>("local_classification_labels"),
  start: (options: { install?: boolean; tagId?: string; pendingOnly?: boolean } = {}) =>
    invoke<void>("local_classification_start", { install: false, tagId: null, pendingOnly: true, ...options }),
  stop: () => invoke<void>("local_classification_stop"),
  enable: (enabled: boolean) => invoke<void>("local_classification_enable", { enabled }),
  save: (id: string | null, name: string, description: string, enabled: boolean) =>
    invoke<string>("local_classification_save_label", { id, name, description, enabled }),
  example: (tagId: string, assetIds: string[], positive: boolean) =>
    invoke<void>("local_classification_example", { tagId, assetIds, positive }),
};
