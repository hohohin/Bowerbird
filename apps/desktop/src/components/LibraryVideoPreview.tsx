import { CreationImagePreview } from "./CreationImagePreview";
import { Lightbox } from "./Lightbox";
import { saveVideoFrame } from "../lib/saveVideoFrame";
import { saveVideoFrameToCanvas } from "../lib/videoFrameCanvas";
import { api } from "../lib/api";
import { prepareVideoCollectionProject } from "../lib/videoCollectionCanvas";
import type { Asset, GenJob } from "../lib/types";
import { isVideoPath } from "../lib/videoGeneration";

export function LibraryVideoPreview({ asset, job, path, sourceKey, projectId, onClose }: {
  asset: Asset; job?: GenJob; path: string; sourceKey?: string; projectId: string | null; onClose: () => void;
}) {
  if (!isVideoPath(path)) return <Lightbox images={[path]} index={0} onIndexChange={() => {}} onClose={onClose}/>;
  return <CreationImagePreview asset={asset} job={job} projectId={projectId} onClose={onClose} video={{
    path, sourceKey, frameTarget: "library", onAddFrame: async frame => {
      if (projectId) await prepareVideoCollectionProject(projectId);
      await saveVideoFrame(frame, projectId);
    }, onSaveTrim: async request => {
      if (projectId) await prepareVideoCollectionProject(projectId);
      return api.trimVideo(request, projectId ?? undefined);
    },
    onAddFrameToCanvas: projectId ? frame => saveVideoFrameToCanvas(frame, projectId) : undefined,
  }}/>;
}
