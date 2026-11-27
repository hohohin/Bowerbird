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

export function quickTransferFileSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export type QuickTransferDestination =
  | { kind: "default" }
  | { kind: "project"; projectId: string }
  | { kind: "folder"; folderId: string };

export type QuickTransferLocation = QuickTransferDestination & { name: string; directory: string };

export function quickTransferDestinationKey(target: QuickTransferDestination) {
  switch (target.kind) {
    case "default": return "default";
    case "project": return `project:${target.projectId}`;
    case "folder": return `folder:${target.folderId}`;
  }
}

export function initialQuickTransferDestination(
  activeProjectId: string | null,
  projects: { id: string }[],
  effective: QuickTransferDestination,
): QuickTransferDestination {
  if (activeProjectId && projects.some(project => project.id === activeProjectId)) {
    return { kind: "project", projectId: activeProjectId };
  }
  return effective.kind === "folder" ? { kind: "folder", folderId: effective.folderId } : { kind: "default" };
}

export type QuickTransferSnapshot = {
  revision: number;
  active: boolean;
  directory: string | null;
  destination: QuickTransferLocation | null;
  url: string | null;
  transfers: QuickTransferFile[];
  sending?: { url: string; files: { id: string; name: string; size: number }[] } | null;
};

export const EMPTY_QUICK_TRANSFER: QuickTransferSnapshot = {
  revision: -1, active: false, directory: null, destination: null, url: null, transfers: [],
};

/** IPC replies and emitted events can arrive out of order. */
export function acceptQuickTransferSnapshot(current: QuickTransferSnapshot, incoming: QuickTransferSnapshot) {
  return incoming.revision >= current.revision ? incoming : current;
}
