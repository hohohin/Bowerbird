import { notify, notifyError } from "../lib/notify";
import { arrangeCanvasNodes } from "../lib/canvasArrangement";
import { newReferencesForCanvasCard, placeNewCanvasReferences, trackNewCanvasReferences } from "../lib/canvasReferencePlacement";
import { isVideoPath } from "../lib/videoGeneration";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent,
  type ReactNode,
  type WheelEvent,
} from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  ArrowLeft,
  Archive,
  ArchiveRestore,
  Copy,
  Folder,
  Images,
  LayoutDashboard,
  List,
  LoaderCircle,
  Maximize2,
  Minus,
  Move,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Sparkles,
  Trash2,
  Ungroup,
  X,
} from "lucide-react";
import { MasonryGrid } from "./MasonryGrid";
import { GeneratedImageFilter } from "./GeneratedImageFilter";
import { Lightbox } from "./Lightbox";
import { CreativeComposer } from "./CreativeComposer";
import { GenerationPanel } from "./GenerationPanel";
import { CloudAgentSession } from "./CloudAgentPanel";
import { CreativeTimeline } from "./CreativeTimeline";
import { api } from "../lib/api";
import { countCloudAgentResultImages, selectCloudAgentResultArtifacts } from "../lib/cloudAgentResult";
import { getDragAssets } from "../lib/dragPayload";
import {
  supersededProjectTaskIds,
  isProjectNodeNavigable,
  projectGraphVisibility,
  projectTimelineProjection,
  resolveProjectFocusNode,
  resolveProjectFocusThread,
} from "../lib/projectActivity";
import { isCreativeComposerDraftMeaningful } from "../lib/creativeDraft";
import {
  isWorkspaceOperationCurrent,
  isWorkspaceSnapshotCurrent,
  shouldMountProjectComposer,
} from "../lib/workspaceRoute";
import {
  projectInspectorHeader,
  resolveProjectInspectorPlacement,
  shouldCloseProjectInspectorOnEscape,
  type ProjectInspectorHeader,
} from "../lib/projectInspector";
import { cloudAgentStatusLabel } from "../lib/cloudAgent";
import { cloudProviderLabel, isCloudProvider } from "../lib/genProviders";
import { expectedCreativeContinuation } from "../lib/creativeGeneration";
import {
  canvasNodeIdsInRect,
  canvasPrimaryMaterialAction,
  canvasViewForNewCard,
  canvasPlacementForNewCard,
  canvasRectFromPoints,
  canStartCanvasMarquee,
  clampCanvasZoom,
  exceedsCanvasDragThreshold,
  findCanvasHoverTarget,
  isCanvasPanGesture,
  mergeCanvasAssetsIntoTarget,
  mergeCanvasNodesIntoFolder,
  snapCanvasRect,
  translateCanvasSelection,
  type CanvasPoint,
  type CanvasSnapGuide,
} from "../lib/canvasLogic";
import { BOARD_ASSET_PICK_EVENT } from "./creation/useCreationEditor";
import {
  canvasSourceColumnCount,
  agentPromptGroupMap,
  CANVAS_REMOVE_NODES_EVENT,
  CANVAS_ARRANGE_NODES_EVENT,
  type CanvasArrangeNodesEventDetail,
  clampCanvasSourceThumbnailScale,
  createCanvasAssetSnapshot,
  DEFAULT_CANVAS_SOURCE_THUMBNAIL_SCALE,
  hydrateProjectCanvas,
  isCanvasAssetHydrationCurrent,
  newProjectCanvasAssetNode,
  newProjectCanvasGroup,
  projectGraphNodesWithLiveLayout,
  projectCanvasGroupUpdate,
  projectCanvasAssetIds,
  projectCanvasNodeLayoutUpdate,
  projectCanvasViewInput,
  persistedProjectActiveNodeId,
  rehydrateProjectCanvasAssets,
  type CanvasAssetSnapshot,
  type CanvasRemoveNodesEventDetail,
  type ProjectCanvasUiNode,
} from "../lib/creativeCanvas";
import {
  creativeLaunchTargetsProject,
  creativePromptLoadForProject,
  type CreativeLaunchRequest,
} from "../lib/creativeLaunch";
import { createOrderedWriteJournal, drainOrderedWriteJournal } from "../lib/orderedWriteJournal";
import { useStore } from "../store";
import { EXPLORER_CANVAS_DROP_EVENT, type ExplorerCanvasDropDetail } from "../lib/explorerCanvasDrop";
import type {
  Asset,
  CanvasGroup,
  CanvasEdge,
  CanvasNode as ProjectGraphNode,
  CreativeThread,
  Project,
  ProjectTitleSource,
  CreativeViewMode,
} from "../lib/types";

const ASSET_WIDTH = 190;
const FOLDER_WIDTH = 204;
const FOLDER_HEIGHT = 178;
const DEFAULT_TITLE = "未命名创作";
const CANVAS_SOURCE_THUMBNAIL_SCALE_KEY = "bowerbird.canvasSourceThumbnailScale";

function readCanvasSourceThumbnailScale(): number {
  try {
    const stored = Number(localStorage.getItem(CANVAS_SOURCE_THUMBNAIL_SCALE_KEY));
    return stored ? clampCanvasSourceThumbnailScale(stored) : DEFAULT_CANVAS_SOURCE_THUMBNAIL_SCALE;
  } catch {
    return DEFAULT_CANVAS_SOURCE_THUMBNAIL_SCALE;
  }
}

type CanvasNode = ProjectCanvasUiNode;
type CanvasAssetNode = Extract<CanvasNode, { kind: "asset" }>;
type CanvasFolderNode = Extract<CanvasNode, { kind: "folder" }>;
type CanvasSourceScope = "project" | "library";

interface CanvasMarquee {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface CanvasMarqueePress extends CanvasMarquee {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  active: boolean;
  additive: boolean;
  baseSelection: Set<string>;
}

interface ActiveCanvasState {
  id: string;
  title: string;
  titleSource: ProjectTitleSource;
  draftJson: string;
  materialized: boolean;
}

type HoverIntent =
  | { kind: "internal"; key: string; movingId: string; targetId: string }
  | { kind: "external"; key: string; targetId: string; assets: CanvasAssetSnapshot[] };

function canvasId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function provisionalCanvas(project: Project | null): ActiveCanvasState {
  return {
    id: project?.id ?? "",
    title: project?.name ?? DEFAULT_TITLE,
    titleSource: project?.title_source ?? "default",
    draftJson: JSON.stringify({ schema_version: 1 }),
    materialized: !!project && !project.provisional,
  };
}

function activeFromProject(
  project: Project,
  draftJson: string,
): ActiveCanvasState {
  return {
    id: project.id,
    title: project.name,
    titleSource: project.title_source ?? "default",
    draftJson,
    materialized: true,
  };
}

function assetNodeSize(asset: CanvasAssetSnapshot) {
  const ratio = asset.width && asset.height ? asset.height / asset.width : 0.78;
  const imageHeight = Math.min(242, Math.max(112, Math.round(ASSET_WIDTH * ratio)));
  return { width: ASSET_WIDTH, height: imageHeight + 30 };
}

function nodeRect(node: { x: number; y: number; width: number; height: number }) {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

function containedNodeIds(nodes: CanvasNode[]) {
  return new Set(nodes.flatMap((node) => node.kind === "asset"
    ? [node.asset.id]
    : node.assets.map((asset) => asset.id)));
}

function uniqueSnapshots(assets: CanvasAssetSnapshot[]) {
  const seen = new Set<string>();
  return assets.filter((asset) => {
    if (seen.has(asset.id)) return false;
    seen.add(asset.id);
    return true;
  });
}

function groupedAssetNode(asset: CanvasAssetSnapshot, group: CanvasFolderNode, index: number): CanvasAssetNode {
  const size = assetNodeSize(asset);
  return {
    kind: "asset",
    id: asset.id,
    asset,
    x: group.x + (index % 2) * 22,
    y: group.y + Math.floor(index / 2) * 22,
    width: size.width,
    height: size.height,
    order: group.order + index + 1,
  };
}

function promptNodeSummary(node: ProjectGraphNode) {
  try {
    const payload = JSON.parse(node.payloadJson) as {
      job_id?: string;
      turn_key?: string;
      text?: string;
      provider?: string;
      status?: string;
    };
    return {
      jobId: payload.job_id ?? "",
      turnKey: payload.turn_key ?? "",
      text: payload.text?.trim() || "生成指令",
      provider: payload.provider ?? "provider",
      status: payload.status ?? "saved",
    };
  } catch {
    return { jobId: "", turnKey: "", text: "生成指令", provider: "provider", status: "saved" };
  }
}

function agentGroupSummary(node: ProjectGraphNode) {
  try {
    const payload = JSON.parse(node.payloadJson) as {
      run_id?: string;
      skill_id?: string;
      status?: string;
      current_step?: string;
      progress?: number;
      approvals?: Array<{ status?: string }>;
      clarifications?: Array<{ status?: string }>;
      artifacts?: Array<{ role?: string; mime?: string; user_visible?: boolean }>;
    };
    return {
      runId: payload.run_id ?? "",
      skill: payload.skill_id ?? "Bowerbird Agent",
      status: payload.status ?? "created",
      currentStep: payload.current_step ?? null,
      progress: payload.progress ?? null,
      pendingApprovals: payload.approvals?.filter((item) => item.status === "pending").length ?? 0,
      pendingClarifications: payload.clarifications?.filter((item) => item.status === "pending").length ?? 0,
      artifactCount: countCloudAgentResultImages(payload.artifacts ?? []),
    };
  } catch {
    return {
      runId: "",
      skill: "Bowerbird Agent",
      status: "unknown",
      currentStep: null,
      progress: null,
      pendingApprovals: 0,
      pendingClarifications: 0,
      artifactCount: 0,
    };
  }
}

function FolderPreview({
  node,
  onAssetContextMenu,
}: {
  node: CanvasFolderNode;
  onAssetContextMenu: (event: React.MouseEvent<HTMLElement>, asset: CanvasAssetSnapshot) => void;
}) {
  return (
    <div className="canvas-folder-grid" aria-hidden="true">
      {node.assets.slice(0, 4).map((asset) => {
        const path = asset.thumbPath ?? asset.storePath;
        return path && isVideoPath(path) ? <video key={asset.id} src={convertFileSrc(path)} preload="metadata" muted playsInline /> : path ? (
          <img
            key={asset.id}
            src={convertFileSrc(path)}
            alt=""
            draggable={false}
            onContextMenu={(event) => onAssetContextMenu(event, asset)}
          />
        ) : (
          <span key={asset.id} onContextMenu={(event) => onAssetContextMenu(event, asset)}>
            {asset.name.slice(0, 1)}
          </span>
        );
      })}
      {node.assets.length > 4 && <b>+{node.assets.length - 4}</b>}
    </div>
  );
}

function ProjectInspectorShell({
  header,
  anchorNodeId,
  restoreFocusTarget,
  editing = false,
  onClose,
  children,
}: {
  header: ProjectInspectorHeader;
  anchorNodeId?: string | null;
  restoreFocusTarget?: () => HTMLElement | null;
  editing?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const shellRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closedByOutsideClickRef = useRef(false);
  const restoreFocusTargetRef = useRef(restoreFocusTarget);
  restoreFocusTargetRef.current = restoreFocusTarget;

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    shellRef.current?.focus({ preventScroll: true });
    return () => {
      if (closedByOutsideClickRef.current) return;
      const previous = previousFocusRef.current;
      const target = previous?.isConnected ? previous : restoreFocusTargetRef.current?.();
      if (target?.isConnected) window.requestAnimationFrame(() => target.focus({ preventScroll: true }));
    };
  }, []);

  useEffect(() => {
    closedByOutsideClickRef.current = false;
    if (editing) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      if (shellRef.current?.contains(event.target)) return;
      // 面板内打开的预览、弹窗和菜单可能通过 portal 挂在 body 下。
      if (event.target.closest('[role="dialog"], [role="menu"], [role="listbox"], .task-center-entry')) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      closedByOutsideClickRef.current = true;
      onClose();
    }
    // 使用 click 而非 pointerdown，避免收起后布局变化影响本次点击目标。
    document.addEventListener("click", closeOnOutsideClick, true);
    return () => document.removeEventListener("click", closeOnOutsideClick, true);
  }, [editing, onClose, anchorNodeId]);

  return (
    <section
      ref={shellRef}
      tabIndex={-1}
      role="complementary"
      aria-label={`${header.title} · 项目详情`}
      data-project-inspector={header.kind}
      data-anchor-node-id={anchorNodeId ?? undefined}
      className={`project-inspector-shell${editing ? " is-editing" : ""}`}
    >
      <div className={`shrink-0 ${editing ? "gen-view-out pointer-events-none" : "gen-view-in"}`}>
        <div className={`${editing ? "" : "pointer-events-auto"} project-inspector-header`}>
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
            {header.kind === "generation" ? <Images size={14} /> : <Sparkles size={14} />}
          </span>
          <strong className="min-w-0 flex-1 truncate text-xs font-semibold" title={header.title}>
            {header.title}
          </strong>
          <span className="max-w-[48%] shrink truncate rounded-full border border-edge px-2 py-0.5 text-[11px] text-muted" title={header.detail}>
            {header.detail}
          </span>
          {header.running && (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-accent">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              {header.kind === "generation" ? "生成中" : "运行中"}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="app-icon-button ml-auto"
            title="关闭详情（进行中的任务不会中断）"
            aria-label={header.closeLabel}
          >
            <X size={16} />
          </button>
        </div>
        <div className="hatch-divider" aria-hidden="true"><span /></div>
      </div>
      {children}
    </section>
  );
}

export function CanvasWorkspace({
  projectId,
  exploring = false,
  focusThreadId = null,
  focusNodeId = null,
  focusRequestId = null,
  onFocusConsumed,
  launchRequest = null,
  onLaunchConsumed,
  onExit,
}: {
  projectId: string | null;
  exploring?: boolean;
  focusThreadId?: string | null;
  focusNodeId?: string | null;
  focusRequestId?: string | null;
  onFocusConsumed?: (requestId: string) => void;
  launchRequest?: CreativeLaunchRequest | null;
  onLaunchConsumed?: (requestId: string) => void;
  onExit?: () => void;
}) {
  const assets = useStore((state) => state.assets);
  const smartFilter = useStore((state) => state.smartFilter);
  const assetTotal = useStore((state) => state.total);
  const promptedAssets = useStore((state) => state.promptedAssets);
  const folders = useStore((state) => state.folders);
  const projects = useStore((state) => state.projects);
  const reloadProjects = useStore((state) => state.reloadProjects);
  const openContextMenu = useStore((state) => state.openContextMenu);
  const genPanelOpen = useStore((state) => state.genPanelOpen);
  const boardOpen = useStore((state) => state.boardOpen);
  const activeSessionKind = useStore((state) => state.activeSessionKind);
  const genJobs = useStore((state) => state.genJobs);
  const activeJobId = useStore((state) => state.activeJobId);
  const openGenerationJob = useStore((state) => state.openGenerationJob);
  const genEditing = useStore((state) => state.genEditing);
  const setGenPanelOpen = useStore((state) => state.setGenPanelOpen);
  const cloudEntitlement = useStore((state) => state.cloudEntitlement);
  const cloudAgentRuns = useStore((state) => state.cloudAgentRuns);
  const activeCloudAgentRunId = useStore((state) => state.activeCloudAgentRunId);
  const openCloudAgentRun = useStore((state) => state.openCloudAgentRun);
  const creativeNavigation = useStore((state) => state.creativeNavigation);
  const projectRoutePending = useStore((state) => state.projectRoutePending);
  const projectRouteRevision = useStore((state) => state.projectRouteRevision);
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const focusedThreadId = useStore((state) => state.focusedThreadId);
  const setFocusedThreadId = useStore((state) => state.setFocusedThreadId);
  const timelineScope = useStore((state) => state.projectTimelineScope);
  const setProjectTimelineScope = useStore((state) => state.setProjectTimelineScope);
  const [activeCanvas, setActiveCanvasState] = useState<ActiveCanvasState>(() => provisionalCanvas(project));
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [graphNodes, setGraphNodes] = useState<ProjectGraphNode[]>([]);
  const [graphEdges, setGraphEdges] = useState<CanvasEdge[]>([]);
  const [threads, setThreads] = useState<CreativeThread[]>([]);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(focusNodeId);
  const focusedNodeIdRef = useRef(focusedNodeId);
  const pendingNewCardRef = useRef<string | null>(null);
  const pendingNewReferencesRef = useRef(new Map<string, ProjectGraphNode>());
  focusedNodeIdRef.current = focusedNodeId;
  const appliedFocusRequestRef = useRef<string | null>(null);
  const [pan, setPan] = useState<CanvasPoint>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [viewMode, setViewMode] = useState<CreativeViewMode>("canvas");
  const [composerSeedIds, setComposerSeedIds] = useState<string[]>([]);
  const [sourceWidth, setSourceWidth] = useState(360);
  const [sourceCollapsed, setSourceCollapsed] = useState(exploring);
  const sourcePanelId = useId();
  const [sourceThumbnailScale, setSourceThumbnailScale] = useState(readCanvasSourceThumbnailScale);
  const [sourceScope, setSourceScope] = useState<CanvasSourceScope>(() => project?.provisional ? "library" : "project");
  const [librarySourceAssets, setLibrarySourceAssets] = useState<Asset[]>([]);
  const [canvasAssets, setCanvasAssets] = useState<Asset[]>([]);
  const [librarySourceTotal, setLibrarySourceTotal] = useState(0);
  const [librarySourceLoading, setLibrarySourceLoading] = useState(false);
  // 中央素材 tab 的文件夹筛选（null = 全部）。
  const [librarySourceFolderId, setLibrarySourceFolderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [guides, setGuides] = useState<CanvasSnapGuide[]>([]);
  const [hoverIntent, setHoverIntent] = useState<HoverIntent | null>(null);
  const [folderDropTargetId, setFolderDropTargetId] = useState<string | null>(null);
  const [sourceResizing, setSourceResizing] = useState(false);
  const [externalDragOver, setExternalDragOver] = useState(false);
  const [spacePanReady, setSpacePanReady] = useState(false);
  const [panning, setPanning] = useState(false);
  const [canvasMarquee, setCanvasMarquee] = useState<CanvasMarquee | null>(null);
  const [selectedCanvasNodeIds, setSelectedCanvasNodeIds] = useState<Set<string>>(() => new Set());
  const [canvasLightbox, setCanvasLightbox] = useState<{ images: string[]; index: number } | null>(null);
  const [promptMenu, setPromptMenu] = useState<{ node: ProjectGraphNode | null; nodeIds: string[]; x: number; y: number } | null>(null);
  const promptMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setPromptMenu(null); }, [projectId, viewMode]);
  useEffect(() => {
    if (!promptMenu) return;
    function closeOutside(event: globalThis.PointerEvent) {
      if (!promptMenuRef.current?.contains(event.target as Node)) setPromptMenu(null);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setPromptMenu(null);
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const buttons = Array.from(promptMenuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
    const frame = requestAnimationFrame(() => promptMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
    window.addEventListener("pointerdown", closeOutside, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", closeOutside, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [promptMenu]);
  const [viewRevision, setViewRevision] = useState(0);
  const activeGenerationJob = activeJobId ? genJobs[activeJobId] ?? null : null;
  const activeAgentRun = activeCloudAgentRunId ? cloudAgentRuns[activeCloudAgentRunId] ?? null : null;
  const activeInspectorExecution = activeSessionKind === "generation"
    ? activeGenerationJob
    : activeAgentRun;
  const scopedInspectorOpen = resolveProjectInspectorPlacement({
    open: genPanelOpen,
    loading,
    navigationPending: creativeNavigation != null || projectRoutePending,
    activeProjectId: activeCanvas.id,
    execution: activeInspectorExecution,
  }) === "project";
  const promptLoadRequest = useMemo(
    () => creativePromptLoadForProject(launchRequest, activeCanvas.id || projectId),
    [launchRequest, activeCanvas.id, projectId],
  );
  const workspaceRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef(nodes);
  const graphNodesRef = useRef(graphNodes);
  const focusedThreadIdRef = useRef(focusedThreadId);
  const timelineScopeRef = useRef(timelineScope);
  const panRef = useRef(pan);
  const zoomRef = useRef(zoom);
  const viewModeRef = useRef(viewMode);
  const sourceWidthRef = useRef(sourceWidth);
  const activeCanvasRef = useRef(activeCanvas);
  const groupsRef = useRef(new Map<string, CanvasGroup>());
  const removalHistoryRef = useRef<Array<{ projectId: string; materials: CanvasNode[]; graph: ProjectGraphNode[]; groups: Map<string, CanvasGroup> }>>([]);
  const titleBaselineRef = useRef(activeCanvas.title);
  const sourceWidthWasStored = useRef(false);
  const viewDirtyRef = useRef(false);
  const viewRevisionRef = useRef(0);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const writeJournalRef = useRef(createOrderedWriteJournal());
  const pendingWritesRef = useRef(0);
  const composerDraftFlushRef = useRef<(() => void) | null>(null);
  const loadTokenRef = useRef(0);
  const loadingRef = useRef(loading);
  const initialSnapshotRestoredRef = useRef(false);
  const assetHydrationEpochRef = useRef(0);
  const processedLaunchRef = useRef<string | null>(null);
  const externalInstancesRef = useRef<{ signature: string; assets: CanvasAssetSnapshot[] } | null>(null);
  const spacePressedRef = useRef(false);
  const suppressNodeClickRef = useRef(false);
  const nodeDragRef = useRef<{
    nodeId: string;
    toggleSelection: boolean;
    selectedIds: Set<string>;
    initialNodes: CanvasNode[];
    initialGraphNodes: ProjectGraphNode[];
    pointerId: number;
    offsetX: number;
    offsetY: number;
    startClientX: number;
    startClientY: number;
    moved: boolean;
  } | null>(null);
  const graphNodeDragRef = useRef<{
    nodeId: string;
    toggleSelection: boolean;
    initialNodes: ProjectGraphNode[];
    initialMaterialNodes: CanvasNode[];
    selectedIds: Set<string>;
    pointerId: number;
    offsetX: number;
    offsetY: number;
    startClientX: number;
    startClientY: number;
    moved: boolean;
  } | null>(null);
  const panDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
    moved: boolean;
  } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; width: number; moved: boolean } | null>(null);
  const marqueePressRef = useRef<CanvasMarqueePress | null>(null);
  const selectedCanvasNodeIdsRef = useRef(selectedCanvasNodeIds);

  nodesRef.current = nodes;
  graphNodesRef.current = graphNodes;
  focusedThreadIdRef.current = focusedThreadId;
  timelineScopeRef.current = timelineScope;
  panRef.current = pan;
  zoomRef.current = zoom;
  viewModeRef.current = viewMode;
  sourceWidthRef.current = sourceWidth;
  activeCanvasRef.current = activeCanvas;
  loadingRef.current = loading;
  selectedCanvasNodeIdsRef.current = selectedCanvasNodeIds;

  useEffect(() => {
    setSelectedCanvasNodeIds(new Set());
    setCanvasLightbox(null);
    removalHistoryRef.current = [];
    setCanvasMarquee(null);
    marqueePressRef.current = null;
  }, [projectId]);

  useEffect(() => {
    function removeRequestedNodes(event: Event) {
      const detail = (event as CustomEvent<CanvasRemoveNodesEventDetail>).detail;
      if (!detail || detail.projectId !== activeCanvasRef.current.id) return;
      removeNodes(detail.nodeIds);
    }
    window.addEventListener(CANVAS_REMOVE_NODES_EVENT, removeRequestedNodes);
    return () => window.removeEventListener(CANVAS_REMOVE_NODES_EVENT, removeRequestedNodes);
  }, []);

  useEffect(() => {
    const liveIds = new Set(selectionAnchors().map((node) => node.id));
    setSelectedCanvasNodeIds((current) => {
      const next = new Set([...current].filter((id) => liveIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [nodes, graphNodes, threads]);

  useEffect(() => {
    function arrangeRequestedNodes(event: Event) {
      const detail = (event as CustomEvent<CanvasArrangeNodesEventDetail>).detail;
      if (!detail || detail.projectId !== activeCanvasRef.current.id || loadingRef.current) return;
      arrangeNodes(detail.nodeIds);
    }
    window.addEventListener(CANVAS_ARRANGE_NODES_EVENT, arrangeRequestedNodes);
    return () => window.removeEventListener(CANVAS_ARRANGE_NODES_EVENT, arrangeRequestedNodes);
  }, [graphEdges, threads]);

  const assetById = useMemo(() => {
    const map = new Map<string, Asset>();
    for (const asset of promptedAssets) map.set(asset.id, asset);
    for (const asset of assets) map.set(asset.id, asset);
    for (const asset of librarySourceAssets) map.set(asset.id, asset);
    for (const asset of canvasAssets) map.set(asset.id, asset);
    return map;
  }, [assets, canvasAssets, librarySourceAssets, promptedAssets]);
  const assetByIdRef = useRef(assetById);
  assetByIdRef.current = assetById;

  useEffect(() => {
    const hydrated = rehydrateProjectCanvasAssets(nodesRef.current, assetById);
    if (hydrated !== nodesRef.current) commitNodes(hydrated);
  }, [assetById]);

  const sourceAssets = useMemo(() => {
    const scopedAssets = sourceScope === "library" ? librarySourceAssets : assets;
    if (smartFilter !== "source:generated" && smartFilter !== "source:!generated") return scopedAssets;
    return scopedAssets.filter((asset) => (asset.generation_session_id != null) === (smartFilter === "source:generated"));
  }, [sourceScope, librarySourceAssets, assets, smartFilter]);
  const sourceTotal = sourceScope === "library" ? librarySourceTotal : assetTotal;
  // 素材库 tab 顶部文件夹区域：仅普通文件夹（约定 12：collection/smart 不承载 folder_id 位置）。
  const libraryFolders = useMemo(
    () => folders.filter((folder) => folder.id !== "root" && (folder.kind ?? "folder") === "folder"),
    [folders],
  );

  function reportError(reason: unknown) {
    setError(reason instanceof Error ? reason.message : String(reason));
  }

  function commitNodes(next: CanvasNode[]) {
    nodesRef.current = next;
    setNodes(next);
  }

  function replaceActive(next: ActiveCanvasState) {
    activeCanvasRef.current = next;
    setActiveCanvasState({ ...next });
  }

  function markViewDirty() {
    viewDirtyRef.current = true;
    viewRevisionRef.current += 1;
    setViewRevision(viewRevisionRef.current);
  }

  function lockWorkspaceInteraction() {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const focused = document.activeElement;
    workspace.inert = true;
    if (focused instanceof HTMLElement && workspace.contains(focused)) focused.blur();
  }

  function scheduleWriteDrain(retryBlocked: boolean) {
    pendingWritesRef.current += 1;
    setSaving(true);
    const run = writeQueueRef.current
      .then(async () => {
        const failure = await drainOrderedWriteJournal(writeJournalRef.current, retryBlocked);
        if (failure != null) reportError(failure);
      })
      .finally(() => {
        pendingWritesRef.current -= 1;
        if (pendingWritesRef.current === 0) setSaving(false);
      });
    writeQueueRef.current = run;
    return run;
  }

  function enqueueWrite(work: () => Promise<void>) {
    writeJournalRef.current.pending.push(work);
    return scheduleWriteDrain(false);
  }

  async function retryPendingWrites() {
    if (writeJournalRef.current.pending.length === 0) return;
    await scheduleWriteDrain(true);
    if (writeJournalRef.current.failure != null) throw writeJournalRef.current.failure;
    setError(null);
  }

  async function flushCanvasWrites(includeView: boolean) {
    // Pull the editor's latest in-memory ProseMirror document through the
    // persistence callback before waiting on the queue.
    composerDraftFlushRef.current?.();
    await writeQueueRef.current;
    await retryPendingWrites();
    if (includeView) {
      await queueViewPersistence(true);
      await writeQueueRef.current;
      await retryPendingWrites();
    }
  }

  async function ensureMaterialized(
    draft: ActiveCanvasState,
    initialNodes: ReturnType<typeof newProjectCanvasAssetNode>[] = [],
    initialView: ReturnType<typeof projectCanvasViewInput> | null = null,
    initialThreads: Array<{
      id: string;
      projectId: string;
      title: string;
      origin: "direct";
    }> = [],
  ) {
    if (draft.materialized) return false;
    const materializeRouteRevision = useStore.getState().projectRouteRevision;
    const selectedProject = useStore.getState().projects.find((candidate) => candidate.id === draft.id);
    if (!selectedProject) throw new Error("当前项目不存在");
    await api.projectCanvasMaterialize({
      projectId: draft.id,
      name: draft.title.trim() || DEFAULT_TITLE,
      workspacePath: selectedProject.workspace_path || `blank:${draft.id}`,
      workspaceKey: `blank:${draft.id}`,
      kind: selectedProject.kind || "blank",
      titleSource: draft.titleSource,
      draftJson: draft.draftJson,
    }, initialThreads, initialNodes, initialView);
    const route = useStore.getState();
    if (isWorkspaceOperationCurrent(
      draft.id,
      route.activeProjectId,
      route.projectRoutePending,
      materializeRouteRevision,
      route.projectRouteRevision,
    )) {
      await api.setActiveProject(draft.id);
    }
    draft.materialized = true;
    useStore.setState((state) => ({
      projects: state.projects.map((project) => project.id === draft.id
        ? { ...project, provisional: false }
        : project),
    }));
    if (activeCanvasRef.current.id === draft.id && !useStore.getState().projectRoutePending) {
      replaceActive(draft);
    }
    await reloadProjects();
    return true;
  }

  async function persistNewAssetNodesNow(draft: ActiveCanvasState, assetNodes: CanvasAssetNode[]) {
    if (assetNodes.length === 0) {
      await ensureMaterialized(draft);
      return;
    }
    const inputs = assetNodes.map((node) => newProjectCanvasAssetNode(draft.id, node));
    const materializedNow = await ensureMaterialized(draft, inputs);
    if (!materializedNow) {
      for (const input of inputs) await api.projectCanvasNodeCreate(input);
    }
  }

  function persistAddedNodes(assetNodes: CanvasAssetNode[]) {
    const draft = activeCanvasRef.current;
    void enqueueWrite(async () => persistNewAssetNodesNow(draft, assetNodes));
  }

  function persistCreatedGroup(
    group: CanvasFolderNode,
    newMembers: CanvasAssetNode[] = [],
    finalMovingNode?: CanvasAssetNode,
  ) {
    const draft = activeCanvasRef.current;
    void enqueueWrite(async () => {
      await persistNewAssetNodesNow(draft, newMembers);
      if (finalMovingNode) {
        await api.projectCanvasNodeUpdate(finalMovingNode.id, projectCanvasNodeLayoutUpdate(finalMovingNode));
      }
      const persisted = await api.projectCanvasGroupCreate(
        newProjectCanvasGroup(draft.id, group),
        group.assets.map((asset) => asset.id),
      );
      groupsRef.current.set(persisted.id, persisted);
    });
  }

  function persistGroupMembership(
    group: CanvasFolderNode,
    newMembers: CanvasAssetNode[] = [],
    finalMovingNode?: CanvasAssetNode,
  ) {
    const draft = activeCanvasRef.current;
    void enqueueWrite(async () => {
      await persistNewAssetNodesNow(draft, newMembers);
      if (finalMovingNode) {
        await api.projectCanvasNodeUpdate(finalMovingNode.id, projectCanvasNodeLayoutUpdate(finalMovingNode));
      }
      await api.projectCanvasGroupSetItems(group.id, group.assets.map((asset) => asset.id));
    });
  }

  function persistGeometries(movedNodes: readonly CanvasNode[]) {
    if (movedNodes.length === 0) return;
    const draft = activeCanvasRef.current;
    void enqueueWrite(async () => {
      await ensureMaterialized(draft);
      for (const node of movedNodes) {
        if (node.kind === "asset") {
          await api.projectCanvasNodeUpdate(node.id, projectCanvasNodeLayoutUpdate(node));
          continue;
        }
        const persisted = groupsRef.current.get(node.id);
        if (!persisted) continue;
        const updated = projectCanvasGroupUpdate(persisted, node);
        await api.projectCanvasGroupUpdate(updated);
        groupsRef.current.set(node.id, updated);
      }
    });
  }

  function queueViewPersistence(flush: boolean) {
    if (!viewDirtyRef.current) return writeQueueRef.current;
    const draft = activeCanvasRef.current;
    if (!draft.materialized) {
      viewDirtyRef.current = false;
      return writeQueueRef.current;
    }
    const revision = viewRevisionRef.current;
    const input = projectCanvasViewInput(
      draft.id,
      panRef.current,
      zoomRef.current,
      sourceWidthRef.current,
      workspaceRef.current?.getBoundingClientRect().width,
      viewModeRef.current,
      focusedThreadIdRef.current,
      timelineScopeRef.current,
      persistedProjectActiveNodeId(focusedNodeIdRef.current, graphNodesRef.current),
    );
    return enqueueWrite(async () => {
      if (flush) await api.projectCanvasViewFlush(input);
      else await api.projectCanvasViewUpsert(input);
      if (activeCanvasRef.current.id === draft.id && viewRevisionRef.current === revision) {
        viewDirtyRef.current = false;
      }
    });
  }

  function applySnapshot(
    snapshot: Awaited<ReturnType<typeof api.projectCanvasGet>>,
    options: { restoreView: boolean },
    exactAssets: Asset[],
    expectedRouteRevision: number,
  ) {
    const route = useStore.getState();
    if (
      activeCanvasRef.current.id !== snapshot.canvas.projectId
      || !isWorkspaceSnapshotCurrent(
        snapshot.canvas.projectId,
        route.activeProjectId,
        expectedRouteRevision,
        route.projectRouteRevision,
      )
    ) return false;
    assetHydrationEpochRef.current += 1;
    const archivedThreadIds = new Set(
      snapshot.threads.filter((thread) => thread.archivedAt != null).map((thread) => thread.id),
    );
    const exactAssetById = new Map(assetByIdRef.current);
    for (const asset of exactAssets) exactAssetById.set(asset.id, asset);
    const hydrated = hydrateProjectCanvas(
      {
        ...snapshot,
        nodes: snapshot.nodes.filter((node) => !node.threadId || !archivedThreadIds.has(node.threadId)),
      },
      exactAssetById,
    );
    const currentProject = useStore.getState().projects.find((candidate) => candidate.id === snapshot.canvas.projectId);
    if (!currentProject) throw new Error("项目已不存在");
    // A background execution refresh owns graph projection only. The live title
    // and composer draft are user-owned local state and may be newer than the
    // snapshot that was in flight.
    if (options.restoreView) {
      replaceActive(activeFromProject(currentProject, snapshot.canvas.draftJson));
    }
    groupsRef.current = new Map(snapshot.groups.map((group) => [group.id, group]));
    if (options.restoreView) {
      pendingNewCardRef.current = null;
      pendingNewReferencesRef.current.clear();
    } else {
      pendingNewReferencesRef.current = trackNewCanvasReferences(
        pendingNewReferencesRef.current, graphNodesRef.current, snapshot.nodes,
        new Set(snapshot.groupItems.map((item) => item.nodeId)),
      );
      const previousIds = new Set(graphNodesRef.current.map((node) => node.id));
      const agentPrompts = agentPromptGroupMap(snapshot.nodes, snapshot.edges);
      const newCards = snapshot.nodes.filter((node) => !previousIds.has(node.id)
        && (node.kind === "prompt" || node.kind === "agent_group")
        && !agentPrompts.has(node.id) && node.hiddenAt == null
        && (!node.threadId || !archivedThreadIds.has(node.threadId)));
      const newest = newCards.sort((a, b) => b.createdAt - a.createdAt)[0];
      if (newest) pendingNewCardRef.current = newest.id;
    }
    setCanvasAssets(exactAssets);
    commitNodes(hydrated.nodes);
    graphNodesRef.current = snapshot.nodes;
    setGraphNodes(snapshot.nodes);
    setGraphEdges(snapshot.edges);
    setThreads(snapshot.threads);
    if (options.restoreView) {
      panRef.current = hydrated.pan;
      zoomRef.current = hydrated.zoom;
      sourceWidthRef.current = hydrated.sourceWidth ?? 360;
      setPan(hydrated.pan);
      setZoom(hydrated.zoom);
      viewModeRef.current = hydrated.viewMode;
      setViewMode(hydrated.viewMode);
      setSourceWidth(hydrated.sourceWidth ?? 360);
      sourceWidthWasStored.current = hydrated.sourceWidth != null;
      setFocusedThreadId(snapshot.view?.focusedThreadId ?? null);
      setProjectTimelineScope(snapshot.view?.timelineScope ?? "focused");
      const activeNodeId = snapshot.view?.activeNodeId ?? null;
      setFocusedNodeId(activeNodeId && snapshot.nodes.some((node) => (
        node.id === activeNodeId && isProjectNodeNavigable(node, archivedThreadIds)
      )) ? activeNodeId : null);
      setComposerSeedIds([]);
      viewDirtyRef.current = false;
    }
    if (options.restoreView) titleBaselineRef.current = currentProject.name;
    setError(null);
    return true;
  }

  function activateProvisional() {
    pendingNewCardRef.current = null;
    pendingNewReferencesRef.current.clear();
    const draft = provisionalCanvas(project);
    replaceActive(draft);
    groupsRef.current.clear();
    commitNodes([]);
    graphNodesRef.current = [];
    setGraphNodes([]);
    setGraphEdges([]);
    setThreads([]);
    assetHydrationEpochRef.current += 1;
    setCanvasAssets([]);
    panRef.current = { x: 0, y: 0 };
    zoomRef.current = 1;
    sourceWidthRef.current = 360;
    setPan({ x: 0, y: 0 });
    setZoom(1);
    viewModeRef.current = "canvas";
    setViewMode("canvas");
    setSourceWidth(360);
    sourceWidthWasStored.current = false;
    titleBaselineRef.current = draft.title;
    setComposerSeedIds([]);
    viewDirtyRef.current = false;
    setError(null);
    initialSnapshotRestoredRef.current = true;
  }

  function seedInitialAssets(assetIds: string[]) {
    const snapshots = assetIds.flatMap((assetId) => {
      const asset = assetById.get(assetId);
      return asset ? [createCanvasAssetSnapshot(asset, canvasId("asset"))] : [];
    });
    const created = snapshots.map((asset, index): CanvasAssetNode => {
      const size = assetNodeSize(asset);
      return {
        kind: "asset",
        id: asset.id,
        asset,
        x: 56 + (index % 3) * (ASSET_WIDTH + 28),
        y: 88 + Math.floor(index / 3) * 210,
        width: size.width,
        height: size.height,
        order: index + 1,
      };
    });
    setComposerSeedIds(assetIds.filter((assetId) => assetById.has(assetId)));
    if (created.length === 0) return;
    commitNodes(created);
    persistAddedNodes(created);
  }

  function persistComposerDraft(draftJson: string) {
    const draft = activeCanvasRef.current;
    draft.draftJson = draftJson;
    if (!draft.materialized && !isCreativeComposerDraftMeaningful(draftJson)) return;
    void enqueueWrite(async () => {
      const materializedNow = await ensureMaterialized(draft);
      if (!materializedNow) await api.projectCanvasUpdateDraft(draft.id, draftJson);
    });
  }

  async function prepareForGeneration() {
    const draft = activeCanvasRef.current;
    await flushCanvasWrites(false);
    await enqueueWrite(async () => {
      await ensureMaterialized(draft);
    });
    await retryPendingWrites();
  }

  async function resolveCreativeThread(
    parentAssetId: string | null,
    prompt: string,
    routeRevision = useStore.getState().projectRouteRevision,
    expectedContinuationRequestId: string | null = null,
    requestedParentNodeId: string | null = null,
  ) {
    const projectId = activeCanvasRef.current.id;
    const assertCurrentWorkspace = () => {
      const state = useStore.getState();
      if (!isWorkspaceOperationCurrent(
        projectId,
        state.activeProjectId,
        state.projectRoutePending,
        routeRevision,
        state.projectRouteRevision,
      )) {
        throw new Error("项目已切换，本次发送已停止");
      }
    };
    assertCurrentWorkspace();
    const eligibleParent = (node: ProjectGraphNode) => (
      node.projectId === projectId
      && node.assetId === parentAssetId
      && node.hiddenAt == null
      && ["output", "intermediate", "final"].includes(node.role ?? "")
      && !!node.threadId
    );
    const pendingContinuation = expectedCreativeContinuation(
      useStore.getState().pendingCreativeContinuation,
      expectedContinuationRequestId,
      projectId,
    );
    const continuationRequestId = pendingContinuation?.requestId ?? null;
    const activate = (threadId: string, parentNodeId: string | null) => {
      assertCurrentWorkspace();
      setFocusedThreadId(threadId);
      setProjectTimelineScope("focused");
      useStore.getState().clearProjectThreadUnread(projectId, threadId);
      markViewDirty();
      return { threadId, parentNodeId, continuationRequestId };
    };
    if (
      parentAssetId
      && pendingContinuation
      && pendingContinuation.projectId === projectId
      && pendingContinuation.parentAssetId === parentAssetId
    ) {
      if (pendingContinuation.parentNodeId) {
        const local = graphNodes.find((node) => node.id === pendingContinuation.parentNodeId);
        if (local && (!eligibleParent(local) || local.threadId !== pendingContinuation.threadId)) {
          throw new Error("续作节点与当前项目、线程或父素材不一致");
        }
        if (!local) {
          await api.projectCanvasForNode(
            projectId,
            pendingContinuation.threadId,
            pendingContinuation.parentNodeId,
          );
          assertCurrentWorkspace();
        }
        return activate(pendingContinuation.threadId, pendingContinuation.parentNodeId);
      }
      const pendingMatches = graphNodes.filter((node) => (
        eligibleParent(node) && node.threadId === pendingContinuation.threadId
      ));
      if (pendingMatches.length > 1) {
        throw new Error("同一素材在线程中出现多次，请先在画板上选择具体结果节点");
      }
      return activate(pendingContinuation.threadId, pendingMatches[0]?.id ?? null);
    }

    if (requestedParentNodeId) {
      const exactParent = graphNodes.find((node) => node.id === requestedParentNodeId);
      if (!exactParent || !eligibleParent(exactParent) || !exactParent.threadId) {
        throw new Error("所选父结果已不可用，请在画板上重新选择");
      }
      return activate(exactParent.threadId, exactParent.id);
    }

    const parentCandidates = parentAssetId ? graphNodes.filter(eligibleParent) : [];
    const focusedParent = parentCandidates.find((node) => node.id === focusedNodeId);
    const focusedThreadParents = focusedThreadId
      ? parentCandidates.filter((node) => node.threadId === focusedThreadId)
      : [];
    const parentNode = focusedParent
      ?? (focusedThreadParents.length === 1 ? focusedThreadParents[0] : null)
      ?? (parentCandidates.length === 1 ? parentCandidates[0] : null);
    if (parentNode?.threadId) {
      return activate(parentNode.threadId, parentNode.id);
    }
    if (parentCandidates.length > 1) {
      throw new Error("这张素材对应多个画板结果，请先选择具体节点后再继续");
    }

    const draft = activeCanvasRef.current;
    const title = prompt.trim().split(/\r?\n/, 1)[0].slice(0, 64) || "新创作";
    const thread = {
      id: crypto.randomUUID(),
      projectId: draft.id,
      title,
      origin: "direct" as const,
    };
    const shouldAutoTitle = draft.titleSource === "default";
    const wasMaterialized = draft.materialized;
    if (shouldAutoTitle && !wasMaterialized) {
      draft.title = title;
      draft.titleSource = "first_prompt";
      replaceActive(draft);
      useStore.setState((state) => ({
        projects: state.projects.map((project) => project.id === draft.id
          ? { ...project, name: title, title_source: "first_prompt" }
          : project),
      }));
    }
    const materializedNow = await ensureMaterialized(draft, [], null, [thread]);
    assertCurrentWorkspace();
    const created = materializedNow ? {
      ...thread,
      archivedAt: null,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    } : await api.projectThreadCreate(thread);
    assertCurrentWorkspace();
    if (shouldAutoTitle && wasMaterialized) {
      const renamed = await api.projectCanvasTitleFromFirstPrompt(draft.id, title);
      if (renamed) {
        draft.title = title;
        draft.titleSource = "first_prompt";
        replaceActive(draft);
      }
      await reloadProjects();
      assertCurrentWorkspace();
    }
    setThreads((current) => current.some((item) => item.id === created.id) ? current : [...current, created]);
    setFocusedThreadId(created.id);
    setProjectTimelineScope("focused");
    useStore.getState().clearProjectThreadUnread(draft.id, created.id);
    markViewDirty();
    return { threadId: created.id, parentNodeId: null, continuationRequestId };
  }

  useEffect(() => {
    // A fresh provisional project has no members yet, so start from the central
    // library. Persisted projects open on their own materialized asset scope.
    setSourceScope(project?.provisional ? "library" : "project");
  }, [projectId]);

  useEffect(() => {
    if (sourceScope !== "library") return;
    let alive = true;
    let unlisten: UnlistenFn | undefined;
    let requestVersion = 0;

    async function loadCentralLibrary() {
      const version = ++requestVersion;
      setLibrarySourceLoading(true);
      try {
        const [nextAssets, nextTotal] = await Promise.all([
          api.listAssets(librarySourceFolderId ?? undefined, null),
          // 选定文件夹时 countAssets 无对应参数，直接用本页数量（总数仅驱动空态文案）。
          librarySourceFolderId ? Promise.resolve(null) : api.countAssets(null),
        ]);
        if (!alive || version !== requestVersion) return;
        setLibrarySourceAssets(nextAssets);
        setLibrarySourceTotal(nextTotal ?? nextAssets.length);
      } catch (reason) {
        if (alive && version === requestVersion) reportError(reason);
      } finally {
        if (alive && version === requestVersion) setLibrarySourceLoading(false);
      }
    }

    void loadCentralLibrary();
    listen("library://assets-changed", () => void loadCentralLibrary()).then((cleanup) => {
      if (alive) unlisten = cleanup;
      else cleanup();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [sourceScope, librarySourceFolderId]);

  useEffect(() => {
    if (!projectId || project?.provisional) return;
    let alive = true;
    let requestVersion = 0;
    let unlisten: UnlistenFn | undefined;

    async function refreshExactCanvasAssets() {
      const version = ++requestVersion;
      const epoch = assetHydrationEpochRef.current;
      const requestedAssetIds = projectCanvasAssetIds(graphNodesRef.current);
      try {
        const next = await api.getAssetsByIds(requestedAssetIds);
        const route = useStore.getState();
        if (
          !alive
          || version !== requestVersion
          || activeCanvasRef.current.id !== projectId
          || !isWorkspaceOperationCurrent(projectId, route.activeProjectId, route.projectRoutePending)
          || !isCanvasAssetHydrationCurrent(
            epoch,
            assetHydrationEpochRef.current,
            requestedAssetIds,
            projectCanvasAssetIds(graphNodesRef.current),
          )
        ) return;
        setCanvasAssets(next);
      } catch (reason) {
        if (alive && version === requestVersion) reportError(reason);
      }
    }

    listen("library://assets-changed", () => void refreshExactCanvasAssets()).then((cleanup) => {
      if (alive) unlisten = cleanup;
      else cleanup();
    });
    return () => {
      alive = false;
      requestVersion += 1;
      unlisten?.();
    };
  }, [project?.provisional, projectId]);

  useEffect(() => {
    const token = ++loadTokenRef.current;
    const loadRouteRevision = projectRouteRevision;
    let cancelled = false;
    initialSnapshotRestoredRef.current = false;
    loadingRef.current = true;
    setLoading(true);
    setLoadFailed(false);
    setError(null);
    void (async () => {
      try {
        if (!projectId || !project) {
          throw new Error("项目不存在或已离开");
        }
        if (project.provisional) {
          activateProvisional();
          if (project.title_source === "manual") {
            // Named provisional projects materialize through the same barrier as
            // every canvas write, so exit/switch must wait for this request.
            await enqueueWrite(async () => {
              await ensureMaterialized(activeCanvasRef.current);
            });
            if (cancelled || token !== loadTokenRef.current) return;
          }
        } else {
          await api.projectCanvasEnsure(projectId);
          if (cancelled || token !== loadTokenRef.current) return;
          const snapshot = await api.projectCanvasGet(projectId);
          if (cancelled || token !== loadTokenRef.current) return;
          const exactAssets = await api.getAssetsByIds(projectCanvasAssetIds(snapshot.nodes));
          if (cancelled || token !== loadTokenRef.current) return;
          initialSnapshotRestoredRef.current = applySnapshot(
            snapshot,
            { restoreView: true },
            exactAssets,
            loadRouteRevision,
          );
          void api.projectCanvasTouch(projectId).catch((reason) => {
            if (!cancelled && token === loadTokenRef.current) reportError(reason);
          });
        }
      } catch (reason) {
        if (!cancelled && token === loadTokenRef.current) {
          if (project?.provisional) activateProvisional();
          else setLoadFailed(true);
          reportError(reason);
        }
      } finally {
        if (!cancelled && token === loadTokenRef.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (loadTokenRef.current === token) loadTokenRef.current += 1;
    };
  }, [loadRevision, projectId, projectRouteRevision]);

  useEffect(() => {
    if (
      !launchRequest
      || launchRequest.promptLoad
      || !creativeLaunchTargetsProject(launchRequest, projectId)
      || !project?.provisional
      || processedLaunchRef.current === launchRequest.id
    ) return;
    processedLaunchRef.current = launchRequest.id;
    activateProvisional();
    seedInitialAssets(launchRequest.assetIds);
    onLaunchConsumed?.(launchRequest.id);
  }, [launchRequest, onLaunchConsumed, project?.provisional, projectId]);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    let refreshVersion = 0;

    function scheduleRefresh(eventProjectId: string, delay: number) {
      if (timer) clearTimeout(timer);
      const version = ++refreshVersion;
      timer = setTimeout(() => {
        void refreshGraph(eventProjectId, version);
      }, delay);
    }

    async function refreshGraph(eventProjectId: string, version: number) {
      const settledQueue = writeQueueRef.current;
      await settledQueue;
      if (!alive || version !== refreshVersion || activeCanvasRef.current.id !== eventProjectId) return;
      if (loadingRef.current || !initialSnapshotRestoredRef.current) {
        scheduleRefresh(eventProjectId, 80);
        return;
      }
      // Never replace optimistic local state with an older backend snapshot
      // while the ordered journal is blocked on a failed write.
      if (writeJournalRef.current.failure != null || writeJournalRef.current.pending.length > 0) return;
      // A write appended while we waited, or a live node gesture whose write is
      // not queued until pointer-up, means the local projection is newer.
      if (writeQueueRef.current !== settledQueue || nodeDragRef.current || graphNodeDragRef.current) {
        scheduleRefresh(eventProjectId, 80);
        return;
      }
      try {
        const route = useStore.getState();
        if (!isWorkspaceOperationCurrent(eventProjectId, route.activeProjectId, route.projectRoutePending)) return;
        const refreshRouteRevision = route.projectRouteRevision;
        const queueBeforeRead = writeQueueRef.current;
        const snapshot = await api.projectCanvasGet(eventProjectId);
        const exactAssets = await api.getAssetsByIds(projectCanvasAssetIds(snapshot.nodes));
        if (
          !alive
          || version !== refreshVersion
          || activeCanvasRef.current.id !== eventProjectId
        ) return;
        if (
          writeJournalRef.current.failure != null
          || writeJournalRef.current.pending.length > 0
        ) return;
        if (writeQueueRef.current !== queueBeforeRead || nodeDragRef.current || graphNodeDragRef.current) {
          scheduleRefresh(eventProjectId, 80);
          return;
        }
        applySnapshot(snapshot, { restoreView: false }, exactAssets, refreshRouteRevision);
      } catch (reason) {
        reportError(reason);
      }
    }

    // This listener must stay mounted for the whole project lifetime. Asset
    // ingestion emits library://assets-changed immediately before the terminal
    // creative event; rebinding on assetById changes leaves an async listener
    // gap in which "done" can be lost and the output only appears after reload.
    listen<{
      projectId?: string;
      threadId?: string;
      jobId: string;
      turnKey: string;
      status: string;
    }>("creative://changed", (event) => {
      const eventProjectId = event.payload.projectId ?? projectId;
      const threadId = event.payload.threadId ?? null;
      const navigation = useStore.getState();
      const threadIsOutsideFocus = navigation.projectTimelineScope === "focused"
        && !!navigation.focusedThreadId
        && navigation.focusedThreadId !== threadId;
      if (eventProjectId && threadId && (eventProjectId !== activeCanvasRef.current.id || threadIsOutsideFocus)) {
        navigation.markProjectThreadUnread(eventProjectId, threadId);
      }
      if (eventProjectId !== activeCanvasRef.current.id) {
        return;
      }
      scheduleRefresh(eventProjectId, event.payload.status === "done" ? 420 : 40);
    }).then((cleanup) => {
      if (alive) unlisten = cleanup;
      else cleanup();
    });
    return () => {
      alive = false;
      refreshVersion += 1;
      unlisten?.();
      if (timer) clearTimeout(timer);
    };
  }, [projectId]);

  useEffect(() => {
    if (!focusRequestId || loading || loadFailed) return;
    const requestKey = `${projectId ?? ""}:${focusThreadId}:${focusNodeId}:${focusRequestId ?? "initial"}`;
    if (appliedFocusRequestRef.current === requestKey) return;
    const archived = new Set(
      threads.filter((thread) => thread.archivedAt != null).map((thread) => thread.id),
    );
    const threadResolution = resolveProjectFocusThread(threads, focusThreadId);
    if (threadResolution === "pending") return;
    const resolution = resolveProjectFocusNode(
      graphNodes,
      agentPromptGroupMap(graphNodes, graphEdges).get(focusNodeId ?? "")?.id ?? focusNodeId ?? null,
      archived,
      focusThreadId,
    );
    if (resolution.state === "pending") return;
    const target = resolution.state === "ready" ? resolution.node : null;
    const stage = stageRef.current;
    if (target && stage) {
      const rect = stage.getBoundingClientRect();
      const nextPan = {
        x: rect.width / 2 - (target.x + target.width / 2),
        y: rect.height / 2 - (target.y + target.height / 2),
      };
      panRef.current = nextPan;
      zoomRef.current = 1;
      setPan(nextPan);
      setZoom(1);
      focusGraphNode(target.id);
    } else if (resolution.state === "thread-only" && threadResolution === "ready" && focusThreadId) {
      setFocusedThreadId(focusThreadId);
      setProjectTimelineScope("focused");
      if (projectId) useStore.getState().clearProjectThreadUnread(projectId, focusThreadId);
      markViewDirty();
    }
    appliedFocusRequestRef.current = requestKey;
    onFocusConsumed?.(focusRequestId);
  }, [focusNodeId, focusRequestId, focusThreadId, graphNodes, graphEdges, loadFailed, loading, onFocusConsumed, projectId, threads]);

  useEffect(() => {
    if (exploring) {
      setSourceCollapsed(true);
      resizeRef.current = null;
      setSourceResizing(false);
    }
  }, [exploring]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace || sourceCollapsed) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      const min = Math.min(240, width * 0.42);
      const max = Math.max(min, width * 0.55);
      setSourceWidth((current) => {
        if (!sourceWidthWasStored.current) {
          sourceWidthWasStored.current = true;
          return Math.min(max, Math.max(min, width * 0.33));
        }
        return Math.min(max, Math.max(min, current));
      });
    });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [sourceCollapsed]);

  useEffect(() => {
    if (!sourceResizing) return;
    document.body.classList.add("app-sidebar-resizing");
    return () => document.body.classList.remove("app-sidebar-resizing");
  }, [sourceResizing]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const editing = !!target && (
        target.isContentEditable
        || target.tagName === "INPUT"
        || target.tagName === "TEXTAREA"
        || target.tagName === "SELECT"
      );
      if (promptMenuRef.current) return;
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z"
        && !editing && !event.defaultPrevented && !scopedInspectorOpen && viewModeRef.current === "canvas"
        && !nodeDragRef.current && !graphNodeDragRef.current
        && !document.querySelector('[role="dialog"][aria-modal="true"]') && removalHistoryRef.current.length > 0) {
        event.preventDefault();
        undoRemoval();
        return;
      }
      if (event.code === "Space") {
        if (scopedInspectorOpen) return;
        if (!editing && viewModeRef.current === "canvas") {
          event.preventDefault();
          spacePressedRef.current = true;
          setSpacePanReady(true);
        }
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        const selectedIds = selectedCanvasNodeIdsRef.current;
        if (
          event.defaultPrevented
          || editing
          || scopedInspectorOpen
          || viewModeRef.current !== "canvas"
          || selectedIds.size === 0
          || useStore.getState().contextMenu != null
          || document.querySelector('[role="dialog"][aria-modal="true"]')
        ) return;
        event.preventDefault();
        removeNodes(selectedIds);
        return;
      }
      if (event.key !== "Escape") return;
      if (shouldCloseProjectInspectorOnEscape({
        key: event.key,
        open: scopedInspectorOpen,
        defaultPrevented: event.defaultPrevented,
        editing: !!genEditing,
        targetTagName: target?.tagName,
        targetContentEditable: !!target?.isContentEditable,
        blockingDialogOpen: !!document.querySelector(
          '[role="dialog"][aria-modal="true"]:not([data-project-inspector])',
        ),
        popupOpen: !!document.querySelector('[aria-haspopup][aria-expanded="true"]'),
      })) {
        event.preventDefault();
        setGenPanelOpen(false);
        return;
      }
      if (nodeDragRef.current) {
        if (nodeDragRef.current.moved) {
          commitNodes(nodeDragRef.current.initialNodes);
          translateGraphSelection(nodeDragRef.current.initialGraphNodes, nodeDragRef.current.selectedIds, 0, 0);
        }
        nodeDragRef.current = null;
        setActiveDragId(null);
        setGuides([]);
        setHover(null);
        setFolderDropTargetId(null);
      }
      if (graphNodeDragRef.current) {
        if (graphNodeDragRef.current.moved) {
          translateGraphSelection(graphNodeDragRef.current.initialNodes, graphNodeDragRef.current.selectedIds, 0, 0);
          commitNodes(graphNodeDragRef.current.initialMaterialNodes);
        }
        graphNodeDragRef.current = null;
        setActiveDragId(null);
        setGuides([]);
      }
      if (panDragRef.current) {
        panDragRef.current = null;
        setPanning(false);
      }
      if (resizeRef.current) {
        resizeRef.current = null;
        setSourceResizing(false);
      }
    }
    function releaseSpace() {
      spacePressedRef.current = false;
      setSpacePanReady(false);
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.code === "Space") releaseSpace();
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseSpace);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseSpace);
    };
  }, [genEditing, scopedInspectorOpen, setGenPanelOpen]);

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    workspace.inert = projectRoutePending;
    if (projectRoutePending) {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && workspace.contains(focused)) focused.blur();
    }
    return () => {
      workspace.inert = false;
    };
  }, [projectRoutePending]);

  useEffect(() => {
    if (!viewDirtyRef.current || loading) return;
    const timer = window.setTimeout(() => void queueViewPersistence(false), 220);
    return () => window.clearTimeout(timer);
  }, [loading, pan, sourceWidth, viewRevision, zoom]);

  useEffect(() => {
    const flush = async () => {
      // Route transitions set pending before entering this callback. Lock and
      // blur synchronously so no focused editor can mutate after the snapshot.
      if (useStore.getState().projectRoutePending) lockWorkspaceInteraction();
      await flushCanvasWrites(true);
    };
    useStore.getState().registerProjectCanvasFlush(flush);
    return () => {
      if (useStore.getState().projectCanvasFlush === flush) {
        useStore.getState().registerProjectCanvasFlush(null);
      }
    };
  }, []);

  useEffect(() => () => {
    const draft = activeCanvasRef.current;
    if (!draft.materialized || !viewDirtyRef.current) return;
    const input = projectCanvasViewInput(
      draft.id,
      panRef.current,
      zoomRef.current,
      sourceWidthRef.current,
      workspaceRef.current?.getBoundingClientRect().width,
      viewModeRef.current,
      focusedThreadIdRef.current,
      timelineScopeRef.current,
      persistedProjectActiveNodeId(focusedNodeIdRef.current, graphNodesRef.current),
    );
    const journal = writeJournalRef.current;
    void writeQueueRef.current
      .then(async () => {
        const failure = await drainOrderedWriteJournal(journal, true);
        if (failure == null) await api.projectCanvasViewFlush(input);
      })
      .catch((reason) => console.error("project canvas unmount flush failed", reason));
  }, []);

  function commitProjectTitle() {
    const draft = activeCanvasRef.current;
    const title = draft.title.trim();
    if (!title) {
      draft.title = project?.name ?? DEFAULT_TITLE;
      replaceActive(draft);
      return;
    }
    if (title === titleBaselineRef.current) return;
    draft.title = title;
    draft.titleSource = "manual";
    replaceActive(draft);
    void enqueueWrite(async () => {
      const materializedNow = await ensureMaterialized(draft);
      if (!materializedNow) await api.projectCanvasRename(draft.id, title);
      titleBaselineRef.current = title;
      await reloadProjects();
    });
  }

  useEffect(() => {
    // Menu edits share the current canvas's materialization barrier and draft.
    const rename = async (title: string) => {
      if (loadingRef.current || !initialSnapshotRestoredRef.current) {
        throw new Error("项目画板尚未就绪，请稍后重试");
      }
      const projectId = activeCanvasRef.current.id;
      await flushCanvasWrites(false);
      if (activeCanvasRef.current.id !== projectId || useStore.getState().projectRoutePending) {
        throw new Error("项目正在切换，请稍后重试");
      }
      const draft = { ...activeCanvasRef.current, title, titleSource: "manual" as const };
      const materializedNow = await ensureMaterialized(draft);
      if (!materializedNow && !await api.projectCanvasRename(projectId, title)) {
        throw new Error("项目已不存在，无法重命名");
      }
      if (activeCanvasRef.current.id === projectId) {
        replaceActive({ ...activeCanvasRef.current, title, titleSource: "manual", materialized: true });
        titleBaselineRef.current = title;
      }
    };
    useStore.setState({ projectCanvasRename: rename });
    return () => {
      if (useStore.getState().projectCanvasRename === rename) {
        useStore.setState({ projectCanvasRename: null });
      }
    };
  }, []);

  async function toggleFocusedThreadArchive() {
    if (!focusedThreadId) return;
    const thread = threads.find((item) => item.id === focusedThreadId);
    if (!thread) return;
    const operationProjectId = activeCanvasRef.current.id;
    const operationRouteRevision = useStore.getState().projectRouteRevision;
    const isCurrentWorkspace = () => {
      const state = useStore.getState();
      return isWorkspaceOperationCurrent(
        operationProjectId,
        state.activeProjectId,
        state.projectRoutePending,
        operationRouteRevision,
        state.projectRouteRevision,
      );
    };
    if (!isCurrentWorkspace()) return;
    setSaving(true);
    setError(null);
    try {
      await flushCanvasWrites(false);
      await enqueueWrite(async () => {
        if (!isCurrentWorkspace()) return;
        if (thread.archivedAt == null) {
          await api.projectThreadArchive(thread.id);
        } else {
          await api.projectThreadRestore(thread.id);
        }
        if (!isCurrentWorkspace()) return;
        const snapshot = await api.projectCanvasGet(operationProjectId);
        if (!isCurrentWorkspace()) return;
        const exactAssets = await api.getAssetsByIds(projectCanvasAssetIds(snapshot.nodes));
        if (!isCurrentWorkspace()) return;
        if (!applySnapshot(snapshot, { restoreView: false }, exactAssets, operationRouteRevision)) return;
        if (thread.archivedAt == null) {
          setFocusedThreadId(null);
          setProjectTimelineScope("all");
        } else {
          setFocusedThreadId(thread.id);
          setProjectTimelineScope("focused");
        }
        markViewDirty();
      });
      if (writeJournalRef.current.failure != null) throw writeJournalRef.current.failure;
    } catch (cause) {
      if (isCurrentWorkspace()) setError(String(cause));
    } finally {
      setSaving(false);
    }
  }

  function toBoardPoint(clientX: number, clientY: number): CanvasPoint {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - panRef.current.x) / zoomRef.current,
      y: (clientY - rect.top - panRef.current.y) / zoomRef.current,
    };
  }

  function clampSourcePanelWidth(value: number) {
    const workspaceWidth = workspaceRef.current?.getBoundingClientRect().width ?? 900;
    const min = Math.min(240, workspaceWidth * 0.42);
    const max = Math.max(min, workspaceWidth * 0.55);
    return Math.min(max, Math.max(min, value));
  }

  function setHover(next: HoverIntent | null) {
    setHoverIntent((current) => current?.key === next?.key ? current : next);
  }

  function hitNode(point: CanvasPoint, excludedId?: string) {
    return findCanvasHoverTarget(
      point,
      nodesRef.current.map((node) => ({
        id: node.id,
        order: node.order,
        rect: nodeRect(node),
        node,
      })),
      excludedId,
    )?.node ?? null;
  }

  useEffect(() => {
    if (!hoverIntent) return;
    const timer = window.setTimeout(() => {
      const current = nodesRef.current;
      if (hoverIntent.kind === "internal") {
        const moving = current.find((node): node is CanvasAssetNode =>
          node.id === hoverIntent.movingId && node.kind === "asset");
        const next = mergeCanvasNodesIntoFolder(
          current,
          hoverIntent.movingId,
          hoverIntent.targetId,
          canvasId("group"),
          { width: FOLDER_WIDTH, height: FOLDER_HEIGHT },
        );
        if (next !== current) {
          commitNodes(next);
          const group = next.find((node): node is CanvasFolderNode =>
            node.kind === "folder" && node.assets.some((asset) => asset.id === hoverIntent.movingId));
          if (group && groupsRef.current.has(group.id)) persistGroupMembership(group, [], moving);
          else if (group) persistCreatedGroup(group, [], moving);
        }
        nodeDragRef.current = null;
        setActiveDragId(null);
        setGuides([]);
      } else {
        const targetWasGroup = groupsRef.current.has(hoverIntent.targetId);
        const next = mergeCanvasAssetsIntoTarget(
          current,
          hoverIntent.targetId,
          hoverIntent.assets,
          canvasId("group"),
          { width: FOLDER_WIDTH, height: FOLDER_HEIGHT },
        );
        if (next !== current) {
          commitNodes(next);
          const group = next.find((node): node is CanvasFolderNode =>
            node.kind === "folder" && node.assets.some((asset) => hoverIntent.assets.some((item) => item.id === asset.id)));
          if (group) {
            const newMembers = hoverIntent.assets.map((asset, index) => groupedAssetNode(asset, group, index));
            if (targetWasGroup) persistGroupMembership(group, newMembers);
            else persistCreatedGroup(group, newMembers);
          }
        }
      }
      setHoverIntent(null);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [hoverIntent]);

  function addSnapshotsAt(incoming: CanvasAssetSnapshot[], point: CanvasPoint) {
    const current = nodesRef.current;
    const existingIds = containedNodeIds(current);
    const additions = uniqueSnapshots(incoming).filter((asset) => !existingIds.has(asset.id));
    if (additions.length === 0) return;
    const next = [...current];
    const created: CanvasAssetNode[] = [];
    const target = findCanvasHoverTarget(
      point,
      next.map((node) => ({ id: node.id, order: node.order, rect: nodeRect(node), node })),
    )?.node;
    let order = next.reduce((max, node) => Math.max(max, node.order), 0) + 1;
    additions.forEach((asset, index) => {
      const size = assetNodeSize(asset);
      const raw = target && index === 0
        ? { x: target.x + target.width, y: target.y, ...size }
        : { x: point.x - size.width / 2 + index * 22, y: point.y - size.height / 2 + index * 22, ...size };
      const snapped = snapCanvasRect(
        raw,
        next.map((node) => ({ id: node.id, order: node.order, rect: nodeRect(node) })),
      );
      const node: CanvasAssetNode = {
        kind: "asset",
        id: asset.id,
        asset,
        x: snapped.x,
        y: snapped.y,
        width: size.width,
        height: size.height,
        order: order++,
      };
      next.push(node);
      created.push(node);
    });
    commitNodes(next);
    persistAddedNodes(created);
  }

  function draggedSnapshots() {
    const ids = getDragAssets() ?? [];
    const signature = ids.join("\u0000");
    if (externalInstancesRef.current?.signature === signature) {
      return externalInstancesRef.current.assets;
    }
    const incoming = ids.flatMap((id) => {
      const asset = assetById.get(id);
      return asset ? [createCanvasAssetSnapshot(asset, canvasId("asset"))] : [];
    });
    externalInstancesRef.current = { signature, assets: incoming };
    return incoming;
  }

  function clearExternalDrag() {
    externalInstancesRef.current = null;
    setExternalDragOver(false);
    setHover(null);
    setFolderDropTargetId(null);
  }

  function onCanvasDragOver(event: DragEvent<HTMLDivElement>) {
    const incoming = draggedSnapshots();
    if (incoming.length === 0) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setExternalDragOver(true);
    const point = toBoardPoint(event.clientX, event.clientY);
    const target = hitNode(point);
    if (!target) {
      setHover(null);
      setFolderDropTargetId(null);
      return;
    }
    if (target.kind === "folder") {
      setHover(null);
      setFolderDropTargetId(target.id);
      return;
    }
    setFolderDropTargetId(null);
    const key = `external:${target.id}:${incoming.map((asset) => asset.id).join(",")}`;
    setHover({ kind: "external", key, targetId: target.id, assets: incoming });
  }

  function onCanvasDrop(event: DragEvent<HTMLDivElement>) {
    const incoming = draggedSnapshots();
    if (incoming.length === 0) return;
    event.preventDefault();
    setExternalDragOver(false);
    setHover(null);
    setFolderDropTargetId(null);
    const point = toBoardPoint(event.clientX, event.clientY);
    const target = hitNode(point);
    if (target?.kind === "folder") {
      const current = nodesRef.current;
      const next = mergeCanvasAssetsIntoTarget(
        current,
        target.id,
        incoming,
        canvasId("group"),
        { width: FOLDER_WIDTH, height: FOLDER_HEIGHT },
      );
      if (next !== current) {
        commitNodes(next);
        const group = next.find((node): node is CanvasFolderNode => node.id === target.id && node.kind === "folder");
        if (group) {
          const newIds = new Set(incoming.map((asset) => asset.id));
          const newMembers = group.assets
            .filter((asset) => newIds.has(asset.id))
            .map((asset, index) => groupedAssetNode(asset, group, index));
          persistGroupMembership(group, newMembers);
        }
      }
      externalInstancesRef.current = null;
      return;
    }
    addSnapshotsAt(incoming, point);
    externalInstancesRef.current = null;
  }

  function selectionAnchors(materials = nodesRef.current, graph = graphNodesRef.current) {
    const archived = new Set(threads.filter((thread) => thread.archivedAt != null).map((thread) => thread.id));
    const agentPrompts = agentPromptGroupMap(graph, graphEdges);
    return [
      ...materials.map((node) => ({ id: node.id, order: node.order, rect: nodeRect(node) })),
      ...graph.filter((node) => (node.kind === "prompt" || node.kind === "agent_group")
        && !agentPrompts.has(node.id)
        && node.hiddenAt == null && (!node.threadId || !archived.has(node.threadId)))
        .map((node) => ({ id: node.id, order: node.zIndex, rect: nodeRect(node) })),
    ];
  }

  function translateGraphSelection(initial: ProjectGraphNode[], selectedIds: Set<string>, dx: number, dy: number) {
    const positions = new Map(translateCanvasSelection(initial, selectedIds, dx, dy).map((node) => [node.id, node]));
    const next = graphNodesRef.current.map((node) => {
      const position = positions.get(node.id);
      return selectedIds.has(node.id) && position ? { ...node, x: position.x, y: position.y } : node;
    });
    graphNodesRef.current = next;
    setGraphNodes(next);
  }

  function arrangeNodes(nodeIds: Iterable<string>) {
    const aliases = new Map<string, string>();
    for (const node of nodesRef.current) {
      if (node.kind === "folder") for (const asset of node.assets) aliases.set(asset.id, node.id);
    }
    for (const [id, group] of agentPromptGroupMap(graphNodesRef.current, graphEdges)) aliases.set(id, group.id);
    const anchors = selectionAnchors();
    const elements = new Map(Array.from(stageRef.current?.querySelectorAll<HTMLElement>("[data-canvas-node-id]") ?? [])
      .map((element) => [element.dataset.canvasNodeId, element]));
    for (const anchor of anchors) {
      const rect = elements.get(anchor.id)?.getBoundingClientRect();
      if (rect) {
        anchor.rect.width = Math.max(anchor.rect.width, rect.width / zoomRef.current);
        anchor.rect.height = Math.max(anchor.rect.height, rect.height / zoomRef.current);
      }
    }
    const positions = arrangeCanvasNodes(anchors, graphEdges.map((edge) => ({
      fromNodeId: aliases.get(edge.fromNodeId) ?? edge.fromNodeId,
      toNodeId: aliases.get(edge.toNodeId) ?? edge.toNodeId,
    })), nodeIds);
    if (positions.size === 0) return;
    const next = nodesRef.current.map((node) => positions.has(node.id) ? { ...node, ...positions.get(node.id)! } : node);
    const graph = graphNodesRef.current.map((node) => positions.has(node.id) ? { ...node, ...positions.get(node.id)! } : node);
    commitNodes(next);
    graphNodesRef.current = graph;
    setGraphNodes(graph);
    setSelectedCanvasNodeIds(new Set(positions.keys()));
    persistGeometries(next.filter((node) => positions.has(node.id)));
    for (const node of graph) {
      if (positions.has(node.id) && (node.kind === "prompt" || node.kind === "agent_group")) persistGraphNodeGeometry(node);
    }
  }

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    function prepareDrop(event: Event) {
      const detail = (event as CustomEvent<ExplorerCanvasDropDetail>).detail;
      if (loadingRef.current || viewModeRef.current !== "canvas"
        || detail.projectId !== activeCanvasRef.current.id || useStore.getState().projectRoutePending) return;
      const projectId = detail.projectId;
      const point = toBoardPoint(detail.clientX, detail.clientY);
      const order = nodesRef.current.reduce((max, node) => Math.max(max, node.order), 0) + 1;
      detail.place = async (asset) => {
        const snapshot = createCanvasAssetSnapshot(asset, canvasId("asset"));
        const size = assetNodeSize(snapshot);
        const node: CanvasAssetNode = {
          kind: "asset", id: snapshot.id, asset: snapshot,
          x: point.x - size.width / 2, y: point.y - size.height / 2,
          ...size, order,
        };
        // Capture already materialized this project. Persist to the frozen ID
        // even if another project is now visible, without moving the viewport.
        await enqueueWrite(async () => {
          await api.projectCanvasNodeCreate(newProjectCanvasAssetNode(projectId, node));
          const route = useStore.getState();
          if (stage?.isConnected && activeCanvasRef.current.id === projectId
            && route.activeProjectId === projectId && !route.projectRoutePending) {
            commitNodes([...nodesRef.current.filter(existing => existing.id !== node.id), node]);
          }
        });
        if (writeJournalRef.current.failure != null) throw writeJournalRef.current.failure;
      };
    }
    stage.addEventListener(EXPLORER_CANVAS_DROP_EVENT, prepareDrop);
    return () => stage.removeEventListener(EXPLORER_CANVAS_DROP_EVENT, prepareDrop);
  }, []);

  function openCanvasNodeMenu(event: React.MouseEvent<HTMLElement>, nodeId: string, node: ProjectGraphNode | null = null) {
    event.preventDefault();
    event.stopPropagation();
    useStore.getState().closeContextMenu();
    const nodeIds = selectedCanvasNodeIdsRef.current.has(nodeId) ? [...selectedCanvasNodeIdsRef.current] : [nodeId];
    setSelectedCanvasNodeIds(new Set(nodeIds));
    setPromptMenu({ node, nodeIds, x: event.clientX, y: event.clientY });
  }

  function toggleCanvasNodeSelection(nodeId: string) {
    setSelectedCanvasNodeIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }

  function beginNodeDrag(event: PointerEvent<HTMLDivElement>, node: CanvasNode) {
    if (isCanvasPanGesture(event.button, spacePressedRef.current) || event.button !== 0) return;
    event.stopPropagation();
    const point = toBoardPoint(event.clientX, event.clientY);
    const toggleSelection = event.ctrlKey || event.metaKey;
    const selectedIds = toggleSelection || selectedCanvasNodeIdsRef.current.has(node.id)
      ? new Set([...selectedCanvasNodeIdsRef.current, node.id])
      : new Set([node.id]);
    nodeDragRef.current = {
      nodeId: node.id,
      toggleSelection,
      selectedIds,
      initialNodes: nodesRef.current,
      initialGraphNodes: graphNodesRef.current,
      pointerId: event.pointerId,
      offsetX: point.x - node.x,
      offsetY: point.y - node.y,
      startClientX: event.clientX,
      startClientY: event.clientY,
      moved: false,
    };
    if (!toggleSelection) {
      focusGraphNode(node.id);
      if (!selectedCanvasNodeIdsRef.current.has(node.id)) setSelectedCanvasNodeIds(new Set());
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function beginGraphNodeDrag(event: PointerEvent<HTMLElement>, node: ProjectGraphNode) {
    if (isCanvasPanGesture(event.button, spacePressedRef.current) || event.button !== 0) return;
    event.stopPropagation();
    const point = toBoardPoint(event.clientX, event.clientY);
    const toggleSelection = event.ctrlKey || event.metaKey;
    graphNodeDragRef.current = {
      nodeId: node.id,
      toggleSelection,
      initialNodes: graphNodesRef.current,
      initialMaterialNodes: nodesRef.current,
      selectedIds: toggleSelection || selectedCanvasNodeIdsRef.current.has(node.id)
        ? new Set([...selectedCanvasNodeIdsRef.current, node.id]) : new Set([node.id]),
      pointerId: event.pointerId,
      offsetX: point.x - node.x,
      offsetY: point.y - node.y,
      startClientX: event.clientX,
      startClientY: event.clientY,
      moved: false,
    };
    if (!toggleSelection) {
      focusGraphNode(node.id);
      if (!selectedCanvasNodeIdsRef.current.has(node.id)) setSelectedCanvasNodeIds(new Set());
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveGraphNode(event: PointerEvent<HTMLElement>) {
    const drag = graphNodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved) {
      if (!exceedsCanvasDragThreshold(
        { x: drag.startClientX, y: drag.startClientY },
        { x: event.clientX, y: event.clientY },
      )) return;
      drag.moved = true;
      if (drag.toggleSelection) setSelectedCanvasNodeIds(drag.selectedIds);
      setActiveDragId(drag.nodeId);
    }
    const origin = drag.initialNodes.find((node) => node.id === drag.nodeId);
    if (!origin) return;
    const point = toBoardPoint(event.clientX, event.clientY);
    const snapped = snapCanvasRect(
      {
        x: point.x - drag.offsetX,
        y: point.y - drag.offsetY,
        width: origin.width,
        height: origin.height,
      },
      selectionAnchors(drag.initialMaterialNodes, drag.initialNodes).filter((node) => !drag.selectedIds.has(node.id)),
    );
    setGuides(snapped.guides);
    translateGraphSelection(drag.initialNodes, drag.selectedIds, snapped.x - origin.x, snapped.y - origin.y);
    commitNodes(translateCanvasSelection(drag.initialMaterialNodes, drag.selectedIds, snapped.x - origin.x, snapped.y - origin.y));
  }

  function persistGraphNodeGeometry(node: ProjectGraphNode) {
    const draft = activeCanvasRef.current;
    void enqueueWrite(async () => {
      await ensureMaterialized(draft);
      await api.projectCanvasNodeUpdate(node.id, {
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        zIndex: node.zIndex,
        positionLocked: node.positionLocked,
      });
    });
  }

  function endGraphNodeDrag(event: PointerEvent<HTMLElement>, cancelled = false) {
    const drag = graphNodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (cancelled) suppressNodeClickRef.current = true;
    const node = graphNodesRef.current.find((candidate) => candidate.id === drag.nodeId);
    if (!cancelled && !drag.moved && drag.toggleSelection) {
      toggleCanvasNodeSelection(drag.nodeId);
      suppressNodeClickRef.current = true;
    }
    if (cancelled && drag.moved) {
      translateGraphSelection(drag.initialNodes, drag.selectedIds, 0, 0);
      commitNodes(drag.initialMaterialNodes);
    } else if (drag.moved && node) {
      suppressNodeClickRef.current = true;
      for (const selected of graphNodesRef.current.filter((candidate) => drag.selectedIds.has(candidate.id) && (candidate.kind === "prompt" || candidate.kind === "agent_group"))) persistGraphNodeGeometry(selected);
      persistGeometries(nodesRef.current.filter((candidate) => drag.selectedIds.has(candidate.id)));
    }
    graphNodeDragRef.current = null;
    setActiveDragId(null);
    setGuides([]);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function openCanvasAssetContextMenu(
    event: React.MouseEvent<HTMLElement>,
    selectionNode: CanvasNode,
    selectedAsset: CanvasAssetSnapshot,
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedAsset.assetId) {
      openCanvasNodeMenu(event, selectionNode.id);
      return;
    }
    setPromptMenu(null);
    const selectedIds = selectedCanvasNodeIdsRef.current.has(selectionNode.id)
      ? new Set(selectedCanvasNodeIdsRef.current)
      : new Set([selectionNode.id]);
    if (!selectedCanvasNodeIdsRef.current.has(selectionNode.id)) setSelectedCanvasNodeIds(selectedIds);
    openContextMenu(event.clientX, event.clientY, selectedAsset.assetId, {
      asset: canvasAssets.find((asset) => asset.id === selectedAsset.assetId),
      canvasSelection: {
        projectId: activeCanvasRef.current.id,
        nodeIds: [...selectedIds],
      },
    });
  }

  function activateCanvasMaterial(node: CanvasNode) {
    const state = useStore.getState();
    if (canvasPrimaryMaterialAction(state.boardOpen, !!state.genEditing) === "compose") {
      const assetIds = (node.kind === "asset" ? [node.asset] : node.assets)
        .flatMap((asset) => asset.assetId ? [{ assetId: asset.assetId, canvasNodeId: asset.id }] : []);
      for (const asset of assetIds) {
        window.dispatchEvent(new CustomEvent(BOARD_ASSET_PICK_EVENT, { detail: asset }));
      }
      if (assetIds.length === 1 && state.promptedAssets.some(
        (asset) => asset.id === assetIds[0].assetId && asset.sections && asset.sections.length > 0,
      )) {
        const anchor = Array.from(stageRef.current?.querySelectorAll<HTMLElement>("[data-canvas-node-id]") ?? [])
          .find((element) => element.dataset.canvasNodeId === node.id);
        if (anchor) {
          window.dispatchEvent(new CustomEvent("bowerbird://board-asset-peek", {
            detail: { assetId: assetIds[0].assetId, anchor },
          }));
        }
      }
      return;
    }

    const images = (node.kind === "asset" ? [node.asset] : node.assets)
      .map((asset) => asset.storePath ?? asset.thumbPath)
      .filter((path): path is string => !!path);
    if (images.length > 0) setCanvasLightbox({ images, index: 0 });
  }

  function openCanvasSourcePreview(asset: Asset, group?: Asset[]) {
    const candidates = group && group.length > 1 ? group : [asset];
    const available = candidates.flatMap((candidate) => {
      const path = candidate.store_path ?? candidate.thumb_path;
      return path ? [{ id: candidate.id, path }] : [];
    });
    if (available.length === 0) return;
    const selectedIndex = available.findIndex((candidate) => candidate.id === asset.id);
    setCanvasLightbox({
      images: available.map((candidate) => candidate.path),
      index: selectedIndex >= 0 ? selectedIndex : 0,
    });
  }

  function moveNode(event: PointerEvent<HTMLDivElement>) {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const originMoving = drag.initialNodes.find((node) => node.id === drag.nodeId);
    if (!originMoving) return;
    if (!drag.moved) {
      if (!exceedsCanvasDragThreshold(
        { x: drag.startClientX, y: drag.startClientY },
        { x: event.clientX, y: event.clientY },
      )) return;
      drag.moved = true;
      if (drag.toggleSelection) setSelectedCanvasNodeIds(drag.selectedIds);
      setActiveDragId(drag.nodeId);
    }
    const point = toBoardPoint(event.clientX, event.clientY);
    const raw = {
      x: point.x - drag.offsetX,
      y: point.y - drag.offsetY,
      width: originMoving.width,
      height: originMoving.height,
    };
    const snapped = snapCanvasRect(
      raw,
      selectionAnchors(drag.initialNodes, drag.initialGraphNodes).filter((node) => !drag.selectedIds.has(node.id)),
    );
    setGuides(snapped.guides);
    const next = translateCanvasSelection(
      drag.initialNodes,
      drag.selectedIds,
      snapped.x - originMoving.x,
      snapped.y - originMoving.y,
    );
    commitNodes(next);
    translateGraphSelection(drag.initialGraphNodes, drag.selectedIds, snapped.x - originMoving.x, snapped.y - originMoving.y);
    const moving = next.find((node) => node.id === drag.nodeId);
    if (drag.selectedIds.size > 1 || moving?.kind !== "asset") {
      setHover(null);
      setFolderDropTargetId(null);
      return;
    }
    const target = hitNode(point, moving.id);
    if (!target) {
      setHover(null);
      setFolderDropTargetId(null);
      return;
    }
    if (target.kind === "folder") {
      setHover(null);
      setFolderDropTargetId(target.id);
      return;
    }
    setFolderDropTargetId(null);
    setHover({
      kind: "internal",
      key: `internal:${moving.id}:${target.id}`,
      movingId: moving.id,
      targetId: target.id,
    });
  }

  function endNodeDrag(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const moving = nodesRef.current.find((node) => node.id === drag.nodeId);
    const target = !cancelled && drag.moved && drag.selectedIds.size === 1
      ? hitNode(toBoardPoint(event.clientX, event.clientY), drag.nodeId)
      : null;
    if (cancelled && drag.moved) {
      commitNodes(drag.initialNodes);
      translateGraphSelection(drag.initialGraphNodes, drag.selectedIds, 0, 0);
    } else if (!cancelled && !drag.moved && moving) {
      if (drag.toggleSelection) toggleCanvasNodeSelection(moving.id);
      else activateCanvasMaterial(moving);
    } else if (!cancelled && moving?.kind === "asset" && target?.kind === "folder") {
      const current = nodesRef.current;
      const next = mergeCanvasNodesIntoFolder(
        current,
        moving.id,
        target.id,
        canvasId("group"),
        { width: FOLDER_WIDTH, height: FOLDER_HEIGHT },
      );
      if (next !== current) {
        commitNodes(next);
        const group = next.find((node): node is CanvasFolderNode => node.id === target.id && node.kind === "folder");
        if (group) persistGroupMembership(group, [], moving);
      }
    } else if (moving && drag.moved) {
      persistGeometries(nodesRef.current.filter((node) => drag.selectedIds.has(node.id)));
      for (const selected of graphNodesRef.current.filter((node) => drag.selectedIds.has(node.id) && (node.kind === "prompt" || node.kind === "agent_group"))) persistGraphNodeGeometry(selected);
    }
    nodeDragRef.current = null;
    setActiveDragId(null);
    setGuides([]);
    setHover(null);
    setFolderDropTargetId(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function beginPan(event: PointerEvent<HTMLDivElement>) {
    if (!isCanvasPanGesture(event.button, spacePressedRef.current)) {
      const targetIsCanvasNode = !!(event.target as HTMLElement).closest("[data-canvas-node]");
      if (event.button === 0 && !targetIsCanvasNode) {
        if (focusedNodeIdRef.current != null) {
          setFocusedNodeId(null);
          markViewDirty();
        }
        if (!event.shiftKey && !event.ctrlKey && !event.metaKey) setSelectedCanvasNodeIds(new Set());
        const state = useStore.getState();
        if (canStartCanvasMarquee(event.button, state.boardOpen, !!state.genEditing, targetIsCanvasNode)) {
          event.preventDefault();
          const stageRect = event.currentTarget.getBoundingClientRect();
          const press: CanvasMarqueePress = {
            pointerId: event.pointerId,
            startX: event.clientX - stageRect.left,
            startY: event.clientY - stageRect.top,
            currentX: event.clientX - stageRect.left,
            currentY: event.clientY - stageRect.top,
            startClientX: event.clientX,
            startClientY: event.clientY,
            active: false,
            additive: event.shiftKey || event.ctrlKey || event.metaKey,
            baseSelection: new Set(selectedCanvasNodeIds),
          };
          marqueePressRef.current = press;
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      }
      return;
    }
    event.preventDefault();
    panDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: panRef.current.x,
      panY: panRef.current.y,
      moved: false,
    };
    setPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function movePan(event: PointerEvent<HTMLDivElement>) {
    const marqueePress = marqueePressRef.current;
    if (marqueePress?.pointerId === event.pointerId) {
      if (!marqueePress.active) {
        if (!exceedsCanvasDragThreshold(
          { x: marqueePress.startClientX, y: marqueePress.startClientY },
          { x: event.clientX, y: event.clientY },
          4,
        )) {
          return;
        }
        marqueePress.active = true;
        setSelectedCanvasNodeIds(marqueePress.additive ? new Set(marqueePress.baseSelection) : new Set());
      }
      const stageRect = event.currentTarget.getBoundingClientRect();
      marqueePress.currentX = event.clientX - stageRect.left;
      marqueePress.currentY = event.clientY - stageRect.top;
      setCanvasMarquee({
        startX: marqueePress.startX,
        startY: marqueePress.startY,
        currentX: marqueePress.currentX,
        currentY: marqueePress.currentY,
      });
      const selection = canvasRectFromPoints(
        toBoardPoint(marqueePress.startClientX, marqueePress.startClientY),
        toBoardPoint(event.clientX, event.clientY),
      );
      const selected = canvasNodeIdsInRect(
        selection,
        selectionAnchors(),
      );
      setSelectedCanvasNodeIds(new Set(
        marqueePress.additive ? [...marqueePress.baseSelection, ...selected] : selected,
      ));
      return;
    }
    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.moved = true;
    const next = {
      x: drag.panX + event.clientX - drag.startX,
      y: drag.panY + event.clientY - drag.startY,
    };
    panRef.current = next;
    setPan(next);
  }

  function endPan(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const marqueePress = marqueePressRef.current;
    if (marqueePress?.pointerId === event.pointerId) {
      if (cancelled) {
        setSelectedCanvasNodeIds(new Set(marqueePress.baseSelection));
      } else if (marqueePress.active) {
        movePan(event);
      }
      marqueePressRef.current = null;
      setCanvasMarquee(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      return;
    }
    if (panDragRef.current?.pointerId !== event.pointerId) return;
    if (panDragRef.current.moved) markViewDirty();
    // 平移手势从节点或节点按钮起步时，即使没有明显位移也不能落成一次 click。
    suppressNodeClickRef.current = true;
    window.setTimeout(() => { suppressNodeClickRef.current = false; }, 0);
    panDragRef.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function consumeSuppressedNodeClick() {
    if (!suppressNodeClickRef.current) return false;
    suppressNodeClickRef.current = false;
    return true;
  }

  function zoomAround(clientX: number, clientY: number, requested: number) {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const nextZoom = clampCanvasZoom(requested);
    const point = toBoardPoint(clientX, clientY);
    const nextPan = {
      x: clientX - rect.left - point.x * nextZoom,
      y: clientY - rect.top - point.y * nextZoom,
    };
    zoomRef.current = nextZoom;
    panRef.current = nextPan;
    setZoom(nextZoom);
    setPan(nextPan);
    markViewDirty();
  }

  function onCanvasWheel(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      zoomAround(event.clientX, event.clientY, zoomRef.current * Math.exp(-event.deltaY * 0.0015));
    } else {
      const next = { x: panRef.current.x - event.deltaX, y: panRef.current.y - event.deltaY };
      panRef.current = next;
      setPan(next);
      markViewDirty();
    }
  }

  function fitCanvas() {
    const stage = stageRef.current;
    if (!stage || nodesRef.current.length === 0) {
      panRef.current = { x: 0, y: 0 };
      zoomRef.current = 1;
      setPan({ x: 0, y: 0 });
      setZoom(1);
      markViewDirty();
      return;
    }
    const bounds = nodesRef.current.reduce(
      (acc, node) => ({
        left: Math.min(acc.left, node.x),
        top: Math.min(acc.top, node.y),
        right: Math.max(acc.right, node.x + node.width),
        bottom: Math.max(acc.bottom, node.y + node.height),
      }),
      { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
    );
    const rect = stage.getBoundingClientRect();
    const width = Math.max(1, bounds.right - bounds.left);
    const height = Math.max(1, bounds.bottom - bounds.top);
    const nextZoom = clampCanvasZoom(Math.min(1, (rect.width - 120) / width, (rect.height - 120) / height));
    const nextPan = {
      x: (rect.width - width * nextZoom) / 2 - bounds.left * nextZoom,
      y: (rect.height - height * nextZoom) / 2 - bounds.top * nextZoom,
    };
    zoomRef.current = nextZoom;
    panRef.current = nextPan;
    setZoom(nextZoom);
    setPan(nextPan);
    markViewDirty();
  }

  function removeNodes(nodeIds: Iterable<string>) {
    const ids = new Set(nodeIds);
    const materials = nodesRef.current.filter((node) => ids.has(node.id));
    for (const node of materials) {
      if (node.kind === "folder") for (const asset of node.assets) ids.add(asset.id);
    }
    const graph = graphNodesRef.current.filter((node) => ids.has(node.id) && node.hiddenAt == null);
    if (materials.length === 0 && graph.length === 0) return;
    const draft = activeCanvasRef.current;
    removalHistoryRef.current.push({ projectId: draft.id, materials, graph, groups: new Map(groupsRef.current) });
    commitNodes(nodesRef.current.filter((node) => !ids.has(node.id)));
    const next = graphNodesRef.current.map((node) => ids.has(node.id) ? { ...node, hiddenAt: Date.now() } : node);
    graphNodesRef.current = next;
    setGraphNodes(next);
    setSelectedCanvasNodeIds((current) => new Set([...current].filter((id) => !ids.has(id))));
    if (focusedNodeIdRef.current && ids.has(focusedNodeIdRef.current)) setFocusedNodeId(null);
    void enqueueWrite(async () => {
      await ensureMaterialized(draft);
      for (const node of materials) {
        if (node.kind === "folder") {
          await api.projectCanvasGroupDelete(node.id);
          groupsRef.current.delete(node.id);
        }
      }
      const groupIds = new Set(materials.filter((node) => node.kind === "folder").map((node) => node.id));
      for (const id of ids) if (!groupIds.has(id)) await api.projectCanvasNodeRemove(id);
    });
  }

  function removeGraphNode(nodeId: string) {
    removeNodes([nodeId]);
  }

  function promptSessionJobs(node: ProjectGraphNode) {
    const jobs = useStore.getState().genJobs;
    const jobId = promptNodeSummary(node).jobId;
    const job = jobs[jobId];
    return Object.values(jobs).filter((candidate) => candidate.id === jobId
      || (job?.conversationId && candidate.conversationId === job.conversationId
        && candidate.projectId === job.projectId));
  }

  function reuseCanvasPrompt(node: ProjectGraphNode) {
    const state = useStore.getState();
    if (node.kind === "agent_group") {
      const run = state.cloudAgentRuns[agentGroupSummary(node).runId];
      if (run) {
        state.reusePromptToBoard(run.intentPrompt, run.referenceAssetIds.flatMap((id) => {
          const asset = assetById.get(id);
          return asset ? [asset] : [];
        }), []);
        setPromptMenu(null);
        return;
      }
    }
    const promptId = node.kind === "agent_group"
      ? [...agentPromptGroupMap(graphNodesRef.current, graphEdges)].find(([, group]) => group.id === node.id)?.[0]
      : node.id;
    const prompt = graphNodesRef.current.find((candidate) => candidate.id === promptId);
    if (!prompt) return;
    const summary = promptNodeSummary(prompt);
    const job = state.genJobs[summary.jobId];
    const turn = job?.turns.find((candidate) => candidate.turnKey === summary.turnKey);
    if (!turn && summary.jobId) {
      // Startup may omit the job or hydrate only its latest turn. Recover the
      // exact persisted turn instead of borrowing the latest job parameters.
      const outputIds = new Set(graphEdges.filter((edge) => edge.fromNodeId === prompt.id).map((edge) => edge.toNodeId));
      const output = graphNodesRef.current.find((candidate) => outputIds.has(candidate.id) && candidate.assetId);
      if (!output?.assetId) { notify("这条生成记录尚未载入，请先从对应结果打开生成过程", "info"); return; }
      const projectId = state.activeProjectId;
      const routeRevision = state.projectRouteRevision;
      void api.generationHistory(output.assetId, projectId).then((history) => {
        const current = useStore.getState();
        if (current.activeProjectId !== projectId || current.projectRouteRevision !== routeRevision || current.projectRoutePending) return;
        const historicalTurn = history.turns.find((candidate) => candidate.turn_key === summary.turnKey);
        if (!historicalTurn) { notify("无法恢复这条生成指令的完整参数，请从对应结果打开生成过程", "info"); return; }
        current.reusePromptToBoard(historicalTurn.prompt_raw || historicalTurn.prompt,
          historicalTurn.ref_assets ?? history.references, history.dimension_assets ?? [], undefined,
          { media: historicalTurn.media ?? history.media, videoOptions: historicalTurn.video_options ?? history.video_options, ratio: historicalTurn.ratio ?? history.ratio });
        setPromptMenu(null);
      }).catch((error) => notifyError(error, "读取生成记录失败"));
      return;
    }
    state.reusePromptToBoard(
      turn?.promptRaw || turn?.prompt || summary.text,
      turn?.refAssets ?? job?.refAssets ?? [],
      job?.dimAssets ?? [],
      undefined,
      { media: turn?.media ?? job?.media, videoOptions: turn?.videoOptions ?? job?.videoOptions, ratio: turn?.ratio ?? job?.lastRatio },
    );
    setPromptMenu(null);
  }

  function deletePromptSession(node: ProjectGraphNode) {
    const jobs = promptSessionJobs(node);
    if (jobs.some((job) => job.running)) return;
    const jobIds = new Set([promptNodeSummary(node).jobId, ...jobs.map((job) => job.id)]);
    removeNodes(graphNodesRef.current.filter((candidate) => candidate.kind === "prompt"
      && (candidate.id === node.id || (promptNodeSummary(candidate).jobId
        && jobIds.has(promptNodeSummary(candidate).jobId)))).map((candidate) => candidate.id));
    const state = useStore.getState();
    if (state.activeJobId && jobIds.has(state.activeJobId)) state.setGenPanelOpen(false);
    jobs.forEach((job) => state.removeGenJob(job.id));
    setPromptMenu(null);
  }

  function undoRemoval() {
    const entry = removalHistoryRef.current[removalHistoryRef.current.length - 1];
    if (!entry || entry.projectId !== activeCanvasRef.current.id) return;
    removalHistoryRef.current.pop();
    const ids = new Set(entry.graph.map((node) => node.id));
    const currentIds = new Set(nodesRef.current.map((node) => node.id));
    commitNodes([...nodesRef.current, ...entry.materials.filter((node) => !currentIds.has(node.id))]);
    const graphIds = new Set(graphNodesRef.current.map((node) => node.id));
    const next = [...graphNodesRef.current.map((node) => ids.has(node.id) ? { ...node, hiddenAt: null } : node),
      ...entry.graph.filter((node) => !graphIds.has(node.id))];
    graphNodesRef.current = next;
    setGraphNodes(next);
    const draft = activeCanvasRef.current;
    void enqueueWrite(async () => {
      await ensureMaterialized(draft);
      const restored = new Set<string>();
      for (const original of entry.graph) {
        if (!await api.projectCanvasNodeRestore(entry.projectId, original.id)) {
          const { hiddenAt: _hidden, createdAt: _created, updatedAt: _updated, ...input } = original;
          await api.projectCanvasNodeCreate(input);
        }
        restored.add(original.id);
      }
      for (const node of entry.materials) {
        const assets = node.kind === "asset" ? [node] : node.assets.map((asset, index) => groupedAssetNode(asset, node, index));
        for (const asset of assets) {
          if (!restored.has(asset.id) && !await api.projectCanvasNodeRestore(entry.projectId, asset.id)) {
            await api.projectCanvasNodeCreate(newProjectCanvasAssetNode(entry.projectId, asset));
          }
        }
        if (node.kind === "folder") {
          const original = entry.groups.get(node.id);
          const group = await api.projectCanvasGroupCreate(original ? projectCanvasGroupUpdate(original, node) : newProjectCanvasGroup(entry.projectId, node), node.assets.map((asset) => asset.id));
          groupsRef.current.set(node.id, group);
        }
      }
    });
  }

  function ungroupFolder(folder: CanvasFolderNode) {
    const orderStart = nodesRef.current.reduce((max, node) => Math.max(max, node.order), 0) + 1;
    const restored: CanvasAssetNode[] = folder.assets.map((asset, index) => {
      const size = assetNodeSize(asset);
      return {
        kind: "asset",
        id: asset.id,
        asset,
        x: folder.x + (index % 2) * (ASSET_WIDTH + 16),
        y: folder.y + Math.floor(index / 2) * 170,
        width: size.width,
        height: size.height,
        order: orderStart + index,
      };
    });
    commitNodes([...nodesRef.current.filter((node) => node.id !== folder.id), ...restored]);
    const draft = activeCanvasRef.current;
    void enqueueWrite(async () => {
      await ensureMaterialized(draft);
      await api.projectCanvasGroupDelete(folder.id);
      groupsRef.current.delete(folder.id);
      for (const node of restored) {
        await api.projectCanvasNodeUpdate(node.id, projectCanvasNodeLayoutUpdate(node));
      }
    });
  }

  function moveNodeWithKeyboard(nodeId: string, dx: number, dy: number) {
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    const selectedIds = selectedCanvasNodeIdsRef.current.has(nodeId)
      ? selectedCanvasNodeIdsRef.current
      : new Set([nodeId]);
    const raw = { ...nodeRect(node), x: node.x + dx, y: node.y + dy };
    const snapped = snapCanvasRect(
      raw,
      nodesRef.current
        .filter((candidate) => !selectedIds.has(candidate.id))
        .map((candidate) => ({ id: candidate.id, order: candidate.order, rect: nodeRect(candidate) })),
    );
    const next = translateCanvasSelection(
      nodesRef.current,
      selectedIds,
      snapped.x - node.x,
      snapped.y - node.y,
    );
    commitNodes(next);
    persistGeometries(next.filter((candidate) => selectedIds.has(candidate.id)));
  }

  function selectViewMode(next: CreativeViewMode) {
    if (viewModeRef.current === next) return;
    viewModeRef.current = next;
    setViewMode(next);
    markViewDirty();
  }

  function focusGraphNode(nodeId: string) {
    setFocusedNodeId(nodeId);
    markViewDirty();
    const threadId = graphNodes.find((node) => node.id === nodeId)?.threadId ?? null;
    if (!threadId) return;
    setFocusedThreadId(threadId);
    useStore.getState().clearProjectThreadUnread(activeCanvasRef.current.id, threadId);
  }

  function locateGraphNode(nodeId: string) {
    const targetId = agentPromptGroupMap(graphNodesRef.current, graphEdges).get(nodeId)?.id ?? nodeId;
    const persistedTarget = graphNodesRef.current.find((node) => node.id === targetId && node.hiddenAt == null);
    const target = persistedTarget
      ? projectGraphNodesWithLiveLayout([persistedTarget], nodesRef.current)[0]
      : null;
    if (!target) return;
    const rect = stageRef.current?.getBoundingClientRect();
    if (rect) {
      const nextPan = {
        x: rect.width / 2 - (target.x + target.width / 2) * zoomRef.current,
        y: rect.height / 2 - (target.y + target.height / 2) * zoomRef.current,
      };
      panRef.current = nextPan;
      setPan(nextPan);
    }
    focusGraphNode(targetId);
    viewModeRef.current = "canvas";
    setViewMode("canvas");
    markViewDirty();
  }

  const hoverTargetId = hoverIntent?.targetId ?? null;
  const panelColumns = canvasSourceColumnCount(sourceThumbnailScale);
  const archivedThreadIds = useMemo(
    () => new Set(threads.filter((thread) => thread.archivedAt != null).map((thread) => thread.id)),
    [threads],
  );
  const focusedThreadIsArchived = !!focusedThreadId && archivedThreadIds.has(focusedThreadId);
  const activeGraph = useMemo(
    () => projectGraphVisibility(graphNodes, graphEdges, archivedThreadIds),
    [archivedThreadIds, graphEdges, graphNodes],
  );
  const activeGraphNodes = activeGraph.nodes;
  const agentPromptGroups = useMemo(() => agentPromptGroupMap(graphNodes, graphEdges), [graphNodes, graphEdges]);
  const liveGraphNodes = useMemo(
    () => projectGraphNodesWithLiveLayout(activeGraphNodes.filter((node) => !agentPromptGroups.has(node.id)), nodes),
    [activeGraphNodes, agentPromptGroups, nodes],
  );
  const graphNodeById = useMemo(
    () => new Map(liveGraphNodes.map((node) => [node.id, node])),
    [liveGraphNodes],
  );
  const supersededTaskIds = useMemo(
    () => supersededProjectTaskIds(activeGraph.nodes, activeGraph.edges),
    [activeGraph],
  );
  const promptGraphNodes = useMemo(
    () => activeGraphNodes.filter((node) => node.kind === "prompt" && node.hiddenAt == null && !agentPromptGroups.has(node.id)),
    [activeGraphNodes, agentPromptGroups],
  );
  const agentGraphNodes = useMemo(
    () => activeGraphNodes.filter((node) => node.kind === "agent_group" && node.hiddenAt == null),
    [activeGraphNodes],
  );
  useLayoutEffect(() => {
    const nodeId = pendingNewCardRef.current;
    if (!nodeId || loading || projectRoutePending || panning || activeDragId) return;
    if (viewMode !== "canvas") {
      pendingNewCardRef.current = null;
      return;
    }
    const target = [...promptGraphNodes, ...agentGraphNodes].find((node) => node.id === nodeId);
    const stage = stageRef.current;
    if (!target || !stage) {
      pendingNewCardRef.current = null;
      return;
    }
    const stageRect = stage.getBoundingClientRect();
    if (!stageRect.width || !stageRect.height) return;
    const element = Array.from(stage.querySelectorAll<HTMLElement>("[data-canvas-node-id]"))
      .find((candidate) => candidate.dataset.canvasNodeId === nodeId);
    const card = element?.getBoundingClientRect();
    const composer = stage.parentElement?.querySelector(".canvas-composer-host")?.getBoundingClientRect();
    const visibleBottom = composer && composer.height > 0
      ? Math.min(stageRect.height, composer.top - stageRect.top)
      : stageRect.height;
    const measuredCard = {
      ...target,
      width: card ? card.width / zoomRef.current : target.width,
      height: card ? card.height / zoomRef.current : target.height,
    };
    const viewport = { x: 24, y: 72, width: stageRect.width - 48, height: visibleBottom - 96 };
    const newReferences = newReferencesForCanvasCard(
      target, projectGraphNodesWithLiveLayout(graphNodesRef.current, nodesRef.current), graphEdges,
      pendingNewReferencesRef.current,
    ).filter((node) => nodesRef.current.some((material) => material.kind === "asset" && material.id === node.id));
    const referenceIds = new Set(newReferences.map((node) => node.id));
    const obstacles = selectionAnchors().filter((anchor) => anchor.id !== nodeId && !referenceIds.has(anchor.id)).map((anchor) => anchor.rect);
    const placement = target.positionLocked ? null
      : canvasPlacementForNewCard(measuredCard, viewport, panRef.current, zoomRef.current, obstacles);
    pendingNewCardRef.current = null;
    if (newReferences.length > 0) {
      const moved = { ...target, ...(placement ?? {}) };
      const references = placeNewCanvasReferences({ ...measuredCard, x: moved.x, y: moved.y }, newReferences, obstacles);
      const changed = new Map(references.map((node) => [node.id, node]));
      changed.set(moved.id, moved);
      const updated = graphNodesRef.current.map((node) => changed.get(node.id) ?? node);
      graphNodesRef.current = updated;
      setGraphNodes(updated);
      commitNodes(nodesRef.current.map((node) => {
        const reference = changed.get(node.id);
        return reference && node.kind === "asset" ? { ...node, x: reference.x, y: reference.y } : node;
      }));
      if (moved.x !== target.x || moved.y !== target.y) persistGraphNodeGeometry(moved);
      for (const reference of references) {
        persistGraphNodeGeometry(reference);
        // Agent launch and visible Run card can arrive in separate snapshots.
        if (target.id.startsWith("agent-prompt:")) pendingNewReferencesRef.current.set(reference.id, reference);
        else pendingNewReferencesRef.current.delete(reference.id);
      }
      setFocusedNodeId(nodeId);
      markViewDirty();
      return;
    }
    if (placement) {
      if (placement.x !== target.x || placement.y !== target.y) {
        const moved = { ...target, ...placement };
        const updated = graphNodesRef.current.map((node) => node.id === nodeId ? moved : node);
        graphNodesRef.current = updated;
        setGraphNodes(updated);
        persistGraphNodeGeometry(moved);
      }
      setFocusedNodeId(nodeId);
      markViewDirty();
      return;
    }
    const next = canvasViewForNewCard(measuredCard, viewport, panRef.current, zoomRef.current);
    if (!next) return;
    panRef.current = next.pan;
    zoomRef.current = next.zoom;
    setPan(next.pan);
    setZoom(next.zoom);
    setFocusedNodeId(nodeId);
    markViewDirty();
  }, [promptGraphNodes, agentGraphNodes, loading, projectRoutePending, panning, activeDragId, viewMode, scopedInspectorOpen]);
  const continuationCandidates = useMemo(
    () => activeGraphNodes.flatMap((node) => (
      node.kind === "asset"
      && node.hiddenAt == null
      && node.assetId
      && node.threadId
      && ["output", "intermediate", "final"].includes(node.role ?? "")
        ? [{ assetId: node.assetId, nodeId: node.id, threadId: node.threadId }]
        : []
    )),
    [activeGraphNodes],
  );
  const inspectorHeader = useMemo(() => {
    if (!scopedInspectorOpen) return null;
    if (activeSessionKind === "generation") {
      const imageCount = activeGenerationJob?.turns.reduce((total, turn) => total + turn.images.length, 0) ?? 0;
      const provider = activeGenerationJob?.provider;
      const providerLabel = provider === "jimeng"
        ? "即梦"
        : isCloudProvider(provider)
          ? cloudProviderLabel(provider, cloudEntitlement) ?? "Bowerbird Cloud"
          : "codex";
      return projectInspectorHeader({
        kind: "generation",
        prompt: activeGenerationJob?.turns[0]?.promptRaw
          || activeGenerationJob?.turns[0]?.prompt
          || activeGenerationJob?.lastPrompt,
        detail: activeGenerationJob
          ? `${activeGenerationJob.turns.length} 轮 · ${imageCount} 图 · ${providerLabel}`
          : "等待选择生成任务",
        running: !!activeGenerationJob?.running,
      });
    }
    if (!activeAgentRun) {
      return projectInspectorHeader({
        kind: "agent",
        detail: "等待选择 Agent 任务",
        running: false,
      });
    }
    const runtime = activeAgentRun.snapshot.run.agent_runtime === "dsh" ? "DSH" : "Legacy";
    const category = activeAgentRun.skillId === "bowerbird-html-layout-render"
      ? "HTML 排版"
      : activeAgentRun.skillId === "bowerbird-unified-agent"
        ? "DSH · 自动选工具"
        : `Agent · ${runtime}`;
    return projectInspectorHeader({
      kind: "agent",
      prompt: activeAgentRun.intentPrompt,
      detail: `${category} · ${cloudAgentStatusLabel(activeAgentRun.status)} · ${activeAgentRun.referenceAssetIds.length} 张参考图`,
      running: !["succeeded", "failed", "cancelled"].includes(activeAgentRun.status),
    });
  }, [
    activeAgentRun,
    activeGenerationJob,
    activeSessionKind,
    cloudEntitlement,
    scopedInspectorOpen,
  ]);
  const inspectorEditing = activeSessionKind === "generation" && !!genEditing;
  const drawableEdges = useMemo(
    () => graphEdges.flatMap((edge) => {
      const from = graphNodeById.get(edge.fromNodeId);
      const to = graphNodeById.get(agentPromptGroups.get(edge.toNodeId)?.id ?? edge.toNodeId);
      return from && to && from.hiddenAt == null && to.hiddenAt == null ? [{ edge, from, to }] : [];
    }),
    [graphEdges, graphNodeById, agentPromptGroups],
  );
  const timelineProjection = useMemo(
    () => {
      const visible = focusedThreadIsArchived
        ? projectGraphVisibility(graphNodes, graphEdges, archivedThreadIds, focusedThreadId)
        : activeGraph;
      return projectTimelineProjection(visible.nodes, visible.edges, timelineScope, focusedThreadId);
    },
    [activeGraph, archivedThreadIds, focusedThreadId, focusedThreadIsArchived, graphEdges, graphNodes, timelineScope],
  );
  const timelineNodes = timelineProjection.nodes;
  const timelineEdges = timelineProjection.edges;

  if (loadFailed) {
    return (
      <div className="canvas-load-failure" role="alert">
        <div className="canvas-load-failure-card">
          <span className="panel-kicker">项目画板</span>
          <h2>未能载入项目</h2>
          <p>为避免把暂时读取失败误当成空画板，编辑功能已暂停。原项目数据没有被覆盖。</p>
          {error && <code>{error}</code>}
          <div>
            <button type="button" className="app-button-primary" onClick={() => setLoadRevision((value) => value + 1)}>
              重试载入
            </button>
            {onExit && (
              <button type="button" className="app-button-secondary" onClick={onExit}>
                返回素材库
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={workspaceRef}
      className={`canvas-workspace${loading || projectRoutePending ? " is-route-pending" : ""}`}
      aria-busy={loading || projectRoutePending}
      style={{ gridTemplateColumns: sourceCollapsed ? "36px minmax(0, 1fr)" : `${sourceWidth}px 7px minmax(0, 1fr)` }}
    >
      <aside id={sourcePanelId} className="canvas-source-panel" aria-label="画板素材库">
        {sourceCollapsed && <button
          type="button"
          className="canvas-source-toggle canvas-source-expand"
          aria-label="展开画板素材库"
          title="展开素材库"
          aria-expanded={false}
          aria-controls={`${sourcePanelId}-content`}
          onClick={() => {
            setSourceCollapsed(false);
            requestAnimationFrame(() => workspaceRef.current?.querySelector<HTMLButtonElement>(".canvas-source-collapse")?.focus());
          }}
        ><PanelLeftOpen size={14} /><span>素材库</span></button>}
        <div id={`${sourcePanelId}-content`} className="canvas-source-content" hidden={sourceCollapsed}>
        <div className="canvas-source-header">
          <button
            type="button"
            className="canvas-source-toggle canvas-source-collapse"
            aria-label="收起画板素材库"
            title="收起素材库"
            aria-expanded={true}
            aria-controls={`${sourcePanelId}-content`}
            onClick={() => {
              setSourceCollapsed(true);
              requestAnimationFrame(() => workspaceRef.current?.querySelector<HTMLButtonElement>(".canvas-source-expand")?.focus());
            }}
          ><PanelLeftClose size={14} /></button>
          <div>
            <span className="panel-kicker">素材来源</span>
            <div className="canvas-source-tabs" role="tablist" aria-label="画板素材来源">
              <button
                type="button"
                role="tab"
                aria-selected={sourceScope === "project"}
                className={sourceScope === "project" ? "is-active" : ""}
                onClick={() => setSourceScope("project")}
              >
                项目素材
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sourceScope === "library"}
                className={sourceScope === "library" ? "is-active" : ""}
                onClick={() => setSourceScope("library")}
              >
                中央素材
              </button>
            </div>
          </div>
          <div className="canvas-source-view-controls">
            <GeneratedImageFilter />
            <div className="canvas-source-scale-control" title="调整素材缩略图大小">
              <span className="canvas-source-scale-label">缩略图大小</span>
              <div className="canvas-source-scale-dots" role="group" aria-label="调整素材缩略图大小">
                {[1, 2, 3].map((scale) => {
                  const label = scale === 1 ? "小" : scale === 2 ? "中" : "大";
                  return (
                    <button
                      key={scale}
                      type="button"
                      className={sourceThumbnailScale === scale ? "is-active" : ""}
                      aria-label={`${label}缩略图`}
                      aria-pressed={sourceThumbnailScale === scale}
                      onClick={() => {
                        const next = clampCanvasSourceThumbnailScale(scale);
                        setSourceThumbnailScale(next);
                        try {
                          localStorage.setItem(CANVAS_SOURCE_THUMBNAIL_SCALE_KEY, String(next));
                        } catch {
                          // Storage can be unavailable in hardened WebViews; keep the in-memory preference.
                        }
                      }}
                    >
                      <span aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
        {sourceScope === "library" && libraryFolders.length > 0 && (
          <div className="canvas-source-folders" role="group" aria-label="中央素材文件夹">
            <button
              type="button"
              className={librarySourceFolderId == null ? "is-active" : ""}
              aria-pressed={librarySourceFolderId == null}
              onClick={() => setLibrarySourceFolderId(null)}
            >
              全部
            </button>
            {libraryFolders.map((folder) => {
              const active = librarySourceFolderId === folder.id;
              return (
                <button
                  key={folder.id}
                  type="button"
                  className={active ? "is-active" : ""}
                  aria-pressed={active}
                  title={folder.name}
                  onClick={() => setLibrarySourceFolderId(active ? null : folder.id)}
                >
                  <Folder size={11} aria-hidden="true" />
                  <span>{folder.name}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="min-h-0 flex-1">
          {sourceScope === "library" && librarySourceLoading && librarySourceAssets.length === 0 ? (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-muted" role="status">
              <LoaderCircle className="animate-spin" size={14} /> 正在载入中央素材
            </div>
          ) : (
            <MasonryGrid
              variant="canvas-source"
              columnCount={panelColumns}
              assetsOverride={sourceAssets}
              totalOverride={sourceTotal}
              projectScopeId={sourceScope === "library" ? null : projectId}
              onOpenPreview={openCanvasSourcePreview}
            />
          )}
        </div>
        </div>
      </aside>

      <div
        className={`canvas-source-resizer ${sourceResizing ? "is-active" : ""}`}
        hidden={sourceCollapsed}
        role="separator"
        aria-label="调整素材面板宽度"
        aria-orientation="vertical"
        tabIndex={0}
        onPointerDown={(event) => {
          resizeRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            width: sourceWidthRef.current,
            moved: false,
          };
          setSourceResizing(true);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = resizeRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          drag.moved = true;
          const next = clampSourcePanelWidth(drag.width + event.clientX - drag.startX);
          sourceWidthRef.current = next;
          setSourceWidth(next);
        }}
        onPointerUp={(event) => {
          if (resizeRef.current?.pointerId !== event.pointerId) return;
          if (resizeRef.current.moved) markViewDirty();
          resizeRef.current = null;
          setSourceResizing(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const next = clampSourcePanelWidth(sourceWidthRef.current + (event.key === "ArrowLeft" ? -16 : 16));
          sourceWidthRef.current = next;
          setSourceWidth(next);
          markViewDirty();
        }}
      />

      <section className={`canvas-board-shell${scopedInspectorOpen && !inspectorEditing ? " has-project-inspector" : ""}`}>
        {(boardOpen || genEditing) && (
          <>
            <div className="canvas-creation-mode-frame" aria-hidden="true" />
            <div className="creation-mode-notch canvas-creation-mode-notch" aria-hidden="true">
              创作模式
            </div>
          </>
        )}
        <div className="canvas-board-toolbar">
          <div>
            {onExit && (
              <button type="button" className="canvas-back-button" onClick={onExit}>
                <ArrowLeft size={14} /> 返回素材库
              </button>
            )}
            <input
              className="canvas-board-title"
              aria-label="项目名称"
              title="点击重命名项目"
              value={activeCanvas.title}
              onChange={(event) => {
                const draft = activeCanvasRef.current;
                draft.title = event.target.value;
                draft.titleSource = "manual";
                replaceActive(draft);
              }}
              onBlur={commitProjectTitle}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
            <small>
              {viewMode === "canvas"
                ? boardOpen || genEditing
                  ? "创作模式 · 点击素材加入创作 · 拖动素材调整位置"
                  : "浏览模式 · 点击素材放大 · 空白拖动框选 · Ctrl/⌘ + 点击增减选择 · 空格 + 左键 / 中键平移"
                : "项目内创作线程的顺序投影"}
            </small>
            {selectedCanvasNodeIds.size > 0 && (
              <>
                <small className="canvas-selection-count">
                  已选择 {selectedCanvasNodeIds.size} 项 · 拖动可整体移动
                </small>
                <button
                  type="button"
                  className="canvas-selection-delete"
                  title="从画板移除所选内容（Delete）"
                  aria-label={`从画板移除所选 ${selectedCanvasNodeIds.size} 项`}
                  onClick={() => removeNodes(selectedCanvasNodeIds)}
                >
                  <Trash2 size={12} /> 移除
                </button>
              </>
            )}
            {(loading || saving) && (
              <small className="canvas-save-state"><LoaderCircle size={12} /> {loading ? "载入中" : "保存中"}</small>
            )}
            {error && <small className="canvas-save-error" title={error}>保存失败，修改仍保留在当前画面</small>}
          </div>
          <div className="canvas-zoom-controls" aria-label="画布缩放">
            {viewMode === "timeline" && threads.length > 0 && (
              <select
                aria-label="时间线范围"
                value={timelineScope === "all" ? "__all" : focusedThreadId ?? "__all"}
                onChange={(event) => {
                  if (event.target.value === "__all") {
                    setProjectTimelineScope("all");
                  } else {
                    setFocusedThreadId(event.target.value);
                    setProjectTimelineScope("focused");
                    useStore.getState().clearProjectThreadUnread(activeCanvas.id, event.target.value);
                  }
                  markViewDirty();
                }}
              >
                <option value="__all">项目全部活动</option>
                <optgroup label="进行中的线程">
                  {threads.filter((thread) => thread.archivedAt == null).map((thread) => (
                    <option key={thread.id} value={thread.id}>{thread.title}</option>
                  ))}
                </optgroup>
                {threads.some((thread) => thread.archivedAt != null) && (
                  <optgroup label="已归档（选择后可恢复）">
                    {threads.filter((thread) => thread.archivedAt != null).map((thread) => (
                      <option key={thread.id} value={thread.id}>{thread.title}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            )}
            {viewMode === "timeline" && timelineScope === "focused" && focusedThreadId && threads.some((thread) => thread.id === focusedThreadId) && (
              <button
                type="button"
                title={focusedThreadIsArchived ? "恢复当前线程" : "归档当前线程"}
                aria-label={focusedThreadIsArchived ? "恢复当前线程" : "归档当前线程"}
                onClick={() => void toggleFocusedThreadArchive()}
              >
                {focusedThreadIsArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              </button>
            )}
            <button
              type="button"
              className={viewMode === "canvas" ? "is-active" : ""}
              title="画板视图"
              aria-label="画板视图"
              onClick={() => selectViewMode("canvas")}
            >
              <LayoutDashboard size={14} />
            </button>
            <button
              type="button"
              className={viewMode === "timeline" ? "is-active" : ""}
              title="时间线视图"
              aria-label="时间线视图"
              onClick={() => selectViewMode("timeline")}
            >
              <List size={14} />
            </button>
            <button
              type="button"
              title="缩小"
              aria-label="缩小"
              disabled={viewMode !== "canvas"}
              onClick={() => {
                const rect = stageRef.current?.getBoundingClientRect();
                if (rect) zoomAround(rect.left + rect.width / 2, rect.top + rect.height / 2, zoomRef.current - 0.15);
              }}
            >
              <Minus size={14} />
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              title="放大"
              aria-label="放大"
              disabled={viewMode !== "canvas"}
              onClick={() => {
                const rect = stageRef.current?.getBoundingClientRect();
                if (rect) zoomAround(rect.left + rect.width / 2, rect.top + rect.height / 2, zoomRef.current + 0.15);
              }}
            >
              <Plus size={14} />
            </button>
            <button type="button" title="适应内容" aria-label="适应内容" disabled={viewMode !== "canvas"} onClick={fitCanvas}>
              <Maximize2 size={14} />
            </button>
          </div>
        </div>

        <div
          ref={stageRef}
          tabIndex={-1}
          data-canvas-stage
          className={`canvas-stage ${externalDragOver ? "is-drag-over" : ""} ${spacePanReady ? "is-pan-ready" : ""} ${panning ? "is-panning" : ""} ${boardOpen || genEditing ? "is-creation-mode" : ""} ${viewMode !== "canvas" ? "is-view-hidden" : ""}`}
          style={{
            backgroundPosition: `${pan.x}px ${pan.y}px`,
            backgroundSize: `${24 * zoom}px ${24 * zoom}px`,
          }}
          onPointerDown={beginPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onPointerCancel={(event) => endPan(event, true)}
          onWheel={onCanvasWheel}
          onDragOver={onCanvasDragOver}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clearExternalDrag();
          }}
          onDrop={onCanvasDrop}
        >
          <div
            className="canvas-plane"
            style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }}
          >
            <svg className="canvas-graph-edges" aria-hidden="true">
              {drawableEdges.map(({ edge, from, to }) => {
                const x1 = from.x + from.width;
                const y1 = from.y + from.height / 2;
                const x2 = to.x;
                const y2 = to.y + to.height / 2;
                const bend = Math.max(48, Math.abs(x2 - x1) * 0.42);
                return (
                  <path
                    key={edge.id}
                    className={`is-${edge.kind} `}
                    d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                  />
                );
              })}
            </svg>
            {promptGraphNodes.map((node) => {
              const summary = promptNodeSummary(node);
              return (
                <div
                  key={node.id}
                  data-canvas-node
                  data-canvas-node-id={node.id}
                  role="button"
                  tabIndex={0}
                  className={`canvas-prompt-node ${selectedCanvasNodeIds.has(node.id) ? "is-selected" : ""} is-${summary.status} ${focusedNodeId === node.id ? "is-focused" : ""} ${activeDragId === node.id || (activeDragId != null && selectedCanvasNodeIds.has(node.id)) ? "is-moving" : ""} ${supersededTaskIds.has(node.id) ? "is-superseded" : ""}`}
                  onContextMenu={(event) => openCanvasNodeMenu(event, node.id, node)}
                  style={{
                    width: node.width,
                    minHeight: node.height,
                    transform: `translate3d(${node.x}px, ${node.y}px, 0)`,
                    zIndex: activeDragId === node.id || (activeDragId != null && selectedCanvasNodeIds.has(node.id)) ? 10000 + node.zIndex : node.zIndex,
                  }}
                  onPointerDown={(event) => {
                    beginGraphNodeDrag(event, node);
                  }}
                  onPointerMove={moveGraphNode}
                  onPointerUp={endGraphNodeDrag}
                  onPointerCancel={(event) => endGraphNodeDrag(event, true)}
                  onClick={() => {
                    if (consumeSuppressedNodeClick()) return;
                    focusGraphNode(node.id);
                    if (summary.jobId && genJobs[summary.jobId]) {
                      openGenerationJob(summary.jobId, { navigate: false });
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Delete" || event.key === "Backspace") {
                      event.preventDefault();
                      event.stopPropagation();
                      removeNodes(selectedCanvasNodeIdsRef.current.has(node.id) ? selectedCanvasNodeIdsRef.current : [node.id]);
                      return;
                    }
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.currentTarget.click();
                  }}
                >
                  <div><span>生成指令</span><small>{summary.provider} · {summary.status}</small></div>
                  <p>{summary.text}</p>
                  <button
                    type="button"
                    className="canvas-prompt-node__remove"
                    title="从画板移除"
                    aria-label="从画板移除生成指令"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      removeGraphNode(node.id);
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
            {agentGraphNodes.map((node) => {
              const summary = agentGroupSummary(node);
              const run = summary.runId ? cloudAgentRuns[summary.runId] : undefined;
              const resultCount = run ? selectCloudAgentResultArtifacts(run.snapshot.artifacts, run.snapshot.renderManifest, run.snapshot.events).length : summary.artifactCount;
              return (
                <div
                  key={node.id}
                  role="button"
                  tabIndex={0}
                  data-canvas-node
                  data-canvas-node-id={node.id}
                  className={`canvas-agent-node ${selectedCanvasNodeIds.has(node.id) ? "is-selected" : ""} is-${summary.status} ${focusedNodeId === node.id ? "is-focused" : ""} ${activeDragId === node.id || (activeDragId != null && selectedCanvasNodeIds.has(node.id)) ? "is-moving" : ""} ${supersededTaskIds.has(node.id) ? "is-superseded" : ""}`}
                  onContextMenu={(event) => openCanvasNodeMenu(event, node.id, node)}
                  style={{
                    width: node.width,
                    minHeight: node.height,
                    transform: `translate3d(${node.x}px, ${node.y}px, 0)`,
                    zIndex: activeDragId === node.id || (activeDragId != null && selectedCanvasNodeIds.has(node.id)) ? 10000 + node.zIndex : node.zIndex,
                  }}
                  onPointerDown={(event) => {
                    beginGraphNodeDrag(event, node);
                  }}
                  onPointerMove={moveGraphNode}
                  onPointerUp={endGraphNodeDrag}
                  onPointerCancel={(event) => endGraphNodeDrag(event, true)}
                  onClick={() => {
                    if (consumeSuppressedNodeClick()) return;
                    focusGraphNode(node.id);
                    if (run) openCloudAgentRun(run, { navigate: false });
                  }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Delete" || event.key === "Backspace") {
                      event.preventDefault();
                      event.stopPropagation();
                      removeNodes(selectedCanvasNodeIdsRef.current.has(node.id) ? selectedCanvasNodeIdsRef.current : [node.id]);
                      return;
                    }
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.currentTarget.click();
                  }}
                >
                  <div><span>Agent 执行组</span><small>{summary.status}</small></div>
                  <strong>{summary.currentStep ?? summary.skill}</strong>
                  <p>
                    {summary.progress != null ? `${summary.progress}%` : "等待进度"}
                    {summary.pendingApprovals > 0 ? ` · ${summary.pendingApprovals} 项待批准` : ""}
                    {summary.pendingClarifications > 0 ? ` · ${summary.pendingClarifications} 个待澄清` : ""}
                    {resultCount > 0 ? ` · ${resultCount} 张图片` : ""}
                  </p>
                  <button
                    type="button"
                    className="canvas-prompt-node__remove"
                    title="从画板移除"
                    aria-label="从画板移除 Agent 执行组"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      removeGraphNode(node.id);
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
            {guides.map((guide) => (
              <span
                key={`${guide.axis}-${guide.position}`}
                className={`canvas-snap-guide is-${guide.axis}`}
                style={guide.axis === "x" ? { left: guide.position } : { top: guide.position }}
              />
            ))}
            {nodes.map((node) => {
              const holding = hoverTargetId === node.id;
              const directFolderTarget = folderDropTargetId === node.id;
              const movingWithSelection = activeDragId === node.id
                || (activeDragId != null && selectedCanvasNodeIds.has(node.id));
              const path = node.kind === "asset" ? node.asset.thumbPath ?? node.asset.storePath : null;
              return (
                <div
                  key={node.id}
                  data-canvas-node
                  data-canvas-node-id={node.id}
                  role="group"
                  tabIndex={0}
                  aria-label={`${node.kind === "asset" ? node.asset.name : `素材组，${node.assets.length} 个素材`}，${boardOpen || genEditing ? "点击加入创作" : "点击放大"}${selectedCanvasNodeIds.has(node.id) ? "，已选中" : ""}`}
                  className={`canvas-node is-${node.kind} ${focusedNodeId === node.id ? "is-focused" : ""} ${selectedCanvasNodeIds.has(node.id) ? "is-selected" : ""} ${movingWithSelection ? "is-moving" : ""} ${holding ? "is-folder-target" : ""} ${directFolderTarget ? "is-folder-drop-target" : ""} `}
                  style={{
                    width: node.width,
                    height: node.height,
                    transform: `translate3d(${node.x}px, ${node.y}px, 0)`,
                    zIndex: movingWithSelection ? 10000 + node.order : node.order,
                  }}
                  onPointerDown={(event) => beginNodeDrag(event, node)}
                  onPointerMove={moveNode}
                  onPointerUp={endNodeDrag}
                  onPointerCancel={(event) => endNodeDrag(event, true)}
                  onLostPointerCapture={(event) => endNodeDrag(event, true)}
                  onContextMenu={node.kind === "asset"
                    ? (event) => openCanvasAssetContextMenu(event, node, node.asset)
                    : (event) => openCanvasNodeMenu(event, node.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      activateCanvasMaterial(node);
                      return;
                    }
                    const step = event.shiftKey ? 24 : 6;
                    const delta = {
                      ArrowLeft: [-step, 0],
                      ArrowRight: [step, 0],
                      ArrowUp: [0, -step],
                      ArrowDown: [0, step],
                    }[event.key];
                    if (!delta) return;
                    event.preventDefault();
                    moveNodeWithKeyboard(node.id, delta[0], delta[1]);
                  }}
                >
                  {node.kind === "asset" ? (
                    <>
                      {path ? (
                        isVideoPath(path) ? <video src={convertFileSrc(path)} preload="metadata" muted playsInline className="pointer-events-none" /> : <img src={convertFileSrc(path)} alt={node.asset.name} draggable={false} />
                      ) : (
                        <div className="canvas-node-placeholder">{node.asset.name.slice(0, 1)}</div>
                      )}
                      {isVideoPath(node.asset.storePath) && <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-1.5 text-xs text-white" aria-label="视频">▶ 视频</span>}
                      <span className="canvas-node-name">{node.asset.name}</span>
                    </>
                  ) : (
                    <>
                      <FolderPreview
                        node={node}
                        onAssetContextMenu={(event, asset) => openCanvasAssetContextMenu(event, node, asset)}
                      />
                      <span className="canvas-folder-name"><Folder size={13} /> 素材组 · {node.assets.length}</span>
                    </>
                  )}
                  <div className="canvas-node-actions">
                    {node.kind === "folder" && (
                      <button
                        type="button"
                        title="解散素材组"
                        aria-label="解散素材组"
                        onPointerDown={(event) => {
                          if (!isCanvasPanGesture(event.button, spacePressedRef.current)) event.stopPropagation();
                        }}
                        onClick={() => {
                          if (!consumeSuppressedNodeClick()) ungroupFolder(node);
                        }}
                      >
                        <Ungroup size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      title="从画布移除"
                      aria-label="从画布移除"
                      onPointerDown={(event) => {
                        if (!isCanvasPanGesture(event.button, spacePressedRef.current)) event.stopPropagation();
                      }}
                      onClick={() => {
                        if (consumeSuppressedNodeClick()) return;
                        const selectedIds = selectedCanvasNodeIdsRef.current;
                        removeNodes(selectedIds.has(node.id) ? selectedIds : [node.id]);
                      }}
                    >
                      <X size={13} />
                    </button>
                  </div>
                  {holding && <span className="canvas-folder-hint" role="tooltip">创建素材组</span>}
                  {directFolderTarget && <span className="canvas-folder-hint" role="tooltip">松手移入素材组</span>}
                </div>
              );
            })}
          </div>

          {canvasMarquee && (
            <div
              className="canvas-selection-marquee"
              aria-hidden="true"
              style={{
                left: Math.min(canvasMarquee.startX, canvasMarquee.currentX),
                top: Math.min(canvasMarquee.startY, canvasMarquee.currentY),
                width: Math.abs(canvasMarquee.currentX - canvasMarquee.startX),
                height: Math.abs(canvasMarquee.currentY - canvasMarquee.startY),
              }}
            />
          )}

          {nodes.length === 0 && promptGraphNodes.length === 0 && agentGraphNodes.length === 0 && !loading && (
            <div className="canvas-empty-state" aria-hidden="true">
              <span><Move size={20} /></span>
              <strong>把左侧素材拖到这里</strong>
              <p>素材靠近时会自动吸附；叠在另一素材上停留 1 秒即可建立透明素材组。</p>
            </div>
          )}
          {externalDragOver && <div className="canvas-drop-label">松开放到画布</div>}
        </div>
        {viewMode === "timeline" && (
          <CreativeTimeline
            nodes={timelineNodes}
            edges={timelineEdges}
            selectedNodeId={focusedNodeId}
            onSelect={focusGraphNode}
            onLocate={locateGraphNode}
          />
        )}
        {shouldMountProjectComposer(loading, inspectorEditing) && (
          <CreativeComposer
            key={activeCanvas.id}
            projectId={activeCanvas.id}
            draftJson={activeCanvas.draftJson}
            initialAssetIds={composerSeedIds}
            continuationCandidates={continuationCandidates}
            focusedContinuationNodeId={focusedNodeId}
            focusedContinuationThreadId={focusedThreadId}
            promptLoadRequest={promptLoadRequest}
            onPromptLoadConsumed={onLaunchConsumed}
            onDraftChange={persistComposerDraft}
            registerDraftFlush={(flush) => {
              composerDraftFlushRef.current = flush;
            }}
            beforeGenerate={prepareForGeneration}
            resolveCreativeThread={resolveCreativeThread}
          />
        )}
        {scopedInspectorOpen && inspectorHeader && (
          <ProjectInspectorShell
            header={inspectorHeader}
            anchorNodeId={focusedNodeId}
            restoreFocusTarget={() => {
              const stage = stageRef.current;
              if (!stage) return null;
              const anchor = Array.from(stage.querySelectorAll<HTMLElement>("[data-canvas-node-id]"))
                .find((element) => element.dataset.canvasNodeId === focusedNodeId);
              return anchor ?? stage;
            }}
            editing={inspectorEditing}
            onClose={() => setGenPanelOpen(false)}
          >
            {activeSessionKind === "generation"
              ? <GenerationPanel embedded hydratedAssets={canvasAssets} />
              : activeAgentRun
                ? <CloudAgentSession embedded hydratedAssets={canvasAssets} />
                : (
                    <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted">
                      请从画板节点或任务中心选择一个 Agent 任务。
                    </div>
                  )}
          </ProjectInspectorShell>
        )}
        {promptMenu && createPortal(
          <div
            ref={promptMenuRef}
            role="menu"
            aria-label={promptMenu.node?.kind === "agent_group" ? "Agent 执行组菜单" : promptMenu.node ? "生成指令菜单" : "画板节点菜单"}
            className="fixed z-[60] w-[200px] rounded-lg border border-edge bg-panel p-1 shadow-xl"
            style={{ left: Math.max(8, Math.min(promptMenu.x, window.innerWidth - 208)), top: Math.max(8, Math.min(promptMenu.y, window.innerHeight - 124)) }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs hover:bg-panel2" onClick={() => {
              arrangeNodes(promptMenu.nodeIds);
              setPromptMenu(null);
            }}>
              <LayoutDashboard size={14} /> 整理
            </button>
            {promptMenu.node && <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs hover:bg-panel2" onClick={() => reuseCanvasPrompt(promptMenu.node!)}>
              <Copy size={14} /> 复用提示词
            </button>}
            {promptMenu.node?.kind === "prompt" && <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-red-400 hover:bg-panel2 disabled:opacity-40"
              disabled={promptSessionJobs(promptMenu.node).some((job) => job.running)}
              title={promptSessionJobs(promptMenu.node).some((job) => job.running) ? "生成中，请结束后再删除会话" : "删除会话记录及指令卡片，保留已生成图片"}
              onClick={() => deletePromptSession(promptMenu.node!)}>
              <Trash2 size={14} /> 删除会话
            </button>}
          </div>, document.body,
        )}
        {canvasLightbox && (
          <Lightbox
            images={canvasLightbox.images}
            index={canvasLightbox.index}
            onClose={() => setCanvasLightbox(null)}
            onIndexChange={(index) => setCanvasLightbox((current) => current ? { ...current, index } : null)}
          />
        )}
      </section>
    </div>
  );
}
