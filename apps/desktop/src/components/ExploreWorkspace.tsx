import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { GripVertical, LoaderCircle } from "lucide-react";
import { SourceBrowserPanel } from "./SourceBrowserPanel";
import { useStore } from "../store";
import { api } from "../lib/api";
import { EXPLORER_MIME, parseExplorerImage } from "../lib/explorer";
import { notifyError, notifySuccess } from "../lib/notify";
import { prepareExplorerCanvasDrop } from "../lib/explorerCanvasDrop";

export function ExploreWorkspace({ url, open, navigationId = 0, onClose, children }: { url: string | null; open: boolean; navigationId?: number; onClose: () => void; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [over, setOver] = useState(false);
  const [width, setWidth] = useState(460);
  const [resizing, setResizing] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  async function drop(event: DragEvent) {
    const image = parseExplorerImage(event.dataTransfer);
    setOver(false);
    if (!image) {
      if (event.dataTransfer.types.includes(EXPLORER_MIME) || event.dataTransfer.getData("text/plain").startsWith("bowerbird-explorer:")) {
        event.preventDefault(); event.stopPropagation();
        notifyError(null, "未能识别拖入的图片，请重新拖动网页图片");
      }
      return;
    }
    event.preventDefault(); event.stopPropagation();
    const state = useStore.getState();
    if (busyRef.current || state.projectRoutePending) return;
    busyRef.current = true; setBusy(true);
    const target = state.activeProjectId;
    const revision = state.projectRouteRevision;
    const placeOnCanvas = prepareExplorerCanvasDrop(event.target, target, event.clientX, event.clientY);
    try {
      // Flush existing composer state before materializing a still-empty project.
      if (target) {
        await state.projectCanvasFlush?.();
        const current = useStore.getState();
        if (current.projectRoutePending || current.projectRouteRevision !== revision || current.activeProjectId !== target) {
          throw new Error("项目正在切换，请重新拖入图片");
        }
        const selected = current.projects.find(p => p.id === target);
        if (!selected) throw new Error("项目已不存在");
        if (selected.provisional) {
          await api.projectCanvasMaterialize({ projectId: target, name: selected.name,
            workspacePath: selected.workspace_path || `blank:${target}`, workspaceKey: `blank:${target}`,
            kind: selected.kind || "blank", titleSource: selected.title_source || "default", draftJson: '{"schema_version":1}' });
          useStore.setState(s => ({ projects: s.projects.map(p => p.id === target ? { ...p, provisional: false } : p) }));
          const route = useStore.getState();
          if (!route.projectRoutePending && route.projectRouteRevision === revision && route.activeProjectId === target) await api.setActiveProject(target);
        }
      }
      const asset = await api.captureSourceBrowserImage(image.imageUrl, image.pageUrl, target);
      if (placeOnCanvas) {
        try { await placeOnCanvas(asset); }
        catch (error) { notifyError(error, "图片已入库，但画板卡片保存失败"); return; }
      }
      notifySuccess(placeOnCanvas ? "图片已采集并添加到画板" : "图片已采集");
    } catch (error) { notifyError(error, "采集失败，请重试"); }
    finally { busyRef.current = false; setBusy(false); }
  }

  return <div ref={root} className={`explore-workspace ${open ? "is-open" : ""}`} aria-label="主工作区">
    <aside className="explore-browser" style={{ width }} hidden={!open} aria-label="探索面板">
      {url && <SourceBrowserPanel url={url} navigationId={navigationId} onClose={onClose} visible={open} suspended={resizing} />}
    </aside>
    <div className="explore-resizer" hidden={!open} role="separator" aria-label="调整浏览器宽度" aria-orientation="vertical" tabIndex={0}
      onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault(); setWidth(w => Math.max(320, Math.min((root.current?.clientWidth || 900) - 280, w + (event.key === "ArrowLeft" ? -20 : 20))));
      } }}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); setResizing(true); }}
      onPointerMove={event => { if (resizing && root.current) setWidth(Math.max(320, Math.min(root.current.clientWidth - 280, event.clientX - root.current.getBoundingClientRect().left))); }}
      onPointerUp={() => setResizing(false)} onLostPointerCapture={() => setResizing(false)}><GripVertical size={12} /></div>
    <section className={`explore-main ${over ? "is-drop-target" : ""}`} aria-label="探索采集素材"
      onDragOverCapture={event => {
        if (Array.from(event.dataTransfer.types).some(type => type === EXPLORER_MIME || type === "text/plain")) {
          event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = busy ? "none" : "copy"; setOver(!busy);
        }
      }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false); }}
      onDropCapture={event => void drop(event)}>
      {children}
      {busy && <div className="explore-capture-status pointer-events-none" role="status"><LoaderCircle size={13} className="animate-spin" />采集中…</div>}
      {over && <div className="explore-drop-hint">松开采集图片</div>}
    </section>
  </div>;
}
