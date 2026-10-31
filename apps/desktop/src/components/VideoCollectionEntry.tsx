import { useRef, useState } from "react";
import { Video } from "lucide-react";
import type { Asset } from "../lib/types";
import { saveCollectedVideoToCanvas, prepareVideoCollectionProject } from "../lib/videoCollectionCanvas";
import { VideoCollectionDialog } from "./VideoCollectionDialog";
import { useStore } from "../store";

export function VideoCollectionEntry({ projectId, onCloseLibrary, onCreateProject, onAssetsChange }: {
  projectId: string | null; onCloseLibrary: () => void;
  onCreateProject?: (ids?: string[]) => Promise<unknown>; onAssetsChange?: (assets: Asset[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const operations = useRef(new Map<string, string>());
  return <>
    <button type="button" className="library-filter-trigger" title="采集视频" aria-label="采集视频" onClick={() => setOpen(true)}><Video size={14}/></button>
    {open && <VideoCollectionDialog projectId={projectId} onClose={() => setOpen(false)}
      ensureProject={projectId ? () => prepareVideoCollectionProject(projectId) : undefined} onCollected={async (asset, owner, addToCanvas) => {
      if (addToCanvas) {
        if (!owner) {
          if (!onCreateProject) throw new Error("请先打开目标项目");
          await onCreateProject([asset.id]);
        } else {
          let operation = operations.current.get(asset.id);
          if (!operation) { operation = crypto.randomUUID(); operations.current.set(asset.id, operation); }
          await saveCollectedVideoToCanvas(asset, owner, operation);
          operations.current.delete(asset.id);
        }
        setOpen(false);
        if (useStore.getState().activeProjectId === owner) onCloseLibrary();
      }
      if (useStore.getState().activeProjectId === owner) onAssetsChange?.([asset]);
    }}/>}
  </>;
}
