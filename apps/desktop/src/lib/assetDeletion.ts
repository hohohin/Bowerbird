import type { Asset } from "./types";

function isBowerbirdTemporaryOrigin(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return ["bowerbird-upload-", "bowerbird-cloud-", "bowerbird-dreamina-"].some(
    (prefix) => normalized.includes(`/temp/${prefix}`) || normalized.includes(`/tmp/${prefix}`)
      || ((normalized.startsWith("/var/folders/") || normalized.startsWith("/private/var/folders/"))
        && normalized.includes(`/t/${prefix}`)),
  );
}

/** 只有拥有稳定用户原路径的素材才能“移出园丁鸟”。 */
export function canMoveAssetOut(
  asset: Pick<Asset, "source" | "origin_path"> | null | undefined,
): boolean {
  if (!asset?.origin_path || asset.source === "extension") return false;
  return !isBowerbirdTemporaryOrigin(asset.origin_path);
}
