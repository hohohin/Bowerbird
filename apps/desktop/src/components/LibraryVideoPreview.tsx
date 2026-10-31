import { Lightbox } from "./Lightbox";
import { saveVideoFrame } from "../lib/saveVideoFrame";
import { saveVideoFrameToCanvas } from "../lib/videoFrameCanvas";
import { api } from "../lib/api";
import { prepareVideoCollectionProject } from "../lib/videoCollectionCanvas";

export function LibraryVideoPreview({ path, sourceKey, projectId, onClose }: {
  path: string; sourceKey?: string; projectId: string | null; onClose: () => void;
}) {
  return <Lightbox images={[path]} index={0} onIndexChange={() => {}} onClose={onClose}
    videoSourceKey={sourceKey} videoFrameTarget="library" onAddVideoFrame={async frame => {
      if (projectId) await prepareVideoCollectionProject(projectId);
      await saveVideoFrame(frame, projectId);
    }} onSaveVideoTrim={async request => {
      if (projectId) await prepareVideoCollectionProject(projectId);
      return api.trimVideo(request, projectId ?? undefined);
    }}
    onAddFrameToCanvas={projectId ? frame => saveVideoFrameToCanvas(frame, projectId) : undefined}/ >;
}
