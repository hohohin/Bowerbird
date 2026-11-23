import { folderConnections } from "./folderConnections";
import { materialCatalog } from "./materialCatalog";
import { isPendingOriginal } from "./pendingOriginalDeletion";

export type VideoBatchScope = { projectId: string | null; label: string; folderId?: string };

export async function videoBatchScopeIds(scope: VideoBatchScope, descendants: boolean, isCurrent: () => boolean): Promise<string[]> {
  const ids = new Set<string>();
  if (scope.folderId) {
    const folders = [scope.folderId];
    if (descendants) {
      const listed = await folderConnections.list(scope.projectId, "videos");
      const children = new Map<string, string[]>();
      for (const folder of listed) {
        if (!folder.parent_id || !folder.available) continue;
        const siblings = children.get(folder.parent_id) ?? [];
        siblings.push(folder.id);
        children.set(folder.parent_id, siblings);
      }
      const seen = new Set(folders);
      for (const folder of folders) {
        for (const child of children.get(folder) ?? []) {
          if (seen.has(child)) continue;
          seen.add(child);
          folders.push(child);
        }
      }
    }
    for (const folderId of folders) {
      if (!isCurrent()) break;
      const entries = await folderConnections.ids(folderId, "videos", scope.projectId);
      for (const entry of await folderConnections.resolve(entries, isCurrent)) {
        if (entry.available && !isPendingOriginal(entry.asset_id)) ids.add(entry.asset_id);
      }
    }
  } else {
    const filter = { kind: "all", id: null, projectId: scope.projectId, media: "videos", query: "", generated: null, color: null } as const;
    let after: string | null = null;
    do {
      const page = await materialCatalog.graphPage(filter, after);
      after = page.after;
      for (const asset of page.assets) {
        if (!isPendingOriginal(asset.id)) ids.add(asset.id);
      }
    } while (after && isCurrent());
  }
  return [...ids];
}
