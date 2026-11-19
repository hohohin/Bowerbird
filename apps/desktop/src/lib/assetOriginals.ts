import { invoke } from "@tauri-apps/api/core";

export interface AssetOriginal {
  asset_id: string;
  name: string;
  path: string;
  fingerprint: string;
  missing?: boolean;
}

export const assetOriginals = {
  preview: async (assetIds: string[]) => {
    type Preview = AssetOriginal | { asset_id: string; error: string };
    const ids = [...new Set(assetIds)], originals: Preview[] = [];
    for (let offset = 0; offset < ids.length; offset += 2000) {
      originals.push(...await invoke<Preview[]>("preview_asset_originals", { assetIds: ids.slice(offset, offset + 2000), allowPartial: true }));
    }
    return originals;
  },
  trash: (original: AssetOriginal) => invoke<void>("trash_asset_original", { original }),
};
