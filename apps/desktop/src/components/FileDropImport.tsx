import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { notifyError, notifySuccess } from "../lib/notify";
import { prepareExplorerCanvasDrop } from "../lib/explorerCanvasDrop";

/** Capture external files above cards, editors and portals; internal asset drags keep their own handlers. */
export function FileDropImport() {
  const [hint, setHint] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  useEffect(() => {
    let alive = true;
    const isFiles = (event: DragEvent) => !!event.dataTransfer?.types.includes("Files");
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
      if (!files.length) { notifyError(null, "未读取到图片文件，请重新拖入"); return; }
      const state = useStore.getState();
      const projectId = targetProject(event);
      const revision = state.projectRouteRevision;
      const place = prepareExplorerCanvasDrop(event.target, projectId, event.clientX, event.clientY);
      setPending(count => count + 1);
      let imported = 0;
      const failures: string[] = [];
      try {
        if (projectId) {
          if (state.projectRoutePending) throw new Error("项目正在切换，请重新拖入图片");
          if (projectId === state.activeProjectId) await state.projectCanvasFlush?.();
          const project = useStore.getState().projects.find(project => project.id === projectId);
          if (!project || project.archived_at) throw new Error("目标项目已不可用");
          if (project.provisional) {
            const current = useStore.getState();
            if (current.projectRoutePending || current.projectRouteRevision !== revision) throw new Error("项目正在切换，请重新拖入图片");
            await api.projectCanvasMaterialize({ projectId, name: project.name,
              workspacePath: project.workspace_path || `blank:${projectId}`, workspaceKey: `blank:${projectId}`,
              kind: project.kind || "blank", titleSource: project.title_source || "default", draftJson: '{"schema_version":1}' });
            useStore.setState(s => ({ projects: s.projects.map(p => p.id === projectId ? { ...p, provisional: false } : p) }));
            const route = useStore.getState();
            if (!route.projectRoutePending && route.projectRouteRevision === revision && route.activeProjectId === projectId) await api.setActiveProject(projectId);
          }
        }
        for (const file of files) {
          try {
            if (file.size > 50 * 1024 * 1024) throw new Error("图片不能超过 50 MB");
            if (!file.type.startsWith("image/") && !/\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(file.name)) {
              throw new Error("不支持的图片格式");
            }
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(file);
            });
            const asset = await api.importImageBytes({ dataUrl, fileName: file.name, projectId, source: "imported" });
            imported++;
            if (place) await place(asset);
          } catch (error) { failures.push(`${file.name}：${String(error)}`); }
        }
        if (imported) {
          const current = useStore.getState();
          if (current.activeProjectId === state.activeProjectId && current.projectRouteRevision === revision && !current.projectRoutePending) {
            current.setCurrentCollection(null); current.setCurrentFolder(null);
            current.setSearchQuery(""); current.setSmartFilter(null); current.setColorFilter(null);
          }
          notifySuccess(`已导入 ${imported} 张素材`);
        }
        if (failures.length) notifyError(null, failures.join("\n"));
      } catch (error) { notifyError(error, "图片导入失败"); }
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
    {pending > 0 && !hint && <div role="status" className="pointer-events-none fixed right-5 top-16 z-[250] rounded-full border border-edge bg-panel px-4 py-2 text-xs text-ink">正在导入图片…</div>}
  </>;
}
