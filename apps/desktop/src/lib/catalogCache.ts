// Session-only, bounded snapshots. A change makes snapshots stale without
// removing them: reopening a pane can paint immediately while it revalidates.
import type { Asset } from "./types";
import type { ConnectionEntry, FolderConnection } from "./folderConnections";

export type CatalogPage = { assets: Asset[]; groups: Record<string, Asset[]> };
export type CatalogPreviewChange = { assets: Asset[]; versions?: Record<string, string> };
export type ConnectionProgress = { rootId: string; folderId?: string; activeFolderId?: string; scanning: boolean; error: string | null; rootAvailable?: boolean };
export type CatalogChange = { rootIds?: string[]; folderIds?: string[] };
export type CatalogFolderScope = { id: string; rootId: string };
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
    const currentVersion = version ?? entryAsset.connectionEntry?.version;
    // Plain Asset pages have no content fingerprint. Never replace an already
    // rendered, different thumbnail with a delayed completion. Native emission
    // also verifies fingerprint + thumbnail against the current database row.
    const sameVersion = expected && currentVersion ? expected === currentVersion
      : !asset.thumb_path || !update?.thumb_path || asset.thumb_path === update.thumb_path;
    if (update && update.store_path === asset.store_path && update.file_mtime === asset.file_mtime
      && (update.size === undefined || asset.size === undefined || update.size === asset.size)
      && sameVersion) {
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
  const next = folders.map(folder => {
    if (folder.root_id !== progress.rootId) return folder;
    const inScope = !progress.folderId || folder.id === progress.folderId;
    const scanning = progress.scanning && (progress.activeFolderId ? folder.id === progress.activeFolderId : inScope);
    const error = inScope || scanning ? progress.error : folder.error;
    // A returned root does not prove that every former subfolder still exists.
    const available = progress.rootAvailable === false ? false
      : folder.id === progress.rootId && progress.rootAvailable === true ? true : folder.available;
    return folder.scanning === scanning && folder.error === error && folder.available === available
      ? folder : { ...folder, scanning, error, ...(folder.available !== available ? { available } : {}) };
  });
  return next.every((folder, i) => folder === folders[i]) ? folders : next;
}

type Snapshot<T> = { value: T; revision: number; colorFiltered: boolean; scope?: CatalogFolderScope };
export function createCatalogCache(limit = 128) {
  let globalRevision = 0, aggregateRevision = 0;
  let colorRevision = 0, sequence = 0;
  const rootRevisions = new Map<string, number>();
  const folderRevisions = new Map<string, number>();
  const previews = new Map<string, { asset: Asset; version?: string }>();
  const progressByRoot = new Map<string, ConnectionProgress>();
  const values = new Map<string, Snapshot<unknown>>();
  const folders = new Map<string, Snapshot<unknown>>();
  const pending = new Map<string, { revision: number; promise: Promise<unknown> }>();
  const poolFor = (key: string) => key.startsWith("folders:") ? folders : values;
  return {
    revision(colorFiltered = false, scope?: CatalogFolderScope) {
      const structure = scope
        ? Math.max(globalRevision, rootRevisions.get(scope.rootId) ?? 0, folderRevisions.get(scope.id) ?? 0)
        : aggregateRevision;
      return colorFiltered ? Math.max(structure, colorRevision) : structure;
    },
    invalidate(change?: CatalogChange | null) {
      aggregateRevision = ++sequence;
      // A folder list narrows the event to exact sections. A root-only event
      // covers the entire connection, including children not loaded yet.
      if (change?.folderIds?.length) {
        for (const id of change.folderIds) folderRevisions.set(id, sequence);
      } else if (change?.rootIds?.length) {
        for (const id of change.rootIds) rootRevisions.set(id, sequence);
      } else {
        globalRevision = sequence;
        rootRevisions.clear(); folderRevisions.clear(); previews.clear();
      }
    },
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
      for (const entry of folders.values()) entry.value = patchConnectionProgress(entry.value as FolderConnection[], progress);
    },
    peek<T>(key: string): Snapshot<T> | undefined {
      const pool = poolFor(key);
      const entry = pool.get(key);
      if (entry) { pool.delete(key); pool.set(key, entry); }
      return entry as Snapshot<T> | undefined;
    },
    entries<T>(prefix: string) {
      return [...poolFor(prefix)].filter(([key]) => key.startsWith(prefix)) as [string, Snapshot<T>][];
    },
    fresh(entry: Snapshot<unknown>) {
      return entry.revision === this.revision(entry.colorFiltered, entry.scope);
    },
    read<T>(key: string, loader: () => Promise<T>, colorFiltered = false, scope?: CatalogFolderScope): Promise<T> {
      const entry = this.peek<T>(key);
      const requestedRevision = this.revision(colorFiltered, scope);
      if (entry?.revision === requestedRevision) return Promise.resolve(entry.value);
      const existing = pending.get(key);
      if (existing?.revision === requestedRevision) return existing.promise as Promise<T>;
      const promise = Promise.resolve().then(loader).then(value => {
        if (key.startsWith("pages:") && previews.size) value = patchCatalogPage(value as CatalogPage, {
          assets: [...previews.values()].map(item => item.asset),
          versions: Object.fromEntries([...previews].flatMap(([id, item]) => item.version ? [[id, item.version]] : [])),
        }) as T;
        if (key.startsWith("folders:")) for (const progress of progressByRoot.values()) value = patchConnectionProgress(value as FolderConnection[], progress) as T;
        // An old read must never overwrite a newer snapshot after a mutation.
        if (this.revision(colorFiltered, scope) === requestedRevision) {
          const pool = poolFor(key);
          pool.delete(key);
          pool.set(key, { value, revision: requestedRevision, colorFiltered, scope });
          while (pool.size > limit) pool.delete(pool.keys().next().value!);
        }
        return value;
      }).finally(() => { if (pending.get(key)?.promise === promise) pending.delete(key); });
      pending.set(key, { revision: requestedRevision, promise });
      return promise;
    },
  };
}
export const catalogCache = createCatalogCache();
