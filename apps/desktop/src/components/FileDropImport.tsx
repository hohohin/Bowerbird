import { userErrorMessage } from "../lib/userError";
import { useEffect, useState } from "react";
import { useStore } from "../store";
import { importDroppedMedia, prepareMediaImport, showImportedMedia } from "../lib/mediaImport";
import type { Asset } from "../lib/types";
import { notifyError, notifySuccess } from "../lib/notify";
import { prepareExplorerCanvasDrop } from "../lib/explorerCanvasDrop";
import { EXPLORER_MIME } from "../lib/explorer";
import { getDragAssets } from "../lib/dragPayload";
import { libraryPaneAt } from "../lib/libraryPane";
import { folderConnections } from "../lib/folderConnections";
import { useLocalFileMode } from "../lib/localFileMode";
import { localClassification, projectClassification } from "../lib/localClassification";
import { captureDropMessage, resolveCaptureDropTarget } from "../lib/captureDropTarget";
import { useCaptureDropFeedback } from "./CaptureDropFeedback";

/** Capture external files above cards, editors and portals; internal asset drags keep their own handlers. */
export function FileDropImport() {
  const [pending, setPending] = useState(0);
  const { feedback: dropFeedback, show: showDropFeedback, clear: clearDropFeedback } = useCaptureDropFeedback("files");
  useEffect(() => {
    let alive = true;
    const isFiles = (event: DragEvent) => {
      if (getDragAssets()?.length) return false;
      const data = event.dataTransfer;
      if (!data?.types.includes("Files")) return false;
      // WebView2 image drags can carry both Files and our capture protocol.
      // Let ExploreWorkspace validate even malformed metadata and report errors.
      if (data.types.includes(EXPLORER_MIME) || data.getData("text/plain").startsWith("bowerbird-explorer:")) return false;
      // Native bridges can strip custom MIME; dragover exposes types but no text.
      // Defer mixed text/files over the explorer target until drop can read it.
      if (event.type !== "drop" && data.types.includes("text/plain") && event.target instanceof Element
        && event.target.closest(".explore-workspace.is-open .explore-main")) return false;
      return true;
    };
    const collection = (event: DragEvent) => event.target instanceof Element && !!event.target.closest(".collection-panel .app-modal");
    function over(event: DragEvent) {
      if (!isFiles(event)) { clearDropFeedback(); return; }
      event.preventDefault();
      if (collection(event)) { event.dataTransfer!.dropEffect = "copy"; clearDropFeedback(); return; }
      event.stopPropagation();
      const state = useStore.getState();
      if (state.projectRoutePending) { event.dataTransfer!.dropEffect = "none"; clearDropFeedback(); return; }
      const destination = resolveCaptureDropTarget(event.target, state);
      event.dataTransfer!.dropEffect = destination.disabled ? "none" : "copy";
      showDropFeedback(destination, event.target);
    }
    async function importFiles(event: DragEvent) {
      clearDropFeedback();
      if (!isFiles(event) || collection(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const state = useStore.getState();
      if (state.projectRoutePending) { notifyError(null, "项目正在切换，请稍后重新拖入"); return; }
      const destination = resolveCaptureDropTarget(event.target, state);
      if (destination.disabled) { notifyError(null, captureDropMessage(destination)); return; }
      // FileList and destination must be copied while the drop is synchronous.
      const files = Array.from(event.dataTransfer!.files);
      if (!files.length) { notifyError(null, "未读取到素材文件，请重新拖入"); return; }
      const projectId = destination.projectId;
      const libraryMode = libraryPaneAt(event.target)?.mode ?? useLocalFileMode;
      const librarySource = libraryMode.getState().source;
      const libraryProjectId = libraryMode.getState().browseProjectId;
      const revision = state.projectRouteRevision;
      const place = destination.kind === "canvas" ? prepareExplorerCanvasDrop(event.target, projectId, event.clientX, event.clientY) : null;
      if (destination.kind === "canvas" && !place) {
        notifyError(null, "画布尚未准备好，请稍后重新拖入"); return;
      }
      setPending(count => count + 1);
      const imported: Asset[] = [];
      const failures: string[] = [];
      try {
        await prepareMediaImport(projectId, revision);
        for (const file of files) {
          let ingested = false;
          try {
            const asset = await importDroppedMedia(file, projectId);
            ingested = true;
            if (destination.kind === "folder") await folderConnections.references([asset.id], destination.id);
            if (destination.kind === "tag") await (projectId ? projectClassification(projectId) : localClassification).example(destination.id, [asset.id], true);
            if (place) await place(asset);
            imported.push(asset);
          } catch (error) { console.error("File intake failed", file.name, error); failures.push(`${ingested ? "已加入素材库，但放置未完成。" : ""}${userErrorMessage(error, "添加未完成，请检查文件是否可用后重试。")}`); }
        }
        if (imported.length) {
          const current = useStore.getState();
          if (!place && destination.kind !== "folder" && destination.kind !== "tag" && libraryMode.getState().source === librarySource
            && (librarySource !== "project" || libraryMode.getState().browseProjectId === libraryProjectId)
            && current.activeProjectId === state.activeProjectId && current.projectRouteRevision === revision && !current.projectRoutePending) {
            current.setCurrentCollection(null); current.setCurrentFolder(null);
            current.setSearchQuery(""); current.setSmartFilter(null); current.setColorFilter(null);
            showImportedMedia(imported, libraryMode);
          }
          notifySuccess(`已添加 ${imported.length} 个素材`);
        }
        if (failures.length) notifyError(null, `${failures.length > 1 ? `${failures.length} 项未完成。` : ""}${failures[0]}`);
      } catch (error) { notifyError(error, "素材添加失败"); }
      finally { if (alive) setPending(count => count - 1); }
    }
    window.addEventListener("dragenter", over, true);
    window.addEventListener("dragover", over, true);
    window.addEventListener("drop", importFiles, true);
    return () => {
      alive = false;
      window.removeEventListener("dragenter", over, true);
      window.removeEventListener("dragover", over, true);
      window.removeEventListener("drop", importFiles, true);
    };
  }, [clearDropFeedback, showDropFeedback]);
  return <>
    {dropFeedback}
    {pending > 0 && !dropFeedback && <div role="status" className="file-drop-feedback pointer-events-none fixed right-5 top-16 z-[250] rounded-full border border-edge bg-panel px-4 py-2 text-xs text-ink">正在添加素材…</div>}
  </>;
}
