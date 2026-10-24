import { userErrorMessage } from "../lib/userError";
import { useEffect, useState } from "react";
import { useStore } from "../store";
import { importDroppedMedia, prepareMediaImport, showImportedMedia } from "../lib/mediaImport";
import type { Asset } from "../lib/types";
import { notifyError, notifySuccess } from "../lib/notify";
import { prepareExplorerCanvasDrop } from "../lib/explorerCanvasDrop";
import { EXPLORER_MIME } from "../lib/explorer";

/** Capture external files above cards, editors and portals; internal asset drags keep their own handlers. */
export function FileDropImport() {
  const [hint, setHint] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  useEffect(() => {
    let alive = true;
    const isFiles = (event: DragEvent) => {
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
    const targetProject = (event: DragEvent) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-project-drop-id], [data-file-import-project-id]") : null;
      if (target) return target.dataset.projectDropId ?? (target.dataset.fileImportProjectId || null);
      return useStore.getState().activeProjectId;
    };
    function over(event: DragEvent) {
      if (!isFiles(event)) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = "copy";
      if (collection(event)) { setHint(null); return; }
      event.stopPropagation();
      const id = targetProject(event);
      const project = useStore.getState().projects.find(project => project.id === id);
      setHint(project ? `松开导入到「${project.name}」` : "松开导入到素材库");
    }
    function clear() { setHint(null); }
    function leave(event: DragEvent) {
      if (!event.relatedTarget) clear();
    }
    async function importFiles(event: DragEvent) {
      clear();
      if (!isFiles(event) || collection(event)) return;
      event.preventDefault();
      event.stopPropagation();
      // FileList and destination must be copied while the drop is synchronous.
      const files = Array.from(event.dataTransfer!.files);
      if (!files.length) { notifyError(null, "未读取到素材文件，请重新拖入"); return; }
      const state = useStore.getState();
      const projectId = targetProject(event);
      const revision = state.projectRouteRevision;
      const place = prepareExplorerCanvasDrop(event.target, projectId, event.clientX, event.clientY);
      setPending(count => count + 1);
      const imported: Asset[] = [];
      const failures: string[] = [];
      try {
        await prepareMediaImport(projectId, revision);
        for (const file of files) {
          try {
            const asset = await importDroppedMedia(file, projectId);
            imported.push(asset);
            if (place) await place(asset);
          } catch (error) { console.error("File import failed", error); failures.push(`${file.name}：${userErrorMessage(error, "导入未完成，请检查文件是否可用后重试。")}`); }
        }
        if (imported.length) {
          const current = useStore.getState();
          if (current.activeProjectId === state.activeProjectId && current.projectRouteRevision === revision && !current.projectRoutePending) {
            current.setCurrentCollection(null); current.setCurrentFolder(null);
            current.setSearchQuery(""); current.setSmartFilter(null); current.setColorFilter(null);
            showImportedMedia(imported);
          }
          notifySuccess(`已导入 ${imported.length} 个素材`);
        }
        if (failures.length) notifyError(null, failures.join("\n"));
      } catch (error) { notifyError(error, "素材导入失败"); }
      finally { if (alive) setPending(count => count - 1); }
    }
    window.addEventListener("dragenter", over, true);
    window.addEventListener("dragover", over, true);
    window.addEventListener("dragleave", leave, true);
    window.addEventListener("drop", importFiles, true);
    window.addEventListener("dragend", clear, true);
    window.addEventListener("blur", clear);
    return () => {
      alive = false;
      window.removeEventListener("dragenter", over, true);
      window.removeEventListener("dragover", over, true);
      window.removeEventListener("dragleave", leave, true);
      window.removeEventListener("drop", importFiles, true);
      window.removeEventListener("dragend", clear, true);
      window.removeEventListener("blur", clear);
    };
  }, []);
  return <>
    {hint && <div className="pointer-events-none fixed inset-0 z-[250] flex items-center justify-center bg-accent/10 ring-2 ring-inset ring-accent" data-file-drop-overlay>
      <div role="status" className="rounded-full border border-accent/30 bg-panel px-5 py-3 text-sm text-ink shadow-panel">{hint}</div>
    </div>}
    {pending > 0 && !hint && <div role="status" className="pointer-events-none fixed right-5 top-16 z-[250] rounded-full border border-edge bg-panel px-4 py-2 text-xs text-ink">正在导入素材…</div>}
  </>;
}
