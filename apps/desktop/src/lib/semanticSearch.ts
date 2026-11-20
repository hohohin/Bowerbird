import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CatalogFilter } from "./materialCatalog";
import type { Asset } from "./types";

export interface SemanticStatus {
  supported: boolean;
  libraryId: string;
  activeModelKey: string | null;
  modelState: "missing" | "downloading" | "ready" | "corrupt";
  indexState: "off" | "running" | "paused";
  operationId: string | null;
  indexRevision: number;
  backfillComplete: boolean;
  eligible: number;
  indexed: number;
  pending: number;
  auditing: number;
  unavailable: number;
  unsupported: number;
  failed: number;
  lastError: string | null;
  modelError?: string | null;
  workerError?: string | null;
  downloadBytes: number;
  installedBytes: number;
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface SemanticSession {
  requestId: string;
  sessionId: string;
  libraryId: string;
  modelKey: string;
  indexRevision: number;
  eligible: number;
  indexed: number;
  resultCount: number;
  truncated: boolean;
}

export type SemanticModelAction = "install" | "cancel" | "repair" | "uninstall";
export type SemanticIndexAction = "start" | "pause" | "resume" | "cancel" | "rebuild" | "disable";
type Operation = { operationId: string | null };
type Page = { sessionId: string; offset: number; limit: number };

export const semanticSearch = {
  status: () => invoke<SemanticStatus>("semantic_status"),
  model: (action: SemanticModelAction) => invoke<Operation>("semantic_model_control", { action }),
  index: (action: SemanticIndexAction) => invoke<Operation>("semantic_index_control", { action }),
  start: (request: { requestId: string; paneId: string; text: string; filter: CatalogFilter; topK: number }) =>
    invoke<SemanticSession>("semantic_search_start", request),
  page: (page: Page) => invoke<{ asset: Asset; score: number }[]>("semantic_search_page", page),
  ids: (page: Page) => invoke<string[]>("semantic_search_ids", page),
  cancel: (target: { requestId: string } | { sessionId: string }) => invoke<void>("semantic_search_cancel", target),
  onProgress: (onProgress: (status: SemanticStatus) => void) => listen<SemanticStatus>("semantic://progress", event => onProgress(event.payload)),
  onSessionsReset: (onReset: (libraryId: string) => void) => listen<{ libraryId: string }>("semantic://sessions-reset", event => {
    if (event.payload?.libraryId) onReset(event.payload.libraryId);
  }),
};
