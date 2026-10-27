import { userErrorMessage } from "../lib/userError";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { GripVertical, LoaderCircle } from "lucide-react";
import { SourceBrowserPanel } from "./SourceBrowserPanel";
import { useStore } from "../store";
import { api } from "../lib/api";
import { EXPLORER_MIME, parseExplorerImage } from "../lib/explorer";
import { notifyError, notifySuccess } from "../lib/notify";
import { prepareExplorerCanvasDrop } from "../lib/explorerCanvasDrop";
import { LearningHint } from "./OnboardingTour";
import { beginOnboardingOperation } from "../lib/onboardingStore";
import { ExplorerCaptureFeedback, type CaptureFeedback } from "./ExplorerCaptureFeedback";
import { useExplorerDragMotion } from "../lib/useExplorerDragMotion";
import { getDragAssets } from "../lib/dragPayload";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ExplorerClassificationDock, type ExplorerClassificationItem } from "./ExplorerClassificationDock";

export function ExploreWorkspace({ url, open, navigationId = 0, onClose, children }: { url: string | null; open: boolean; navigationId?: number; onClose: () => void; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [over, setOver] = useState(false);
  const [width, setWidth] = useState(460);
  const [resizing, setResizing] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const [feedback, setFeedback] = useState<CaptureFeedback | null>(null);
  const [classifications, setClassifications] = useState<ExplorerClassificationItem[]>([]);
  const completionOrder = useRef(0);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const activeProjectId = useStore(s => s.activeProjectId);
  const projectRouteRevision = useStore(s => s.projectRouteRevision);
  const receiveThumbnail = useCallback((dragId: string, thumbnail: string) => {
    setClassifications(items => items.map(item => item.id.startsWith(`${dragId}:`) && /^https?:/.test(item.imageUrl)
      ? { ...item, imageUrl: thumbnail } : item));
  }, []);
  const dragMotion = useExplorerDragMotion(root, open, activeProjectId, receiveThumbnail);
  const clearFeedback = useCallback(() => setFeedback(null), []);
  const removeClassification = useCallback((id: string) => setClassifications(items => items.filter(item => item.id !== id)), []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { sequence.current += 1; setFeedback(null); }, [open, activeProjectId]);
  useLayoutEffect(() => { setClassifications([]); }, [activeProjectId, projectRouteRevision]);

  async function drop(event: DragEvent) {
    if (getDragAssets()?.length) { setOver(false); return; }
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
    const operation = ++sequence.current;
    setFeedback(null);
    const point = { x: event.clientX, y: event.clientY };
    const target = state.activeProjectId;
    const completeLesson = beginOnboardingOperation("explore", target);
    const revision = state.projectRouteRevision;
    const placeOnCanvas = prepareExplorerCanvasDrop(event.target, target, event.clientX, event.clientY);
    // Older/incomplete page injections can lack a drag ID; start on drop then.
    const dragId = image.dragId ?? crypto.randomUUID().replaceAll("-", "");
    const previewUrl = dragMotion.drop(image, dragId, point.x, point.y);
    const classificationId = `${dragId}:${operation}`;
    const inTarget = () => {
      const route = useStore.getState();
      return mounted.current && route.activeProjectId === target && route.projectRouteRevision === revision;
    };
    const updateClassification = (patch: Partial<ExplorerClassificationItem>) => {
      if (inTarget()) setClassifications(items => items.map(item => item.id === classificationId ? { ...item, ...patch } : item));
    };
    let capturedId: string | undefined;
    let placedNodeId: string | undefined;
    let handedOff = false;
    try {
      let analysisIssue = "";
      const analysing = await api.claimSourceBrowserAnalysis(dragId, image.imageUrl, image.pageUrl).catch(error => {
        const reason = error instanceof Error ? error.message : typeof error === "string" ? error : "";
        console.error("Capture classification unavailable", error);
        analysisIssue = /not found|unknown command/i.test(reason) ? "分类暂不可用，请更新应用后重试" : userErrorMessage(error, "分类暂不可用，可稍后重新分类");
        return false;
      });
      if (analysing && inTarget()) {
        const imageUrl = dragMotion.park(dragId) ?? previewUrl;
        setClassifications(items => [...items, { id: classificationId, imageUrl, origin: point }]);
      }
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
      const asset = await api.captureSourceBrowserImage(image.imageUrl, image.pageUrl, target, dragId);
      capturedId = asset.id;
      if (asset.thumb_path) updateClassification({ imageUrl: convertFileSrc(asset.thumb_path) });
      let nodeId: string | void = undefined;
      if (placeOnCanvas) {
        try { nodeId = await placeOnCanvas(asset); }
        catch (error) { notifyError(error, "图片已入库，但画板卡片保存失败"); return; }
      }
      if (placeOnCanvas) completeLesson();
      placedNodeId = nodeId || undefined;
      const result: CaptureFeedback = { id: operation, assetId: asset.id, nodeId: nodeId || undefined, ...point,
        projectId: target, message: analysisIssue ? `已采集；${analysisIssue}` : "已采集", pending: false };
      const show = (value: CaptureFeedback) => {
        const route = useStore.getState();
        if (mounted.current && sequence.current === operation && route.activeProjectId === target && route.projectRouteRevision === revision) setFeedback(value);
      };
      if (!analysing) show(result);
      if (analysing) {
        handedOff = true;
        void api.finishSourceBrowserAnalysis(dragId, asset.id).then(tags => {
          updateClassification({ labels: tags, outcome: tags.length ? "matched" : "unmatched", completedOrder: ++completionOrder.current });
        }).catch(error => {
          updateClassification({ outcome: "failed", completedOrder: ++completionOrder.current });
          notifyError(error, "图片已采集，但标签识别未完成");
        });
      }
      // Retain a global acknowledgement if the user has navigated away from the target.
      if (useStore.getState().activeProjectId !== target) notifySuccess(placeOnCanvas ? "图片已采集并添加到画板" : "图片已采集");
    } catch (error) { notifyError(error, "采集失败，请重试"); }
    finally {
      dragMotion.finish(dragId, capturedId, placedNodeId);
      if (!handedOff) {
        if (mounted.current) removeClassification(classificationId);
        void api.releaseSourceBrowserAnalysis(dragId).catch(() => {});
      }
      busyRef.current = false; setBusy(false);
    }
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
        if (getDragAssets()?.length) { setOver(false); return; }
        if (Array.from(event.dataTransfer.types).some(type => type === EXPLORER_MIME || type === "text/plain")) {
          event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = busy ? "none" : "copy"; setOver(!busy);
          if (!busy) dragMotion.over(event.clientX, event.clientY);
        }
      }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setOver(false); dragMotion.leave(); } }}
      onDropCapture={event => void drop(event)}>
      {open && <div className="explore-learning-hint"><LearningHint topic="explore" /></div>}
      {children}
      <ExplorerClassificationDock items={classifications} onDone={removeClassification} />
      {open && feedback && feedback.projectId === activeProjectId && <ExplorerCaptureFeedback value={feedback} onDone={clearFeedback} />}
      {busy && <div className="explore-capture-status pointer-events-none" role="status"><LoaderCircle size={13} className="animate-spin" />采集中…</div>}
      {over && <div className="explore-drop-hint">松开采集图片</div>}
    </section>
  </div>;
}
