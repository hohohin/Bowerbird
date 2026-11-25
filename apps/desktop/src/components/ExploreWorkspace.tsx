import { userErrorMessage } from "../lib/userError";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { PanelLeftOpen } from "lucide-react";
import { PanelEdgeHandle } from "./PanelEdgeHandle";
import { SourceBrowserPanel } from "./SourceBrowserPanel";
import { ExploreLibrary } from "./ExploreLibrary";
import { localClassification, projectClassification } from "../lib/localClassification";
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
import { captureDropMessage, resolveCaptureDropTarget } from "../lib/captureDropTarget";
import type { ExploreCaptureReceipt } from "../lib/exploreCaptureOrder";
import { useCaptureDropFeedback } from "./CaptureDropFeedback";

const DEFAULT_EXPLORER_WIDTH = 460;
const MIN_EXPLORER_WIDTH = 320;
const CANVAS_WIDTH_KEY = "bowerbird.explorer.canvasWidth";
const MIDDLE_WIDTH_KEY = "bowerbird.explorer.middleWidth";
const MIDDLE_OPEN_KEY = "bowerbird.explorer.middleOpen";
const SIDEBAR_OPEN_KEY = "bowerbird.explorer.sidebarOpen";
const DEFAULT_MIDDLE_WIDTH = 360;
const MIN_MIDDLE_WIDTH = 240;
const MAX_MIDDLE_WIDTH = 560;

function preference(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function remember(key: string, value: number | boolean) {
  try { localStorage.setItem(key, String(value)); } catch { /* Storage may be unavailable. */ }
}

function readWidth(value: string | null, fallback: number, minimum: number, maximum = Infinity) {
  const saved = Number(value);
  return saved > 0 && Number.isFinite(saved) ? Math.max(minimum, Math.min(maximum, saved)) : fallback;
}

const projectPreparations = new Map<string, Promise<void>>();
function prepareCaptureProject(projectId: string, operation: () => Promise<void>) {
  const next = (projectPreparations.get(projectId) ?? Promise.resolve()).catch(() => {}).then(operation);
  projectPreparations.set(projectId, next);
  return next.finally(() => {
    if (projectPreparations.get(projectId) === next) projectPreparations.delete(projectId);
  });
}

export function ExploreWorkspace({ url, open, navigationId = 0, layout = "canvas", onClose, onOpenProject, onCreateProject, foreground, children }: {
  url: string | null;
  open: boolean;
  navigationId?: number;
  layout?: "home" | "canvas";
  onClose: () => void;
  onOpenProject?: (id: string) => void | Promise<unknown>;
  onCreateProject?: (ids?: string[]) => Promise<unknown>;
  foreground?: ReactNode;
  children: ReactNode;
}) {
  const home = layout === "home" && open;
  const [visitedHome, setVisitedHome] = useState(false);
  const [width, setWidth] = useState(() => readWidth(preference(CANVAS_WIDTH_KEY) ?? preference("bowerbird.explorer.panelWidth"), DEFAULT_EXPLORER_WIDTH, MIN_EXPLORER_WIDTH));
  const [middleWidth, setMiddleWidth] = useState(() => readWidth(preference(MIDDLE_WIDTH_KEY), DEFAULT_MIDDLE_WIDTH, MIN_MIDDLE_WIDTH, MAX_MIDDLE_WIDTH));
  const [middleOpen, setMiddleOpen] = useState(() => preference(MIDDLE_OPEN_KEY) !== "false");
  const [sidebarOpen, setSidebarOpen] = useState(() => preference(SIDEBAR_OPEN_KEY) !== "false");
  const [nativeDragging, setNativeDragging] = useState(false);
  const dockOpen = home && !middleOpen && !sidebarOpen && nativeDragging;
  const [resizing, setResizing] = useState(false);
  const [workspaceWidth, setWorkspaceWidth] = useState(1280);
  const [directoryWidth, setDirectoryWidth] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const focusHandle = useRef(false);
  const resizeStart = useRef<{ pointer: number; x: number; width: number } | null>(null);
  const maximumWidth = Math.max(MIN_EXPLORER_WIDTH, workspaceWidth - 280);
  const maximumMiddleWidth = Math.max(0, Math.min(MAX_MIDDLE_WIDTH, workspaceWidth - directoryWidth - MIN_EXPLORER_WIDTH));
  const minimumMiddleWidth = Math.min(MIN_MIDDLE_WIDTH, maximumMiddleWidth);
  const browserWidth = Math.min(width, maximumWidth);
  const displayedMiddleWidth = Math.min(middleWidth, maximumMiddleWidth);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setWorkspaceWidth(element.clientWidth);
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const directory = home && (sidebarOpen || dockOpen) ? root.current?.querySelector<HTMLElement>("[data-explore-directory]") : null;
    if (!directory) { setDirectoryWidth(0); return; }
    const measure = () => setDirectoryWidth(directory.getBoundingClientRect().width);
    const observer = new ResizeObserver(measure); observer.observe(directory); measure();
    return () => observer.disconnect();
  }, [home, sidebarOpen, dockOpen]);
  useEffect(() => { if (home) setVisitedHome(true); }, [home]);
  useEffect(() => {
    if (resizing) return;
    remember(CANVAS_WIDTH_KEY, width);
    remember(MIDDLE_WIDTH_KEY, middleWidth);
  }, [resizing, width, middleWidth]);
  useLayoutEffect(() => {
    if (!focusHandle.current) return;
    focusHandle.current = false;
    handle.current?.querySelector("button")?.focus({ preventScroll: true });
  }, [middleOpen]);
  function showMiddle(visible: boolean) {
    focusHandle.current = true;
    setMiddleOpen(visible);
    remember(MIDDLE_OPEN_KEY, visible);
  }
  function toggleSidebar() {
    setSidebarOpen(!sidebarOpen);
    remember(SIDEBAR_OPEN_KEY, !sidebarOpen);
  }
  const resize = (next: number) => {
    if (home) setMiddleWidth(Math.max(minimumMiddleWidth, Math.min(maximumMiddleWidth, next)));
    else setWidth(Math.max(MIN_EXPLORER_WIDTH, Math.min(maximumWidth, next)));
  };
  const finishResize = () => { resizeStart.current = null; setResizing(false); };
  const [feedback, setFeedback] = useState<CaptureFeedback | null>(null);
  const [classifications, setClassifications] = useState<ExplorerClassificationItem[]>([]);
  const [captureReceipts, setCaptureReceipts] = useState<ExploreCaptureReceipt[]>([]);
  const completionOrder = useRef(0);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const activeProjectId = useStore(s => s.activeProjectId);
  const projectRouteRevision = useStore(s => s.projectRouteRevision);
  const receiveThumbnail = useCallback((dragId: string, thumbnail: string) => {
    setClassifications(items => items.map(item => item.id.startsWith(`${dragId}:`) && /^https?:/.test(item.imageUrl)
      ? { ...item, imageUrl: thumbnail } : item));
  }, []);
  const { feedback: dropFeedback, show: showDropFeedback, clear: clearDropFeedback } = useCaptureDropFeedback("explorer");
  const endDrag = useCallback(() => { setNativeDragging(false); clearDropFeedback(); }, [clearDropFeedback]);
  const startDrag = useCallback(() => setNativeDragging(true), []);
  const dragMotion = useExplorerDragMotion(root, open, activeProjectId, receiveThumbnail, endDrag, startDrag);
  const clearFeedback = useCallback(() => setFeedback(null), []);
  const removeClassification = useCallback((id: string) => setClassifications(items => items.filter(item => item.id !== id)), []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { sequence.current += 1; setFeedback(null); setNativeDragging(false); }, [open, activeProjectId, layout]);
  useLayoutEffect(() => { setClassifications([]); }, [activeProjectId, projectRouteRevision]);
  useLayoutEffect(clearDropFeedback, [open, clearDropFeedback]);

  async function drop(event: DragEvent) {
    endDrag();
    if (getDragAssets()?.length) return;
    const image = parseExplorerImage(event.dataTransfer);
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
    const destination = resolveCaptureDropTarget(event.target, state);
    if (destination.disabled) {
      dragMotion.reject(image.dragId);
      if (image.dragId && !isVideo) void api.releaseSourceBrowserAnalysis(image.dragId).catch(() => {});
      notifyError(null, captureDropMessage(destination));
      return;
    }
    const operation = ++sequence.current;
    setFeedback(null);
    const point = { x: event.clientX, y: event.clientY };
    const contextProjectId = state.activeProjectId;
    const target = destination.projectId;
    const collectionId = destination.kind === "folder" ? destination.id : null;
    const tagId = destination.kind === "tag" ? destination.id : null;
    const completeLesson = beginOnboardingOperation("explore", target);
    const revision = state.projectRouteRevision;
    const droppedOnCanvas = destination.kind === "canvas";
    const placeOnCanvas = droppedOnCanvas ? prepareExplorerCanvasDrop(event.target, target, event.clientX, event.clientY) : null;
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
    // Reserve the original drag on queue acceptance. Legacy drops without a
    // private notice keep their current-page capture path.
    const authorize = image.dragId ? () => api.authorizeSourceBrowserCapture(image.imageUrl, image.pageUrl, dragId, image.mediaKind).catch(() => null) : undefined;
    const discard = () => { dragMotion.finish(dragId); if (!isVideo) void api.releaseSourceBrowserAnalysis(dragId).catch(() => {}); };
    try { enqueueExplorerCapture({ mediaKind: image.mediaKind, pageUrl: image.pageUrl, thumbnail: previewUrl, authorize }, async (attempt, admission) => {
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
      if (target && !capturedAsset) await prepareCaptureProject(target, async () => {
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
      });
      if (!capturedAsset) {
        const proof = (await admission) ?? undefined;
        attempt.beforeCapture();
        capturedAsset = await api.captureSourceBrowserImage(image.imageUrl, image.pageUrl, target, dragId, image.mediaKind, attempt.captureId, tagId ? true : undefined, proof);
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
      if (home && inTarget()) setCaptureReceipts(previous => {
        const target = { kind: destination.kind, id: destination.id };
        const latest = { assetId: asset.id, target, revision: (previous[0]?.revision ?? 0) + 1 };
        return [latest, ...previous.filter(item => item.target.kind !== target.kind || item.target.id !== target.id)].slice(0, 32);
      });
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
    }, discard);
    } catch (error) { discard(); notifyError(error, "采集任务未加入，请重试"); }
  }

  const preferredWidth = home ? displayedMiddleWidth : browserWidth;
  const minimum = home ? minimumMiddleWidth : MIN_EXPLORER_WIDTH;
  const maximum = home ? maximumMiddleWidth : maximumWidth;
  const dragDirection = home ? 1 : -1;
  const revealMiddle = home && !middleOpen;
  const browser = <aside id="explore-browser-panel" className="explore-browser" style={home ? undefined : { width: browserWidth }} hidden={!open} aria-label="探索面板">
      {url && <SourceBrowserPanel onCreateProject={onCreateProject} url={url} navigationId={navigationId} onClose={onClose} visible={open}
        suspended={resizing} closeOnEscape={layout === "canvas"}
        leadingControls={home && !sidebarOpen ? <button type="button" className="explore-open-directory" title="展开侧栏" aria-label="展开侧栏"
          onClick={toggleSidebar}><PanelLeftOpen size={15} aria-hidden="true" /></button> : undefined} />}
      <PanelEdgeHandle ref={handle} variant="overlay" side="left" className={`explore-panel-handle ${resizing ? "is-library-resizing" : ""}`}
        closeLabel={home ? (middleOpen ? "关闭素材流" : "展开素材流") : "收起浏览器"}
        revealLabel={revealMiddle ? "素材流" : undefined} onClose={home ? () => showMiddle(!middleOpen) : onClose} onEscape={home ? undefined : onClose}
        grip={revealMiddle ? undefined : {
        "aria-label": home ? "调整素材流宽度" : "调整浏览器宽度", "aria-controls": home ? "explore-material-stream" : "explore-browser-panel",
        "aria-valuemin": minimum, "aria-valuemax": maximum, "aria-valuenow": preferredWidth,
        title: "拖动调整宽度 · 左右方向键微调 · 双击恢复默认宽度",
        onKeyDown: event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          resize(event.key === "Home" ? minimum : event.key === "End" ? maximum : preferredWidth + (event.key === "ArrowLeft" ? -20 : 20) * dragDirection);
        },
        onPointerDown: event => {
          if (event.button !== 0 || resizeStart.current) return;
          event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
          resizeStart.current = { pointer: event.pointerId, x: event.clientX, width: preferredWidth };
          event.currentTarget.setPointerCapture(event.pointerId); setResizing(true);
        },
        onPointerMove: event => {
          const start = resizeStart.current;
          if (start?.pointer === event.pointerId) resize(start.width + (event.clientX - start.x) * dragDirection);
        },
        onPointerUp: event => {
          if (resizeStart.current?.pointer !== event.pointerId) return;
          finishResize(); event.currentTarget.releasePointerCapture(event.pointerId);
        },
        onPointerCancel: finishResize, onLostPointerCapture: finishResize,
        onDoubleClick: () => { if (home) setMiddleWidth(DEFAULT_MIDDLE_WIDTH); else setWidth(DEFAULT_EXPLORER_WIDTH); },
      }} />
    </aside>;
  const feedbackOnly = home && !middleOpen && !sidebarOpen && !dockOpen && (classifications.length > 0 || !!feedback || !!foreground);
  return <div ref={root} className={`explore-workspace ${open ? "is-open" : ""} ${home ? "is-home-explore" : ""}`}
    data-explore-resizing={resizing || undefined}
    data-explore-full={home && !middleOpen && !sidebarOpen && !dockOpen || undefined} aria-label="主工作区"
    style={{ "--explore-middle-width": `${displayedMiddleWidth}px` } as CSSProperties}>
    <section className="explore-main" aria-label="探索采集素材"
      data-explore-feedback-only={feedbackOnly || undefined}
      onDragOverCapture={event => {
        const state = useStore.getState();
        const types = event.dataTransfer.types;
        const text = event.dataTransfer.getData("text/plain");
        // Native fallback may expose only the text type until the actual drop.
        const accepts = types.includes(EXPLORER_MIME) || (types.includes("text/plain") && (!text || text.startsWith("bowerbird-explorer:")));
        if (getDragAssets()?.length || !accepts) { clearDropFeedback(); return; }
        event.preventDefault(); event.stopPropagation();
        if (state.projectRoutePending) { event.dataTransfer.dropEffect = "none"; clearDropFeedback(); return; }
        const destination = resolveCaptureDropTarget(event.target, state);
        event.dataTransfer.dropEffect = destination.disabled ? "none" : "copy";
        showDropFeedback(destination, event.target);
        dragMotion.over(event.clientX, event.clientY, destination.kind === "tag");
      }}
      onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) { clearDropFeedback(); dragMotion.leave(); } }}
      onDropCapture={event => void drop(event)}>
      {open && <div className="explore-learning-hint"><LearningHint topic="explore" /></div>}
      <div className="explore-workspace-content" hidden={home}>{children}</div>
      {(home || visitedHome) && <div className="explore-home-content" hidden={!home}><ExploreLibrary active={home}
        middleOpen={middleOpen} sidebarOpen={sidebarOpen} dockOpen={dockOpen} onCloseMiddle={() => showMiddle(false)}
        onToggleSidebar={toggleSidebar} onOpenProject={onOpenProject} onCreateProject={onCreateProject} captureReceipts={captureReceipts} /></div>}
      {foreground}
      <ExplorerClassificationDock items={classifications} onDone={removeClassification} />
      {open && feedback && feedback.projectId === activeProjectId && <ExplorerCaptureFeedback value={feedback} onDone={clearFeedback} />}
      {dropFeedback}
    </section>
    {browser}
  </div>;
}
