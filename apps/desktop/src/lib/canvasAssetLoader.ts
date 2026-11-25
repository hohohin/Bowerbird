import { api } from "./api";
import type { Asset } from "./types";

/** Share exact-ID fallbacks across the cards and workflows of one project snapshot. */
export function createCanvasAssetLoader() {
  const requests = new Map<string, Promise<Asset | undefined>>();
  return async (ids: string[]) => {
    const missing = ids.filter(id => !requests.has(id));
    if (missing.length) {
      const batch = api.getAssetsByIds(missing).then(assets => new Map(assets.map(asset => [asset.id, asset])));
      for (const id of missing) {
        requests.set(id, batch.then(assets => {
          const asset = assets.get(id);
          if (!asset) requests.delete(id);
          return asset;
        }, () => {
          requests.delete(id);
          return undefined;
        }));
      }
    }
    return (await Promise.all(ids.map(id => requests.get(id)))).filter((asset): asset is Asset => !!asset);
  };
}
