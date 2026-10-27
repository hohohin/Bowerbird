import { userErrorMessage } from "../lib/userError";
import { useLocalFileMode } from "../lib/localFileMode";
import type { LibrarySource } from "../lib/localFileMode";
import { LocalFileWorkspace } from "./LocalFileWorkspace";
import { ProjectInspectorShell } from "./ProjectInspectorShell";
import { WorkflowAgentDetail } from "./WorkflowAgentDetail";
import { WORKFLOW_SKILL_ENABLED, WORKFLOW_PLANNER_ENABLED, WORKFLOW_TEMPLATE_LIBRARY_ENABLED } from "../lib/featureFlags";
import { CanvasTextCard } from "./CanvasTextCard";
import { CanvasArtboardDialog } from "./CanvasArtboardDialog";
import { CANVAS_ARTBOARD_FROM_IMAGE, artboardComposition, containArtboardImage, intersectArtboard, type ArtboardComposition, type ArtboardImage } from "../lib/canvasArtboard";
import { CanvasToolbox } from "./CanvasToolbox";
import { VideoReplicationDialog } from "./VideoReplicationDialog";
import { CanvasWorkflowLayer, WindingKey, type WorkflowLayerHandle, type WorkflowGeometry, type MaterialAnchor } from "./CanvasWorkflowLayer";
import { canvasConversationCards } from "../lib/canvasConversationCards";
import { CanvasConversationImages } from "./CanvasConversationImages";
import { canvasMaterialFilterState, type CanvasMaterialFilterState } from "../lib/canvasMaterialFilter";
import { containedSessionOutputIds, hiddenWorkflowSessionIds, resolveGenerationCells, canvasSessionImages } from "../lib/canvasSessionOutputs";
import { canvasWorkflowController } from "../lib/canvasWorkflowRuntime";
import { restoreWorkflowEdit, workflowEditUndo, type WorkflowEditUndo } from "../lib/workflowUndo";
import { removeWorkflowNodes } from "../lib/workflowRemoval";
import { WORKFLOW_CARD_DRAG_TYPE, workflowNodeRun, type WorkflowInput, type WorkflowKind } from "../lib/canvasWorkflow";
import { replicationWorkflow } from "../lib/replicationWorkflow";
import { captureCanvasClipboard, cloneCanvasClipboard, parseCanvasClipboard, serializeCanvasClipboard, type CanvasClipboard } from "../lib/canvasClipboard";
import { CanvasResizeHandle } from "./CanvasResizeHandle";
import { CanvasLibraryResize } from "./CanvasLibraryResize";
import { exportAssetArchive } from "../lib/assetArchive";
import { CanvasLayerMenuItem } from "./CanvasLayerMenuItem";
import { CANVAS_LAYER_STEP_EVENT, stepCanvasLayers, type CanvasLayerStepDetail } from "../lib/canvasLayers";
import { ReadonlyPrompt } from "./creation/ReadonlyPrompt";
import "./CanvasNotes.css";
import { canvasSectionMembers, canvasTextMinSize, emptyCanvasCell, expandCanvasSections, readCanvasNote, type CanvasNotePayload } from "../lib/canvasNotes";
import { beginOnboardingOperation, useOnboarding } from "../lib/onboardingStore";
import { notify, notifyError } from "../lib/notify";
import { arrangeCanvasNodes } from "../lib/canvasArrangement";
import { canvasCardSourceRects, placeCanvasCardNearSource, newReferencesForCanvasCard, placeNewCanvasReferences, trackNewCanvasReferences } from "../lib/canvasReferencePlacement";
import { DEFAULT_VIDEO_OPTIONS, isVideoPath, videoModelLabel } from "../lib/videoGeneration";
import { VideoPoster } from "./VideoPoster";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type CSSProperties,
  type PointerEvent,
  type WheelEvent,
} from "react";
import { ContextMenu, DeleteSubmenu } from "./ContextMenu";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  Archive,
  ArchiveRestore,
  Copy,
  ChevronUp,
  Folder,
  Images,
  LayoutDashboard,
  Layers,
  List,
  LoaderCircle,
  Maximize2,
  Magnet,
  Minus,
  Move,
  MousePointer2,
  MessageCircle,
  Frame,
  Scan,
  Table2,
  TextCursorInput,
  GripHorizontal,
  Hand,
  PanelLeftClose,
  PanelLeftOpen,
  PenTool,
  Palette,
  Repeat2,
  Plus,
  Sparkles,
  Trash2,
  Ungroup,
} from "lucide-react";
import { LibrarySourceTabs } from "./LibrarySourceTabs";
import { LibraryCatalogTransition } from "./LibraryCatalogTransition";
import { Lightbox } from "./Lightbox";
import { videoTime, type VideoFrame } from "../lib/videoFrame";
import type { VideoTrimRequest } from "../lib/videoTrim";
import { CreativeComposer } from "./CreativeComposer";
import { CanvasConversation } from "./CanvasConversation";
import { LocalChatPanel, LocalChatCard, LocalChatHistory } from "./LocalChatPanel";
import { useLocalChatStore } from "../lib/localChatStore";
import { LOCAL_CHAT_CARDS_CHANGED_EVENT, LOCAL_CHAT_UPDATED_EVENT, localChat, localChatRunning, type ChatCardAction, type ChatCardDefaults, type ChatConversation } from "../lib/localChat";
import { canvasChatId } from "../lib/canvasChat";
import { canvasConversationTurn, canvasConversationTurns } from "../lib/canvasConversation";
import { GenerationPanel } from "./GenerationPanel";
import { CloudAgentSession } from "./CloudAgentPanel";
import { AgentApprovalToggle } from "./AgentApprovalToggle";
import { CreativeTimeline, generationStatusLabel } from "./CreativeTimeline";
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
import { clearSentCreativeChatDraft, isCreativeComposerDraftMeaningful, parseCreativeComposerState, serializeCreativeComposerState } from "../lib/creativeDraft";
import {
  isWorkspaceOperationCurrent,
  isWorkspaceSnapshotCurrent,
  shouldMountProjectComposer,
} from "../lib/workspaceRoute";
import {
  projectInspectorHeader,
  resolveProjectInspectorPlacement,
  shouldCloseProjectInspectorOnEscape,
} from "../lib/projectInspector";
import { cloudAgentStatusLabel, cloudAgentStepLabel } from "../lib/cloudAgent";
import { imageProviderLabel } from "../lib/genProviders";
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
  type CanvasRect,
  type CanvasSnapGuide,
} from "../lib/canvasLogic";
import { BOARD_ASSET_PICK_EVENT } from "./creation/useCreationEditor";
import {
  canvasAssetNodeSize,
  canvasAssetMediaPath,
  canvasPromptReferences,
  agentPromptGroupMap,
  CANVAS_REMOVE_NODES_EVENT,
  CANVAS_ARRANGE_NODES_EVENT,
  type CanvasArrangeNodesEventDetail,
  createCanvasAssetSnapshot,
  hydrateProjectCanvas,
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
  AnnotationMeta,
  CanvasGroup,
  CanvasEdge,
  CanvasNode as ProjectGraphNode,
  CreativeThread,
  Project,
  ProjectTitleSource,
  CreativeViewMode,
} from "../lib/types";

const ASSET_WIDTH = 190;
let canvasClipboardText = "";
const FOLDER_WIDTH = 204;
const FOLDER_HEIGHT = 178;
const DEFAULT_TITLE = "未命名创作";
const CANVAS_SNAP_ENABLED_KEY = "bowerbird.canvasSnapEnabled";

type CanvasNode = ProjectCanvasUiNode;
type CanvasAssetNode = Extract<CanvasNode, { kind: "asset" }>;
type CanvasFolderNode = Extract<CanvasNode, { kind: "folder" }>;

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

type CanvasUndoEntry =
  | { kind: "workflow"; projectId: string; edit: WorkflowEditUndo }
  | { kind: "paste"; projectId: string; nodeIds: string[]; groupIds: string[]; workflowIds: string[] }
  | { kind: "removal"; projectId: string; materials: CanvasNode[]; graph: ProjectGraphNode[]; groups: Map<string, CanvasGroup>; workflow?: WorkflowEditUndo | null }
  | { kind: "geometry"; projectId: string; materials: CanvasNode[]; graph: ProjectGraphNode[]; workflow: WorkflowGeometry[] };

interface ActiveCanvasState {
  id: string;
  title: string;
  titleSource: ProjectTitleSource;
  draftJson: string;
  materialized: boolean;
}

type HoverIntent =
  | { kind: "internal"; key: string; movingId: string; targetId: string }
  | { kind: "external"; key: string; targetId: string; assets: CanvasAssetSnapshot[] }
  | { kind: "cell"; key: string; targetId: string; cellId: string; rect: CanvasRect; source: WorkflowInput; movingId?: string };

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
  return canvasAssetNodeSize(asset, ASSET_WIDTH);
}

function baseNodeRect(node: { x: number; y: number; width: number; height: number; kind?: string }) {
  // Stored asset geometry includes its caption, independent of this display preference.
  const caption = node.kind === "asset" && !useStore.getState().settings?.canvas_show_asset_names ? 30 : 0;
  return { x: node.x, y: node.y, width: node.width, height: node.height - caption };
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
  filterState,
}: {
  node: CanvasFolderNode;
  filterState: (asset: CanvasAssetSnapshot) => CanvasMaterialFilterState;
  onAssetContextMenu: (event: React.MouseEvent<HTMLElement>, asset: CanvasAssetSnapshot) => void;
}) {
  const layerWorkspaceIds = useStore((state) => state.layerWorkspaceIds);
  return (
    <div className="canvas-folder-grid" aria-hidden="true">
      {node.assets.slice(0, 4).map((asset) => {
        const path = canvasAssetMediaPath(asset);
        return isVideoPath(asset.storePath) ? <VideoPoster key={asset.id} data-canvas-filter={filterState(asset)} path={asset.storePath} poster={asset.thumbPath} alt={asset.name} onContextMenu={event => onAssetContextMenu(event, asset)} /> : path ? (
          <div key={asset.id} data-canvas-filter={filterState(asset)} className="relative min-h-0" onContextMenu={(event) => onAssetContextMenu(event, asset)}>
            <img
              src={convertFileSrc(path)}
              alt=""
              draggable={false}
              loading="lazy"
            />
            {asset.assetId && layerWorkspaceIds.has(asset.assetId) && <span className="pointer-events-none absolute left-1 top-1 z-10 rounded-full bg-black/70 px-1.5 py-1 text-white backdrop-blur" title="有分层工程" aria-label="有分层工程"><Layers size={12} /></span>}
          </div>
        ) : (
          <span key={asset.id} data-canvas-filter={filterState(asset)} onContextMenu={(event) => onAssetContextMenu(event, asset)}>
            {asset.name.slice(0, 1)}
          </span>
        );
      })}
      {node.assets.length > 4 && <b>+{node.assets.length - 4}</b>}
    </div>
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
  const mediaFilter = useStore((state) => state.mediaFilter);
  const promptedAssets = useStore((state) => state.promptedAssets);
  const captionedIds = useStore((state) => state.captionedIds);
  const layerWorkspaceIds = useStore((state) => state.layerWorkspaceIds);
  const projects = useStore((state) => state.projects);
  const reloadProjects = useStore((state) => state.reloadProjects);
  const openContextMenu = useStore((state) => state.openContextMenu);
  const showAssetNames = useStore((state) => state.settings?.canvas_show_asset_names ?? false);
  const [workflowAgentDetail, setWorkflowAgentDetail] = useState<{ projectId: string; nodeId: string } | null>(null);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const [composerDraftRevision, setComposerDraftRevision] = useState(0);
  const chatSummaries = useLocalChatStore(state => state.summaries);
  useEffect(() => {
    setSelectedChatId(null);
    setChatHistoryOpen(false);
    if (projectId) void useLocalChatStore.getState().loadProject(projectId).catch(error => console.warn("Chat history unavailable", error));
  }, [projectId]);
  const genPanelOpen = useStore((state) => state.genPanelOpen);
  const boardOpen = useStore((state) => state.boardOpen);
  const activeSessionKind = useStore((state) => state.activeSessionKind);
  const genJobs = useStore((state) => state.genJobs);
  const activeJobId = useStore((state) => state.activeJobId);
  const openGenerationJob = useStore((state) => state.openGenerationJob);
  const genEditing = useStore((state) => state.genEditing);
  const setGenPanelOpen = useStore((state) => state.setGenPanelOpen);
  useEffect(() => { setWorkflowAgentDetail(null); }, [projectId]);
  useEffect(() => { if (genPanelOpen) setWorkflowAgentDetail(null); }, [genPanelOpen]);
  useEffect(() => { if (genPanelOpen) setSelectedChatId(null); }, [genPanelOpen]);
  useEffect(() => { if (workflowAgentDetail) setSelectedChatId(null); }, [workflowAgentDetail]);
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
  const [snapshotPromptId, setSnapshotPromptId] = useState<string | null>(null);
  const [graphNodes, setGraphNodes] = useState<ProjectGraphNode[]>([]);
  const nonChatGraphNodes = useMemo(() => graphNodes.filter(node => !canvasChatId(node)), [graphNodes]);
  const [graphEdges, setGraphEdges] = useState<CanvasEdge[]>([]);
  const [threads, setThreads] = useState<CreativeThread[]>([]);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(focusNodeId);
  const focusedNodeIdRef = useRef(focusedNodeId);
  const [pendingNewCards, setPendingNewCards] = useState<string[]>([]);
  const pendingNewReferencesRef = useRef(new Map<string, ProjectGraphNode>());
  focusedNodeIdRef.current = focusedNodeId;
  const appliedFocusRequestRef = useRef<string | null>(null);
  const [pan, setPan] = useState<CanvasPoint>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [viewMode, setViewMode] = useState<CreativeViewMode>("canvas");
  const [composerSeedIds, setComposerSeedIds] = useState<string[]>([]);
  const sourceCollapsed = !useStore(state => state.canvasLibraryOpen);
  const setCanvasLibraryOpen = useStore(state => state.setCanvasLibraryOpen);
  const setSourceCollapsed = useCallback((collapsed: boolean) => setCanvasLibraryOpen(!collapsed), [setCanvasLibraryOpen]);
  const sourcePanelRef = useRef<HTMLElement>(null);
  const sourceDragFrame = useRef<number | null>(null);
  const [libraryDragging, setLibraryDragging] = useState(false);
  const boardShellRef = useRef<HTMLElement>(null);
  const explainTutorialSources = useOnboarding(state => state.guide.status === "active" && state.guide.role === "designer"
    && state.guide.sessions.designer?.projectId === projectId && [2, 7, 8].includes(state.guide.sessions.designer.step));
  const sourcePanelId = useId();
  const sourceScope = useLocalFileMode(state => state.source);
  const localFilesOpen = useLocalFileMode(state => state.open);
  const fileMode = useLocalFileMode(state => state.mode);
  const libraryMedia = useLocalFileMode(state => state.media);
  function changeSource(value: string) {
    useLocalFileMode.getState().openSource(value as LibrarySource);
    useStore.getState().clearSelect();
  }
  function closeSource() {
    useLocalFileMode.getState().setOpen(false);
    setSourceCollapsed(true);
    requestAnimationFrame(() => boardShellRef.current?.querySelector<HTMLButtonElement>('.canvas-source-toggle')?.focus());
  }
  useEffect(() => { if (localFilesOpen) setCanvasLibraryOpen(true); }, [localFilesOpen, setCanvasLibraryOpen]);

  const [canvasAssets, setCanvasAssets] = useState<Asset[]>([]);
  const [catalogAssets, setCatalogAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savingVisible, setSavingVisible] = useState(false);
  useEffect(() => {
    // Ignore quick local writes and bridge short gaps between queued writes.
    const timer = window.setTimeout(() => setSavingVisible(saving), saving ? 250 : 350);
    return () => window.clearTimeout(timer);
  }, [saving]);
  const [error, setError] = useState<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [guides, setGuides] = useState<CanvasSnapGuide[]>([]);
  const [snapEnabled, setSnapEnabled] = useState(() => {
    try { return localStorage.getItem(CANVAS_SNAP_ENABLED_KEY) !== "false"; }
    catch { return true; }
  });
  const snapEnabledRef = useRef(snapEnabled);
  const [hoverIntent, setHoverIntent] = useState<HoverIntent | null>(null);
  const hoverRef = useRef<{ intent: HoverIntent; ready: boolean } | null>(null);
  const [hoverReady, setHoverReady] = useState(false);
  const [folderDropTargetId, setFolderDropTargetId] = useState<string | null>(null);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(() => new Set());
  const [pendingProductGroup, setPendingProductGroup] = useState<{ projectId: string; id: string } | null>(null);
  const [replicationProjectId, setReplicationProjectId] = useState<string | null>(null);
  useEffect(() => { setReplicationProjectId(null); }, [projectId]);
  const expandedFolderIdsRef = useRef(expandedFolderIds);
  const [externalDragOver, setExternalDragOver] = useState(false);
  const [spacePanReady, setSpacePanReady] = useState(false);
  const [panning, setPanning] = useState(false);
  const [canvasMarquee, setCanvasMarquee] = useState<CanvasMarquee | null>(null);
  const [selectedCanvasNodeIds, setSelectedCanvasNodeIds] = useState<Set<string>>(() => new Set());
  const [canvasLightbox, setCanvasLightbox] = useState<{ images: string[]; index: number } | null>(null);
  const videoFrameSaves = useRef(new Map<string, () => Promise<void>>());
  const videoTrimSaves = useRef(new Map<string, () => Promise<Asset>>());
  const [promptMenu, setPromptMenu] = useState<{ node: ProjectGraphNode | null; nodeIds: string[]; folder?: CanvasFolderNode; section?: { id: string; name: string } | null; x: number; y: number; point: CanvasPoint | null } | null>(null);
  useEffect(() => { setPromptMenu(null); }, [projectId, viewMode]);
  const [viewRevision, setViewRevision] = useState(0);
  const activeGenerationJob = activeJobId ? genJobs[activeJobId] ?? null : null;
  const activeAgentRun = activeCloudAgentRunId ? cloudAgentRuns[activeCloudAgentRunId] ?? null : null;
  const snapshotPrompt = !activeGenerationJob && !activeAgentRun && genPanelOpen
    ? graphNodes.find(node => node.id === snapshotPromptId && node.hiddenAt == null) ?? null : null;
  useEffect(() => {
    if (!genPanelOpen || activeJobId || activeCloudAgentRunId) setSnapshotPromptId(null);
  }, [genPanelOpen, activeJobId, activeCloudAgentRunId]);
  const activeInspectorExecution = snapshotPrompt ?? (activeSessionKind === "generation"
    ? activeGenerationJob
    : activeAgentRun);
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
  const sourceWidthRef = useRef(360); // Preserve the legacy saved view field; the library now fills the workspace.
  const activeCanvasRef = useRef(activeCanvas);
  const groupsRef = useRef(new Map<string, CanvasGroup>());
  const undoHistoryRef = useRef<CanvasUndoEntry[]>([]);
  const resizeBaselineRef = useRef<Map<string, { material?: CanvasNode; graph?: ProjectGraphNode }>>(new Map());
  const titleBaselineRef = useRef(activeCanvas.title);
  const viewDirtyRef = useRef(false);
  const viewRevisionRef = useRef(0);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const writeJournalRef = useRef(createOrderedWriteJournal());
  const pendingWritesRef = useRef(0);
  const composerDraftFlushRef = useRef<(() => void) | null>(null);
  const loadTokenRef = useRef(0);
  const loadingRef = useRef(loading);
  const initialSnapshotRestoredRef = useRef(false);
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
    initialWorkflow: WorkflowGeometry[];
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
    initialWorkflow: WorkflowGeometry[];
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
  const marqueePressRef = useRef<CanvasMarqueePress | null>(null);
  const selectedCanvasNodeIdsRef = useRef(selectedCanvasNodeIds);
  const [drawingTool, setDrawingTool] = useState<"select" | "pan" | "section" | "artboard" | "bubble" | Exclude<WorkflowKind, "trigger">>("select");
  const [artboardDialog, setArtboardDialog] = useState<{ nodeId: string; projectId: string; revision: number; composition: ArtboardComposition } | null>(null);
  useEffect(() => { setArtboardDialog(null); }, [projectId]);
  const workflowRef = useRef<WorkflowLayerHandle>(null);
  const pastingRef = useRef(false);
  const [workflowRevision, setWorkflowRevision] = useState(0);
  const workflowNodes = projectId ? canvasWorkflowController(projectId).document.nodes : [];
  const workflowHistoryIds = useMemo(() => hiddenWorkflowSessionIds(workflowNodes), [workflowNodes]);
  const containedOutputIds = useMemo(() => containedSessionOutputIds(graphNodes, workflowNodes), [graphNodes, workflowNodes]);
  const conversationCards = useMemo(() => canvasConversationCards(graphNodes, genJobs,
    new Set([...workflowHistoryIds, ...agentPromptGroupMap(graphNodes, graphEdges).keys(),
      ...graphNodes.filter(node => threads.some(thread => thread.id === node.threadId && thread.archivedAt != null)).map(node => node.id)]),
    new Set([...containedOutputIds, ...nodes.filter(node => node.kind === "folder").flatMap(node => node.assets.map(asset => asset.id))])),
    [graphNodes, genJobs, workflowHistoryIds, graphEdges, threads, containedOutputIds, nodes]);
  const conversationCardsRef = useRef(conversationCards);
  conversationCardsRef.current = conversationCards;
  const [conversationImageSelection, setConversationImageSelection] = useState<Record<string, { newest: string; selected: string }>>({});
  const conversationImageClickRef = useRef<ReturnType<typeof setTimeout>>();
  function cancelConversationImageClick() {
    clearTimeout(conversationImageClickRef.current);
    conversationImageClickRef.current = undefined;
  }
  useEffect(() => cancelConversationImageClick, [projectId, boardOpen, genEditing]);
  function conversationImages(id: string) {
    return (conversationCardsRef.current.cards.get(id)?.outputs ?? []).flatMap(output => {
      const material = nodes.find(item => item.kind === "asset" && item.id === output.id);
      return material?.kind === "asset" ? [material.asset] : [];
    });
  }
  function selectedConversationImage(id: string, images: CanvasAssetSnapshot[]) {
    const selection = conversationImageSelection[id];
    const newest = images[images.length - 1];
    return (selection?.newest === newest?.id && images.find(image => image.id === selection?.selected)) || newest;
  }
  const imageOnlyConversationIds = new Set([...conversationCards.cards].flatMap(([id, card]) => {
    const summary = promptNodeSummary(card.latest);
    const running = genJobs[summary.jobId]?.running ?? ["running", "querying", "queued"].includes(summary.status);
    const images = conversationImages(id);
    return !running && summary.status === "done" && images.length ? [id] : [];
  }));
  const visibleMaterials = useMemo(() => nodes.filter(node => !containedOutputIds.has(node.id) && !conversationCards.hiddenIds.has(node.id)), [nodes, containedOutputIds, conversationCards]);
  function chooseCanvasTool(tool: typeof drawingTool) {
    workflowRef.current?.cancelPlacement();
    setDrawingTool(tool);
  }
  function canvasCardTool(kind: "bubble" | Exclude<WorkflowKind, "trigger">) {
    return {
      draggable: true,
      "aria-pressed": drawingTool === kind,
      onClick: () => chooseCanvasTool(kind),
      onDragStart: (event: DragEvent<HTMLButtonElement>) => {
        if (loadingRef.current || useStore.getState().projectRoutePending) { event.preventDefault(); return; }
        event.stopPropagation();
        chooseCanvasTool("select");
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(WORKFLOW_CARD_DRAG_TYPE, JSON.stringify({ kind, projectId }));
      },
    };
  }
  const [sectionPreview, setSectionPreview] = useState<CanvasRect | null>(null);
  const sectionDrawRef = useRef<{ pointerId: number; start: CanvasPoint; artboard: boolean } | null>(null);

  nodesRef.current = nodes;
  graphNodesRef.current = graphNodes;
  focusedThreadIdRef.current = focusedThreadId;
  timelineScopeRef.current = timelineScope;
  panRef.current = pan;
  zoomRef.current = zoom;
  viewModeRef.current = viewMode;
  activeCanvasRef.current = activeCanvas;
  loadingRef.current = loading;
  selectedCanvasNodeIdsRef.current = selectedCanvasNodeIds;

  useEffect(() => {
    setSelectedCanvasNodeIds(new Set());
    setDrawingTool("select");
    setSectionPreview(null);
    sectionDrawRef.current = null;
    setCanvasLightbox(null);
    undoHistoryRef.current = [];
    resizeBaselineRef.current.clear();
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
  }, [nodes, graphNodes, threads, workflowRevision, conversationCards]);

  useEffect(() => {
    function arrangeRequestedNodes(event: Event) {
      const detail = (event as CustomEvent<CanvasArrangeNodesEventDetail>).detail;
      if (!detail || detail.projectId !== activeCanvasRef.current.id || loadingRef.current) return;
      arrangeNodes(detail.nodeIds);
    }
    window.addEventListener(CANVAS_ARRANGE_NODES_EVENT, arrangeRequestedNodes);
    return () => window.removeEventListener(CANVAS_ARRANGE_NODES_EVENT, arrangeRequestedNodes);
  }, [graphEdges, threads]);

  useEffect(() => {
    function changeLayers(event: Event) {
      const detail = (event as CustomEvent<CanvasLayerStepDetail>).detail;
      if (!detail || detail.projectId !== activeCanvasRef.current.id || loadingRef.current
        || viewModeRef.current !== "canvas" || useStore.getState().projectRoutePending) return;
      const sections = new Set(graphNodesRef.current.filter(node => node.kind === "note"
        && readCanvasNote(node).note_type === "section").map(node => node.id));
      const anchors = new Map(selectionAnchors().filter(node => !sections.has(node.id)).map(node => [node.id, node]));
      const cards = Array.from(stageRef.current?.querySelectorAll<HTMLElement>("[data-canvas-node-id]") ?? [])
        .flatMap(element => anchors.has(element.dataset.canvasNodeId!) ? [anchors.get(element.dataset.canvasNodeId!)!] : []);
      const orders = stepCanvasLayers(cards, new Set(detail.nodeIds), detail.direction);
      if (!orders.size) return;
      const preMaterials = nodesRef.current.filter((node) => orders.has(node.id));
      const preGraph = graphNodesRef.current.filter((node) => orders.has(node.id));
      const materials = nodesRef.current.map(node => orders.has(node.id) ? { ...node, order: orders.get(node.id)! } : node);
      const graph = graphNodesRef.current.map(node => orders.has(node.id) ? { ...node, zIndex: orders.get(node.id)! } : node);
      commitNodes(materials);
      graphNodesRef.current = graph;
      setGraphNodes(graph);
      pushGeometryUndo(preMaterials, preGraph);
      persistGeometries(materials.filter(node => orders.has(node.id)));
      for (const node of graph) if (node.kind !== "asset" && orders.has(node.id)) persistGraphNodeGeometry(node);
    }
    window.addEventListener(CANVAS_LAYER_STEP_EVENT, changeLayers);
    return () => window.removeEventListener(CANVAS_LAYER_STEP_EVENT, changeLayers);
  }, [graphEdges, threads]);

  const assetById = useMemo(() => {
    const map = new Map<string, Asset>();
    for (const asset of promptedAssets) map.set(asset.id, asset);
    for (const asset of assets) map.set(asset.id, asset);
    for (const asset of catalogAssets) map.set(asset.id, asset);
    for (const asset of canvasAssets) map.set(asset.id, asset);
    return map;
  }, [assets, canvasAssets, catalogAssets, promptedAssets]);
  const assetByIdRef = useRef(assetById);
  assetByIdRef.current = assetById;
  const generatedAssetIds = useMemo(() => new Set(graphNodes
    .filter(node => node.kind === "asset" && node.role === "output" && node.assetId)
    .map(node => node.assetId)), [graphNodes]);
  const materialFilterState = (asset: CanvasAssetSnapshot) => canvasMaterialFilterState(
    asset.storePath,
    !!asset.assetId && (!!assetById.get(asset.assetId)?.generation_session_id || generatedAssetIds.has(asset.assetId)),
    smartFilter, mediaFilter,
  );

  useEffect(() => {
    const hydrated = rehydrateProjectCanvasAssets(nodesRef.current, assetById);
    if (hydrated !== nodesRef.current) commitNodes(hydrated);
  }, [assetById]);

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
    options: { restoreView: boolean; restoreDraft?: boolean },
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
    if (options.restoreView && options.restoreDraft !== false) {
      replaceActive(activeFromProject(currentProject, snapshot.canvas.draftJson));
    }
    groupsRef.current = new Map(snapshot.groups.map((group) => [group.id, group]));
    if (options.restoreView) {
      setPendingNewCards([]);
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
      if (newCards.length) setPendingNewCards(pending => [...new Set([...pending,
        ...newCards.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map(node => node.id)])]);
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
    setPendingNewCards([]);
    pendingNewReferencesRef.current.clear();
    const draft = provisionalCanvas(project);
    replaceActive(draft);
    groupsRef.current.clear();
    commitNodes([]);
    graphNodesRef.current = [];
    setGraphNodes([]);
    setGraphEdges([]);
    setThreads([]);
    setCanvasAssets([]);
    panRef.current = { x: 0, y: 0 };
    zoomRef.current = 1;
    sourceWidthRef.current = 360;
    setPan({ x: 0, y: 0 });
    setZoom(1);
    viewModeRef.current = "canvas";
    setViewMode("canvas");
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

  function clearSentChatDraft(originProjectId: string, sentDraftJson: string) {
    if (activeCanvasRef.current.id === originProjectId) {
      // Flush before enqueuing the clear: the editor debounces its latest text,
      // and its full draft must be saved before the cleared snapshot.
      composerDraftFlushRef.current?.();
      const current = activeCanvasRef.current;
      const clearedDraftJson = clearSentCreativeChatDraft(current.draftJson, sentDraftJson);
      if (clearedDraftJson === null) return;
      current.draftJson = clearedDraftJson;
      setComposerDraftRevision(value => value + 1);
      // Keep the same snapshot on retries; newer edits queue after this write.
      void enqueueWrite(async () => { await api.projectCanvasUpdateDraft(originProjectId, clearedDraftJson); });
      return;
    }
    let preparedDraftJson: string | null | undefined;
    void enqueueWrite(async () => {
      // A send acknowledgement may arrive after leaving and revisiting its project.
      // Compare against the latest draft and save only to the original project.
      if (preparedDraftJson === undefined) {
        const saved = await api.projectCanvasGet(originProjectId);
        if (activeCanvasRef.current.id === originProjectId) {
          // The project became visible during the read. Append its editor flush
          // and clear in order; awaiting that new queue from here would deadlock.
          clearSentChatDraft(originProjectId, sentDraftJson);
          preparedDraftJson = null;
          return;
        }
        preparedDraftJson = clearSentCreativeChatDraft(saved.canvas.draftJson, sentDraftJson);
      }
      if (preparedDraftJson !== null) await api.projectCanvasUpdateDraft(originProjectId, preparedDraftJson);
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

  function openLocalChat(conversationId: string) {
    const chat = useLocalChatStore.getState().summaries[conversationId];
    if (chat && chat.projectId !== activeCanvasRef.current.id) return;
    composerDraftFlushRef.current?.();
    setGenPanelOpen(false);
    setWorkflowAgentDetail(null);
    setChatHistoryOpen(false);
    setSelectedChatId(conversationId);
    useStore.getState().setBoardActive(false);
    if (chat) {
      setFocusedNodeId(chat.nodeId);
      setFocusedThreadId(chat.threadId);
      useStore.getState().clearProjectThreadUnread(chat.projectId, chat.threadId);
      markViewDirty();
    }
  }

  function newLocalChat() {
    const draft = parseCreativeComposerState(activeCanvasRef.current.draftJson);
    draft.mode = "chat";
    persistComposerDraft(serializeCreativeComposerState(draft));
    setSelectedChatId(null);
    setChatHistoryOpen(false);
    useStore.getState().setBoardActive(true);
  }

  function chatCardDefaults(): ChatCardDefaults {
    const state = useStore.getState();
    const video = parseCreativeComposerState(activeCanvasRef.current.draftJson).drafts.video?.generation;
    return { provider: state.activeGenProvider || state.defaultProvider,
      videoChannel: video?.videoChannel ?? "jimeng", videoOptions: { ...(video?.videoOptions ?? DEFAULT_VIDEO_OPTIONS) } };
  }

  async function undoChatCards(action: ChatCardAction) {
    const id = activeCanvasRef.current.id;
    const chat = useLocalChatStore.getState().summaries[action.conversationId];
    if (chat?.projectId !== id) throw new Error("请回到这段对话所属的项目再撤销。");
    if (nodeDragRef.current || graphNodeDragRef.current) throw new Error("请先完成卡片拖动再撤销。");
    await flushCanvasWrites(false);
    const controller = canvasWorkflowController(id);
    await controller.flush();
    const conversation = await localChat.undoCards(action.conversationId, action.id);
    await controller.refreshExternalCards();
    return conversation;
  }

  async function locateChatCards(action: ChatCardAction) {
    const id = activeCanvasRef.current.id;
    const revision = useStore.getState().projectRouteRevision;
    const chat = useLocalChatStore.getState().summaries[action.conversationId];
    if (chat?.projectId !== id) return;
    await canvasWorkflowController(id).refreshExternalCards();
    const snapshot = await api.projectCanvasGet(id);
    if (activeCanvasRef.current.id !== id || useStore.getState().projectRouteRevision !== revision) return;
    const ids = new Set(action.cards.map(card => card.id));
    const workflows = canvasWorkflowController(id).document.nodes.filter(node => ids.has(node.id));
    const measured = new Map((workflowRef.current?.bounds() ?? []).map(rect => [rect.id, rect]));
    const rects = [...snapshot.nodes.filter(node => ids.has(node.id) && node.hiddenAt == null),
      ...workflows.map(node => measured.get(node.id) ?? { ...node, width: 344, height: 536 })];
    const stage = stageRef.current?.getBoundingClientRect();
    if (!rects.length || !stage) throw new Error("这些卡片已被移除，无法定位。");
    const left = Math.min(...rects.map(rect => rect.x)), top = Math.min(...rects.map(rect => rect.y)) - 45;
    const width = Math.max(...rects.map(rect => rect.x + rect.width)) - left;
    const height = Math.max(...rects.map(rect => rect.y + rect.height)) - top;
    const nextZoom = clampCanvasZoom(Math.min(1, Math.max(200, stage.width - 520) / width, Math.max(200, stage.height - 140) / height));
    const nextPan = { x: 60 - left * nextZoom, y: (stage.height - height * nextZoom) / 2 - top * nextZoom };
    zoomRef.current = nextZoom; panRef.current = nextPan;
    setZoom(nextZoom); setPan(nextPan); setSelectedCanvasNodeIds(new Set(rects.map(rect => rect.id)));
    viewModeRef.current = "canvas"; setViewMode("canvas"); markViewDirty();
  }

  async function startLocalChat(request: { prompt: string; references: Asset[] }) {
    const id = activeCanvasRef.current.id;
    const revision = useStore.getState().projectRouteRevision;
    await prepareForGeneration();
    const route = useStore.getState();
    if (!isWorkspaceOperationCurrent(id, route.activeProjectId, route.projectRoutePending, revision, route.projectRouteRevision)) {
      throw new Error("项目已切换，请在原项目重新发送。");
    }
    const bounds = stageRef.current?.getBoundingClientRect();
    const point = bounds ? toBoardPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 3) : { x: 80, y: 80 };
    const placement = placeCanvasCardNearSource({ x: point.x - 160, y: point.y, width: 320, height: 190 }, selectionAnchors().map(anchor => anchor.rect));
    const chat = await useLocalChatStore.getState().send({ projectId: id, text: request.prompt,
      referenceAssetIds: request.references.map(asset => asset.id), cardDefaults: chatCardDefaults(), placement: { ...placement, width: 320, height: 190, zIndex: Date.now() % 1000000 } });
    if (activeCanvasRef.current.id === id && useStore.getState().projectRouteRevision === revision) openLocalChat(chat.id);
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
    const state = useLocalFileMode.getState();
    useLocalFileMode.setState({ source: "project", mode: (state.media === "images" ? state.views : state.videoViews).project, query: "" });
  }, [projectId]);

  useEffect(() => {
    if (!sourceCollapsed) useLocalFileMode.getState().setOpen(true);
  }, [sourceCollapsed]);

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
    let unlistenAssets: UnlistenFn | undefined;
    let unlistenImport: UnlistenFn | undefined;
    let unlistenChat: UnlistenFn | undefined;
    let unlistenChatCards: UnlistenFn | undefined;
    let restoreImportedView = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    let refreshVersion = 0;

    // A cached controller may have been off screen when a chat created cards.
    if (projectId && !useStore.getState().projects.find(project => project.id === projectId)?.provisional) {
      void canvasWorkflowController(projectId).refreshExternalCards().catch(reportError);
    }

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
        if (applySnapshot(snapshot, { restoreView: restoreImportedView, restoreDraft: false }, exactAssets, refreshRouteRevision)) {
          restoreImportedView = false;
        }
      } catch (reason) {
        reportError(reason);
      }
    }

    // Deletion changes graph visibility as well as metadata. Use the same
    // journal/gesture/route guards as execution refreshes, preserving the live draft and view.
    listen("library://assets-changed", () => {
      if (projectId && activeCanvasRef.current.materialized) scheduleRefresh(projectId, 40);
    }).then((cleanup) => {
      if (alive) unlistenAssets = cleanup;
      else cleanup();
    });

    listen<{ projectId: string }>("project-canvas://imported", (event) => {
      if (event.payload.projectId !== projectId) return;
      restoreImportedView = true;
      scheduleRefresh(event.payload.projectId, 0);
    }).then((cleanup) => {
      if (alive) unlistenImport = cleanup;
      else cleanup();
    });

    listen<ChatConversation>(LOCAL_CHAT_UPDATED_EVENT, ({ payload: chat }) => {
      if (chat.projectId !== projectId) return;
      if (!graphNodesRef.current.some(node => node.id === chat.nodeId && node.hiddenAt == null)) scheduleRefresh(chat.projectId, 40);
    }).then(cleanup => { if (alive) unlistenChat = cleanup; else cleanup(); });

    listen<{ projectId: string }>(LOCAL_CHAT_CARDS_CHANGED_EVENT, ({ payload }) => {
      if (!alive || payload.projectId !== projectId) return;
      scheduleRefresh(payload.projectId, 40);
      void canvasWorkflowController(payload.projectId).refreshExternalCards().catch(reportError);
    }).then(cleanup => { if (alive) unlistenChatCards = cleanup; else cleanup(); });

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
      revealProductGroupId?: string;
      revealProductNodeId?: string;
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
      if (event.payload.revealProductGroupId && eventProjectId) setPendingProductGroup({ projectId: eventProjectId, id: event.payload.revealProductGroupId });
      if (event.payload.revealProductNodeId && eventProjectId) setPendingProductGroup({ projectId: eventProjectId, id: event.payload.revealProductNodeId });
      scheduleRefresh(eventProjectId, event.payload.status === "done" ? 420 : 40);
    }).then((cleanup) => {
      if (alive) unlisten = cleanup;
      else cleanup();
    });
    return () => {
      alive = false;
      refreshVersion += 1;
      unlisten?.();
      unlistenAssets?.();
      unlistenImport?.();
      unlistenChat?.();
      unlistenChatCards?.();
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

  useEffect(() => { setCanvasLibraryOpen(false); }, [projectId, setCanvasLibraryOpen]);

  const entryFocusProject = useRef<string | null>(null);
  useEffect(() => {
    if (loading || loadFailed || projectRoutePending || entryFocusProject.current === projectId) return;
    // Wait for the project picker to close and restore its trigger focus first.
    const frame = requestAnimationFrame(() => {
      entryFocusProject.current = projectId;
      if (exploring || viewMode !== "canvas" || !sourceCollapsed || scopedInspectorOpen
        || workspaceRef.current?.closest("[inert]") || document.querySelector('[role="dialog"], [role="menu"]')) return;
      const focused = document.activeElement as HTMLElement | null;
      if (workspaceRef.current?.contains(focused) && focused?.closest('input, textarea, select, [contenteditable="true"]')) return;
      stageRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [projectId, loading, loadFailed, projectRoutePending, exploring, viewMode, sourceCollapsed, scopedInspectorOpen]);

  useEffect(() => {
    if (exploring) {
      setSourceCollapsed(true);
    }
  }, [exploring]);

  useEffect(() => {
    if (explainTutorialSources) { changeSource("project"); setSourceCollapsed(false); }
  }, [explainTutorialSources, exploring]);

  useLayoutEffect(() => {
    if (sourcePanelRef.current) sourcePanelRef.current.inert = sourceCollapsed;
    // Typing in the global search also reveals the library; keep that input focused.
    if (!sourceCollapsed && !document.activeElement?.matches('input, textarea, select, [contenteditable="true"]')) {
      sourcePanelRef.current?.focus({ preventScroll: true });
    }
  }, [sourceCollapsed]);

  useEffect(() => {
    function toggleLibrary(event: KeyboardEvent) {
      if (!["tab", "escape", "q", "e"].includes(event.key.toLowerCase()) || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing || event.keyCode === 229
        || event.defaultPrevented || exploring || workspaceRef.current?.closest("[inert]")
        || loadingRef.current || useStore.getState().projectRoutePending) return;
      const target = event.target as HTMLElement | null;
      const composerTab = event.key === "Tab" && !event.shiftKey && !!target
        && workspaceRef.current?.contains(target)
        && !!target.closest('.creation-editor .ProseMirror, [data-generation-composer] .ProseMirror');
      if (!composerTab && event.key !== "Escape" && (target?.isContentEditable || target?.closest('input, textarea, select, .app-topbar'))) return;
      if (event.key === "Escape" && target?.closest('[data-folder-path-editor]')) return;
      if (target?.closest('[role="dialog"], [role="menu"]')
        || document.querySelector('[role="dialog"], [role="menu"]') || useStore.getState().contextMenu
        || useStore.getState().projectContextMenu) return;
      const open = useStore.getState().canvasLibraryOpen;
      if (event.key !== "Tab" && !open) return;
      if (["q", "e"].includes(event.key.toLowerCase()) && target && boardShellRef.current?.contains(target)) return;
      // Escape belongs to the canvas while it is being used alongside the drawer.
      if (event.key === "Escape" && target && boardShellRef.current?.contains(target)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Escape") { closeSource(); return; }
      if (composerTab) {
        if (!open) { changeSource("global"); setCanvasLibraryOpen(true); beginOnboardingOperation("expand-source", projectId)(); }
        requestAnimationFrame(() => sourcePanelRef.current?.focus({ preventScroll: true }));
        return;
      }
      if (!open) { changeSource("global"); setCanvasLibraryOpen(true); beginOnboardingOperation("expand-source", projectId)(); return; }
      if (event.key === "Tab") useLocalFileMode.getState().toggleCatalog();
      else changeSource(event.key.toLowerCase() === "q" ? "global" : "project");
      requestAnimationFrame(() => sourcePanelRef.current?.focus({ preventScroll: true }));
    }
    window.addEventListener("keydown", toggleLibrary, true);
    return () => window.removeEventListener("keydown", toggleLibrary, true);
  }, [exploring, projectId, setCanvasLibraryOpen]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (workspaceRef.current?.closest("[inert]")) return;
      const target = event.target as HTMLElement | null;
      if ((useStore.getState().canvasLibraryOpen || useLocalFileMode.getState().open)
        && (!target || !boardShellRef.current?.contains(target))) return;
      const editing = !!target && (
        target.isContentEditable
        || target.tagName === "INPUT"
        || target.tagName === "TEXTAREA"
        || target.tagName === "SELECT"
      );
      if (document.querySelector("[data-context-owner]") || workflowAgentDetail && target?.closest("[data-project-inspector]")) return;
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z"
        && !editing && !event.defaultPrevented && !scopedInspectorOpen && viewModeRef.current === "canvas"
        && !nodeDragRef.current && !graphNodeDragRef.current
        && !document.querySelector('[role="dialog"][aria-modal="true"]') && undoHistoryRef.current.length > 0) {
        event.preventDefault();
        undoCanvasAction();
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
      if (event.key !== "Escape") return;
      if (hoverRef.current?.intent.kind === "cell" && !nodeDragRef.current) clearExternalDrag();
      setDrawingTool("select");
      sectionDrawRef.current = null;
      setSectionPreview(null);
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
          translateWorkflowSelection(nodeDragRef.current.initialWorkflow, nodeDragRef.current.selectedIds, 0, 0);
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
          translateWorkflowSelection(graphNodeDragRef.current.initialWorkflow, graphNodeDragRef.current.selectedIds, 0, 0);
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
  }, [genEditing, scopedInspectorOpen, setGenPanelOpen, workflowAgentDetail]);

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
  }, [loading, pan, viewRevision, zoom]);

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

  function setFolderExpanded(id: string, expanded: boolean) {
    const next = new Set(expandedFolderIdsRef.current);
    if (expanded) next.add(id);
    else next.delete(id);
    expandedFolderIdsRef.current = next;
    setExpandedFolderIds(next);
  }

  useEffect(() => {
    if (!pendingProductGroup) return;
    if (pendingProductGroup.projectId !== projectId) { setPendingProductGroup(null); return; }
    const folder = nodes.find(node => node.id === pendingProductGroup.id && node.kind === "folder")
      ?? graphNodes.find(node => node.id === pendingProductGroup.id && node.kind === "note" && node.hiddenAt == null);
    const bounds = stageRef.current?.getBoundingClientRect();
    if (!folder || !bounds) return;
    if (folder.kind === "folder") setFolderExpanded(folder.id, true);
    const next = canvasViewForNewCard(nodeRect(folder), { x: 80, y: 60, width: Math.max(200, bounds.width - 120), height: Math.max(200, bounds.height - 270) }, panRef.current, zoomRef.current, true);
    if (!next) { setPendingProductGroup(null); return; }
    panRef.current = next.pan; zoomRef.current = next.zoom;
    setPan(next.pan); setZoom(next.zoom); markViewDirty();
    setPendingProductGroup(null);
  }, [pendingProductGroup, projectId, nodes, graphNodes]);

  function nodeRect(node: CanvasNode | ProjectGraphNode) {
    if (node.kind === "prompt" && imageOnlyConversationIds.has(node.id)) {
      const image = selectedConversationImage(node.id, conversationImages(node.id));
      const ratio = image?.width && image?.height ? image.height / image.width : 1;
      return { x: node.x, y: node.y, width: node.width, height: node.width * ratio };
    }
    if (node.kind === "prompt" && conversationCardsRef.current.cards.get(node.id)?.outputs.length) {
      return { x: node.x, y: node.y, width: node.width, height: Math.max(node.height, 340) };
    }
    if (node.kind === "note" && "payloadJson" in node) {
      const note = readCanvasNote(node);
      if (note.note_type === "text" || note.note_type === "images") {
        const minimum = canvasTextMinSize(note.cells);
        return { x: node.x, y: node.y, width: Math.max(node.width, minimum.width), height: Math.max(node.height, minimum.height) };
      }
    }
    if (node.kind === "folder" && expandedFolderIdsRef.current.has(node.id)) {
      const rows = Math.ceil(node.assets.length / 3);
      const rowHeight = useStore.getState().settings?.canvas_show_asset_names ? 164 : 140;
      return { x: node.x, y: node.y, width: Math.max(548, node.width), height: 82 + rows * rowHeight + Math.max(0, rows - 1) * 12 };
    }
    return baseNodeRect(node);
  }

  function setHover(next: HoverIntent | null) {
    if (hoverRef.current?.intent.key === next?.key) return;
    hoverRef.current = next ? { intent: next, ready: false } : null;
    setHoverReady(false);
    setHoverIntent(next);
  }

  function hitNode(point: CanvasPoint, excludedId?: string) {
    // Overlapping images on an artboard are layers, not a request to form a folder.
    if (graphNodesRef.current.some(node => node.kind === "note" && node.hiddenAt == null && readCanvasNote(node).artboard
      && point.x >= node.x && point.y >= node.y && point.x <= node.x + node.width && point.y <= node.y + node.height)) return null;
    const contained = containedSessionOutputIds(graphNodesRef.current, canvasWorkflowController(activeCanvasRef.current.id).document.nodes);
    return findCanvasHoverTarget(
      point,
      nodesRef.current.filter(node => !contained.has(node.id) && !conversationCardsRef.current.hiddenIds.has(node.id)).map((node) => ({
        id: node.id,
        order: node.order,
        rect: nodeRect(node),
        node,
      })),
      excludedId,
    )?.node ?? null;
  }

  function hitContentCell(clientX: number, clientY: number) {
    const candidates = Array.from(stageRef.current?.querySelectorAll<HTMLElement>("[data-canvas-cell]") ?? []).flatMap(element => {
      const targetId = element.closest<HTMLElement>("[data-canvas-node-id]")?.dataset.canvasNodeId;
      const card = graphNodesRef.current.find(node => node.id === targetId && node.kind === "note" && node.hiddenAt == null);
      if (!card || workflowRef.current?.isLocked(card.id)) return [];
      const bounds = element.getBoundingClientRect();
      if (clientX < bounds.left || clientX >= bounds.right || clientY < bounds.top || clientY >= bounds.bottom) return [];
      return [{ targetId: card.id, cellId: element.dataset.canvasCell!, order: card.zIndex,
        rect: { ...toBoardPoint(bounds.left, bounds.top), width: bounds.width / zoomRef.current, height: bounds.height / zoomRef.current } }];
    });
    return candidates.sort((a, b) => b.order - a.order)[0] ?? null;
  }

  function hoverContentCell(clientX: number, clientY: number, source: WorkflowInput, movingId?: string) {
    const target = hitContentCell(clientX, clientY);
    if (!target) return false;
    setFolderDropTargetId(null);
    setHover({ kind: "cell", key: `cell:${movingId ?? source.assetId}:${target.targetId}:${target.cellId}`, ...target, source, movingId });
    return true;
  }

  function fillHoveredCell(hover: Extract<HoverIntent, { kind: "cell" }>) {
    const controller = canvasWorkflowController(activeCanvasRef.current.id);
    const pending = hover.source.canvasNodeId
      ? controller.storeCellGeneration(hover.targetId, hover.cellId, hover.source.canvasNodeId, hover.source.assetNodeId)
      : controller.storeCellImages(hover.targetId, hover.cellId, [hover.source.assetId!], hover.movingId);
    void pending.catch(error => notifyError(error, "内容未能放入单元格"));
  }

  useEffect(() => {
    if (!hoverIntent) return;
    const timer = window.setTimeout(() => {
      // Hover only arms a drop; release must still hit the same group or cell.
      if (hoverRef.current?.intent !== hoverIntent) return;
      hoverRef.current.ready = true;
      setHoverReady(true);
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
        { enabled: snapEnabledRef.current, zoom: zoomRef.current },
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

  useEffect(() => {
    const end = () => {
      if (sourceDragFrame.current !== null) cancelAnimationFrame(sourceDragFrame.current);
      sourceDragFrame.current = null;
      setLibraryDragging(false);
      clearExternalDrag();
    };
    window.addEventListener("dragend", end);
    return () => {
      window.removeEventListener("dragend", end);
      if (sourceDragFrame.current !== null) cancelAnimationFrame(sourceDragFrame.current);
    };
  }, []);

  function onCanvasDragOver(event: DragEvent<HTMLDivElement>) {
    if (event.dataTransfer.types.includes(WORKFLOW_CARD_DRAG_TYPE)) {
      event.preventDefault(); event.dataTransfer.dropEffect = "copy"; return;
    }
    const incoming = draggedSnapshots();
    if (incoming.length === 0) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setExternalDragOver(true);
    if (incoming.length === 1 && incoming[0].assetId && !isVideoPath(incoming[0].storePath)
      && hoverContentCell(event.clientX, event.clientY, { assetId: incoming[0].assetId })) return;
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

  async function onCanvasDrop(event: DragEvent<HTMLDivElement>) {
    if (event.dataTransfer.types.includes(WORKFLOW_CARD_DRAG_TYPE)) {
      event.preventDefault(); event.stopPropagation();
      if (loadingRef.current || useStore.getState().projectRoutePending || (event.target as HTMLElement).closest(".canvas-drawing-tools")) return;
      try {
        const value = JSON.parse(event.dataTransfer.getData(WORKFLOW_CARD_DRAG_TYPE));
        if (value.projectId !== projectId || !["text", "bubble", "instruction", "generation", "skill", "agent", "visual-profile", "loop", ...(import.meta.env.DEV ? ["planner"] : [])].includes(value.kind)) return;
        const point = toBoardPoint(event.clientX, event.clientY);
        placeCanvasCard(value.kind, point);
      } catch { /* Ignore unrelated or malformed external drag payloads. */ }
      return;
    }
    let incoming = draggedSnapshots();
    const draggedIds = getDragAssets() ?? [];
    if (draggedIds.length === 0) return;
    event.preventDefault();
    const expectedProject = activeCanvasRef.current.id;
    const expectedRevision = useStore.getState().projectRouteRevision;
    const clientX = event.clientX, clientY = event.clientY;
    const hover = hoverRef.current;
    // Virtualized library pages can have evicted selected items. Resolve all
    // missing identities before committing, never silently drop only a subset.
    const known = new Set(incoming.map(asset => asset.assetId));
    const missing = draggedIds.filter(id => !known.has(id));
    if (missing.length) {
      try {
        const resolved: Asset[] = [];
        for (let i = 0; i < missing.length; i += 200) resolved.push(...await api.getAssetsByIds(missing.slice(i, i + 200)));
        const state = useStore.getState();
        if (state.activeProjectId !== expectedProject || state.projectRouteRevision !== expectedRevision || state.projectRoutePending) return;
        if (resolved.length !== missing.length) throw new Error("部分所选素材已不存在，请重新选择");
        const byId = new Map(incoming.map(asset => [asset.assetId, asset]));
        resolved.forEach(asset => byId.set(asset.id, createCanvasAssetSnapshot(asset, canvasId("asset"))));
        incoming = draggedIds.map(id => byId.get(id)!);
      } catch (error) { clearExternalDrag(); notifyError(error, "无法添加所选素材"); return; }
    }
    setExternalDragOver(false);
    setHover(null);
    setFolderDropTargetId(null);
    const cell = hitContentCell(clientX, clientY);
    if (hover?.ready && hover.intent.kind === "cell" && !hover.intent.movingId && incoming.length === 1
      && incoming[0].assetId === hover.intent.source.assetId && cell?.targetId === hover.intent.targetId && cell.cellId === hover.intent.cellId) {
      fillHoveredCell(hover.intent);
      externalInstancesRef.current = null;
      return;
    }
    const point = toBoardPoint(clientX, clientY);
    const target = hitNode(point);
    if (target && (target.kind === "folder" || (hover?.ready
      && hover.intent.kind === "external" && hover.intent.targetId === target.id
      && hover.intent.assets === incoming))) {
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
        const group = next.find((node): node is CanvasFolderNode => node.kind === "folder"
          && node.assets.some((asset) => asset.id === incoming[0].id));
        if (group) {
          const newIds = new Set(incoming.map((asset) => asset.id));
          const newMembers = group.assets
            .filter((asset) => newIds.has(asset.id))
            .map((asset, index) => groupedAssetNode(asset, group, index));
          if (target.kind === "folder") persistGroupMembership(group, newMembers);
          else persistCreatedGroup(group, newMembers);
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
    const contained = containedSessionOutputIds(graph, canvasWorkflowController(activeCanvasRef.current.id).document.nodes);
    const historyIds = hiddenWorkflowSessionIds(canvasWorkflowController(activeCanvasRef.current.id).document.nodes);
    return [
      ...(workflowRef.current?.bounds() ?? []).map(node => ({ id: node.id, order: 9000, rect: node })),
      ...materials.filter(node => !contained.has(node.id) && !conversationCardsRef.current.hiddenIds.has(node.id)).map((node) => ({ id: node.id, order: node.order, rect: nodeRect(node) })),
      ...graph.filter((node) => (node.kind === "prompt" || node.kind === "agent_group" || node.kind === "note")
        && !agentPrompts.has(node.id) && !historyIds.has(node.id) && !conversationCardsRef.current.hiddenIds.has(node.id)
        && node.hiddenAt == null && (!node.threadId || !archived.has(node.threadId)))
        .map((node) => ({ id: node.id, order: node.zIndex, rect: nodeRect(node) })),
    ];
  }

  function translateWorkflowSelection(initial: WorkflowGeometry[], ids: Set<string>, dx: number, dy: number) {
    workflowRef.current?.position(new Map(initial.filter(node => ids.has(node.id)).map(node => [node.id, { x: node.x + dx, y: node.y + dy }])));
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
    const sections = graphNodesRef.current.filter(node => node.kind === "note" && node.hiddenAt == null && readCanvasNote(node).note_type === "section");
    const sectionOwners = new Map(sections.flatMap(section => readCanvasNote(section).member_ids.map(id => [id, section.id] as const)));
    const allAnchors = selectionAnchors().filter(node => !workflowRef.current?.isLocked(node.id));
    const anchors = allAnchors.filter(anchor => !sectionOwners.has(anchor.id));
    const resolveAnchor = (id: string) => sectionOwners.get(aliases.get(id) ?? id) ?? aliases.get(id) ?? id;
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
      fromNodeId: resolveAnchor(edge.fromNodeId),
      toNodeId: resolveAnchor(edge.toNodeId),
    })), [...nodeIds].map(resolveAnchor));
    if (positions.size === 0) return;
    for (const section of sections) {
      const position = positions.get(section.id);
      if (!position) continue;
      for (const member of allAnchors.filter(anchor => sectionOwners.get(anchor.id) === section.id)) {
        positions.set(member.id, { x: member.rect.x + position.x - section.x, y: member.rect.y + position.y - section.y });
      }
    }
    const beforeMaterials = nodesRef.current, beforeGraph = graphNodesRef.current, beforeWorkflow = workflowRef.current?.bounds() ?? [];
    workflowRef.current?.position(positions, true);
    const next = nodesRef.current.map((node) => positions.has(node.id) ? { ...node, ...positions.get(node.id)! } : node);
    const graph = graphNodesRef.current.map((node) => positions.has(node.id) ? { ...node, ...positions.get(node.id)! } : node);
    commitNodes(next);
    graphNodesRef.current = graph;
    setGraphNodes(graph);
    pushGeometryUndo(beforeMaterials, beforeGraph, beforeWorkflow);
    setSelectedCanvasNodeIds(new Set(positions.keys()));
    persistGeometries(next.filter((node) => positions.has(node.id)));
    for (const node of graph) {
      if (positions.has(node.id) && node.kind !== "asset") persistGraphNodeGeometry(node);
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
      const frozenProject = activeCanvasRef.current;
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
        // Persist to the frozen project even when indexing finishes after navigation.
        await enqueueWrite(async () => {
          await ensureMaterialized(frozenProject);
          await api.projectCanvasNodeCreate(newProjectCanvasAssetNode(projectId, node));
          const route = useStore.getState();
          if (stage?.isConnected && activeCanvasRef.current.id === projectId
            && route.activeProjectId === projectId && !route.projectRoutePending) {
            setCanvasAssets(current => [...current.filter(item => item.id !== asset.id), asset]);
            commitNodes([...nodesRef.current.filter(existing => existing.id !== node.id), node]);
          }
        });
        if (writeJournalRef.current.failure != null) throw writeJournalRef.current.failure;
        return node.id;
      };
    }
    stage.addEventListener(EXPLORER_CANVAS_DROP_EVENT, prepareDrop);
    return () => stage.removeEventListener(EXPLORER_CANVAS_DROP_EVENT, prepareDrop);
  }, []);

  useEffect(() => {
    let alive = true;
    let cleanup: (() => void) | undefined;
    if (!projectId) return;
    const targetProjectId = projectId;
    listen("external-files://changed", async () => {
      try {
        const snapshot = await api.projectCanvasGet(targetProjectId);
        const exact = await api.getAssetsByIds(projectCanvasAssetIds(snapshot.nodes));
        if (alive) setCanvasAssets(exact);
      } catch (reason) { if (alive) reportError(reason); }
    }).then(fn => { if (alive) cleanup = fn; else fn(); });
    return () => { alive = false; cleanup?.(); };
  }, [projectId]);

  function openCanvasNodeMenu(event: React.MouseEvent<HTMLElement>, nodeId: string, node: ProjectGraphNode | null = null) {
    event.preventDefault();
    event.stopPropagation();
    useStore.getState().closeContextMenu();
    const nodeIds = selectedCanvasNodeIdsRef.current.has(nodeId) ? [...selectedCanvasNodeIdsRef.current] : [nodeId];
    const folder = nodesRef.current.find((candidate): candidate is CanvasFolderNode => candidate.id === nodeId && candidate.kind === "folder");
    const section = graphNodesRef.current.find(candidate => candidate.id === nodeId && candidate.kind === "note" && readCanvasNote(candidate).note_type === "section");
    setPromptMenu({ node, nodeIds, folder, x: event.clientX, y: event.clientY, point: null,
      ...(section ? { section: { id: section.id, name: readCanvasNote(section).text } } : {}) });
  }

  useEffect(() => {
    const prepare = () => {
      const bounds = stageRef.current?.getBoundingClientRect();
      const route = useStore.getState();
      if (!bounds || loadingRef.current || route.projectRoutePending
        || route.activeProjectId !== activeCanvasRef.current.id) return null;
      return prepareAnnotatedImageAt(toBoardPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2));
    };
    useStore.setState({ prepareCanvasAnnotation: prepare });
    return () => {
      if (useStore.getState().prepareCanvasAnnotation === prepare) useStore.setState({ prepareCanvasAnnotation: null });
    };
  }, []);

  function prepareAnnotatedImageAt(point: CanvasPoint) {
    const project = activeCanvasRef.current;
    const stage = stageRef.current;
    const nodeId = canvasId("asset");
    let savedAsset: Asset | null = null;
    let queued = false;
    let completed = false;
    return async (dataUrl: string, meta: AnnotationMeta, fileName: string) => {
      // A failed queued write is retried in place, without importing another image.
      await retryPendingWrites();
      if (completed) return;
      if (!queued) {
        queued = true;
        await enqueueWrite(async () => {
          await ensureMaterialized(project);
          savedAsset ??= await api.saveAnnotatedImage({
            dataUrl, fileName, projectId: project.id, annotationJson: JSON.stringify(meta),
          });
          const snapshot = createCanvasAssetSnapshot(savedAsset, nodeId);
          const size = assetNodeSize(snapshot);
          const node: CanvasAssetNode = {
            kind: "asset", id: nodeId, asset: snapshot,
            x: point.x - size.width / 2, y: point.y - size.height / 2, ...size,
            order: nodesRef.current.reduce((max, node) => Math.max(max, node.order), 0) + 1,
          };
          await api.projectCanvasNodeCreate(newProjectCanvasAssetNode(project.id, node));
          completed = true;
          const route = useStore.getState();
          if (stage?.isConnected && activeCanvasRef.current.id === project.id
            && route.activeProjectId === project.id && !route.projectRoutePending) {
            setCanvasAssets((current) => [...current.filter(asset => asset.id !== savedAsset!.id), savedAsset!]);
            commitNodes([...nodesRef.current.filter(existing => existing.id !== node.id), node]);
          }
        });
      }
      if (writeJournalRef.current.failure != null) throw writeJournalRef.current.failure;
    };
  }

  function newDraftAt(point: CanvasPoint) {
    if (loadingRef.current || useStore.getState().projectRoutePending) return;
    setPromptMenu(null);
    const save = prepareAnnotatedImageAt(point);
    useStore.getState().openDraftAnnotator((dataUrl, meta) => save(dataUrl, meta, "草稿"));
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
    if (isCanvasPanGesture(event.button, spacePressedRef.current, drawingTool === "pan") || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    window.getSelection()?.removeAllRanges();
    event.currentTarget.focus({ preventScroll: true });
    const point = toBoardPoint(event.clientX, event.clientY);
    const toggleSelection = event.ctrlKey || event.metaKey;
    const selectedIds = expandArtboardSelection(toggleSelection || selectedCanvasNodeIdsRef.current.has(node.id)
      ? new Set([...selectedCanvasNodeIdsRef.current, node.id])
      : new Set([node.id]));
    nodeDragRef.current = {
      nodeId: node.id,
      toggleSelection,
      selectedIds,
      initialNodes: nodesRef.current,
      initialGraphNodes: graphNodesRef.current,
      initialWorkflow: workflowRef.current?.bounds() ?? [],
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

  function beginGraphNodeDrag(event: PointerEvent<HTMLElement>, node: { id: string; x: number; y: number; kind: string }) {
    if (isCanvasPanGesture(event.button, spacePressedRef.current, drawingTool === "pan") || event.button !== 0) return;
    setPendingNewCards(pending => pending.filter(id => id !== node.id));
    // Readonly rich text can opt back into selection inside a draggable card.
    event.preventDefault();
    event.stopPropagation();
    window.getSelection()?.removeAllRanges();
    const point = toBoardPoint(event.clientX, event.clientY);
    const toggleSelection = event.ctrlKey || event.metaKey;
    const isWorkflow = workflowRef.current?.bounds().some(item => item.id === node.id);
    if (isWorkflow) stageRef.current?.focus({ preventScroll: true });
    else event.currentTarget.focus({ preventScroll: true });
    graphNodeDragRef.current = {
      nodeId: node.id,
      toggleSelection,
      initialNodes: graphNodesRef.current,
      initialMaterialNodes: nodesRef.current,
      initialWorkflow: workflowRef.current?.bounds() ?? [],
      selectedIds: expandArtboardSelection(toggleSelection || selectedCanvasNodeIdsRef.current.has(node.id)
        ? new Set([...selectedCanvasNodeIdsRef.current, node.id]) : new Set([node.id])),
      pointerId: event.pointerId,
      offsetX: point.x - node.x,
      offsetY: point.y - node.y,
      startClientX: event.clientX,
      startClientY: event.clientY,
      moved: false,
    };
    if (!toggleSelection) {
      if (!isWorkflow) focusGraphNode(node.id);
      if (!selectedCanvasNodeIdsRef.current.has(node.id)) setSelectedCanvasNodeIds(new Set(node.kind === "note" || isWorkflow ? [node.id] : []));
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
    const origin = drag.initialNodes.find((node) => node.id === drag.nodeId) ?? drag.initialWorkflow.find(node => node.id === drag.nodeId);
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
      { enabled: snapEnabledRef.current, zoom: zoomRef.current },
    );
    setGuides(snapped.guides);
    translateGraphSelection(drag.initialNodes, drag.selectedIds, snapped.x - origin.x, snapped.y - origin.y);
    translateWorkflowSelection(drag.initialWorkflow, drag.selectedIds, snapped.x - origin.x, snapped.y - origin.y);
    commitNodes(translateCanvasSelection(drag.initialMaterialNodes, drag.selectedIds, snapped.x - origin.x, snapped.y - origin.y));
    const conversation = conversationCardsRef.current.cards.get(drag.nodeId);
    if (conversation && drag.selectedIds.size === 1) {
      const latest = conversation.latest;
      const selected = selectedConversationImage(drag.nodeId, conversationImages(drag.nodeId));
      const output = selected && conversation.outputs.find(node => node.id === selected.id);
      const summary = promptNodeSummary(latest);
      const selectedSession = summary.status === "done" && output ? conversation.sessions.find(session => canvasSessionImages(session, graphNodesRef.current).some(item => item.id === output.id)) : undefined;
      const source = { canvasNodeId: selectedSession?.id ?? latest.id, cellId: "image", ...(selectedSession && output ? { assetNodeId: output.id } : {}) };
      if (hoverContentCell(event.clientX, event.clientY, source, drag.nodeId)) return;
    }
    setHover(null);
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
    const isWorkflow = drag.initialWorkflow.some(node => node.id === drag.nodeId);
    if (cancelled && !isWorkflow) suppressNodeClickRef.current = true;
    const node = graphNodesRef.current.find((candidate) => candidate.id === drag.nodeId) ?? drag.initialWorkflow.find(candidate => candidate.id === drag.nodeId);
    if (!cancelled && !drag.moved && drag.toggleSelection) {
      toggleCanvasNodeSelection(drag.nodeId);
      if (!isWorkflow) suppressNodeClickRef.current = true;
    }
    const hover = hoverRef.current;
    const cell = !cancelled && drag.moved && drag.selectedIds.size === 1 ? hitContentCell(event.clientX, event.clientY) : null;
    const drop = cell && hover?.ready && hover.intent.kind === "cell" && hover.intent.movingId === drag.nodeId
      && hover.intent.source.canvasNodeId && hover.intent.targetId === cell.targetId && hover.intent.cellId === cell.cellId ? hover.intent : null;
    if (cancelled && drag.moved) {
      translateGraphSelection(drag.initialNodes, drag.selectedIds, 0, 0);
      translateWorkflowSelection(drag.initialWorkflow, drag.selectedIds, 0, 0);
      commitNodes(drag.initialMaterialNodes);
    } else if (drop) {
      suppressNodeClickRef.current = true;
      // The cell owns presentation only after its save succeeds; preserve the source geometry.
      translateGraphSelection(drag.initialNodes, drag.selectedIds, 0, 0);
      commitNodes(drag.initialMaterialNodes);
      fillHoveredCell(drop);
    } else if (drag.moved && node) {
      suppressNodeClickRef.current = true;
      pushGeometryUndo(drag.initialMaterialNodes.filter((candidate) => drag.selectedIds.has(candidate.id)),
        drag.initialNodes.filter((candidate) => drag.selectedIds.has(candidate.id)), drag.initialWorkflow.filter(node => drag.selectedIds.has(node.id)));
      workflowRef.current?.position(new Map((workflowRef.current.bounds() ?? []).filter(node => drag.selectedIds.has(node.id)).map(node => [node.id, node])), true);
      for (const selected of graphNodesRef.current.filter((candidate) => drag.selectedIds.has(candidate.id) && candidate.kind !== "asset" && candidate.hiddenAt == null)) persistGraphNodeGeometry(selected);
      persistGeometries(nodesRef.current.filter((candidate) => drag.selectedIds.has(candidate.id)));
    }
    graphNodeDragRef.current = null;
    setHover(null);
    setActiveDragId(null);
    setGuides([]);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function canvasImagesForSelection(nodeIds: Iterable<string>, includeVideos = false) {
    const ids = new Set(nodeIds);
    for (const id of [...ids]) for (const output of conversationCardsRef.current.cards.get(id)?.outputs ?? []) ids.add(output.id);
    const images = new Map<string, { assetId: string; canvasNodeId: string }>();
    for (const node of nodesRef.current) {
      if (!ids.has(node.id)) continue;
      for (const asset of node.kind === "asset" ? [node.asset] : node.assets) {
        if (asset.assetId && asset.storePath && (includeVideos || !isVideoPath(asset.storePath)) && !images.has(asset.assetId)) {
          images.set(asset.assetId, { assetId: asset.assetId, canvasNodeId: asset.id });
        }
      }
    }
    return [...images.values()];
  }

  function addCanvasImagesToBoard(nodeIds: Iterable<string>) {
    if (loadingRef.current || useStore.getState().projectRoutePending) return;
    setPromptMenu(null);
    for (const asset of canvasImagesForSelection(nodeIds)) {
      window.dispatchEvent(new CustomEvent(BOARD_ASSET_PICK_EVENT, { detail: asset }));
    }
    setSelectedCanvasNodeIds(new Set());
  }

  function openCanvasAssetContextMenu(
    event: React.MouseEvent<HTMLElement>,
    selectionNode: CanvasNode,
    selectedAsset: CanvasAssetSnapshot,
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (selectedCanvasNodeIdsRef.current.has(selectionNode.id) && canvasWorkflowController(activeCanvasRef.current.id).document.nodes.some(node => selectedCanvasNodeIdsRef.current.has(node.id))) {
      openCanvasNodeMenu(event, selectionNode.id);
      return;
    }
    if (!selectedAsset.assetId) {
      openCanvasNodeMenu(event, selectionNode.id);
      return;
    }
    setPromptMenu(null);
    const selectedIds = selectedCanvasNodeIdsRef.current.has(selectionNode.id)
      ? new Set(selectedCanvasNodeIdsRef.current)
      : new Set([selectionNode.id]);
    openContextMenu(event.clientX, event.clientY, selectedAsset.assetId, {
      ungroupCanvasFolder: selectionNode.kind === "folder" ? () => ungroupFolder(selectionNode) : undefined,
      addCanvasImagesToBoard: {
        count: canvasImagesForSelection(selectedIds).length,
        run: () => addCanvasImagesToBoard(selectedIds),
      },
      asset: assetById.get(selectedAsset.assetId),
      canvasSelection: {
        projectId: activeCanvasRef.current.id,
        nodeIds: [...selectedIds],
        assetIds: selectedIds.size > 1
          ? canvasImagesForSelection(selectedIds, true).map(asset => asset.assetId)
          : [selectedAsset.assetId],
      },
    });
  }

  async function addVideoFrame(frame: VideoFrame) {
    const project = activeCanvasRef.current;
    const stage = stageRef.current;
    const route = useStore.getState();
    if (!stage || loadingRef.current || route.projectRoutePending || route.activeProjectId !== project.id) {
      throw new Error("请等待当前画板加载完成");
    }
    const key = `${project.id}\u0000${frame.path}\u0000${frame.time}`;
    let save = videoFrameSaves.current.get(key);
    if (!save) {
      const { path, time } = frame;
      let dataUrl = frame.dataUrl;
      const bounds = stage.getBoundingClientRect();
      const composer = stage.parentElement?.querySelector(".canvas-composer-host")?.getBoundingClientRect();
      const visibleBottom = composer && composer.height > 0 ? Math.min(bounds.bottom, composer.top) : bounds.bottom;
      const center = toBoardPoint(bounds.left + bounds.width / 2, (bounds.top + visibleBottom) / 2);
      const sections = new Set(graphNodesRef.current.filter(node => node.kind === "note"
        && readCanvasNote(node).note_type === "section").map(node => node.id));
      const elements = new Map(Array.from(stage.querySelectorAll<HTMLElement>("[data-canvas-node-id]"))
        .map(element => [element.dataset.canvasNodeId, element]));
      const anchors = selectionAnchors().filter(anchor => !sections.has(anchor.id)).map(anchor => {
        const rect = elements.get(anchor.id)?.getBoundingClientRect();
        return { ...anchor, rect: rect ? { ...toBoardPoint(rect.left, rect.top), width: rect.width / zoomRef.current,
          height: rect.height / zoomRef.current } : { ...anchor.rect } };
      });
      const sourceIds = new Set(nodesRef.current.flatMap(node => node.kind === "folder"
        ? node.assets.some(asset => asset.storePath === path) ? [node.id] : []
        : node.asset.storePath === path ? [conversationCardsRef.current.aliases.get(node.id) ?? node.id] : []));
      const distance = (rect: CanvasRect) => (rect.x + rect.width / 2 - center.x) ** 2 + (rect.y + rect.height / 2 - center.y) ** 2;
      const source = anchors.filter(anchor => sourceIds.has(anchor.id)).sort((a, b) =>
        Number(selectedCanvasNodeIds.has(b.id)) - Number(selectedCanvasNodeIds.has(a.id)) || distance(a.rect) - distance(b.rect))[0]?.rect;
      const obstacles = anchors.map(anchor => anchor.rect);
      const nodeId = canvasId("asset");
      let savedAsset: Asset | null = null, queued = false, completed = false;
      save = async () => {
        await retryPendingWrites();
        if (completed) return;
        if (!queued) {
          queued = true;
          await enqueueWrite(async () => {
            await ensureMaterialized(project);
            savedAsset ??= await api.importImageBytes({ dataUrl, projectId: project.id, source: "video-frame",
              fileName: `${path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "视频"}-${videoTime(time).replace(/:/g, "-")}.png` });
            dataUrl = "";
            const snapshot = createCanvasAssetSnapshot(savedAsset, nodeId);
            const size = assetNodeSize(snapshot);
            const origin = source ? { x: source.x + source.width + 32, y: source.y } : { x: center.x - size.width / 2, y: center.y - size.height / 2 };
            const position = source ? placeCanvasCardNearSource({ ...origin, ...size }, obstacles) : origin;
            const node: CanvasAssetNode = { kind: "asset", id: nodeId, asset: snapshot, ...position, ...size,
              order: nodesRef.current.reduce((max, node) => Math.max(max, node.order), 0) + 1 };
            await api.projectCanvasNodeCreate(newProjectCanvasAssetNode(project.id, node));
            completed = true;
            const current = useStore.getState();
            if (stage.isConnected && activeCanvasRef.current.id === project.id && current.activeProjectId === project.id && !current.projectRoutePending) {
              setCanvasAssets(assets => [...assets.filter(asset => asset.id !== savedAsset!.id), savedAsset!]);
              commitNodes([...nodesRef.current.filter(existing => existing.id !== node.id), node]);
              setSelectedCanvasNodeIds(new Set([node.id]));
            }
          });
        }
        if (writeJournalRef.current.failure != null) throw writeJournalRef.current.failure;
      };
      videoFrameSaves.current.set(key, save);
    }
    await save();
    videoFrameSaves.current.delete(key);
  }

  async function saveVideoTrim(request: VideoTrimRequest): Promise<Asset> {
    const project = activeCanvas;
    const stage = stageRef.current;
    if (!stage || loadingRef.current || useStore.getState().activeProjectId !== project.id || useStore.getState().projectRoutePending) {
      throw new Error("请等待当前画板加载完成");
    }
    const key = JSON.stringify([project.id, request]);
    let save = videoTrimSaves.current.get(key);
    if (!save) {
      const bounds = stage.getBoundingClientRect();
      const center = toBoardPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      const source = nodesRef.current.find(node => node.kind === "asset" && node.asset.storePath === request.sourcePath);
      const frozenPan = { ...panRef.current }, frozenZoom = zoomRef.current;
      const obstacles = nodesRef.current.map(nodeRect);
      const nodeId = canvasId("asset");
      let asset: Asset | null = null, queued = false;
      save = async () => {
        await retryPendingWrites();
        await ensureMaterialized(project);
        asset ??= await api.trimVideo(request, project.id);
        if (!queued) {
          queued = true;
          await enqueueWrite(async () => {
            if (!asset) throw new Error("视频尚未保存完成");
            if (!request.overwrite) {
              const snapshot = createCanvasAssetSnapshot(asset, nodeId);
              const size = assetNodeSize(snapshot);
              const origin = source ? { x: source.x + source.width + 32, y: source.y } : center;
              const position = canvasPlacementForNewCard({ ...origin, ...size }, { x: 0, y: 0, width: bounds.width, height: bounds.height },
                frozenPan, frozenZoom, obstacles) ?? origin;
              const node: CanvasAssetNode = { kind: "asset", id: nodeId, asset: snapshot, ...position, ...size,
                order: nodesRef.current.reduce((max, item) => Math.max(max, item.order), 0) + 1 };
              await api.projectCanvasNodeCreate(newProjectCanvasAssetNode(project.id, node));
              if (stage.isConnected && activeCanvasRef.current.id === project.id && useStore.getState().activeProjectId === project.id && !useStore.getState().projectRoutePending) {
                commitNodes([...nodesRef.current.filter(item => item.id !== nodeId), node]);
                setSelectedCanvasNodeIds(new Set([nodeId]));
              }
            }
            if (activeCanvasRef.current.id === project.id && useStore.getState().activeProjectId === project.id && !useStore.getState().projectRoutePending) {
              setCanvasAssets(current => [...current.filter(item => item.id !== asset!.id), asset!]);
            }
          });
        }
        if (writeJournalRef.current.failure != null) throw writeJournalRef.current.failure;
        if (!asset) throw new Error("视频尚未保存完成");
        return asset;
      };
      videoTrimSaves.current.set(key, save);
    }
    const asset = await save();
    videoTrimSaves.current.delete(key);
    return asset;
  }

  function activateCanvasMaterial(node: CanvasNode, assetAnchor?: HTMLElement) {
    if (node.kind === "folder") {
      setFolderExpanded(node.id, true);
      return;
    }
    if (isVideoPath(node.asset.storePath) && node.asset.storePath) {
      setCanvasLightbox({ images: [node.asset.storePath], index: 0 });
      return;
    }
    const state = useStore.getState();
    if (canvasPrimaryMaterialAction(state.boardOpen, !!state.genEditing) === "compose") {
      const assetIds = [node.asset]
        .flatMap((asset) => asset.assetId ? [{ assetId: asset.assetId, canvasNodeId: asset.id }] : []);
      if (assetIds.length === 1 && state.promptedAssets.some(
        (asset) => asset.id === assetIds[0].assetId && asset.sections && asset.sections.length > 0,
      )) {
        const anchor = assetAnchor ?? Array.from(stageRef.current?.querySelectorAll<HTMLElement>("[data-canvas-node-id]") ?? [])
          .find((element) => element.dataset.canvasNodeId === node.id);
        if (anchor) {
          window.dispatchEvent(new CustomEvent("bowerbird://board-asset-peek", {
            detail: { assetId: assetIds[0].assetId, anchor },
          }));
        }
      } else {
        for (const asset of assetIds) {
          window.dispatchEvent(new CustomEvent(BOARD_ASSET_PICK_EVENT, { detail: asset }));
        }
      }
      return;
    }

    const images = [node.asset]
      .map((asset) => asset.storePath ?? asset.thumbPath)
      .filter((path): path is string => !!path);
    if (images.length > 0) setCanvasLightbox({ images, index: 0 });
  }

  const openCanvasSourcePreview = useCallback((asset: Asset, group?: Asset[]) => {
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
  }, []);

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
      width: nodeRect(originMoving).width,
      height: nodeRect(originMoving).height,
    };
    const snapped = snapCanvasRect(
      raw,
      selectionAnchors(drag.initialNodes, drag.initialGraphNodes).filter((node) => !drag.selectedIds.has(node.id)),
      { enabled: snapEnabledRef.current, zoom: zoomRef.current },
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
    translateWorkflowSelection(drag.initialWorkflow, drag.selectedIds, snapped.x - originMoving.x, snapped.y - originMoving.y);
    const moving = next.find((node) => node.id === drag.nodeId);
    if (drag.selectedIds.size > 1 || moving?.kind !== "asset") {
      setHover(null);
      setFolderDropTargetId(null);
      return;
    }
    if (moving.asset.assetId && !isVideoPath(moving.asset.storePath)
      && hoverContentCell(event.clientX, event.clientY, { assetId: moving.asset.assetId, assetNodeId: moving.id }, moving.id)) return;
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
    const hover = hoverRef.current;
    const cell = !cancelled && drag.moved && drag.selectedIds.size === 1 ? hitContentCell(event.clientX, event.clientY) : null;
    const target = !cancelled && drag.moved && drag.selectedIds.size === 1
      ? hitNode(toBoardPoint(event.clientX, event.clientY), drag.nodeId)
      : null;
    if (cancelled && drag.moved) {
      commitNodes(drag.initialNodes);
      translateGraphSelection(drag.initialGraphNodes, drag.selectedIds, 0, 0);
      translateWorkflowSelection(drag.initialWorkflow, drag.selectedIds, 0, 0);
    } else if (!cancelled && !drag.moved && moving) {
      if (drag.toggleSelection) toggleCanvasNodeSelection(moving.id);
      else activateCanvasMaterial(moving);
    } else if (!cancelled && moving?.kind === "asset" && cell && hover?.ready && hover.intent.kind === "cell"
      && hover.intent.movingId === moving.id && hover.intent.targetId === cell.targetId && hover.intent.cellId === cell.cellId) {
      // Keep the source at its saved position until the cell write succeeds and removes it.
      commitNodes(drag.initialNodes);
      translateGraphSelection(drag.initialGraphNodes, drag.selectedIds, 0, 0);
      fillHoveredCell(hover.intent);
    } else if (!cancelled && moving?.kind === "asset" && target
      && (target.kind === "folder" || (hover?.ready && hover.intent.kind === "internal"
        && hover.intent.movingId === moving.id && hover.intent.targetId === target.id))) {
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
        const group = next.find((node): node is CanvasFolderNode => node.kind === "folder"
          && node.assets.some((asset) => asset.id === moving.id));
        if (group && target.kind === "folder") persistGroupMembership(group, [], moving);
        else if (group) persistCreatedGroup(group, [], moving);
      }
    } else if (moving && drag.moved) {
      pushGeometryUndo(drag.initialNodes.filter((candidate) => drag.selectedIds.has(candidate.id)),
        drag.initialGraphNodes.filter((candidate) => drag.selectedIds.has(candidate.id)), drag.initialWorkflow.filter(node => drag.selectedIds.has(node.id)));
      workflowRef.current?.position(new Map((workflowRef.current.bounds() ?? []).filter(node => drag.selectedIds.has(node.id)).map(node => [node.id, node])), true);
      persistGeometries(nodesRef.current.filter((node) => drag.selectedIds.has(node.id)));
      for (const selected of graphNodesRef.current.filter((node) => drag.selectedIds.has(node.id) && node.kind !== "asset" && node.hiddenAt == null)) persistGraphNodeGeometry(selected);
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

  function updateCanvasNote(nodeId: string, value: CanvasNotePayload, size?: { width: number; height: number }) {
    const payloadJson = JSON.stringify(value);
    const node = graphNodesRef.current.find(candidate => candidate.id === nodeId);
    if (!node) return;
    const minimum = value.note_type !== "section" ? canvasTextMinSize(value.cells, value.note_type === "images", value.note_type === "bubble") : node;
    const updated = { ...node, payloadJson, width: Math.max(size?.width ?? node.width, minimum.width), height: Math.max(size?.height ?? node.height, minimum.height) };
    graphNodesRef.current = graphNodesRef.current.map(candidate => candidate.id === nodeId ? updated : candidate);
    setGraphNodes(graphNodesRef.current);
    void enqueueWrite(async () => { await api.projectCanvasNoteUpdate(nodeId, payloadJson); });
    if (updated.width !== node.width || updated.height !== node.height) persistGraphNodeGeometry(updated);
  }

  function resizeCanvasNote(nodeId: string, size: { width: number; height: number; x?: number; y?: number }, finished: boolean, cancelled = false) {
    const node = graphNodesRef.current.find(candidate => candidate.id === nodeId);
    if (!node) return;
    if (!resizeBaselineRef.current.has(nodeId)) resizeBaselineRef.current.set(nodeId, { graph: node });
    const updated = { ...node, ...size };
    graphNodesRef.current = graphNodesRef.current.map(candidate => candidate.id === nodeId ? updated : candidate);
    setGraphNodes(graphNodesRef.current);
    setActiveDragId(finished ? null : nodeId);
    if (finished) {
      const baseline = resizeBaselineRef.current.get(nodeId)?.graph;
      resizeBaselineRef.current.delete(nodeId);
      if (!cancelled) {
        if (baseline) pushGeometryUndo([], [baseline]);
        persistGraphNodeGeometry(updated);
        const value = readCanvasNote(updated);
        if (value.note_type === "section" && !value.workflow_container && !value.artboard) updateCanvasNote(nodeId, { ...value, member_ids: claimSectionMembers(updated, nodeId) });
      }
    }
  }

  function resizeCanvasMaterial(nodeId: string, size: { width: number; height: number }, finished: boolean, cancelled = false) {
    const node = nodesRef.current.find(candidate => candidate.id === nodeId);
    if (!node) return;
    if (!resizeBaselineRef.current.has(nodeId)) resizeBaselineRef.current.set(nodeId, { material: node });
    const updated = { ...node, ...size };
    commitNodes(nodesRef.current.map(candidate => candidate.id === nodeId ? updated : candidate));
    setActiveDragId(finished ? null : nodeId);
    if (finished) {
      const baseline = resizeBaselineRef.current.get(nodeId)?.material;
      resizeBaselineRef.current.delete(nodeId);
      if (!cancelled) {
        if (baseline) pushGeometryUndo([baseline], []);
        persistGeometries([updated]);
      }
    }
  }

  function claimSectionMembers(rect: CanvasRect, sectionId?: string) {
    const otherSections = new Set(graphNodesRef.current.filter(node => node.kind === "note" && readCanvasNote(node).note_type === "section").map(node => node.id));
    const enclosedMembers = new Set(graphNodesRef.current.filter(node => node.kind === "note" && node.hiddenAt == null && node.id !== sectionId && readCanvasNote(node).workflow_container).flatMap(node => readCanvasNote(node).member_ids));
    const anchors = selectionAnchors().filter(anchor => !otherSections.has(anchor.id) && !enclosedMembers.has(anchor.id));
    const elements = new Map(Array.from(stageRef.current?.querySelectorAll<HTMLElement>("[data-canvas-node-id]") ?? [])
      .map(element => [element.dataset.canvasNodeId, element]));
    for (const anchor of anchors) {
      const bounds = elements.get(anchor.id)?.getBoundingClientRect();
      if (bounds) anchor.rect = { ...anchor.rect, width: bounds.width / zoomRef.current, height: bounds.height / zoomRef.current };
    }
    const members = canvasSectionMembers(rect, anchors);
    // A card belongs to the most recently drawn section, never two moving parents.
    for (const node of graphNodesRef.current) {
      if (node.id === sectionId || !otherSections.has(node.id) || node.hiddenAt != null) continue;
      const value = readCanvasNote(node);
      if (value.member_ids.some(id => members.includes(id))) updateCanvasNote(node.id, { ...value, member_ids: value.member_ids.filter(id => !members.includes(id)) });
    }
    return members;
  }

  /** 命中光标所在分区；多个分区重叠时取最新创建的那个。 */
  function sectionUnderPoint(point: CanvasPoint): ProjectGraphNode | null {
    let found: ProjectGraphNode | null = null;
    for (const node of graphNodesRef.current) {
      if (node.kind !== "note" || node.hiddenAt != null || readCanvasNote(node).note_type !== "section") continue;
      if (point.x >= node.x && point.x <= node.x + node.width && point.y >= node.y && point.y <= node.y + node.height) found = node;
    }
    return found;
  }

  function artboardImages(frame: CanvasRect): ArtboardImage[] {
    return visibleMaterials.flatMap(node => {
      if (node.kind !== "asset" || !node.asset.assetId || isVideoPath(node.asset.storePath)) return [];
      if (!intersectArtboard(frame, nodeRect(node))) return [];
      const asset = assetById.get(node.asset.assetId);
      if (!asset) throw new Error(`素材「${node.asset.name}」不可用，请重新打开项目后重试`);
      const element = Array.from(stageRef.current?.querySelectorAll<HTMLElement>(".canvas-node.is-asset[data-canvas-node-id]") ?? [])
        .find(element => element.dataset.canvasNodeId === node.id)?.querySelector<HTMLImageElement>(":scope > img");
      if (!element) return [];
      const bounds = element.getBoundingClientRect();
      const rect = { ...toBoardPoint(bounds.left, bounds.top), width: bounds.width / zoomRef.current, height: bounds.height / zoomRef.current };
      return [{ nodeId: node.id, asset, order: node.order,
        rect: containArtboardImage(rect, asset.width || element.naturalWidth || rect.width, asset.height || element.naturalHeight || rect.height) }];
    });
  }

  function expandArtboardSelection(ids: Set<string>) {
    const anchors = selectionAnchors();
    const sections = new Set(graphNodesRef.current.filter(node => node.kind === "note" && readCanvasNote(node).note_type === "section").map(node => node.id));
    // Re-evaluate geometry at drag start: entering and leaving a frame needs no manual grouping.
    return expandCanvasSections(ids, graphNodesRef.current.map(node => {
      if (!ids.has(node.id) || node.kind !== "note" || !readCanvasNote(node).artboard) return node;
      const note = readCanvasNote(node);
      const members = anchors.filter(anchor => !sections.has(anchor.id) && intersectArtboard(node, anchor.rect)).map(anchor => anchor.id);
      return { ...node, payloadJson: JSON.stringify({ ...note, member_ids: members }) };
    }));
  }

  function openArtboardComposition(node: ProjectGraphNode) {
    try {
      const baseId = readCanvasNote(node).artboard?.base_asset_id;
      const base = baseId ? assetById.get(baseId) : null;
      if (baseId && !base) throw new Error("画板基底已不可用，请恢复原素材或重新创建画板");
      const composition = artboardComposition(node, base ?? null, artboardImages(node));
      setArtboardDialog({ nodeId: node.id, projectId: activeCanvasRef.current.id, revision: useStore.getState().projectRouteRevision, composition });
    } catch (reason) { notifyError(reason, "无法合成画板"); }
  }

  useEffect(() => {
    const createFromImage = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; nodeIds: string[]; assetId: string }>).detail;
      if (detail.projectId !== activeCanvasRef.current.id || loadingRef.current || useStore.getState().projectRoutePending) return;
      const node = nodesRef.current.find(node => detail.nodeIds.includes(node.id) && node.kind === "asset" && node.asset.assetId === detail.assetId);
      const asset = assetById.get(detail.assetId);
      if (!node || !asset?.store_path || isVideoPath(asset.store_path)) return;
      const width = Math.max(320, node.width), height = width * (asset.height || 1) / (asset.width || 1);
      createCanvasNote({ x: node.x + node.width + 48, y: node.y, width, height }, "section", { base_asset_id: asset.id });
    };
    window.addEventListener(CANVAS_ARTBOARD_FROM_IMAGE, createFromImage);
    return () => window.removeEventListener(CANVAS_ARTBOARD_FROM_IMAGE, createFromImage);
  });

  function createCanvasNote(rect: CanvasRect, noteType: "text" | "section" | "bubble", artboard?: { base_asset_id: string | null }) {
    const draft = activeCanvasRef.current;
    const members = noteType === "section" && !artboard ? claimSectionMembers(rect) : [];
    const value: CanvasNotePayload = { schema_version: 1, text: artboard ? "画板" : noteType === "section" ? "分区" : "", note_type: noteType,
      ...(artboard ? { artboard } : {}),
      cells: noteType !== "section" ? [[emptyCanvasCell()]] : [], member_ids: members,
      ...(noteType === "bubble" ? { bubble_tail: { side: "bottom" as const, position: 25 } } : {}) };
    const node: ProjectGraphNode = { id: canvasId(noteType), projectId: draft.id, threadId: null, kind: "note", assetId: null, role: null,
      payloadJson: JSON.stringify(value), ...rect, zIndex: Math.max(0, ...selectionAnchors().map(anchor => anchor.order)) + 1, positionLocked: false, hiddenAt: null, createdAt: Date.now(), updatedAt: Date.now() };
    graphNodesRef.current = [...graphNodesRef.current, node];
    setGraphNodes(graphNodesRef.current);
    setSelectedCanvasNodeIds(new Set([node.id]));
    void enqueueWrite(async () => {
      await ensureMaterialized(draft);
      const { hiddenAt: _hidden, createdAt: _created, updatedAt: _updated, ...input } = node;
      await api.projectCanvasNodeCreate(input);
    });
    setDrawingTool("select");
  }

  function placeCanvasCard(kind: "bubble" | Exclude<WorkflowKind, "trigger">, point: CanvasPoint) {
    chooseCanvasTool("select");
    if (kind === "text" || kind === "bubble") {
      createCanvasNote({ ...point, width: kind === "bubble" ? 240 : 320,
        height: kind === "bubble" ? 120 : canvasTextMinSize([[emptyCanvasCell()]]).height }, kind);
    } else {
      workflowRef.current?.add(kind, point.x, point.y);
    }
  }

  function beginDrawing(event: PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (drawingTool === "select" || drawingTool === "pan" || event.button !== 0 || spacePressedRef.current
      || (event.target as HTMLElement).closest(".canvas-drawing-tools") || loadingRef.current || useStore.getState().projectRoutePending) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    const start = toBoardPoint(event.clientX, event.clientY);
    if (drawingTool !== "section" && drawingTool !== "artboard") {
      placeCanvasCard(drawingTool, start);
    } else {
      sectionDrawRef.current = { pointerId: event.pointerId, start, artboard: drawingTool === "artboard" };
      setSectionPreview({ ...start, width: 0, height: 0 });
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  function beginPan(event: PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (!isCanvasPanGesture(event.button, spacePressedRef.current, drawingTool === "pan")) {
      const targetIsCanvasNode = !!(event.target as HTMLElement).closest("[data-canvas-node]");
      if (event.button === 0 && !targetIsCanvasNode) {
        if (focusedNodeIdRef.current != null) {
          setFocusedNodeId(null);
          markViewDirty();
        }
        if (!event.shiftKey && !event.ctrlKey && !event.metaKey) setSelectedCanvasNodeIds(new Set());
        if (canStartCanvasMarquee(event.button, targetIsCanvasNode)) {
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
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
    event.currentTarget.focus({ preventScroll: true });
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
    const drawing = sectionDrawRef.current;
    if (drawing?.pointerId === event.pointerId) {
      setSectionPreview(canvasRectFromPoints(drawing.start, toBoardPoint(event.clientX, event.clientY)));
      return;
    }
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
      const sectionIds = new Set(graphNodesRef.current.filter(node => node.kind === "note"
        && readCanvasNote(node).note_type === "section").map(node => node.id));
      const selected = canvasNodeIdsInRect(
        selection,
        selectionAnchors().filter(anchor => !sectionIds.has(anchor.id) || canvasSectionMembers(selection, [anchor]).length > 0),
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
    const drawing = sectionDrawRef.current;
    if (drawing?.pointerId === event.pointerId) {
      const rect = canvasRectFromPoints(drawing.start, toBoardPoint(event.clientX, event.clientY));
      sectionDrawRef.current = null;
      setSectionPreview(null);
      if (!cancelled && rect.width * zoomRef.current >= 12 && rect.height * zoomRef.current >= 12) createCanvasNote(rect, "section", drawing.artboard ? { base_asset_id: null } : undefined);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
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
    const content = [...selectionAnchors().map(anchor => anchor.rect), ...(workflowRef.current?.bounds() ?? []).map(rect => ({ ...rect, y: rect.y - 45, height: rect.height + 45 }))];
    if (!stage || content.length === 0) {
      panRef.current = { x: 0, y: 0 };
      zoomRef.current = 1;
      setPan({ x: 0, y: 0 });
      setZoom(1);
      markViewDirty();
      return;
    }
    const bounds = content.reduce(
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

  function captureSelection(ids: Iterable<string>): CanvasClipboard | null {
    const project = activeCanvasRef.current.id;
    const groups = nodesRef.current.flatMap(node => {
      const group = node.kind === "folder" && groupsRef.current.get(node.id);
      return group ? [{ ...group, ...nodeRect(node), zIndex: node.order }] : [];
    });
    const items = nodesRef.current.flatMap(node => node.kind === "folder" ? node.assets.map((asset, ordinal) => ({ projectId: project, groupId: node.id, nodeId: asset.id, ordinal })) : []);
    const graph = projectGraphNodesWithLiveLayout(graphNodesRef.current, nodesRef.current);
    for (const node of nodesRef.current) if (node.kind === "asset" && !graph.some(item => item.id === node.id)) graph.push({ ...newProjectCanvasAssetNode(project, node), hiddenAt: null, createdAt: 0, updatedAt: 0 });
    const value = captureCanvasClipboard(project, expandArtboardSelection(new Set(ids)), graph, groups, items, canvasWorkflowController(project).document.nodes);
    return value.selection.length ? value : null;
  }

  async function copyCanvasSelection(ids: Iterable<string>, clipboard?: DataTransfer) {
    const value = captureSelection(ids);
    if (!value) { notify("请选择流程卡片、内容卡片或素材", "info"); return; }
    canvasClipboardText = serializeCanvasClipboard(value);
    if (clipboard) clipboard.setData("text/plain", canvasClipboardText);
    else await navigator.clipboard.writeText(canvasClipboardText).catch(() => {});
    notify(`已复制 ${value.selection.length} 张卡片`, "success");
  }

  async function refreshClipboardCanvas(project: string) {
    const routeRevision = useStore.getState().projectRouteRevision;
    const snapshot = await api.projectCanvasGet(project);
    const exact = await api.getAssetsByIds(projectCanvasAssetIds(snapshot.nodes));
    applySnapshot(snapshot, { restoreView: false, restoreDraft: false }, exact, routeRevision);
  }

  async function pasteCanvasSelection(value: CanvasClipboard, point?: CanvasPoint) {
    if (pastingRef.current || loadingRef.current || !value.selection.length) return;
    const draft = activeCanvasRef.current, controller = canvasWorkflowController(draft.id);
    if (!controller.ready || controller.error || writeJournalRef.current.failure) { notify("请先完成当前画板的保存重试", "info"); return; }
    pastingRef.current = true;
    try {
      const positions = [...value.nodes, ...value.groups, ...value.workflow.filter(node => node.kind !== "text")];
      const x = point?.x ?? Math.min(...positions.map(node => node.x)) + 60;
      const y = point?.y ?? Math.min(...positions.map(node => node.y)) + 60;
      const cloned = cloneCanvasClipboard(value, draft.id, x, y);
      let shift = 0;
      const obstacles = selectionAnchors().map(item => item.rect);
      while (obstacles.some(rect => x + shift < rect.x + rect.width + 24 && x + shift + cloned.width + 24 > rect.x && y < rect.y + rect.height + 24 && y + cloned.height + 24 > rect.y)) shift += cloned.width + 60;
      for (const node of [...cloned.nodes, ...cloned.groups, ...cloned.workflow]) node.x += shift;
      const ids: string[] = cloned.workflow.map(node => node.id);
      if (controller.document.nodes.length + ids.length > 500) throw new Error("粘贴后工作流卡片超过 500 张，请缩小选区");
      let completed = false;
      await enqueueWrite(async () => {
        await ensureMaterialized(draft);
        // Retry a partial write using the same identities, never create a second copy.
        const existing = await api.projectCanvasGet(draft.id);
        for (const node of cloned.nodes) if (!existing.nodes.some(item => item.id === node.id)) await api.projectCanvasNodeCreate(node);
        for (const group of cloned.groups) if (!existing.groups.some(item => item.id === group.id)) await api.projectCanvasGroupCreate(group, cloned.items.filter(item => item.groupId === group.id).map(item => item.nodeId));
        if (ids.length) {
          if (controller.document.nodes.some(node => ids.includes(node.id))) {
            if (controller.error) await controller.retrySave();
          } else await controller.edit([...controller.document.nodes, ...cloned.workflow]);
        }
        await refreshClipboardCanvas(draft.id);
        if (!completed && activeCanvasRef.current.id === draft.id) {
          completed = true;
          undoHistoryRef.current.push({ kind: "paste", projectId: draft.id, nodeIds: cloned.nodes.map(node => node.id), groupIds: cloned.groups.map(group => group.id), workflowIds: ids });
          setSelectedCanvasNodeIds(new Set(cloned.selection));
          const bounds = stageRef.current?.getBoundingClientRect();
          if (bounds) {
            const next = canvasViewForNewCard({ x: x + shift, y, width: cloned.width, height: cloned.height }, { x: 80, y: 60, width: Math.max(200, bounds.width - 120), height: Math.max(200, bounds.height - 270) }, panRef.current, zoomRef.current, true);
            if (next) { panRef.current = next.pan; zoomRef.current = next.zoom; setPan(next.pan); setZoom(next.zoom); markViewDirty(); }
          }
          stageRef.current?.focus({ preventScroll: true });
        }
      });
    } catch (error) { notifyError(error, "粘贴卡片失败"); }
    finally { pastingRef.current = false; }
  }

  useEffect(() => {
    const allowed = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      return !event.defaultPrevented && !target?.closest('input,textarea,select,[contenteditable="true"]')
        && ((target === document.body && !useStore.getState().canvasLibraryOpen) || (target instanceof Node && stageRef.current?.contains(target)))
        && viewModeRef.current === "canvas" && !useStore.getState().projectRoutePending && !scopedInspectorOpen
        && !document.querySelector('[role="dialog"][aria-modal="true"]') && !!stageRef.current;
    };
    const copy = (event: ClipboardEvent) => {
      if (!allowed(event) || !event.clipboardData || !selectedCanvasNodeIdsRef.current.size) return;
      if (!captureSelection(selectedCanvasNodeIdsRef.current)) return;
      event.preventDefault(); event.stopPropagation(); void copyCanvasSelection(selectedCanvasNodeIdsRef.current, event.clipboardData);
    };
    const paste = (event: ClipboardEvent) => {
      if (!allowed(event)) return;
      const value = parseCanvasClipboard(event.clipboardData?.getData("text/plain") ?? "");
      if (!value) return;
      event.preventDefault(); event.stopPropagation(); void pasteCanvasSelection(value);
    };
    window.addEventListener("copy", copy, true); window.addEventListener("paste", paste, true);
    return () => { window.removeEventListener("copy", copy, true); window.removeEventListener("paste", paste, true); };
  }, [scopedInspectorOpen]);

  function removeNodes(nodeIds: Iterable<string>) {
    const ids = new Set(nodeIds);
    for (const id of [...ids]) {
      const card = conversationCardsRef.current.cards.get(id);
      if (card) for (const member of [...card.sessions, ...card.outputs]) ids.add(member.id);
    }
    const materials = nodesRef.current.filter((node) => ids.has(node.id));
    for (const node of materials) {
      if (node.kind === "folder") for (const asset of node.assets) ids.add(asset.id);
    }
    const graph = graphNodesRef.current.filter((node) => ids.has(node.id) && node.hiddenAt == null);
    const draft = activeCanvasRef.current;
    const controller = canvasWorkflowController(draft.id);
    const workflowIds = new Set(controller.document.nodes.filter(node => ids.has(node.id)).map(node => node.id));
    if (materials.length === 0 && graph.length === 0 && workflowIds.size === 0) return;
    let workflow: WorkflowEditUndo | null = null;
    if (workflowIds.size) {
      if (controller.error) { notify("请先重试保存工作流，再删除卡片", "info"); return; }
      const before = controller.document;
      const pending = controller.edit(removeWorkflowNodes(before.nodes, workflowIds));
      void pending.catch(error => notifyError(error, "工作流删除未完成"));
      // Validation and running-node locks reject before the optimistic document changes.
      if (controller.document === before) return;
      workflow = workflowEditUndo(before, controller.document);
    }
    undoHistoryRef.current.push({ kind: "removal", projectId: draft.id, materials, graph, groups: new Map(groupsRef.current), workflow });
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
      for (const id of ids) if (!groupIds.has(id) && !workflowIds.has(id)) await api.projectCanvasNodeRemove(id);
    });
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
    const savedTurn = canvasConversationTurn(prompt, graphNodesRef.current, graphEdges, assetById);
    if (savedTurn) {
      if (savedTurn.references.some(asset => !asset.store_path)) {
        notify("引用图片已不可用，请恢复图片后再复用这条提示词", "info"); return;
      }
      state.reusePromptToBoard(savedTurn.text, savedTurn.references, [], undefined,
        { media: "image", ratio: savedTurn.ratio }, savedTurn.referenceNodeIds);
      setSnapshotPromptId(null);
      setPromptMenu(null);
      return;
    }
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

  /** 画板几何是否发生变化（层级/顺序调整不算几何位移，用于合并连续微调）。 */
  function canvasGeometryDiffers(
    before: { x: number; y: number; width: number; height: number },
    after: { x: number; y: number; width: number; height: number } | undefined,
  ) {
    if (!after) return false;
    return before.x !== after.x || before.y !== after.y || before.width !== after.width || before.height !== after.height;
  }

  /** 记录一次移动/层级/缩放前的快照；连续层级微调合并为一条撤销记录。 */
  function pushGeometryUndo(materials: readonly CanvasNode[], graph: readonly ProjectGraphNode[], workflow: WorkflowGeometry[] = []) {
    const draft = activeCanvasRef.current;
    const materialBefore = materials.filter((before) => {
      const after = nodesRef.current.find((node) => node.id === before.id);
      return !!after && (canvasGeometryDiffers(before, after) || before.order !== after.order);
    });
    const graphBefore = graph.filter((before) => {
      if (before.hiddenAt != null) return false;
      const after = graphNodesRef.current.find((node) => node.id === before.id);
      return !!after && (canvasGeometryDiffers(before, after) || before.zIndex !== after.zIndex);
    });
    const workflowBefore = workflow.filter(before => { const after = workflowRef.current?.bounds().find(node => node.id === before.id); return after && (before.x !== after.x || before.y !== after.y); });
    if (materialBefore.length === 0 && graphBefore.length === 0 && workflowBefore.length === 0) return;
    const ids = new Set([...materialBefore, ...graphBefore].map((node) => node.id));
    const top = undoHistoryRef.current[undoHistoryRef.current.length - 1];
    if (top?.kind === "geometry" && !workflowBefore.length && !top.workflow.length && top.projectId === draft.id
      && top.materials.length === materialBefore.length && top.graph.length === graphBefore.length
      && top.materials.every((node) => ids.has(node.id)) && top.graph.every((node) => ids.has(node.id))
      && top.materials.every((node) => !canvasGeometryDiffers(node, nodesRef.current.find((live) => live.id === node.id)))
      && top.graph.every((node) => !canvasGeometryDiffers(node, graphNodesRef.current.find((live) => live.id === node.id)))) {
      return;
    }
    undoHistoryRef.current.push({ kind: "geometry", projectId: draft.id, materials: materialBefore, graph: graphBefore, workflow: workflowBefore });
  }

  function undoCanvasAction() {
    const entry = undoHistoryRef.current[undoHistoryRef.current.length - 1];
    if (!entry || entry.projectId !== activeCanvasRef.current.id) return;
    if (entry.kind === "workflow") {
      const controller = canvasWorkflowController(entry.projectId);
      if (entry.edit.nodes.some(node => controller.isLocked(node.id))) {
        notify("请先停止相关工作流再撤销卡片操作", "info"); return;
      }
      if (controller.error) { notify("请先重试保存工作流，再撤销卡片操作", "info"); return; }
      const before = controller.document;
      const pending = controller.edit(restoreWorkflowEdit(before.nodes, entry.edit), entry.edit);
      if (controller.document !== before) undoHistoryRef.current.pop();
      void pending.catch(error => notifyError(error, "工作流撤销未完成"));
      return;
    }
    if (entry.kind === "paste") {
      const controller = canvasWorkflowController(entry.projectId);
      if (entry.workflowIds.some(id => controller.isLocked(id))) { notify("请先停止这组卡片的工作流再撤销粘贴", "info"); return; }
      const references = new Set([...entry.workflowIds, ...entry.nodeIds, ...entry.groupIds]);
      if (controller.document.nodes.some(node => !entry.workflowIds.includes(node.id) && (
        [node.textSource, node.textTarget?.nodeId, ...(node.resultNodeIds ?? [])].some(id => id && references.has(id))
        || Object.values(node.inputs).flat().some(input => [input.nodeId, input.canvasNodeId, input.assetNodeId, input.groupId].some(id => id && references.has(id)))))) {
        notify("这组卡片已有新的外部连线，请先断开后再撤销粘贴", "info"); return;
      }
      undoHistoryRef.current.pop();
      void enqueueWrite(async () => {
        if (controller.error) await controller.retrySave();
        if (controller.document.nodes.some(node => entry.workflowIds.includes(node.id))) {
          await controller.edit(controller.document.nodes.filter(node => !entry.workflowIds.includes(node.id)));
        }
        for (const id of entry.groupIds) await api.projectCanvasGroupDelete(id);
        for (const id of entry.nodeIds) await api.projectCanvasNodeRemove(id);
        await refreshClipboardCanvas(entry.projectId);
      });
      return;
    }
    if (entry.kind === "geometry" && entry.workflow.some(node => workflowRef.current?.isLocked(node.id))) return;
    if (entry.kind === "removal" && entry.workflow) {
      const controller = canvasWorkflowController(entry.projectId);
      if (controller.error) { notify("请先重试保存工作流，再撤销卡片操作", "info"); return; }
      const before = controller.document;
      const pending = controller.edit(restoreWorkflowEdit(before.nodes, entry.workflow), entry.workflow);
      void pending.catch(error => notifyError(error, "工作流撤销未完成"));
      if (controller.document === before) return;
    }
    undoHistoryRef.current.pop();
    if (entry.kind === "geometry") {
      workflowRef.current?.position(new Map(entry.workflow.map(node => [node.id, node])), true);
      const materialBefore = new Map(entry.materials.map((node) => [node.id, node]));
      commitNodes(nodesRef.current.map((node) => {
        const before = materialBefore.get(node.id);
        return before ? { ...node, x: before.x, y: before.y, width: before.width, height: before.height, order: before.order } : node;
      }));
      const graphBefore = new Map(entry.graph.map((node) => [node.id, node]));
      const next = graphNodesRef.current.map((node) => {
        const before = graphBefore.get(node.id);
        return before ? { ...node, x: before.x, y: before.y, width: before.width, height: before.height, zIndex: before.zIndex } : node;
      });
      graphNodesRef.current = next;
      setGraphNodes(next);
      persistGeometries(nodesRef.current.filter((node) => materialBefore.has(node.id)));
      for (const node of next) if (node.kind !== "asset" && graphBefore.has(node.id)) persistGraphNodeGeometry(node);
      // 分区几何恢复后按还原范围重新圈定成员；等 DOM 提交后再取实际显示尺寸。
      window.requestAnimationFrame(() => {
        if (activeCanvasRef.current.id !== entry.projectId) return;
        for (const node of graphNodesRef.current) {
          if (node.kind !== "note" || node.hiddenAt != null || !graphBefore.has(node.id)) continue;
          const value = readCanvasNote(node);
          if (value.note_type === "section" && !value.workflow_container && !value.artboard) updateCanvasNote(node.id, { ...value, member_ids: claimSectionMembers(node, node.id) });
        }
      });
      return;
    }
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
      { enabled: snapEnabledRef.current, zoom: zoomRef.current },
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
    const history = graphNodesRef.current.find(node => node.id === nodeId && workflowHistoryIds.has(node.id));
    if (history) { openWorkflowGeneration(history); return; }
    const targetId = conversationCardsRef.current.aliases.get(nodeId) ?? agentPromptGroupMap(graphNodesRef.current, graphEdges).get(nodeId)?.id ?? nodeId;
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
    () => projectGraphNodesWithLiveLayout(activeGraphNodes.filter((node) => !agentPromptGroups.has(node.id) && !containedOutputIds.has(node.id) && !workflowHistoryIds.has(node.id) && !conversationCards.hiddenIds.has(node.id)), nodes),
    [activeGraphNodes, agentPromptGroups, nodes, containedOutputIds, workflowHistoryIds, conversationCards],
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
    () => activeGraphNodes.filter((node) => node.kind === "prompt" && node.hiddenAt == null && !agentPromptGroups.has(node.id) && !workflowHistoryIds.has(node.id) && !conversationCards.hiddenIds.has(node.id)),
    [activeGraphNodes, agentPromptGroups, workflowHistoryIds, conversationCards],
  );
  const agentGraphNodes = useMemo(
    () => activeGraphNodes.filter((node) => node.kind === "agent_group" && node.hiddenAt == null),
    [activeGraphNodes],
  );
  const chatGraphNodes = useMemo(() => activeGraphNodes.filter(node => node.hiddenAt == null && canvasChatId(node)), [activeGraphNodes]);
  const promptReferences = useMemo(() => new Map(graphNodes.filter(node => node.kind === "prompt")
    .map(node => [node.id, canvasPromptReferences(node.id, graphNodes, graphEdges, assetById)])), [graphNodes, graphEdges, assetById]);
  // ReadonlyPrompt creates its content in an effect; measure after it has mounted.
  useEffect(() => {
    const nodeId = pendingNewCards[0];
    if (!nodeId || loading || projectRoutePending || panning || activeDragId) return;
    const finishPlacement = () => setPendingNewCards(pending => pending.filter(id => id !== nodeId));
    if (viewMode !== "canvas") {
      viewModeRef.current = "canvas";
      setViewMode("canvas");
      return;
    }
    const target = [...promptGraphNodes, ...agentGraphNodes].find((node) => node.id === nodeId);
    if (projectId && canvasWorkflowController(projectId).document.nodes.some(node => node.sessionNodeIds?.includes(nodeId))) {
      finishPlacement();
      return;
    }
    const stage = stageRef.current;
    if (!target || !stage) {
      finishPlacement();
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
    // Resolve folded results and grouped assets to what the user actually sees.
    const aliases = new Map(conversationCardsRef.current.aliases);
    for (const material of nodesRef.current) if (material.kind === "folder") {
      for (const asset of material.assets) aliases.set(asset.id, material.id);
    }
    const sections = new Set(graphNodesRef.current.filter(node => node.kind === "note"
      && readCanvasNote(node).note_type === "section").map(node => node.id));
    const anchors = selectionAnchors().filter(anchor => !sections.has(anchor.id));
    const elements = new Map(Array.from(stage.querySelectorAll<HTMLElement>("[data-canvas-node-id]"))
      .map(element => [element.dataset.canvasNodeId, element]));
    for (const anchor of anchors) {
      const rect = elements.get(anchor.id)?.getBoundingClientRect();
      if (rect) anchor.rect = { ...anchor.rect, width: rect.width / zoomRef.current, height: rect.height / zoomRef.current };
    }
    const sources = canvasCardSourceRects(target, graphEdges, new Map(anchors.map(anchor => [anchor.id, anchor.rect])), aliases, referenceIds);
    // A staged Agent Run replaces its launch card at the same location.
    const launch = target.kind === "agent_group" ? graphNodesRef.current.find(node =>
      agentPromptGroups.get(node.id)?.id === target.id) : undefined;
    const origin = launch ? { x: launch.x, y: launch.y } : sources.length ? {
      // Reference order gives a stable primary anchor even when inputs are widely scattered.
      x: sources[0].x + sources[0].width + 72,
      y: sources[0].y,
    } : {
      x: (viewport.x + viewport.width / 2 - panRef.current.x) / zoomRef.current - measuredCard.width / 2,
      y: (viewport.y + viewport.height / 2 - panRef.current.y) / zoomRef.current - measuredCard.height / 2,
    };
    const obstacles = anchors.filter(anchor => anchor.id !== nodeId && !referenceIds.has(anchor.id)).map(anchor => anchor.rect);
    const placement = target.positionLocked ? null : placeCanvasCardNearSource({ ...measuredCard, ...origin }, obstacles);
    finishPlacement();
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
    } else if (placement) {
      if (placement.x !== target.x || placement.y !== target.y) {
        const moved = { ...target, ...placement };
        const updated = graphNodesRef.current.map((node) => node.id === nodeId ? moved : node);
        graphNodesRef.current = updated;
        setGraphNodes(updated);
        persistGraphNodeGeometry(moved);
      }
    }
    // Keep the camera still when the card is visible; include nearby inputs when they fit.
    const placedCard = { ...measuredCard, ...(placement ?? {}) };
    const context = {
      x: Math.min(placedCard.x, ...sources.map(source => source.x)),
      y: Math.min(placedCard.y, ...sources.map(source => source.y)),
      width: 0, height: 0,
    };
    context.width = Math.max(placedCard.x + placedCard.width, ...sources.map(source => source.x + source.width)) - context.x;
    context.height = Math.max(placedCard.y + placedCard.height, ...sources.map(source => source.y + source.height)) - context.y;
    const cardOutside = canvasViewForNewCard(placedCard, viewport, panRef.current, zoomRef.current);
    const next = cardOutside && context.width * zoomRef.current <= viewport.width && context.height * zoomRef.current <= viewport.height
      ? canvasViewForNewCard(context, viewport, panRef.current, zoomRef.current) : cardOutside;
    if (next) {
      panRef.current = next.pan;
      zoomRef.current = next.zoom;
      setPan(next.pan);
      setZoom(next.zoom);
    }
    focusGraphNode(nodeId);
    setSelectedCanvasNodeIds(new Set([nodeId]));
    element?.focus({ preventScroll: true });
  }, [pendingNewCards, promptGraphNodes, agentGraphNodes, loading, projectRoutePending, panning, activeDragId, viewMode, scopedInspectorOpen]);
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
  const savedConversation = useMemo(() => snapshotPrompt
    ? canvasConversationTurns(snapshotPrompt, graphNodes, graphEdges, assetById, promptNodeSummary(snapshotPrompt).jobId || undefined) : [],
    [snapshotPrompt, graphNodes, graphEdges, assetById]);
  function openWorkflowGeneration(node: ProjectGraphNode) {
    focusGraphNode(node.id);
    const { jobId } = promptNodeSummary(node);
    if (jobId && useStore.getState().genJobs[jobId]) {
      setSnapshotPromptId(null);
      openGenerationJob(jobId, { navigate: false });
    } else {
      setSnapshotPromptId(node.id);
      useStore.setState({ activeJobId: null, activeCloudAgentRunId: null, activeSessionKind: "generation", genEditing: null, genPanelOpen: true });
    }
  }
  const inspectorHeader = useMemo(() => {
    if (!scopedInspectorOpen) return null;
    if (snapshotPrompt) {
      const provider = savedConversation[0]?.provider;
      const providerLabel = imageProviderLabel(provider, cloudEntitlement, null);
      return projectInspectorHeader({ kind: "generation", prompt: savedConversation[0]?.text,
        detail: `${savedConversation.length} 轮 · ${savedConversation.reduce((total, turn) => total + turn.outputs.length, 0)} 图 · ${providerLabel}`, running: false });
    }
    if (activeSessionKind === "generation") {
      const imageCount = activeGenerationJob?.turns.reduce((total, turn) => total + turn.images.length, 0) ?? 0;
      const provider = activeGenerationJob?.provider;
      const providerLabel = activeGenerationJob?.media === "video" && activeGenerationJob.videoOptions ? videoModelLabel(activeGenerationJob.videoOptions.model_version)
        : imageProviderLabel(provider, cloudEntitlement, null);
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
    snapshotPrompt,
    savedConversation,
    scopedInspectorOpen,
  ]);
  const inspectorEditing = activeSessionKind === "generation" && genEditing === "edit";
  const drawableEdges = useMemo(
    () => {
      // Non-library annotation references and deleted assets remain in execution
      // history, but have no material card to anchor a visible wire.
      const materialIds = new Set(nodes.flatMap(node => node.kind === "asset" ? [node.id] : node.assets.map(asset => asset.id)));
      const hasAnchor = (node: ProjectGraphNode) => node.hiddenAt == null && (node.kind !== "asset" || materialIds.has(node.id));
      const seen = new Set<string>();
      return graphEdges.flatMap((edge) => {
        const from = graphNodeById.get(conversationCards.aliases.get(edge.fromNodeId) ?? edge.fromNodeId);
        const to = graphNodeById.get(conversationCards.aliases.get(edge.toNodeId) ?? agentPromptGroups.get(edge.toNodeId)?.id ?? edge.toNodeId);
        const key = `${from?.id}:${to?.id}:${edge.kind}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return from && to && from.id !== to.id && hasAnchor(from) && hasAnchor(to) ? [{ edge, from, to }] : [];
      });
    },
    [graphEdges, graphNodeById, agentPromptGroups, nodes, conversationCards],
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
          {error && <p>{userErrorMessage(error, "画板暂时无法加载，请重新打开项目。")}</p>}
          <div>
            <button type="button" className="app-button-primary" onClick={() => setLoadRevision((value) => value + 1)}>
              重试载入
            </button>
            {onExit && (
              <button type="button" className="app-button-secondary" onClick={onExit}>
                返回主页
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const sourceNavigation = <header className="library-browser-heading">
    <div data-tour="source-scope" className="library-floating-navigation">
      <LibrarySourceTabs project value={sourceScope} onChange={changeSource}/>
    </div>
  </header>;

  return (
    <div
      ref={workspaceRef}
      data-onboarding-project={projectId ?? undefined}
      className={`canvas-workspace${sourceCollapsed ? " is-source-collapsed" : " is-library-open"}${libraryDragging ? " is-library-dragging" : ""}${loading || projectRoutePending ? " is-route-pending" : ""}`}
      aria-busy={loading || projectRoutePending}
    >
      <aside ref={sourcePanelRef} id={sourcePanelId} className="canvas-source-panel library-browser" aria-label="画板素材库"
        aria-hidden={sourceCollapsed} tabIndex={-1} onDragStart={event => {
          if (!(event.target as HTMLElement).closest('[data-asset-id]') || !getDragAssets()?.length) return;
          if (sourceDragFrame.current !== null) cancelAnimationFrame(sourceDragFrame.current);
          // Wait only for the browser to capture the source thumbnail; never animate over the drop target.
          sourceDragFrame.current = requestAnimationFrame(() => {
            sourceDragFrame.current = null;
            if (!getDragAssets()?.length) return;
            setLibraryDragging(true);
            setSourceCollapsed(true);
          });
        }}>
        <div id={`${sourcePanelId}-content`} className="canvas-source-content">
          {fileMode === "all" || fileMode === "tags" || fileMode === "collections"
            ? <LibraryCatalogTransition key={`${projectId}:${sourceScope}:${libraryMedia}`} kind={fileMode} media={libraryMedia} projectId={projectId}
                projectScope={sourceScope === "project"} navigation={sourceNavigation} onClose={closeSource} onAssetsChange={setCatalogAssets}/>
            : <LocalFileWorkspace navigation={sourceNavigation} onClose={closeSource}/>}
        </div>
      </aside>
      <CanvasLibraryResize panelId={sourcePanelId} collapsed={sourceCollapsed} onClose={closeSource} />

      <section ref={boardShellRef} className={`canvas-board-shell${(selectedChatId || scopedInspectorOpen && !inspectorEditing || workflowAgentDetail?.projectId === projectId && !loading && !genPanelOpen) ? " has-project-inspector" : ""}`}>
        <button
          type="button"
          className={`canvas-source-toggle ${sourceCollapsed ? "canvas-source-expand" : "canvas-source-collapse"}`}
          aria-label={sourceCollapsed ? "展开画板素材库" : "收起画板素材库"}
          title={sourceCollapsed ? "展开素材库" : "收起素材库"}
          aria-expanded={!sourceCollapsed}
          aria-controls={`${sourcePanelId}-content`}
          onClick={() => {
            if (sourceCollapsed) changeSource("global");
            setSourceCollapsed(!sourceCollapsed);
            if (sourceCollapsed) beginOnboardingOperation("expand-source", projectId)();
          }}
        >{sourceCollapsed ? <PanelLeftOpen size={16} aria-hidden="true" /> : <PanelLeftClose size={16} aria-hidden="true" />}</button>
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
            <span className="canvas-board-title-field" data-title={activeCanvas.title || " "}>
              <input
                className="canvas-board-title"
                aria-label="项目名称"
                title="点击重命名项目"
                value={activeCanvas.title}
                onFocus={(event) => event.currentTarget.select()}
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
            </span>
            <small>
              {viewMode === "canvas"
                ? boardOpen || genEditing
                  ? "创作模式 · 点击素材加入创作"
                  : "浏览模式 · 双指移动 / 空格 + 左键 / 中键 平移"
                : "项目内创作线程的顺序投影"}
            </small>
            {selectedCanvasNodeIds.size > 0 && (
              <small className="canvas-selection-count">
                已选择 {selectedCanvasNodeIds.size} 项 · 拖动可整体移动
              </small>
            )}
            <small className={`canvas-save-state${loading || savingVisible ? " is-visible" : ""}`} aria-hidden={!loading && !savingVisible}>
              <LoaderCircle size={12} /> {loading ? "载入中" : "保存中"}
            </small>
            {error && <small className="canvas-save-error" title={userErrorMessage(error, "画板未能保存，请重试保存。")}>保存失败，修改仍保留在当前画面
              {writeJournalRef.current.failure != null && <button type="button" className="ml-2 underline" onClick={() => { void retryPendingWrites().catch(error => notifyError(error, "画板保存失败")); }}>重试保存画板</button>}
            </small>}
          </div>
          <div className="canvas-zoom-controls" aria-label="画布缩放">
            <button type="button" aria-label="项目对话记录" title="项目对话记录" aria-expanded={chatHistoryOpen}
              onClick={() => setChatHistoryOpen(open => !open)}><MessageCircle size={14} /></button>
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
          className={`canvas-stage ${drawingTool !== "select" && drawingTool !== "pan" ? "is-drawing" : ""} ${drawingTool === "pan" ? "is-hand" : ""} ${externalDragOver ? "is-drag-over" : ""} ${spacePanReady ? "is-pan-ready" : ""} ${panning ? "is-panning" : ""} ${boardOpen || genEditing ? "is-creation-mode" : ""} ${viewMode !== "canvas" ? "is-view-hidden" : ""}`}
          style={{
            backgroundPosition: `${pan.x}px ${pan.y}px`,
            backgroundSize: `${24 * zoom}px ${24 * zoom}px`,
          }}
          onPointerDownCapture={beginDrawing}
          onPointerDown={beginPan}
          onKeyDown={(event) => {
            // Mac's backward Delete reports Backspace; also support forward Delete keyboards.
            const deleteKey = event.key === "Delete" && !event.metaKey;
            const macDeleteKey = /Mac/i.test(navigator.platform) && event.metaKey
              && (event.key === "Backspace" || event.key === "Delete");
            if ((!deleteKey && !macDeleteKey) || event.defaultPrevented || event.repeat || event.nativeEvent.isComposing
              || event.ctrlKey || event.altKey || event.shiftKey) return;
            const target = event.target as HTMLElement;
            if (target.isContentEditable || target.closest("input, textarea, select")) return;
            if (viewModeRef.current !== "canvas" || loadingRef.current || useStore.getState().projectRoutePending
              || scopedInspectorOpen || canvasLightbox || promptMenu || useStore.getState().contextMenu
              || nodeDragRef.current || graphNodeDragRef.current || marqueePressRef.current || panDragRef.current
              || document.querySelector('[role="dialog"][aria-modal="true"]')
              || selectedCanvasNodeIdsRef.current.size === 0) return;
            event.preventDefault();
            event.stopPropagation();
            removeNodes(selectedCanvasNodeIdsRef.current);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            if (loadingRef.current || useStore.getState().projectRoutePending) return;
            useStore.getState().closeContextMenu();
            // 分区主体不响应指针事件，右键会落到画板空白处；此处补拾光标所在分区，
            // 让「移除分区」在分区内部也可用，而不必精确点中标题条或窄边。
            const point = toBoardPoint(event.clientX, event.clientY);
            const section = sectionUnderPoint(point);
            setPromptMenu({ node: null, nodeIds: [...selectedCanvasNodeIdsRef.current],
              section: section ? { id: section.id, name: readCanvasNote(section).text.trim() || "分区" } : null,
              x: event.clientX, y: event.clientY, point });
          }}
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
          <div className="canvas-drawing-tools" role="toolbar" aria-label="画板工具" onPointerDown={event => event.stopPropagation()}>
            <button data-tip="选择" aria-label="选择工具" aria-pressed={drawingTool === "select"} onClick={() => chooseCanvasTool("select")}><MousePointer2 size={18} /></button>
            <button data-tip="抓手 · 按住左键平移视图（Esc 退出）" aria-label="抓手工具" aria-pressed={drawingTool === "pan"} onClick={() => chooseCanvasTool("pan")}><Hand size={18} /></button>
            <button data-tip="分区 · 拖拽画框" aria-label="分区工具" aria-pressed={drawingTool === "section"} onClick={() => chooseCanvasTool("section")}><Frame size={18} /></button>
            <button data-tip="画板 · 拖框后拼放图片" aria-label="画板工具" aria-pressed={drawingTool === "artboard"} onClick={() => chooseCanvasTool("artboard")}><Scan size={18} /></button>
            <hr />
            <button data-tip="内容卡片 · 拖入画布或选中后点击放置" aria-label="内容卡片工具" {...canvasCardTool("text")}><Table2 size={18} /></button>
            <button data-tip="气泡便签 · 拖入画布或选中后点击放置" aria-label="气泡便签工具" {...canvasCardTool("bubble")}><MessageCircle size={18} /></button>
            <button data-tip="指令卡片 · 拖入画布或选中后点击放置" aria-label="新增指令卡片" {...canvasCardTool("instruction")}><List size={18} /></button>
            <button data-tip="循环卡片 · 拖入画布或选中后点击放置" aria-label="新增循环卡片" {...canvasCardTool("loop")}><Repeat2 size={18} /></button>
            <button data-tip="生成卡片 · 拖入画布或选中后点击放置" aria-label="新增生成卡片" {...canvasCardTool("generation")}><Images size={18} /></button>
            {WORKFLOW_SKILL_ENABLED && <button data-tip="技能卡片 · 拖入画布或选中后点击放置" aria-label="新增技能卡片" {...canvasCardTool("skill")}><Sparkles size={18} /></button>}
            {WORKFLOW_PLANNER_ENABLED && import.meta.env.DEV && <button data-tip="工作流助手 · 拖入画布或选中后点击放置" aria-label="新增工作流助手" {...canvasCardTool("planner")}><Sparkles size={18} /></button>}
            <button data-tip="Agent 卡片 · 拖入画布或选中后点击放置" aria-label="新增 Agent 卡片" {...canvasCardTool("agent")}><TextCursorInput size={18} /></button>
            <button data-tip="视觉规范卡片 · 拖入画布或选中后点击放置" aria-label="新增视觉规范卡片" {...canvasCardTool("visual-profile")}><Palette size={18} /></button>
            {WORKFLOW_TEMPLATE_LIBRARY_ENABLED && <button data-tip="模板库 · 子流程与分享" aria-label="工作流模板库" onClick={() => workflowRef.current?.templates()}><Copy size={18} /></button>}
            <button data-tip="发条 · 卡片上吸附，空白处创建" aria-label="发条触发器"
              onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); setDrawingTool("select"); workflowRef.current?.arm(event.clientX, event.clientY); }}
              onClick={event => { if (event.detail === 0) { setDrawingTool("select"); workflowRef.current?.arm(); } }}><WindingKey size={21} /></button>
            <hr />
            <CanvasToolbox onOpenReplication={() => { setDrawingTool("select"); if (projectId) setReplicationProjectId(projectId); }} onOpenLocalVideo={() => chooseCanvasTool("comfy-video")} />
            <hr />
            <div className="canvas-assist-tools" role="group" aria-label="辅助">
              <span>辅助</span>
              <button type="button" data-tip={snapEnabled ? "关闭吸附对齐" : "开启吸附对齐"} aria-label="吸附对齐" aria-pressed={snapEnabled} onClick={() => {
                const next = !snapEnabled;
                snapEnabledRef.current = next;
                setSnapEnabled(next);
                setGuides([]);
                try { localStorage.setItem(CANVAS_SNAP_ENABLED_KEY, String(next)); } catch { /* Keep the toggle usable when storage is unavailable. */ }
              }}><Magnet size={18} /></button>
            </div>
          </div>
          <div
            className="canvas-plane"
            style={{ "--canvas-running-width": `${4 / zoom}px`, transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` } as CSSProperties}
          >
            {projectId && !loading && !loadFailed && activeCanvas.id === projectId && <CanvasWorkflowLayer key={projectId} ref={workflowRef} projectId={projectId} provisional={!activeCanvas.materialized} zoom={zoom} toBoardPoint={toBoardPoint} graphNodes={nonChatGraphNodes} conversationCards={conversationCards} imageOnlyConversationIds={imageOnlyConversationIds}
              selectedIds={selectedCanvasNodeIds} panReady={spacePanReady || drawingTool === "pan"} onSelect={(id, additive) => { if (additive) toggleCanvasNodeSelection(id); else setSelectedCanvasNodeIds(new Set([id])); }}
              onNodesChanged={() => setWorkflowRevision(value => value + 1)}
              onEdited={(before, after) => {
                if (activeCanvasRef.current.id !== projectId) return;
                const edit = workflowEditUndo(before, after);
                if (edit) undoHistoryRef.current.push({ kind: "workflow", projectId, edit });
              }}
              onOpenAgent={nodeId => { setGenPanelOpen(false); setWorkflowAgentDetail({ projectId: projectId!, nodeId }); }}
              onOpenGeneration={openWorkflowGeneration}
              onDragStart={beginGraphNodeDrag} onDragMove={moveGraphNode} onDragEnd={endGraphNodeDrag} onNodeMenu={openCanvasNodeMenu}
              onRemove={id => removeNodes(selectedCanvasNodeIdsRef.current.has(id) ? selectedCanvasNodeIdsRef.current : [id])}
              onPlaced={card => {
                const stage = stageRef.current; if (!stage || useStore.getState().activeProjectId !== projectId) return;
                const bounds = stage.getBoundingClientRect();
                const next = canvasViewForNewCard(card, { x: 80, y: 60, width: Math.max(200, bounds.width - 120), height: Math.max(200, bounds.height - 270) }, panRef.current, zoomRef.current, true);
                if (!next) return;
                panRef.current = next.pan; zoomRef.current = next.zoom; setPan(next.pan); setZoom(next.zoom); markViewDirty();
              }}
              ensureMaterialized={async () => { const draft = activeCanvasRef.current; if (!draft) throw new Error("项目尚未就绪"); await ensureMaterialized(draft); await flushCanvasWrites(false); }}
              materials={visibleMaterials.flatMap<MaterialAnchor>(node => node.kind === "folder"
                ? [{ id: node.id, groupId: node.id, assetIds: [...new Set(node.assets.filter(asset => !isVideoPath(asset.storePath)).flatMap(asset => asset.assetId ? [asset.assetId] : []))], ...nodeRect(node) }]
                : node.kind === "asset" && node.asset.assetId ? [{ id: node.id, assetId: node.asset.assetId, video: isVideoPath(node.asset.storePath), ...nodeRect(node) }] : [])} />}
            {graphNodes.filter(node => node.kind === "note" && node.hiddenAt == null && !canvasChatId(node)).map(savedNode => {
              const value = resolveGenerationCells(readCanvasNote(savedNode), graphNodes);
              const minimum = value.note_type === "text" || value.note_type === "images" ? canvasTextMinSize(value.cells) : savedNode;
              const node = { ...savedNode, width: Math.max(savedNode.width, minimum.width), height: Math.max(savedNode.height, minimum.height) };
              const section = value.note_type === "section";
              const selected = selectedCanvasNodeIds.has(node.id);
              const workflowController = projectId ? canvasWorkflowController(projectId) : null;
              const failedWriter = workflowController?.document.nodes.some(writer => (writer.textTarget?.nodeId === node.id || writer.textSource === node.id)
                && (workflowController.issue?.nodeId === writer.id || workflowNodeRun(workflowController.document, writer.id)?.steps[writer.id]?.status === "failed"));
              return <div key={node.id} data-canvas-node data-canvas-node-id={node.id} data-workflow-container={value.workflow_container ? node.id : undefined} tabIndex={0}
                className={`canvas-note ${section ? "is-section" : value.note_type === "bubble" ? "is-bubble" : "is-text is-content-card"} ${value.artboard ? "is-artboard" : ""} ${selected ? "is-selected" : ""} ${failedWriter ? "canvas-card-error" : ""}`}
                style={{ width: node.width, height: node.height, transform: `translate3d(${node.x}px, ${node.y}px, 0)`, zIndex: section ? 0 : activeDragId === node.id || (activeDragId != null && selected) ? 10000 + node.zIndex : node.zIndex }}
                onPointerDown={event => beginGraphNodeDrag(event, node)} onPointerMove={moveGraphNode}
                onPointerUp={endGraphNodeDrag} onPointerCancel={event => endGraphNodeDrag(event, true)}
                onLostPointerCapture={event => endGraphNodeDrag(event, true)}
                onContextMenu={event => openCanvasNodeMenu(event, node.id)}>
                {section ? <>
                  {value.artboard?.base_asset_id && assetById.get(value.artboard.base_asset_id)?.store_path && <img className="canvas-artboard-base" draggable={false}
                    src={convertFileSrc(assetById.get(value.artboard.base_asset_id)!.store_path!)} alt="画板基底" />}
                  <div className="canvas-section-heading" title={value.artboard ? "拖动画板" : "拖动分区"}><GripHorizontal size={17} />
                    {value.workflow_container && <span className="canvas-workflow-container-badge">封装 · {value.member_ids.length}</span>}
                  </div>
                  {value.artboard && <button type="button" className="canvas-artboard-compose" style={node.width < 300 ? { bottom: "calc(100% + 36px)" } : undefined} onPointerDown={event => event.stopPropagation()}
                    onClick={event => { event.stopPropagation(); openArtboardComposition(node); }}><Sparkles size={14} />合成画板中的内容</button>}
                  {["top", "bottom", "left", "right"].map(edge => <div key={edge} className={`canvas-section-edge ${edge}`} />)}
                  {selected && !value.workflow_container && ([["nw", "左上角"], ["ne", "右上角"], ["sw", "左下角"], ["se", "右下角"]] as const).map(([corner, label]) => (
                    <CanvasResizeHandle key={corner} label={`调整${value.artboard ? "画板" : "分区"}大小（${label}）`} corner={corner} size={node} position={{ x: node.x, y: node.y }} zoom={zoom}
                      minimum={{ width: 120, height: 80 }} onResize={(size, finished, cancelled) => resizeCanvasNote(node.id, size, finished, cancelled)} />
                  ))}
                </> : <CanvasTextCard value={value} selected={selected} width={node.width} height={node.height} zoom={zoom}
                  onOpenPreview={openCanvasSourcePreview}
                  onMediaContextMenu={(event, asset) => {
                    setPromptMenu(null);
                    openContextMenu(event.clientX, event.clientY, asset.id, { asset, singleAsset: true });
                  }}
                  onOpenGeneration={cell => {
                    const session = graphNodes.find(item => item.id === cell.generation_ref?.session_node_id && item.hiddenAt == null);
                    if (session) openWorkflowGeneration(session);
                  }}
                  renderGeneration={cell => {
                    const session = graphNodes.find(item => item.id === cell.generation_ref?.session_node_id && item.hiddenAt == null);
                    const summary = session && promptNodeSummary(session);
                    const running = summary && (genJobs[summary.jobId]?.running ?? ["running", "querying", "queued"].includes(summary.status));
                    return <button type="button" className={`canvas-cell-generation ${running ? "canvas-card-running" : ""} ${summary?.status === "failed" ? "is-failed" : ""}`}
                      data-cell-generation={cell.generation_ref?.session_node_id} aria-label="查看单元格生成会话" aria-busy={!!running}
                      onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); if (session) openWorkflowGeneration(session); }}>
                      <span><strong>生成会话</strong><small>{summary?.provider} · {running ? "生成中" : summary?.status === "failed" ? "生成失败" : summary?.status === "done" ? "等待结果图片" : summary?.status === "cancelled" ? "已取消" : "等待生成"}</small></span>
                      <p>{summary?.text ?? "生成会话已不可用"}</p>
                    </button>;
                  }}
                  onConnectCell={(cellId, x, y) => workflowRef.current?.connectCell(node.id, cellId, x, y)}
                  onInput={(cellId, disconnect, type, point) => workflowRef.current?.inputText(node.id, cellId, disconnect, type, point)}
                  inputLocked={workflowRef.current?.isLocked(node.id)}
                  onResize={(size, finished, cancelled) => resizeCanvasNote(node.id, size, finished, cancelled)} onSelect={() => setSelectedCanvasNodeIds(new Set([node.id]))}
                  onChange={(next, size) => updateCanvasNote(node.id, next, size)} />}
              </div>;
            })}
            {sectionPreview && <div className="canvas-section-preview" style={{ left: sectionPreview.x, top: sectionPreview.y, width: sectionPreview.width, height: sectionPreview.height }} />}
            {hoverIntent?.kind === "cell" && <div key={hoverIntent.key} className={`canvas-cell-drop-target ${hoverReady ? "is-ready" : ""}`} style={{ left: hoverIntent.rect.x, top: hoverIntent.rect.y, width: hoverIntent.rect.width, height: hoverIntent.rect.height }}>
              <span className="canvas-folder-hint" role="tooltip">{hoverReady ? "松开放入单元格" : "悬停以放入单元格"}</span>
            </div>}
            <svg className="canvas-graph-edges" aria-hidden="true">
              {drawableEdges.map(({ edge, from, to }) => {
                const fromMaterial = nodes.find(node => node.id === from.id || (node.kind === "folder" && node.assets.some(asset => asset.id === from.id)));
                const toMaterial = nodes.find(node => node.id === to.id || (node.kind === "folder" && node.assets.some(asset => asset.id === to.id)));
                const x1 = from.x + (fromMaterial ? nodeRect(fromMaterial).width : from.width);
                const y1 = from.y + (fromMaterial ? nodeRect(fromMaterial).height : nodeRect(from).height) / 2;
                const x2 = to.x;
                const y2 = to.y + (toMaterial ? nodeRect(toMaterial).height : nodeRect(to).height) / 2;
                const bend = Math.max(48, Math.abs(x2 - x1) * 0.42);
                return (
                  <path
                    key={edge.id}
                    className={`is-${edge.kind}${selectedCanvasNodeIds.has(fromMaterial?.id ?? from.id) || selectedCanvasNodeIds.has(toMaterial?.id ?? to.id) ? " is-selected" : ""}`}
                    d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                  />
                );
              })}
            </svg>
            {chatGraphNodes.map(node => {
              const chatId = canvasChatId(node)!;
              const chat = chatSummaries[chatId];
              return <div key={node.id} data-canvas-node data-canvas-node-id={node.id} data-local-chat-id={chatId}
                role="button" tabIndex={0} aria-label={`对话 · ${chat?.title ?? "本机 Codex"}`} aria-busy={localChatRunning(chat)}
                className={`canvas-chat-node${selectedCanvasNodeIds.has(node.id) ? " is-selected" : ""}${selectedChatId === chatId ? " is-focused" : ""}${localChatRunning(chat) ? " canvas-card-running" : ""}`}
                style={{ width: node.width, minHeight: node.height, transform: `translate3d(${node.x}px, ${node.y}px, 0)`, zIndex: activeDragId === node.id ? 10000 + node.zIndex : node.zIndex }}
                onPointerDown={event => beginGraphNodeDrag(event, node)} onPointerMove={moveGraphNode}
                onPointerUp={endGraphNodeDrag} onPointerCancel={event => endGraphNodeDrag(event, true)}
                onContextMenu={event => openCanvasNodeMenu(event, node.id)}
                onClick={event => {
                  if (consumeSuppressedNodeClick() || event.ctrlKey || event.metaKey || spacePressedRef.current || drawingTool === "pan") return;
                  openLocalChat(chatId);
                }}
                onKeyDown={event => {
                  if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) { event.preventDefault(); openLocalChat(chatId); }
                }}>
                {chat ? <LocalChatCard conversation={chat} /> : <div className="local-chat-card-content"><strong>本机 Codex 对话</strong><p>打开对话详情</p></div>}
              </div>;
            })}
            {promptGraphNodes.map((node) => {
              const conversation = conversationCards.cards.get(node.id);
              const latest = conversation?.latest ?? node;
              const images = conversationImages(node.id);
              const imageOnly = imageOnlyConversationIds.has(node.id);
              const selectedVideo = isVideoPath(selectedConversationImage(node.id, images)?.storePath);
              const openConversation = () => {
                focusGraphNode(node.id);
                if (summary.jobId && genJobs[summary.jobId]) {
                  setSnapshotPromptId(null);
                  openGenerationJob(summary.jobId, { navigate: false });
                } else {
                  setSnapshotPromptId(latest.id);
                  useStore.setState({ activeJobId: null, activeCloudAgentRunId: null, activeSessionKind: "generation", genEditing: null, genPanelOpen: true });
                }
              };
              const summary = promptNodeSummary(latest);
              const running = genJobs[summary.jobId]?.running ?? ["running", "querying", "queued"].includes(summary.status);
              return (
                <div
                  key={node.id}
                  data-canvas-node
                  data-canvas-node-id={node.id}
                  role="button"
                  data-canvas-filter={images.length ? materialFilterState(selectedConversationImage(node.id, images)!) : undefined}
                  tabIndex={0}
                  aria-busy={running}
                  aria-label={imageOnly ? `${selectedConversationImage(node.id, images)?.name ?? "生成图片"}，${selectedVideo ? "点击播放视频" : `${boardOpen || genEditing ? "单击加入创作" : "单击查看生成会话"}，双击放大`}` : undefined}
                  className={`canvas-prompt-node ${imageOnly ? "is-image-only" : ""} ${conversation?.outputs.length ? "has-conversation-images" : ""} ${running ? "canvas-card-running" : ""} ${selectedCanvasNodeIds.has(node.id) ? "is-selected" : ""} is-${summary.status} ${focusedNodeId === node.id ? "is-focused" : ""} ${activeDragId === node.id || (activeDragId != null && selectedCanvasNodeIds.has(node.id)) ? "is-moving" : ""} ${supersededTaskIds.has(latest.id) ? "is-superseded" : ""}`}
                  onContextMenu={(event) => openCanvasNodeMenu(event, node.id, latest)}
                  style={{
                    width: node.width,
                    minHeight: nodeRect(node).height,
                    height: imageOnly ? nodeRect(node).height : undefined,
                    transform: `translate3d(${node.x}px, ${node.y}px, 0)`,
                    zIndex: activeDragId === node.id || (activeDragId != null && selectedCanvasNodeIds.has(node.id)) ? 10000 + node.zIndex : node.zIndex,
                  }}
                  onPointerDown={(event) => {
                    beginGraphNodeDrag(event, node);
                  }}
                  onPointerMove={moveGraphNode}
                  onPointerUp={endGraphNodeDrag}
                  onPointerCancel={(event) => endGraphNodeDrag(event, true)}
                  onClick={(event) => {
                    if (consumeSuppressedNodeClick()) return;
                    if (imageOnly) { event.currentTarget.querySelector<HTMLElement>(".canvas-conversation-images")?.click(); return; }
                    openConversation();
                  }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.currentTarget.click();
                  }}
                >
                  {!imageOnly && <div><span>{conversation?.outputs.length ? "生成会话" : "生成指令"}</span><small>{summary.provider} · {generationStatusLabel(summary.status)}</small></div>}
                  {conversation && <CanvasConversationImages images={images} imageOnly={imageOnly}
                    selectedId={selectedConversationImage(node.id, images)?.id}
                    onSelect={selected => { cancelConversationImageClick(); setConversationImageSelection(previous => ({ ...previous, [node.id]: { newest: images[images.length - 1].id, selected } })); }} onPointerDown={event => {
                    cancelConversationImageClick();
                    // Capture on the image region so a click is not retargeted to the conversation card.
                    beginGraphNodeDrag(event, node);
                  }} onClick={(event, asset) => {
                    if (consumeSuppressedNodeClick()) return;
                    if (isVideoPath(asset.storePath) && asset.storePath) {
                      cancelConversationImageClick();
                      setCanvasLightbox({ images: [asset.storePath], index: 0 });
                      return;
                    }
                    const anchor = event.currentTarget;
                    const activate = () => {
                      if (!graphNodesRef.current.some(item => item.id === node.id && item.hiddenAt == null)) return;
                      const state = useStore.getState();
                      if (imageOnly && canvasPrimaryMaterialAction(state.boardOpen, !!state.genEditing) === "compose") {
                        if (asset.assetId) window.dispatchEvent(new CustomEvent(BOARD_ASSET_PICK_EVENT, { detail: { assetId: asset.assetId, canvasNodeId: asset.id } }));
                      } else if (imageOnly) openConversation();
                      else {
                        const material = nodes.find(item => item.kind === "asset" && item.asset.id === asset.id);
                        if (material?.kind === "asset") activateCanvasMaterial(material, anchor);
                      }
                    };
                    cancelConversationImageClick();
                    if (!imageOnly || event.detail === 0) activate();
                    else if (event.detail === 1) conversationImageClickRef.current = setTimeout(activate, 350);
                  }} onDoubleClick={(event, asset) => {
                    cancelConversationImageClick();
                    if (!imageOnly || event.ctrlKey || event.metaKey || spacePressedRef.current || drawingTool === "pan") return;
                    const path = asset.storePath ?? asset.thumbPath;
                    if (path) setCanvasLightbox({ images: [path], index: 0 });
                  }} onContextMenu={(event, asset) => {
                    cancelConversationImageClick();
                    const material = nodes.find(item => item.kind === "asset" && item.asset.id === asset.id);
                    if (material?.kind === "asset") openCanvasAssetContextMenu(event, { ...material, id: node.id }, material.asset);
                  }} />}
                  {!imageOnly && <section className="canvas-prompt-content"><ReadonlyPrompt prompt={summary.text} references={promptReferences.get(latest.id) ?? []} /></section>}
                </div>
              );
            })}
            {agentGraphNodes.map((node) => {
              const summary = agentGroupSummary(node);
              const run = summary.runId ? cloudAgentRuns[summary.runId] : undefined;
              const running = ["queued", "running", "cancel_requested", "awaiting_local_task"].includes(run?.status ?? summary.status);
              const resultCount = run ? selectCloudAgentResultArtifacts(run.snapshot.artifacts, run.snapshot.renderManifest, run.snapshot.events).length : summary.artifactCount;
              return (
                <div
                  key={node.id}
                  role="button"
                  tabIndex={0}
                  data-canvas-node
                  data-canvas-node-id={node.id}
                  aria-busy={running}
                  className={`canvas-agent-node ${running ? "canvas-card-running" : ""} ${selectedCanvasNodeIds.has(node.id) ? "is-selected" : ""} is-${summary.status} ${focusedNodeId === node.id ? "is-focused" : ""} ${activeDragId === node.id || (activeDragId != null && selectedCanvasNodeIds.has(node.id)) ? "is-moving" : ""} ${supersededTaskIds.has(node.id) ? "is-superseded" : ""}`}
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
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.currentTarget.click();
                  }}
                >
                  <div><span>Agent 执行组</span><small>{cloudAgentStatusLabel(summary.status)}</small></div>
                  <strong>{cloudAgentStepLabel(summary.currentStep ?? "")}</strong>
                  {(() => {
                    const prompt = graphNodes.find(candidate => agentPromptGroups.get(candidate.id)?.id === node.id);
                    return prompt ? <section className="canvas-prompt-content"><ReadonlyPrompt prompt={promptNodeSummary(prompt).text} references={promptReferences.get(prompt.id) ?? []} /></section> : null;
                  })()}
                  <p>
                    {summary.progress != null ? `${summary.progress}%` : "等待进度"}
                    {summary.pendingApprovals > 0 ? ` · ${summary.pendingApprovals} 项待批准` : ""}
                    {summary.pendingClarifications > 0 ? ` · ${summary.pendingClarifications} 个待澄清` : ""}
                    {resultCount > 0 ? ` · ${resultCount} 张图片` : ""}
                  </p>
                  {run && <footer className="mt-auto flex justify-start pt-2"><AgentApprovalToggle run={run} /></footer>}
                </div>
              );
            })}
            {guides.map((guide) => (
              <span
                key={`${guide.axis}-${guide.position}`}
                className={`canvas-snap-guide is-${guide.axis}`}
                style={guide.axis === "x"
                  ? { left: guide.position, width: 1 / zoom, backgroundSize: `100% ${12 / zoom}px` }
                  : { top: guide.position, height: 1 / zoom, backgroundSize: `${12 / zoom}px 100%` }}
              />
            ))}
            {visibleMaterials.map((node) => {
              const expanded = node.kind === "folder" && expandedFolderIds.has(node.id);
              const holding = hoverTargetId === node.id;
              const directFolderTarget = folderDropTargetId === node.id;
              const movingWithSelection = activeDragId === node.id
                || (activeDragId != null && selectedCanvasNodeIds.has(node.id));
              const path = node.kind === "asset" ? canvasAssetMediaPath(node.asset) : null;
              return (
                <div
                  key={node.id}
                  data-canvas-node
                  data-canvas-node-id={node.id}
                  role="group"
                  tabIndex={0}
                  aria-label={`${node.kind === "asset" ? `${node.asset.name}，${boardOpen || genEditing ? "点击加入创作" : "点击放大"}` : `素材组，${node.assets.length} 个素材，${expanded ? "已展开" : "点击展开"}`}${selectedCanvasNodeIds.has(node.id) ? "，已选中" : ""}`}
                  aria-expanded={node.kind === "folder" ? expanded : undefined}
                  data-canvas-filter={node.kind === "asset" ? materialFilterState(node.asset) : undefined}
                  className={`canvas-node is-${node.kind} ${node.kind === "asset" && isVideoPath(node.asset.storePath) ? "is-video" : ""} ${expanded ? "is-expanded" : ""} ${!showAssetNames ? "is-name-hidden" : ""} ${focusedNodeId === node.id ? "is-focused" : ""} ${selectedCanvasNodeIds.has(node.id) ? "is-selected" : ""} ${movingWithSelection ? "is-moving" : ""} ${holding ? "is-folder-target" : ""} ${directFolderTarget ? "is-folder-drop-target" : ""} `}
                  style={{
                    width: nodeRect(node).width,
                    height: nodeRect(node).height,
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
                      {isVideoPath(node.asset.storePath) ? <VideoPoster path={node.asset.storePath} poster={node.asset.thumbPath} alt={node.asset.name} draggable={false} /> : path ? (
                        <img src={convertFileSrc(path)} alt={node.asset.name} draggable={false} loading="lazy" />
                      ) : (
                        <div className="canvas-node-placeholder">{node.asset.name.slice(0, 1)}</div>
                      )}
                      {isVideoPath(node.asset.storePath) && <span className="canvas-video-badge" role="img" aria-label="视频" />}
                      <div className="pointer-events-none absolute left-1 top-1 z-10 flex items-center gap-1">
                        {node.asset.assetId && layerWorkspaceIds.has(node.asset.assetId) && <span className="rounded-full bg-black/70 px-1.5 py-1 text-white backdrop-blur" title="有分层工程" aria-label="有分层工程"><Layers size={12} /></span>}
                        {node.asset.assetId && captionedIds.has(node.asset.assetId) && (
                          <span
                            className="rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] text-white backdrop-blur"
                            title="已反推（有提示词描述）"
                            aria-label="已反推（有提示词描述）"
                          >🏷️</span>
                        )}
                      </div>
                      {showAssetNames && <span className="canvas-node-name">{node.asset.name}</span>}
                    </>
                  ) : (
                    <>
                      {expanded ? <>
                        <header className="canvas-folder-header">
                          <Folder size={16} /><strong>素材组</strong><span>{node.assets.length} 张素材</span>
                          <button type="button" aria-label="收起素材组" title="收起素材组"
                            onPointerDown={(event) => event.stopPropagation()}
                            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " " || event.key.startsWith("Arrow")) event.stopPropagation(); }}
                            onClick={() => setFolderExpanded(node.id, false)}><ChevronUp size={16} /></button>
                        </header>
                        <div className="canvas-folder-expanded-grid" style={{ gridAutoRows: showAssetNames ? 164 : 140 }}>
                          {node.assets.map((asset, index) => {
                            const assetPath = canvasAssetMediaPath(asset);
                            return <button type="button" key={asset.id} data-canvas-folder-asset-id={asset.id}
                              data-canvas-filter={materialFilterState(asset)}
                              className="canvas-folder-asset" aria-label={asset.name}
                              onPointerDown={(event) => { if (!isCanvasPanGesture(event.button, spacePressedRef.current, drawingTool === "pan")) event.stopPropagation(); }}
                              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " " || event.key.startsWith("Arrow")) event.stopPropagation(); }}
                              onClick={(event) => { if (!consumeSuppressedNodeClick()) activateCanvasMaterial(groupedAssetNode(asset, node, index), event.currentTarget); }}
                              onContextMenu={(event) => openCanvasAssetContextMenu(event, node, asset)}>
                              {isVideoPath(asset.storePath) ? <VideoPoster path={asset.storePath} poster={asset.thumbPath} alt={asset.name} draggable={false} /> : assetPath ? <img src={convertFileSrc(assetPath)} alt="" draggable={false} loading="lazy" />
                                : <span className="canvas-folder-asset-placeholder">{asset.name.slice(0, 1)}</span>}
                              {showAssetNames && <span className="canvas-folder-asset-name">{asset.name}</span>}
                            </button>;
                          })}
                        </div>
                      </> : <>
                        <FolderPreview node={node} filterState={materialFilterState} onAssetContextMenu={(event, asset) => openCanvasAssetContextMenu(event, node, asset)} />
                        <span className="canvas-folder-name"><Folder size={13} /> 素材组 · {node.assets.length}</span>
                      </>}
                    </>
                  )}
                  {holding && <span className="canvas-folder-hint" role="tooltip">{hoverReady ? "松开创建素材组" : "悬停以创建素材组"}</span>}
                  {directFolderTarget && <span className="canvas-folder-hint" role="tooltip">松手移入素材组</span>}
                  {!expanded && <CanvasResizeHandle label={node.kind === "asset" ? "调整素材大小" : "调整素材组大小"} size={nodeRect(node)} zoom={zoom}
                    minimum={{ width: 140, height: 120 }}
                    constrain={node.kind === "asset" ? (start, delta) => {
                      // Preserve the image ratio, excluding the fixed caption and borders.
                      const ratio = node.asset.width && node.asset.height ? node.asset.height / node.asset.width : (start.height - (showAssetNames ? 32 : 2)) / (start.width - 2);
                      const change = Math.abs(delta.width) >= Math.abs(delta.height / ratio) ? delta.width : delta.height / ratio;
                      const size = canvasAssetNodeSize({ width: 1, height: ratio }, Math.max(96, 2 + 32 / ratio, start.width + change));
                      return { ...size, height: size.height - (showAssetNames ? 0 : 30) };
                    } : undefined}
                    onResize={(size, finished, cancelled) => resizeCanvasMaterial(node.id, {
                      ...size, height: size.height + (node.kind === "asset" && !showAssetNames ? 30 : 0),
                    }, finished, cancelled)} />}
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

          {nodes.length === 0 && promptGraphNodes.length === 0 && agentGraphNodes.length === 0 && chatGraphNodes.length === 0
            && !graphNodes.some(node => node.kind === "note" && node.hiddenAt == null)
            && !workflowNodes.some(node => node.kind !== "text") && !loading && (
            <div className="canvas-empty-state" aria-hidden="true">
              <span><Move size={20} /></span>
              <strong>把左侧素材拖到这里</strong>
              <p>素材靠近时会自动吸附；在另一素材上停留 1 秒后松开，即可建立透明素材组。</p>
            </div>
          )}
          {externalDragOver && <div className="canvas-drop-label">松开放到画布</div>}
        </div>
        {viewMode === "timeline" && (
          <CreativeTimeline
            nodes={timelineNodes}
            edges={timelineEdges}
            selectedNodeId={focusedNodeId}
            onSelect={id => { const node = graphNodes.find(node => node.id === id); const chatId = node && canvasChatId(node); if (chatId) openLocalChat(chatId); else focusGraphNode(id); }}
            onLocate={locateGraphNode}
          />
        )}
        {!selectedChatId && shouldMountProjectComposer(loading, activeSessionKind === "generation" && !!genEditing) && (
          <CreativeComposer
            key={`${activeCanvas.id}:${composerDraftRevision}`}
            projectId={activeCanvas.id}
            draftJson={activeCanvas.draftJson}
            initialAssetIds={composerSeedIds}
            continuationCandidates={continuationCandidates}
            focusedContinuationNodeId={focusedNodeId}
            focusedContinuationThreadId={focusedThreadId}
            promptLoadRequest={promptLoadRequest}
            onPromptLoadConsumed={onLaunchConsumed}
            onDraftChange={draftJson => { if (activeCanvasRef.current.id === activeCanvas.id) persistComposerDraft(draftJson); }}
            onOpenLibrary={() => {
              if (!useStore.getState().canvasLibraryOpen) {
                changeSource("global");
                setCanvasLibraryOpen(true);
                beginOnboardingOperation("expand-source", projectId)();
              }
              requestAnimationFrame(() => sourcePanelRef.current?.focus({ preventScroll: true }));
            }}
            registerDraftFlush={(flush) => {
              composerDraftFlushRef.current = flush;
            }}
            beforeGenerate={prepareForGeneration}
            onSendChat={startLocalChat}
            onChatDraftSent={sentDraft => clearSentChatDraft(activeCanvas.id, sentDraft)}
            onOpenChatHistory={() => setChatHistoryOpen(open => !open)}
            chatHistoryOpen={chatHistoryOpen}
            onGenerateLocalVideo={async request => {
              const workflow = workflowRef.current;
              const bounds = stageRef.current?.getBoundingClientRect();
              if (!workflow || !bounds) throw new Error("画板正在载入，请稍后重试");
              const point = toBoardPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 3);
              const position = placeCanvasCardNearSource({ ...point, width: 416, height: 360 }, selectionAnchors().map(anchor => anchor.rect));
              await workflow.startLocalVideo(request, position);
            }}
            resolveCreativeThread={resolveCreativeThread}
          />
        )}
        {selectedChatId && projectId && !loading && <LocalChatPanel key={selectedChatId} conversationId={selectedChatId} projectId={projectId}
          onClose={() => { setSelectedChatId(null); useStore.getState().setBoardActive(false); }}
          onSelectConversation={openLocalChat}
          onNewConversation={newLocalChat}
          getCardDefaults={chatCardDefaults} onLocateCards={locateChatCards} onUndoCards={undoChatCards}
          onOpenLibrary={() => { changeSource("global"); setCanvasLibraryOpen(true); useStore.getState().setBoardActive(true); }} />}
        {chatHistoryOpen && projectId && <div id="project-chat-history" className="canvas-chat-history"><LocalChatHistory projectId={projectId}
          activeConversationId={selectedChatId ?? undefined} onOpen={openLocalChat} onClose={() => setChatHistoryOpen(false)} /></div>}
        {workflowAgentDetail && workflowAgentDetail.projectId === projectId && !loading && !genPanelOpen && <WorkflowAgentDetail
          key={`${projectId}:${workflowAgentDetail.nodeId}`} projectId={workflowAgentDetail.projectId} nodeId={workflowAgentDetail.nodeId}
          graphNodes={graphNodes} onOpenGeneration={openWorkflowGeneration} onClose={() => setWorkflowAgentDetail(null)} />}
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
            composing={activeSessionKind === "generation" && genEditing === "revise"}
            onClose={() => setGenPanelOpen(false)}
          >
            {snapshotPrompt
              ? <CanvasConversation turns={savedConversation} selectedId={snapshotPrompt.id} onReuse={reuseCanvasPrompt} onAddVideoFrame={addVideoFrame} onSaveVideoTrim={saveVideoTrim} />
              : activeSessionKind === "generation"
              ? <GenerationPanel embedded hydratedAssets={canvasAssets} onAddVideoFrame={addVideoFrame} onSaveVideoTrim={saveVideoTrim} />
              : activeAgentRun
                ? <CloudAgentSession embedded hydratedAssets={canvasAssets} />
                : (
                    <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted">
                      请从画板节点或任务中心选择一个 Agent 任务。
                    </div>
                  )}
          </ProjectInspectorShell>
        )}
        {promptMenu && <ContextMenu key={`${promptMenu.x}:${promptMenu.y}`} x={promptMenu.x} y={promptMenu.y}
          label={promptMenu.node?.kind === "agent_group" ? "Agent 执行组菜单" : promptMenu.node ? "生成指令菜单" : "画板节点菜单"}
          onClose={() => setPromptMenu(null)}>
            {promptMenu.point && <button type="button" role="menuitem" className="app-context-item px-2 py-1.5" onClick={() => newDraftAt(promptMenu.point!)}>
              <PenTool size={14} /> 新建草稿
            </button>}
            {promptMenu.point && <button type="button" role="menuitem" className="app-context-item px-2 py-1.5" onClick={() => {
              createCanvasNote({ ...promptMenu.point!, width: 480, height: 360 }, "section", { base_asset_id: null }); setPromptMenu(null);
            }}><Scan size={14} /> 新建画板</button>}
            {promptMenu.nodeIds.length > 0 && <button type="button" role="menuitem" className="app-context-item px-2 py-1.5" onClick={() => {
              void copyCanvasSelection(promptMenu.nodeIds); setPromptMenu(null);
            }}><Copy size={14} /> 复制所选卡片</button>}
            {canvasImagesForSelection(promptMenu.nodeIds, true).length > 0 && <button type="button" role="menuitem" title="将所选内容制成压缩包"
              className="app-context-item px-2 py-1.5" onClick={() => {
                const ids = canvasImagesForSelection(promptMenu.nodeIds, true).map(asset => asset.assetId);
                setPromptMenu(null);
                void exportAssetArchive(ids);
              }}><Archive size={14} /> 将所选内容打包</button>}
            {promptMenu.nodeIds.length > 0 && <button type="button" role="menuitem" className="app-context-item px-2 py-1.5" onClick={() => {
              workflowRef.current?.saveTemplate(promptMenu.nodeIds, "container"); setPromptMenu(null);
            }}><Frame size={14} /> 封装为容器</button>}
            {WORKFLOW_TEMPLATE_LIBRARY_ENABLED && [...expandCanvasSections(new Set(promptMenu.nodeIds), graphNodes)].some(id => canvasWorkflowController(activeCanvasRef.current.id).document.nodes.some(node => node.id === id && !["trigger", "text", "planner"].includes(node.kind))) &&
              <button type="button" role="menuitem" className="app-context-item px-2 py-1.5" onClick={() => {
                workflowRef.current?.saveTemplate(promptMenu.nodeIds); setPromptMenu(null);
              }}><Copy size={14} /> 存为模板</button>}
            {promptMenu.nodeIds.some(id => canvasWorkflowController(activeCanvasRef.current.id).document.nodes.some(node => node.id === id && !["trigger", "text", "planner"].includes(node.kind))) &&
              <button type="button" role="menuitem" className="app-context-item px-2 py-1.5" onClick={() => {
                workflowRef.current?.saveTemplate(promptMenu.nodeIds, "package"); setPromptMenu(null);
              }}><Copy size={14} /> 导出工作流数据包</button>}
            <button type="button" role="menuitem" className="app-context-item px-2 py-1.5" onClick={() => {
              workflowRef.current?.templates(true); setPromptMenu(null);
            }}><Copy size={14} /> 导入工作流数据包</button>
            <button type="button" role="menuitem" className="app-context-item px-2 py-1.5" onClick={() => {
              const point = promptMenu.point ?? toBoardPoint(promptMenu.x, promptMenu.y); setPromptMenu(null);
              void navigator.clipboard.readText().catch(() => canvasClipboardText).then(text => {
                const value = parseCanvasClipboard(text);
                if (value) return pasteCanvasSelection(value, point);
                notify("剪贴板中没有可粘贴的画板卡片", "info");
              });
            }}><Copy size={14} /> 粘贴卡片</button>
            {promptMenu.nodeIds.length > 0 && !promptMenu.nodeIds.some(id => workflowRef.current?.bounds().some(node => node.id === id)) && <CanvasLayerMenuItem projectId={activeCanvasRef.current.id} nodeIds={promptMenu.nodeIds}
              className="app-context-item px-2 py-1.5" />}
            {canvasImagesForSelection(promptMenu.nodeIds).length > 0 && <button type="button" role="menuitem" className="app-context-item px-2 py-1.5" onClick={() => addCanvasImagesToBoard(promptMenu.nodeIds)}>
              <Images size={14} className="shrink-0" /> {canvasImagesForSelection(promptMenu.nodeIds).length > 1
                ? `添加所选 ${canvasImagesForSelection(promptMenu.nodeIds).length} 张图片到对话框`
                : "添加到对话框"}
            </button>}
            {promptMenu.nodeIds.length > 0 && <button type="button" role="menuitem" className="app-context-item px-2 py-1.5" onClick={() => {
              arrangeNodes(promptMenu.nodeIds);
              setPromptMenu(null);
            }}>
              <LayoutDashboard size={14} /> 整理
            </button>}
            {promptMenu.node && promptMenu.nodeIds.length === 1 && <button type="button" role="menuitem" className="app-context-item px-2 py-1.5" onClick={() => reuseCanvasPrompt(promptMenu.node!)}>
              <Copy size={14} /> 复用提示词
            </button>}
            {(promptMenu.section || promptMenu.nodeIds.length > 0) && <><div className="app-context-divider" /><DeleteSubmenu>
            {promptMenu.section && <button type="button" role="menuitem" title="移除分区框，保留其中的卡片" className="app-context-item is-danger px-2 py-1.5" onClick={() => {
              removeNodes([promptMenu.section!.id]);
              setPromptMenu(null);
            }}>
              <Trash2 size={14} className="shrink-0" /> {graphNodes.some(node => node.id === promptMenu.section!.id && readCanvasNote(node).workflow_container) ? "解封容器" : graphNodes.some(node => node.id === promptMenu.section!.id && readCanvasNote(node).artboard) ? "移除画板" : "移除分区"}「{promptMenu.section.name}」
            </button>}
            {promptMenu.folder && promptMenu.nodeIds.length === 1 && <button type="button" role="menuitem" className="app-context-item px-2 py-1.5" onClick={() => {
              ungroupFolder(promptMenu.folder!);
              setPromptMenu(null);
            }}>
              <Ungroup size={14} /> 解散素材组
            </button>}
            {promptMenu.nodeIds.length > 0 && <button type="button" role="menuitem" className="app-context-item is-danger px-2 py-1.5" onClick={() => {
              removeNodes(promptMenu.nodeIds);
              setPromptMenu(null);
            }}>
              <Trash2 size={14} className="shrink-0" /> {promptMenu.nodeIds.length > 1
                ? `从画布移出所选 ${promptMenu.nodeIds.length} 项`
                : "从画布移出"}
            </button>}
            {promptMenu.node?.kind === "prompt" && promptMenu.nodeIds.length === 1 && <button type="button" role="menuitem" className="app-context-item is-danger px-2 py-1.5 disabled:opacity-40"
              disabled={promptSessionJobs(promptMenu.node).some((job) => job.running)}
              title={promptSessionJobs(promptMenu.node).some((job) => job.running) ? "生成中，请结束后再删除会话" : "删除会话记录及指令卡片，保留已生成图片"}
              onClick={() => deletePromptSession(promptMenu.node!)}>
              <Trash2 size={14} /> 删除会话
            </button>}
            </DeleteSubmenu></>}
        </ContextMenu>}
        {artboardDialog && <CanvasArtboardDialog composition={artboardDialog.composition} onClose={() => setArtboardDialog(null)}
          onSubmit={async (prompt, instruction, references, provider) => {
            const origin = artboardDialog;
            const assertCurrent = () => {
              const state = useStore.getState();
              if (!isWorkspaceOperationCurrent(origin.projectId, state.activeProjectId, state.projectRoutePending, origin.revision, state.projectRouteRevision)
                || !graphNodesRef.current.some(node => node.id === origin.nodeId && node.hiddenAt == null)) throw new Error("画板或项目已变化，请重新打开合成窗口");
            };
            assertCurrent();
            await prepareForGeneration();
            assertCurrent();
            const thread = await resolveCreativeThread(null, instruction, origin.revision);
            assertCurrent();
            const result = await useStore.getState().startGeneration(prompt, references, null, provider, instruction, undefined, undefined, [], null,
              { projectId: origin.projectId, threadId: thread.threadId, referenceNodeIds: references.map((asset, index) => index < 2 ? null : origin.composition.images.find(image => image.asset.id === asset.id)?.nodeId ?? null) }, true);
            if (!result.accepted) throw new Error(result.error || "合成提交失败");
          }} />}
        {replicationProjectId === projectId && replicationProjectId && <VideoReplicationDialog key={`replication-${replicationProjectId}`} projectId={replicationProjectId}
          onAddFrame={addVideoFrame}
          onCreateWorkflow={async request => {
            const draft = activeCanvasRef.current, stage = stageRef.current;
            if (!draft || draft.id !== replicationProjectId || !stage) throw new Error("项目已切换，请重新打开工具");
            await ensureMaterialized(draft); await flushCanvasWrites(false);
            if (activeCanvasRef.current?.id !== draft.id) throw new Error("项目已切换，请重新打开工具");
            const controller = canvasWorkflowController(draft.id);
            await controller.load();
            if (activeCanvasRef.current?.id !== draft.id) throw new Error("项目已切换，请重新打开工具");
            if (!controller.ready || controller.error) throw new Error(controller.error || "画板正在载入");
            const bounds = stage.getBoundingClientRect();
            const center = toBoardPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
            const position = placeCanvasCardNearSource({ x: center.x - 180, y: center.y - 160, width: 1460, height: 680 }, selectionAnchors().map(item => item.rect));
            const current = useStore.getState();
            const built = replicationWorkflow(request, draft.id, current.activeGenProvider || current.defaultProvider, position.x, position.y);
            const existing = await api.projectCanvasGet(draft.id);
            for (const note of built.notes) {
              if (existing.nodes.some(item => item.id === note.id)) continue;
              const { hiddenAt: _hidden, createdAt: _created, updatedAt: _updated, ...input } = note;
              await api.projectCanvasNodeCreate(input);
            }
            await controller.edit([...controller.document.nodes, ...built.nodes.filter(node => !controller.document.nodes.some(item => item.id === node.id))]);
            if (activeCanvasRef.current?.id !== draft.id) throw new Error("项目已切换，工作流已保存在原项目，尚未运行");
            const snapshot = await api.projectCanvasGet(draft.id);
            if (activeCanvasRef.current?.id !== draft.id) return;
            graphNodesRef.current = snapshot.nodes; setGraphNodes(snapshot.nodes);
            setSelectedCanvasNodeIds(new Set([built.selectedId]));
            const first = controller.document.nodes.find(node => node.id === built.selectedId)!;
            const rect = { ...built.rect, x: first.x, y: first.y };
            const view = canvasViewForNewCard(rect, { x: 80, y: 60, width: Math.max(200, bounds.width - 120), height: Math.max(200, bounds.height - 270) }, panRef.current, zoomRef.current, true);
            if (view) { panRef.current = view.pan; zoomRef.current = view.zoom; setPan(view.pan); setZoom(view.zoom); markViewDirty(); }
          }}
          onClose={() => setReplicationProjectId(null)} ensureProject={async () => {
            const draft = activeCanvasRef.current;
            if (!draft || draft.id !== replicationProjectId) throw new Error("项目已切换，请重新打开工具");
            await ensureMaterialized(draft);
          }} />}
        {canvasLightbox && (
          <Lightbox
            onAddVideoFrame={addVideoFrame}
            onSaveVideoTrim={saveVideoTrim}
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
