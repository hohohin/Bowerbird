import { api } from "./api";
import type { Asset } from "./types";
import { prepareVideoCollectionProject, saveMediaAssetToCanvas } from "./videoCollectionCanvas";

/** One click freezes its destination; placement retries reuse the extracted file and node identity. */
export function createVideoAudioExport(sourcePath: string, projectId: string | null, target: "canvas" | "library") {
  const operationId = crypto.randomUUID();
  let asset: Asset | undefined;
  let completed = false;
  return async () => {
    if (completed) return;
    if (target === "canvas" && !projectId) throw new Error("请先打开项目画板，再添加音轨");
    if (!asset) {
      if (projectId) await prepareVideoCollectionProject(projectId);
      asset = await api.extractVideoAudio(sourcePath, operationId, projectId ?? undefined);
    }
    if (target === "canvas") await saveMediaAssetToCanvas(asset, projectId!, operationId);
    completed = true;
  };
}
