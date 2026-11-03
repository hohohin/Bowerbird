export type QuickTransferFile = {
  id: string;
  name: string;
  size: number;
  received: number;
  status: "receiving" | "indexing" | "complete" | "failed";
  error: string | null;
  assetId: string | null;
  retryable: boolean;
};

export type QuickTransferSnapshot = {
  revision: number;
  active: boolean;
  directory: string | null;
  url: string | null;
  transfers: QuickTransferFile[];
};

export const EMPTY_QUICK_TRANSFER: QuickTransferSnapshot = {
  revision: -1, active: false, directory: null, url: null, transfers: [],
};

/** IPC replies and emitted events can arrive out of order. */
export function acceptQuickTransferSnapshot(current: QuickTransferSnapshot, incoming: QuickTransferSnapshot) {
  return incoming.revision >= current.revision ? incoming : current;
}
