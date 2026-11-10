// Session-only, bounded snapshots. A change makes snapshots stale without
// removing them: reopening a pane can paint immediately while it revalidates.
import type { Asset } from "./types";
import type { ConnectionEntry, FolderConnection } from "./folderConnections";

export type CatalogPage = { assets: Asset[]; groups: Record<string, Asset[]> };
export type CatalogPreviewChange = { assets: Asset[]; versions?: Record<string, string> };
export type ConnectionProgress = { rootId: string; scanning: boolean; error: string | null };
type EntryAsset = Asset & { connectionEntry?: ConnectionEntry; connectionGroup?: Asset[] };
const previewFields = ["thumb_path", "width", "height", "duration", "phash", "colors"] as const;

export function patchCatalogPage<T extends CatalogPage>(page: T, change: CatalogPreviewChange): T {
  const incoming = new Map(change.assets.map(asset => [asset.id, asset]));
  function patchEntry(entry: ConnectionEntry): ConnectionEntry {
    const asset = patchAsset(entry.asset, entry.version);
    const group = entry.group?.map(patchEntry);
    return asset === entry.asset && (!group || group.every((item, i) => item === entry.group![i])) ? entry : { ...entry, asset, group };
  }
  function patchAsset(asset: Asset, version?: string | null): Asset {
    const entryAsset = asset as EntryAsset;
    const update = incoming.get(asset.id);
    let next = asset;
    const expected = change.versions?.[asset.id];
    if (update && update.store_path === asset.store_path && update.file_mtime === asset.file_mtime
      && (!expected || !(version ?? entryAsset.connectionEntry?.version) || expected === (version ?? entryAsset.connectionEntry?.version))) {
      const fields = Object.fromEntries(previewFields.filter(key => update[key] !== undefined && update[key] !== asset[key]).map(key => [key, update[key]]));
      if (Object.keys(fields).length) next = { ...asset, ...fields };
    }
    const connectionEntry = entryAsset.connectionEntry && patchEntry(entryAsset.connectionEntry);
    const connectionGroup = entryAsset.connectionGroup?.map(item => patchAsset(item));
    if (connectionEntry !== entryAsset.connectionEntry || connectionGroup?.some((item, i) => item !== entryAsset.connectionGroup![i])) {
      next = { ...next, connectionEntry, connectionGroup } as EntryAsset;
    }
    return next;
  }
  const assets = page.assets.map(asset => patchAsset(asset));
  const groups = Object.fromEntries(Object.entries(page.groups).map(([id, items]) => [id, items.map(asset => patchAsset(asset))]));
  return assets.every((asset, i) => asset === page.assets[i]) && Object.entries(groups).every(([id, items]) => items.every((asset, i) => asset === page.groups[id][i]))
    ? page : { ...page, assets, groups };
}
export function patchConnectionProgress(folders: FolderConnection[], progress: ConnectionProgress) {
  return folders.map(folder => folder.root_id === progress.rootId && (folder.scanning !== progress.scanning || folder.error !== progress.error)
    ? { ...folder, scanning: progress.scanning, error: progress.error } : folder);
}

type Snapshot<T> = { value: T; revision: number; readAt: number; colorFiltered: boolean };
export function createCatalogCache(limit = 128, maxAge = 60_000) {
  let revision = 0;
  let colorRevision = 0, sequence = 0;
  const previews = new Map<string, { asset: Asset; version?: string }>();
  const progressByRoot = new Map<string, ConnectionProgress>();
  const values = new Map<string, Snapshot<unknown>>();
  const pending = new Map<string, { revision: number; promise: Promise<unknown> }>();
  return {
    revision: (colorFiltered = false) => colorFiltered ? colorRevision : revision,
    invalidate() { revision = colorRevision = ++sequence; previews.clear(); },
    updatePreviews(change: CatalogPreviewChange) {
      if (!change.assets.length) return;
      colorRevision = ++sequence;
      for (const asset of change.assets) {
        previews.delete(asset.id); previews.set(asset.id, { asset, version: change.versions?.[asset.id] });
      }
      while (previews.size > 512) previews.delete(previews.keys().next().value!);
      for (const [key, entry] of values) if (key.startsWith("pages:")) {
        entry.value = patchCatalogPage(entry.value as CatalogPage, change);
      }
    },
    updateConnectionProgress(progress: ConnectionProgress) {
      progressByRoot.delete(progress.rootId); progressByRoot.set(progress.rootId, progress);
      while (progressByRoot.size > limit) progressByRoot.delete(progressByRoot.keys().next().value!);
      for (const [key, entry] of values) if (key.startsWith("folders:")) entry.value = patchConnectionProgress(entry.value as FolderConnection[], progress);
    },
    peek<T>(key: string): Snapshot<T> | undefined {
      const entry = values.get(key);
      if (entry) { values.delete(key); values.set(key, entry); }
      return entry as Snapshot<T> | undefined;
    },
    entries<T>(prefix: string) {
      return [...values].filter(([key]) => key.startsWith(prefix)) as [string, Snapshot<T>][];
    },
    fresh(entry: Snapshot<unknown>) {
      return entry.revision === this.revision(entry.colorFiltered) && Date.now() - entry.readAt < maxAge;
    },
    read<T>(key: string, loader: () => Promise<T>, colorFiltered = false): Promise<T> {
      const entry = this.peek<T>(key);
      if (entry && this.fresh(entry)) return Promise.resolve(entry.value);
      const existing = pending.get(key);
      const requestedRevision = this.revision(colorFiltered);
      if (existing?.revision === requestedRevision) return existing.promise as Promise<T>;
      const promise = Promise.resolve().then(loader).then(value => {
        if (key.startsWith("pages:") && previews.size) value = patchCatalogPage(value as CatalogPage, {
          assets: [...previews.values()].map(item => item.asset),
          versions: Object.fromEntries([...previews].flatMap(([id, item]) => item.version ? [[id, item.version]] : [])),
        }) as T;
        if (key.startsWith("folders:")) for (const progress of progressByRoot.values()) value = patchConnectionProgress(value as FolderConnection[], progress) as T;
        // An old read must never overwrite a newer snapshot after a mutation.
        if (this.revision(colorFiltered) === requestedRevision) {
          values.delete(key);
          values.set(key, { value, revision: requestedRevision, readAt: Date.now(), colorFiltered });
          while (values.size > limit) values.delete(values.keys().next().value!);
        }
        return value;
      }).finally(() => { if (pending.get(key)?.promise === promise) pending.delete(key); });
      pending.set(key, { revision: requestedRevision, promise });
      return promise;
    },
  };
}
export const catalogCache = createCatalogCache();
