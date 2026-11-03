import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "./api";
import { isAudioAsset } from "./audioMedia";
import { isTextAsset } from "./textMedia";
import { createFilePreviewQueue } from "./filePreviewQueue";
import type { QuickTransferFile } from "./quickTransferState";
import type { Asset } from "./types";

type PreviewQueue = ReturnType<typeof createFilePreviewQueue>;

/** Hydrate only newly completed IDs; IPC responses need not preserve request order. */
export function useQuickTransferAssets(files: QuickTransferFile[]) {
  const requests = useRef(new Map<string, Promise<Asset | undefined>>());
  const [assets, setAssets] = useState(new Map<string, Asset>());
  const idsKey = JSON.stringify([...new Set(files.filter(file => file.status === "complete")
    .map(file => file.assetId).filter((id): id is string => !!id))].sort());
  useEffect(() => {
    const ids: string[] = JSON.parse(idsKey);
    const current = new Set(ids);
    for (const id of requests.current.keys()) if (!current.has(id)) requests.current.delete(id);
    const missing = ids.filter(id => !requests.current.has(id));
    if (missing.length) {
      const batch = api.getAssetsByIds(missing).then(items => new Map(items.map(asset => [asset.id, asset])))
        .catch(() => new Map<string, Asset>());
      for (const id of missing) requests.current.set(id, batch.then(items => items.get(id)));
    }
    let alive = true;
    void Promise.all(ids.map(id => requests.current.get(id)!)).then(items => {
      if (alive) setAssets(new Map(items.filter((asset): asset is Asset => !!asset).map(asset => [asset.id, asset])));
    });
    return () => { alive = false; };
  }, [idsKey]);
  return assets;
}

function resolvePreview(asset: Asset | undefined) {
  if (!asset || isAudioAsset(asset) || isTextAsset(asset)) return { key: "", path: null, thumbnail: null };
  return {
    key: JSON.stringify([asset.id, asset.store_path, asset.thumb_path, asset.file_mtime, asset.size]),
    path: asset.store_path, thumbnail: asset.thumb_path,
  };
}

/** Each subscription follows one asset/version; hiding the row cancels queued work. */
export function useQuickTransferThumbnail(asset: Asset | undefined, visible: boolean, previews: PreviewQueue) {
  const { key, path, thumbnail } = resolvePreview(asset);
  const [ready, setReady] = useState<{ key: string; path: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!visible || !path || failed === key) return;
    const cached = thumbnail || previews.peek(key);
    if (cached) { setReady({ key, path: cached }); return; }
    const request = previews.request(key, path, 0, preview => setReady({ key, path: preview }));
    return () => request.cancel();
  }, [visible, path, thumbnail, key, failed, previews]);
  const source = visible && ready?.key === key && failed !== key ? convertFileSrc(ready.path) : null;
  return { source, onError: () => { previews.forget(key); setFailed(key); } };
}
