import { userErrorMessage } from "../lib/userError";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { PanelEdgeHandle } from "./PanelEdgeHandle";
import { SourceBrowserPanel } from "./SourceBrowserPanel";
import { localClassification, projectClassification } from "../lib/localClassification";
import { UNTAGGED_SECTION } from "../lib/materialCatalogOrder";
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
import { folderConnections } from "../lib/folderConnections";
import { enqueueExplorerCapture } from "../lib/explorerCaptureHistory";
import type { Asset } from "../lib/types";

export function ExploreWorkspace({ url, open, navigationId = 0, onClose, children }: { url: string | null; open: boolean; navigationId?: number; onClose: () => void; children: ReactNode }) {
  const [over, setOver] = useState(false);
  const [width, setWidth] = useState(460);
  const [resizing, setResizing] = useState(false);
  const [maximumWidth, setMaximumWidth] = useState(1000);
  const root = useRef<HTMLDivElement>(null);
  const resizeStart = useRef<{ pointer: number; x: number; width: number } | null>(null);
  const browserWidth = Math.min(width, maximumWidth);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setMaximumWidth(Math.max(320, element.clientWidth - 280));
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, []);
  const resize = (next: number) => setWidth(Math.max(320, Math.min(maximumWidth, next)));
  const finishResize = () => { resizeStart.current = null; setResizing(false); };
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
        notifyError(null, "未能识别拖入的素材，请重新拖动网页图片或视频");
      }
      return;
    }
    event.preventDefault(); event.stopPropagation();
    if (image.blocked === "protected_video") {
      notifyError(null, "该视频受播放保护，暂不支持采集"); return;
    }
    const isVideo = image.mediaKind === "video";
    const mediaName = isVideo ? "视频" : "图片";
    const state = useStore.getState();
    if (state.projectRoutePending) { notifyError(null, "项目正在切换，请稍后重新拖入"); return; }
    const operation = ++sequence.current;
    setFeedback(null);
    const point = { x: event.clientX, y: event.clientY };
    const contextProjectId = state.activeProjectId;
    const destination = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-project-drop-id], [data-file-import-project-id]") : null;
    const target = destination
      ? destination.dataset.projectDropId ?? (destination.dataset.fileImportProjectId || null)
      : contextProjectId;
    const collectionId = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-file-import-collection-id]")?.dataset.fileImportCollectionId || null : null;
    const tagElement = event.target instanceof Element
      ? event.target.closest<HTMLElement>(".is-tag-catalog [data-tag-id], .is-tag-catalog [data-tag-section]") : null;
    const droppedTag = tagElement?.dataset.tagId ?? tagElement?.dataset.tagSection;
    const tagId = droppedTag && droppedTag !== UNTAGGED_SECTION ? droppedTag : null;
    const completeLesson = beginOnboardingOperation("explore", target);
    const revision = state.projectRouteRevision;
    const placeOnCanvas = prepareExplorerCanvasDrop(event.target, target, event.clientX, event.clientY);
    const droppedOnCanvas = event.target instanceof Element && !!event.target.closest("[data-canvas-stage]");
    // Older/incomplete page injections can lack a drag ID; start on drop then.
    const dragId = image.dragId ?? crypto.randomUUID().replaceAll("-", "");
    if (tagId && !isVideo) void api.releaseSourceBrowserAnalysis(dragId).catch(() => {});
    const previewUrl = dragMotion.drop(image, dragId, point.x, point.y);
    const classificationId = `${dragId}:${operation}`;
    const inTarget = () => {
      const route = useStore.getState();
      return mounted.current && route.activeProjectId === contextProjectId && route.projectRouteRevision === revision;
    };
    const updateClassification = (patch: Partial<ExplorerClassificationItem>) => {
      if (inTarget()) setClassifications(items => items.map(item => item.id === classificationId ? { ...item, ...patch } : item));
    };
    let capturedId: string | undefined;
    let placedNodeId: string | undefined;
    let capturedAsset: Asset | undefined;
    let collectionDelivered = false;
    let tagDelivered = false;
    const discard = () => { dragMotion.finish(dragId); if (!isVideo) void api.releaseSourceBrowserAnalysis(dragId).catch(() => {}); };
    try { enqueueExplorerCapture({ mediaKind: image.mediaKind, pageUrl: image.pageUrl, thumbnail: previewUrl }, async attempt => {
    let handedOff = false;
    try {
      if (!placeOnCanvas && droppedOnCanvas) throw new Error("画布尚未准备好，请稍后重新拖入");
      let analysisIssue = "";
      const analysing = !tagId && !capturedAsset && !isVideo && await api.claimSourceBrowserAnalysis(dragId, image.imageUrl, image.pageUrl).catch(error => {
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
      if (target && !capturedAsset) {
        if (target === contextProjectId && useStore.getState().activeProjectId === contextProjectId) await state.projectCanvasFlush?.();
        const current = useStore.getState();
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
      if (!capturedAsset) {
        attempt.beforeCapture();
        capturedAsset = await api.captureSourceBrowserImage(image.imageUrl, image.pageUrl, target, dragId, image.mediaKind, attempt.captureId, tagId ? true : undefined);
      }
      const asset = capturedAsset;
      attempt.saved(asset);
      capturedId = asset.id;
      if (tagId && !tagDelivered) {
        await (target ? projectClassification(target) : localClassification).example(tagId, [asset.id], true);
        tagDelivered = true;
      }
      if (asset.thumb_path) updateClassification({ imageUrl: convertFileSrc(asset.thumb_path) });
      if (collectionId && !collectionDelivered) {
        await folderConnections.references([asset.id], collectionId);
        collectionDelivered = true;
      }
      let nodeId: string | void = undefined;
      if (placeOnCanvas) {
        nodeId = await placeOnCanvas(asset);
      }
      if (placeOnCanvas) completeLesson();
      placedNodeId = nodeId || undefined;
      const result: CaptureFeedback = { id: operation, assetId: asset.id, nodeId: nodeId || undefined, ...point,
        projectId: contextProjectId, message: analysisIssue ? `已采集；${analysisIssue}` : "已采集", pending: false };
      const show = (value: CaptureFeedback) => {
        if (sequence.current === operation && inTarget()) setFeedback(value);
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
      if (useStore.getState().activeProjectId !== contextProjectId) notifySuccess(placeOnCanvas ? `${mediaName}已采集并添加到画板` : `${mediaName}已采集`);
    } finally {
      dragMotion.finish(dragId, capturedId, placedNodeId);
      if (!handedOff) {
        if (mounted.current) removeClassification(classificationId);
        if (!isVideo) void api.releaseSourceBrowserAnalysis(dragId).catch(() => {});
      }
    }
    }, discard); } catch (error) { discard(); notifyError(error, "采集任务未加入，请重试"); }
  }

  return <div ref={root} className={`explore-workspace ${open ? "is-open" : ""}`} aria-label="主工作区">
    <aside id="explore-browser-panel" className="explore-browser" style={{ width: browserWidth }} hidden={!open} aria-label="探索面板">
      {url && <SourceBrowserPanel url={url} navigationId={navigationId} onClose={onClose} visible={open} suspended={resizing} />}
      <PanelEdgeHandle variant="overlay" className={`explore-panel-handle ${resizing ? "is-library-resizing" : ""}`} closeLabel="收起浏览器" onClose={onClose} onEscape={onClose} grip={{
        "aria-label": "调整浏览器宽度", "aria-controls": "explore-browser-panel",
        "aria-valuemin": 320, "aria-valuemax": maximumWidth, "aria-valuenow": browserWidth,
        title: "拖动调整浏览器宽度 · 左右方向键微调 · 双击恢复默认宽度",
        onKeyDown: event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          resize(event.key === "Home" ? 320 : event.key === "End" ? maximumWidth : browserWidth + (event.key === "ArrowLeft" ? -20 : 20));
        },
        onPointerDown: event => {
          if (event.button !== 0 || resizeStart.current) return;
          event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
          resizeStart.current = { pointer: event.pointerId, x: event.clientX, width: browserWidth };
          event.currentTarget.setPointerCapture(event.pointerId); setResizing(true);
        },
        onPointerMove: event => {
          const start = resizeStart.current;
          if (start?.pointer === event.pointerId) resize(start.width + event.clientX - start.x);
        },
        onPointerUp: event => {
          if (resizeStart.current?.pointer !== event.pointerId) return;
          finishResize(); event.currentTarget.releasePointerCapture(event.pointerId);
        },
        onPointerCancel: finishResize, onLostPointerCapture: finishResize,
        onDoubleClick: () => resize(460),
      }} />
    </aside>
    <section className={`explore-main ${over ? "is-drop-target" : ""}`} aria-label="探索采集素材"
      onDragOverCapture={event => {
        if (getDragAssets()?.length) { setOver(false); return; }
        if (Array.from(event.dataTransfer.types).some(type => type === EXPLORER_MIME || type === "text/plain")) {
          event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; setOver(true);
          dragMotion.over(event.clientX, event.clientY);
        }
      }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setOver(false); dragMotion.leave(); } }}
      onDropCapture={event => void drop(event)}>
      {open && <div className="explore-learning-hint"><LearningHint topic="explore" /></div>}
      {children}
      <ExplorerClassificationDock items={classifications} onDone={removeClassification} />
      {open && feedback && feedback.projectId === activeProjectId && <ExplorerCaptureFeedback value={feedback} onDone={clearFeedback} />}
      {over && <div className="explore-drop-hint">松开采集</div>}
    </section>
  </div>;
}
