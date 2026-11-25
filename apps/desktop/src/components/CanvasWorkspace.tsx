import { DimensionBadge } from "./DimensionBadge";
import { replicationAnalysisNote } from "../lib/replicationAnalysisNote";
import { optimizeComposerLocalVideo } from "../lib/composerLocalVideo";
import { GenerationJobPreview, GenerationJobProgress } from "./GenerationJobFeedback";
import { originalDeletionEpoch, originalDeletionFor, subscribeOriginalDeletionCommits, usePendingOriginalDeletion } from "../lib/pendingOriginalDeletion";
import { dismissNotices, readDismissedNotices, subscribeDismissedNotices } from "../lib/dismissedNotices";
import { userErrorMessage } from "../lib/userError";
import { isTextAsset, isTextPath } from "../lib/textMedia";
import { readFileContentCards } from "../lib/fileContentCards";
import { CreationImagePreview } from "./CreationImagePreview";
import { CanvasImageContinuation } from "./ImagePreviewContinuation";
import { LibraryVideoPreview } from "./LibraryVideoPreview";
import { CreationModeIndicator } from "./CreationModeIndicator";
import { creationImageAssetId, useCreationImageInteraction } from "./useCreationImageInteraction";
import { useImeGuard } from "../lib/useImeGuard";
import { useLocalFileMode } from "../lib/localFileMode";
import { libraryProject, libraryShortcutMode } from "../lib/localFileMode";
import { ProjectInspectorShell } from "./ProjectInspectorShell";
import { WorkflowAgentDetail } from "./WorkflowAgentDetail";
import { WORKFLOW_SKILL_ENABLED, WORKFLOW_PLANNER_ENABLED, WORKFLOW_TEMPLATE_LIBRARY_ENABLED } from "../lib/featureFlags";
import { CanvasTextCard } from "./CanvasTextCard";
import { CanvasDocumentCard } from "./CanvasDocumentCard";
import type { TextWorkspaceDocument } from "../lib/documentTypes";
import { documentToPromptLoad } from "../lib/documentComposer";
import type { CreativePromptLoadRequest } from "../lib/creativeLaunch";
import { CanvasArtboardDialog } from "./CanvasArtboardDialog";
import { CANVAS_ARTBOARD_FROM_IMAGE, artboardComposition, containArtboardImage, intersectArtboard, type ArtboardComposition, type ArtboardImage } from "../lib/canvasArtboard";
import { CanvasToolbox } from "./CanvasToolbox";
import { VideoReplicationDialog } from "./VideoReplicationDialog";
import { CanvasWorkflowLayer, WindingKey, type WorkflowLayerHandle, type WorkflowGeometry, type MaterialAnchor } from "./CanvasWorkflowLayer";
import { CanvasContextMenu, type CanvasContextMenuState, type CanvasMenuImage } from "./CanvasContextMenu";
import { GALLERY_MERGED_EVENT, type GalleryMerge } from "../lib/generationGallery";
import { canvasConversationCards, canvasConversationGroupTarget } from "../lib/canvasConversationCards";
import { CanvasConnectionHandle } from "./CanvasConnectionHandle";
import { CanvasConversationImages } from "./CanvasConversationImages";
import { GenerationGroupControls } from "./GenerationGroupControls";
import { canvasMaterialFilterState, type CanvasMaterialFilterState } from "../lib/canvasMaterialFilter";
import { containedSessionOutputIds, contentRoutedWorkflowSessionIds, hiddenWorkflowSessionIds, resolveGenerationCells, canvasSessionImages, workflowGenerationCardProjection, workflowGenerationActivity, type WorkflowGenerationActivity } from "../lib/canvasSessionOutputs";
import { canvasWorkflowController } from "../lib/canvasWorkflowRuntime";
import { resolveWorkflowTaskFocus } from "../lib/workflowTaskFocus";
import { restoreWorkflowEdit, workflowEditUndo, type WorkflowEditUndo } from "../lib/workflowUndo";
import { restoreCanvasNoteEdit } from "../lib/canvasNoteUndo";
import { removeWorkflowNodes } from "../lib/workflowRemoval";
import { WORKFLOW_CARD_DRAG_TYPE, workflowCardWidth, workflowNodeRun, type WorkflowInput, type WorkflowKind } from "../lib/canvasWorkflow";
import { replicationWorkflow } from "../lib/replicationWorkflow";
import { captureCanvasClipboard, cloneCanvasClipboard, parseCanvasClipboard, serializeCanvasClipboard, type CanvasClipboard } from "../lib/canvasClipboard";
import { CanvasResizeHandle } from "./CanvasResizeHandle";
import { CanvasLibraryResize } from "./CanvasLibraryResize";
import { useAssetTransferDialogs } from "./AssetTransferMenuItems";
import { buildCanvasContextMenu, type CanvasMenuAction } from "../lib/canvasContextMenu";
import { CANVAS_LAYER_STEP_EVENT, stepCanvasLayers, type CanvasLayerStepDetail } from "../lib/canvasLayers";
import { ReadonlyPrompt } from "./creation/ReadonlyPrompt";
import "./CanvasNotes.css";
import { CanvasTacticalOverlay } from "./CanvasTacticalOverlay";
import { TacticalSelect } from "./TacticalSelect";
import "./CanvasTactical.css";
import "./CanvasTacticalCards.css";
import { canvasDocumentHeight, canvasSectionMembers, canvasTextMinSize, emptyCanvasCell, expandCanvasSections, readCanvasNote, SECTION_COLORS, type CanvasNotePayload } from "../lib/canvasNotes";
import { beginOnboardingOperation, useOnboarding } from "../lib/onboardingStore";
import { notify, notifyError } from "../lib/notify";
import { arrangeCanvasNodes } from "../lib/canvasArrangement";
import { workflowArrangementEdges } from "../lib/canvasOutputPlacement";
import { canvasCardSourceRects, placeCanvasCardNearSource, newReferencesForCanvasCard, placeNewCanvasReferences, trackNewCanvasReferences } from "../lib/canvasReferencePlacement";
import { DEFAULT_VIDEO_OPTIONS, isVideoPath, videoModelLabel } from "../lib/videoGeneration";
import { isAudioPath } from "../lib/audioMedia";
import { AudioWaveform } from "./AudioWaveform";
import { VideoPoster } from "./VideoPoster";
import { CanvasMediaHover } from "./CanvasMediaHover";
import { renderCanvasCards, useCanvasEntryCardContext } from "./CanvasEntryCard";
import { CanvasImage, CanvasMediaProvider } from "./CanvasImage";
import { useCanvasFrame, useLatestCallback } from "../lib/useCanvasFrame";
import { CANVAS_DRAG_Z_LIFT, canvasDragPreview, dragWire, graphWirePath } from "../lib/canvasDragPreview";
import { canvasPaintWindow } from "../lib/canvasPaintWindow";
import { createCanvasCellHitCache } from "../lib/canvasCellHitCache";
import { lazyModule } from "../lib/lazyModule";
import {
  useCallback,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type CSSProperties,
  type ComponentProps,
  type PointerEvent,
  type SyntheticEvent,
  type WheelEvent,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import {
  Archive,
  ArchiveRestore,
  Copy,
  ChevronUp,
  Folder,
  FileText,
  Images,
  LayoutDashboard,
  Layers,
  List,
  LoaderCircle,
  Maximize2,
  MessageSquarePlus,
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
  Palette,
  Repeat2,
  Plus,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import { LibraryCatalog } from "./LibraryCatalog";
import { CanvasFrequentAssets, useCanvasFrequentAssets } from "./CanvasFrequentAssets";
import { Lightbox } from "./Lightbox";
import type { VideoFrame } from "../lib/videoFrame";
import { saveVideoFrame } from "../lib/saveVideoFrame";
import { videoSourceKey } from "../lib/videoSourceKey";
import { VIDEO_FRAME_CANVAS_EVENT, type VideoFrameCanvasDetail } from "../lib/videoFrameCanvas";
import { VIDEO_COLLECTION_CANVAS_EVENT, VIDEO_COLLECTION_PROJECT_EVENT, type VideoCollectionProjectDetail, type VideoCollectionCanvasDetail } from "../lib/videoCollectionCanvas";
import type { VideoTrimRequest } from "../lib/videoTrim";
import { CreativeComposer } from "./CreativeComposer";
import { CanvasConversation } from "./CanvasConversation";
import { LocalChatPanel, LocalChatCard, LocalChatHistory } from "./LocalChatPanel";
import { useProjectChatSummaries, useLocalChatStore } from "../lib/localChatStore";
import { LOCAL_CHAT_CARDS_CHANGED_EVENT, LOCAL_CHAT_UPDATED_EVENT, localChat, localChatRunning, type ChatCardAction, type ChatCardDefaults, type ChatConversation, type ChatComposeRequest } from "../lib/localChat";
import { canvasChatId } from "../lib/canvasChat";
import { canvasConversationTurn, canvasConversationTurns } from "../lib/canvasConversation";
import { GenerationPanel } from "./GenerationPanel";
import { CloudAgentSession } from "./CloudAgentPanel";
import { AgentApprovalToggle } from "./AgentApprovalToggle";
import { CreativeTimeline, generationStatusLabel } from "./CreativeTimeline";
import { api } from "../lib/api";
import { externalFiles } from "../lib/externalFiles";
import { countCloudAgentResultImages, selectCloudAgentResultArtifacts } from "../lib/cloudAgentResult";
import { getDragAssets, isNativeAssetDrag } from "../lib/dragPayload";
import { EXTERNAL_DRAG_ENDED, startExternalDrag } from "../lib/externalDrag";
import { createCanvasDragHold } from "../lib/canvasDragHold";
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
  prepareCanvasSnapAnchors,
  type CanvasSnapAnchor,
  snapCanvasRectPrepared,
  type PreparedCanvasSnapAnchors,
  translateCanvasSelection,
  type CanvasPoint,
  type CanvasRect,
  type CanvasSnapGuide,
} from "../lib/canvasLogic";
import { BOARD_ASSET_PICK_EVENT } from "./creation/useCreationEditor";
import {
  canvasAssetNodeSize,
  canvasAssetMediaPath,
  canvasPromptReferenceLookup,
  agentPromptGroupMap,
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
  type ProjectCanvasUiNode,
  canvasOriginalDeletionProjection,
} from "../lib/creativeCanvas";
import {
  creativeLaunchTargetsProject,
  creativePromptLoadForProject,
  type CreativeLaunchRequest,
} from "../lib/creativeLaunch";
import { createOrderedWriteJournal, drainOrderedWriteJournal } from "../lib/orderedWriteJournal";
import { useStore } from "../store";
import { EXPLORER_CANVAS_DROP_EVENT, prepareExplorerCanvasDrop, type ExplorerCanvasDropDetail } from "../lib/explorerCanvasDrop";
import { importDroppedMedia, prepareMediaImport } from "../lib/mediaImport";
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

const TextWorkspace = lazyModule(() => import("./TextWorkspace").then(module => ({ default: module.TextWorkspace })));
const ASSET_WIDTH = 190;
let canvasClipboardText = "";
const FOLDER_WIDTH = 204;
const FOLDER_HEIGHT = 178;
const DEFAULT_TITLE = "未命名创作";
const CANVAS_SNAP_ENABLED_KEY = "bowerbird.canvasSnapEnabled";

type CanvasNode = ProjectCanvasUiNode;
type CanvasAssetNode = Extract<CanvasNode, { kind: "asset" }>;
type CanvasFolderNode = Extract<CanvasNode, { kind: "folder" }>;

interface DragProjection {
  preview?: ReturnType<typeof canvasDragPreview>;
  apply?: () => void;
}

function clearDragProjection(drag: DragProjection | null) {
  if (!drag) return;
  drag.preview?.clear();
  drag.preview = null;
  drag.apply = undefined;
}

interface CanvasMarqueePress {
  origin: CanvasPoint;
  cursor: CanvasPointerSample;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  active: boolean;
  crossedThreshold?: boolean;
  additive: boolean;
  baseSelection: Set<string>;
  anchors?: CanvasSnapAnchor[];
  sectionIds?: Set<string>;
}

type CanvasUndoEntry =
  | { kind: "gallery"; projectId: string; edit: GalleryMerge }
  | { kind: "names"; projectId: string; before: Record<string, string | undefined> }
  | { kind: "content"; projectId: string; before: ProjectGraphNode; after: ProjectGraphNode; typedAt?: number; restoredMaterials?: CanvasNode[] }
  | { kind: "materials"; projectId: string; before: CanvasNode[]; after: CanvasNode[]; groups: Map<string, CanvasGroup> }
  | { kind: "workflow"; projectId: string; edit: WorkflowEditUndo; connectedGenerationId?: string }
  | { kind: "paste"; projectId: string; nodeIds: string[]; groupIds: string[]; workflowIds: string[] }
  | { kind: "removal"; changedFolders?: CanvasFolderNode[]; projectId: string; materials: CanvasNode[]; graph: ProjectGraphNode[]; groups: Map<string, CanvasGroup>; workflow?: WorkflowEditUndo | null }
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

const ENTRY_LIGHT_CARD_LIMIT = 48;
const ENTRY_MIN_BATCH_WEIGHT = 24;
const ENTRY_HEAVY_CARD_WEIGHT = 6;
const ENTRY_FRAME_BUDGET_MS = 16;
const EMPTY_ENTRY_CARDS: ReadonlySet<string> = new Set();

function afterCanvasPaint(run: () => void) {
  let timer: number | undefined;
  const frame = requestAnimationFrame(() => { timer = window.setTimeout(run, 0); });
  return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); };
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
  onAssetPointerDown,
  filterState,
}: {
  node: CanvasFolderNode;
  filterState: (asset: CanvasAssetSnapshot) => CanvasMaterialFilterState;
  onAssetContextMenu: (event: React.MouseEvent<HTMLElement>, asset: CanvasAssetSnapshot) => void;
  onAssetPointerDown: (event: PointerEvent<HTMLElement>, asset: CanvasAssetSnapshot) => void;
}) {
  const layerWorkspaceIds = useStore((state) => state.layerWorkspaceIds);
  return (
    <div className="canvas-folder-grid" aria-hidden="true">
      {node.assets.slice(0, 4).map((asset) => {
        const path = canvasAssetMediaPath(asset);
        return isVideoPath(asset.storePath) ? <VideoPoster key={asset.id} data-frequent-asset-id={asset.assetId ?? undefined} data-canvas-filter={filterState(asset)} path={asset.storePath} poster={asset.thumbPath} alt={asset.name} draggable={false} onPointerDown={event => onAssetPointerDown(event, asset)} onContextMenu={event => onAssetContextMenu(event, asset)} /> : path ? (
          <div key={asset.id} data-frequent-asset-id={asset.assetId ?? undefined} data-canvas-filter={filterState(asset)} className="relative min-h-0" onPointerDown={event => onAssetPointerDown(event, asset)} onContextMenu={(event) => onAssetContextMenu(event, asset)}>
            <CanvasImage
              path={asset.storePath} thumbPath={asset.thumbPath} sourceWidth={asset.width} sourceHeight={asset.height}
              alt=""
              draggable={false}
              loading="lazy"
            />
            {asset.assetId && layerWorkspaceIds.has(asset.assetId) && <span className="pointer-events-none absolute left-1 top-1 z-10 rounded-full bg-black/70 px-1.5 py-1 text-white backdrop-blur" title="有分层工程" aria-label="有分层工程"><Layers size={12} /></span>}
          </div>
        ) : (
          <span key={asset.id} data-frequent-asset-id={asset.assetId ?? undefined} data-canvas-filter={filterState(asset)} onPointerDown={event => onAssetPointerDown(event, asset)} onContextMenu={(event) => onAssetContextMenu(event, asset)}>
            {asset.name.slice(0, 1)}
          </span>
        );
      })}
      {node.assets.length > 4 && <b>+{node.assets.length - 4}</b>}
    </div>
  );
}


type CanvasPointerSample = Pick<PointerEvent<HTMLElement>, "pointerId" | "clientX" | "clientY" | "currentTarget">;
function canvasPointerSample(event: PointerEvent<HTMLElement>): CanvasPointerSample {
  return { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, currentTarget: event.currentTarget };
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
  const noticeScope = `canvas-generation:${projectId}`;
  const dismissed = useSyncExternalStore(subscribeDismissedNotices, () => readDismissedNotices(noticeScope));
  function generationFailureKey(node: ProjectGraphNode, summary: ReturnType<typeof promptNodeSummary>) {
    return JSON.stringify(["generation", summary.jobId, summary.turnKey || node.id]);
  }
  function dismissFailureButton(key: string) {
    return <button type="button" className="canvas-failure-dismiss" aria-label="关闭本次错误提示" title="关闭本次错误提示"
      onPointerDown={event => event.stopPropagation()} onClick={event => {
        event.stopPropagation();
        dismissNotices(noticeScope, [key]);
      }}><X size={13} /></button>;
  }
  const smartFilter = useStore((state) => state.smartFilter);
  const mediaFilter = useStore((state) => state.mediaFilter);
  const promptedAssets = useStore((state) => state.promptedAssets);
  const captionedIds = useStore((state) => state.captionedIds);
  const layerWorkspaceIds = useStore((state) => state.layerWorkspaceIds);
  const projects = useStore((state) => state.projects);
  const reloadProjects = useStore((state) => state.reloadProjects);
  const openContextMenu = useStore((state) => state.openContextMenu);
  const showAssetNames = useStore((state) => state.settings?.canvas_show_asset_names ?? false);
  const [workflowAgentDetail, setWorkflowAgentDetail] = useState<{ projectId: string; nodeId: string; entryKey?: string } | null>(null);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [h3ChatEditor, setH3ChatEditor] = useState<{ projectId: string; chatId: string; apply: (text: string) => Promise<void> } | null>(null);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const [composerDraftRevision, setComposerDraftRevision] = useState(0);
  const chatSummaries = useProjectChatSummaries(projectId, true);
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
  useEffect(() => {
    if (!workflowAgentDetail || workflowAgentDetail.entryKey || workflowAgentDetail.projectId !== projectId) return;
    const chat = Object.values(chatSummaries).find(chat => chat.projectId === projectId && chat.nodeId === workflowAgentDetail.nodeId);
    if (chat) { setWorkflowAgentDetail(null); setSelectedChatId(chat.id); }
  }, [chatSummaries, workflowAgentDetail, projectId]);
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
  const [graphEdges, setGraphEdges] = useState<CanvasEdge[]>([]);
  const pendingOriginals = usePendingOriginalDeletion();
  const [canvasReadEpoch, setCanvasReadEpoch] = useState(originalDeletionEpoch);
  const hideCanvasOriginal = useCallback((id?: string | null, path?: string | null) =>
    !!originalDeletionFor(id, path, canvasReadEpoch), [canvasReadEpoch]);
  const projection = useMemo(() =>
    pendingOriginals.size || canvasReadEpoch < originalDeletionEpoch()
      ? canvasOriginalDeletionProjection(nodes, graphNodes, graphEdges, hideCanvasOriginal)
      : { materials: nodes, graph: graphNodes, hidden: new Set<string>() },
    [nodes, graphNodes, graphEdges, pendingOriginals, canvasReadEpoch, hideCanvasOriginal]);
  const shownMaterials = projection.materials, shownGraph = projection.graph;
  // Foreground controls share the plane with persisted nodes and their temporary drag lift.
  const workflowForegroundZ = useMemo(() => {
    const materialZ = shownMaterials.reduce((highest, node) => Math.max(highest, node.order), 0);
    const nodeZ = shownGraph.reduce((highest, node) => Math.max(highest, node.zIndex), materialZ);
    return Math.max(11000, nodeZ + CANVAS_DRAG_Z_LIFT + 1);
  }, [shownGraph, shownMaterials]);
  const outputNodesById = useMemo(() => new Map(shownGraph.filter(node => node.kind === "asset" && node.role === "output")
    .map(node => [node.id, node])), [shownGraph]);
  const concealedNodeIds = useRef(projection.hidden);
  concealedNodeIds.current = projection.hidden;
  const nonChatGraphNodes = useMemo(() => shownGraph.filter(node => !canvasChatId(node)), [shownGraph]);
  const [threads, setThreads] = useState<CreativeThread[]>([]);
  const archivedThreadIds = useMemo(() => new Set(threads.filter(thread => thread.archivedAt != null).map(thread => thread.id)), [threads]);
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
  const [sourceCatalogVisited, setSourceCatalogVisited] = useState(!sourceCollapsed);
  const frequentLibrary = useCanvasFrequentAssets(!sourceCollapsed, projectId);
  const [frequentPicking, setFrequentPicking] = useState(false);
  const frequentPickingRef = useRef(frequentPicking);
  frequentPickingRef.current = frequentPicking;
  useEffect(() => { setFrequentPicking(false); }, [projectId, exploring]);
  const setCanvasLibraryOpen = useStore(state => state.setCanvasLibraryOpen);
  const setSourceCollapsed = useCallback((collapsed: boolean) => setCanvasLibraryOpen(!collapsed), [setCanvasLibraryOpen]);
  const sourcePanelRef = useRef<HTMLElement>(null);
  const sourceDragFrame = useRef<number | null>(null);
  const [libraryDragging, setLibraryDragging] = useState(false);
  const libraryDragActive = useRef(false);
  const boardShellRef = useRef<HTMLElement>(null);
  const explainTutorialSources = useOnboarding(state => state.guide.status === "active" && state.guide.role === "designer"
    && state.guide.sessions.designer?.projectId === projectId && [2, 7, 8].includes(state.guide.sessions.designer.step));
  const sourcePanelId = useId();
  const planeId = useId();
  const localFilesOpen = useLocalFileMode(state => state.open);
  const browseProjectId = useLocalFileMode(libraryProject);
  const libraryMedia = useLocalFileMode(state => state.media);
  function openLibrary() {
    useLocalFileMode.getState().setOpen(true);
    useStore.getState().clearSelect();
  }
  function closeSource() {
    useLocalFileMode.getState().setOpen(false);
    setSourceCollapsed(true);
    requestAnimationFrame(() => boardShellRef.current?.querySelector<HTMLButtonElement>('.canvas-source-toggle')?.focus());
  }
  useEffect(() => { if (localFilesOpen) setCanvasLibraryOpen(true); }, [localFilesOpen, setCanvasLibraryOpen]);

  const [canvasAssets, setCanvasAssets] = useState<Asset[]>([]);
  const audioOverwriteRevision = useRef(0);
  const [catalogAssets, setCatalogAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [entryCardIds, setEntryCardIds] = useState<ReadonlySet<string> | null>(EMPTY_ENTRY_CARDS);
  const [entryViewportReady, setEntryViewportReady] = useState(false);
  const opening = loading || !entryViewportReady;
  const entryCandidates = useRef<ReadonlySet<string> | null>(null);
  const prioritizeEntry = useRef<(pan: CanvasPoint, zoom: number) => void>();
  const inputDuringEntry = useRef(0);
  const openingStatus = useRef<HTMLDivElement>(null);
  const entryCardIdsRef = useRef(entryCardIds);
  const entryCommitAt = useRef(0);
  useLayoutEffect(() => {
    entryCardIdsRef.current = entryCardIds;
    entryCommitAt.current = performance.now();
  }, [entryCardIds]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);
  const restoredEntry = useRef<{ projectId: string; loadRevision: number }>();
  const [savingVisible, setSavingVisible] = useState(false);
  const saveIndicator = useRef({ busy: false, timer: 0 });
  function setSaving(busy: boolean) {
    const indicator = saveIndicator.current;
    if (indicator.busy === busy) return;
    indicator.busy = busy;
    window.clearTimeout(indicator.timer);
    indicator.timer = window.setTimeout(() => setSavingVisible(busy), busy ? 250 : 350);
  }
  useEffect(() => () => window.clearTimeout(saveIndicator.current.timer), []);
  const [error, setError] = useState<string | null>(null);
  const [layoutDragId, setActiveDragId] = useState<string | null>(null);
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
  const marqueeElement = useRef<HTMLDivElement>(null);
  const wheelStageRect = useRef<DOMRect | undefined>(undefined);
  const gridElement = useRef<HTMLDivElement>(null);
  const paintWindow = useRef<ReturnType<typeof canvasPaintWindow> | null>(null);
  const [selectedCanvasNodeIds, setSelectedCanvasNodeIds] = useState<Set<string>>(() => new Set());
  const [canvasLightbox, setCanvasLightbox] = useState<{ images: string[]; assetIds?: Array<string | null>; canvasNodeId?: string; index: number } | null>(null);
  const videoFrameSaves = useRef(new Map<string, () => Promise<void>>());
  const videoTrimSaves = useRef(new Map<string, () => Promise<Asset>>());
  const [promptMenu, setPromptMenu] = useState<CanvasContextMenuState | null>(null);
  const transfer = useAssetTransferDialogs();
  useEffect(() => { setPromptMenu(null); }, [projectId, viewMode]);
  const viewSaveTimer = useRef<ReturnType<typeof setTimeout>>();
  const mediaZoomHandle = useRef<((value: number) => void) | null>(null);
  const [documentEditor, setDocumentEditor] = useState<{ nodeId: string; projectId: string; initialDocument: TextWorkspaceDocument } | null>(null);
  const documentEditorSession = useRef(0);
  const documentEditorRevision = useRef(0);
  const [documentPromptLoad, setDocumentPromptLoad] = useState<CreativePromptLoadRequest | null>(null);
  const documentSaveRef = useRef<{ nodeId: string; payloadJson: string } | null>(null);
  const pendingDocumentInput = useRef<() => void>();
  const documentSaveTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => { setDocumentEditor(null); return () => { documentEditorSession.current++; flushDocumentCard(); }; }, [projectId, viewMode]);
  useEffect(() => { setDocumentPromptLoad(null); }, [projectId]);
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
  const [diagnosticTarget, setDiagnosticTarget] = useState<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const planeRef = useRef<HTMLDivElement>(null);
  const zoomLabelRef = useRef<HTMLSpanElement>(null);
  const centeredEditorRef = useRef<HTMLElement | null>(null);
  const editorCenterFrameRef = useRef<number | null>(null);
  useEffect(() => {
    const stop = () => { if (editorCenterFrameRef.current != null) settleCamera(); };
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("blur", stop);
      cancelEditorCenter();
      centeredEditorRef.current = null;
    };
  }, [projectId, viewMode]);
  const cameraSettleRef = useRef<ReturnType<typeof setTimeout>>();
  const snapSizeObserverRef = useRef<ResizeObserver | null>(null);
  const cellHitCacheRef = useRef<ReturnType<typeof createCanvasCellHitCache> | null>(null);
  const lastImportPointRef = useRef<{ projectId: string; x: number; y: number } | null>(null);
  const nodesRef = useRef(nodes);
  // Mutations publish this ref synchronously, even while their React render is pending.
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
  const undoInFlightRef = useRef(false);
  const [canUndo, setCanUndo] = useState(false);
  useEffect(() => {
    const onMerge = (event: Event) => {
      const { edit, projectId } = (event as CustomEvent<{ edit: GalleryMerge; projectId: string | null }>).detail;
      if (projectId === activeCanvasRef.current.id) pushCanvasUndo({ kind: "gallery", projectId, edit });
    };
    window.addEventListener(GALLERY_MERGED_EVENT, onMerge);
    return () => window.removeEventListener(GALLERY_MERGED_EVENT, onMerge);
  }, []);
  function pushCanvasUndo(entry: CanvasUndoEntry) {
    const history = undoHistoryRef.current;
    history.push(entry);
    if (history.length > 80) history.shift();
    setCanUndo(true);
  }
  function popCanvasUndo() {
    const entry = undoHistoryRef.current.pop();
    setCanUndo(undoHistoryRef.current.length > 0);
    return entry;
  }
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
  const canvasDragHold = useRef(createCanvasDragHold());
  const canvasExportRef = useRef<AbortController | null>(null);
  const nodeDragRef = useRef<DragProjection & {
    nodeId: string;
    toggleSelection: boolean;
    selectedIds: Set<string>;
    initialNodes: CanvasNode[];
    initialGraphNodes: ProjectGraphNode[];
    initialWorkflow: WorkflowGeometry[];
    snapAnchors?: PreparedCanvasSnapAnchors;
    crossedThreshold?: boolean;
    pointerId: number;
    offsetX: number;
    offsetY: number;
    startClientX: number;
    startClientY: number;
    moved: boolean;
  } | null>(null);
  const graphNodeDragRef = useRef<DragProjection & {
    nodeId: string;
    toggleSelection: boolean;
    initialNodes: ProjectGraphNode[];
    initialMaterialNodes: CanvasNode[];
    initialWorkflow: WorkflowGeometry[];
    snapAnchors?: PreparedCanvasSnapAnchors;
    crossedThreshold?: boolean;
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
  const blankPressCount = useRef(0);
  const selectedCanvasNodeIdsRef = useRef(selectedCanvasNodeIds);
  const [drawingTool, setDrawingTool] = useState<"select" | "pan" | "section" | "artboard" | "bubble" | "document" | Exclude<WorkflowKind, "trigger">>("select");
  const [artboardDialog, setArtboardDialog] = useState<{ nodeId: string; projectId: string; revision: number; composition: ArtboardComposition } | null>(null);
  useEffect(() => { setArtboardDialog(null); }, [projectId]);
  const workflowRef = useRef<WorkflowLayerHandle>(null);
  const pastingRef = useRef(false);
  const [workflowRevision, setWorkflowRevision] = useState(0);
  const workflow = projectId ? canvasWorkflowController(projectId) : null;
  const [workflowEntry, setWorkflowEntry] = useState<{ projectId: string; revision: number; error: string | null; retry: () => void } | null>(null);
  const workflowCardsChanged = useRef<() => void>(() => {});
  const currentWorkflowEntry = workflowEntry?.projectId === projectId && workflowEntry?.revision === projectRouteRevision ? workflowEntry : null;
  const workflowInteractive = !!workflow?.ready && currentWorkflowEntry?.error === null && !loading && !loadFailed
    && !projectRoutePending && activeCanvas.id === projectId;
  const workflowNodes = workflowInteractive ? workflow.document.nodes : [];
  const writerFailureKeys = useMemo(() => {
    const byCard = new Map<string, string[]>();
    if (!projectId || !workflowInteractive) return byCard;
    const controller = canvasWorkflowController(projectId);
    for (const node of controller.document.nodes) {
      if (!node.textTarget && !node.textSource) continue;
      const failure = controller.cardFailure(node.id);
      if (!failure || failure.dismissed) continue;
      for (const cardId of new Set([node.textTarget?.nodeId, node.textSource])) {
        if (cardId) byCard.set(cardId, [...(byCard.get(cardId) ?? []), failure.key]);
      }
    }
    return byCard;
  }, [projectId, workflowRevision, workflowInteractive]);
  const workflowHistoryIds = useMemo(() => hiddenWorkflowSessionIds(workflowNodes, shownGraph, genJobs), [workflowNodes, shownGraph, genJobs]);
  const containedOutputIds = useMemo(() => containedSessionOutputIds(shownGraph, workflowNodes), [shownGraph, workflowNodes]);
  const conversationCards = useMemo(() => canvasConversationCards(shownGraph, genJobs,
    new Set([...workflowHistoryIds, ...agentPromptGroupMap(shownGraph, graphEdges).keys(),
      ...shownGraph.filter(node => node.threadId && archivedThreadIds.has(node.threadId)).map(node => node.id)]),
    new Set([...containedOutputIds, ...shownMaterials.filter(node => node.kind === "folder").flatMap(node => node.assets.map(asset => asset.id))]), contentRoutedWorkflowSessionIds(shownGraph, workflowNodes)),
    [shownGraph, genJobs, workflowHistoryIds, graphEdges, archivedThreadIds, containedOutputIds, shownMaterials, workflowNodes]);
  const generationMedia = useMemo(() => {
    const standalone = new Set<string>(), delivered = new Set<string>();
    for (const node of shownMaterials) {
      if (node.kind === "asset" && node.asset.storePath) standalone.add(node.id);
      for (const asset of node.kind === "asset" ? [node.asset] : node.assets) if (asset.storePath) delivered.add(asset.id);
    }
    return { standalone, delivered };
  }, [shownMaterials]);
  const generationCardProjection = useMemo(() => {
    if (!workflowInteractive || !workflow) return { anchors: new Map<string, ProjectGraphNode>(), origins: new Map<string, typeof workflowNodes[number]>() };
    const unavailable = new Set([...containedOutputIds, ...shownGraph.filter(node => node.kind === "asset" && !generationMedia.standalone.has(node.id)
      || node.threadId && archivedThreadIds.has(node.threadId)).map(node => node.id)]);
    return workflowGenerationCardProjection(workflow.document, shownGraph, conversationCards, unavailable);
  }, [workflowInteractive, workflow, workflowNodes, workflowRevision, shownGraph, conversationCards, containedOutputIds, generationMedia, archivedThreadIds]);
  const previousGenerationActivities = useRef<ReadonlyMap<string, WorkflowGenerationActivity>>(new Map());
  const generationActivities = useMemo(() => {
    const activities = new Map<string, WorkflowGenerationActivity>();
    if (!workflowInteractive || !workflow) return activities;
    for (const node of workflowNodes) {
      if (node.kind !== "generation" && node.kind !== "comfy-video") continue;
      const run = workflowNodeRun(workflow.document, node.id);
      const activity = workflowGenerationActivity(node, run, graphNodes, genJobs, generationMedia.delivered);
      const previous = previousGenerationActivities.current.get(node.id);
      const threadId = activity.session?.threadId ?? run?.threadId;
      // Keep a live card through delivery, without treating a historical removed result as active on entry.
      if (activity.awaitingOutput && activity.attemptId && previous?.attemptId === activity.attemptId && previous.running
        && (!activity.session || !projection.hidden.has(activity.session.id))
        && (!threadId || !archivedThreadIds.has(threadId))) activity.running = true;
      activities.set(node.id, activity);
    }
    return activities;
  }, [workflowInteractive, workflow, workflowNodes, workflowRevision, graphNodes, genJobs, generationMedia, archivedThreadIds, projection.hidden]);
  useLayoutEffect(() => { previousGenerationActivities.current = generationActivities; }, [generationActivities]);
  const activeGenerationIds = useMemo(() => new Set([...generationActivities].flatMap(([id, activity]) =>
    activity.running || workflow?.startingAction(id) ? [id] : [])), [generationActivities, workflow, workflowRevision]);
  const [pinnedWorkflowCards, setPinnedWorkflowCards] = useState<ReadonlyMap<string, CanvasPoint & { attemptId?: string }>>(() => new Map());
  const [peekedCard, setPeekedCard] = useState<{ nodeId: string; anchorId: string } | null>(null);
  const livePeekAnchor = peekedCard && (shownMaterials.find(node => node.id === peekedCard.anchorId)
    ?? shownGraph.find(node => node.id === peekedCard.anchorId));
  const peekInteraction = useRef<{ anchor: HTMLElement; composing: boolean; point?: CanvasPoint; attemptId?: string } | null>(null);
  const peekAnchorPoint = livePeekAnchor ?? (peekedCard && activeGenerationIds.has(peekedCard.nodeId) ? peekInteraction.current?.point : undefined);
  useLayoutEffect(() => {
    if (livePeekAnchor && peekInteraction.current) peekInteraction.current.point = { x: livePeekAnchor.x, y: livePeekAnchor.y };
  }, [livePeekAnchor]);
  const peekIntent = useRef<ReturnType<typeof setTimeout>>();
  const peekClose = useRef<ReturnType<typeof setTimeout>>();
  const lastCardDragEnd = useRef(-Infinity);
  const externalDragInStage = useRef(false);
  const clearPeek = useCallback(() => {
    clearTimeout(peekIntent.current);
    clearTimeout(peekClose.current);
    peekInteraction.current = null;
    setPeekedCard(null);
  }, []);
  const [quickRevision, setQuickRevision] = useState<{ anchorId: string; image: CanvasAssetSnapshot; invoker?: HTMLElement } | null>(null);
  const quickRevisionPanel = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!quickRevision) return;
    const panel = quickRevisionPanel.current;
    (panel?.querySelector<HTMLElement>("textarea") ?? panel)?.focus({ preventScroll: true });
  }, [quickRevision]);
  const [previewMember, setPreviewMember] = useState<{ openedId: string; nodeId: string } | null>(null);
  const newConnectedTextarea = useRef<HTMLTextAreaElement | null>(null);
  const pinnedCardOffsets = useMemo(() => new Map([...pinnedWorkflowCards].filter(([id]) => generationCardProjection.anchors.has(id) || activeGenerationIds.has(id))),
    [pinnedWorkflowCards, generationCardProjection.anchors, activeGenerationIds]);
  const collapsedGenerationAnchors = useMemo(() => new Map([...generationCardProjection.anchors].filter(([id]) => !pinnedCardOffsets.has(id) && !activeGenerationIds.has(id))),
    [generationCardProjection.anchors, pinnedCardOffsets, activeGenerationIds]);
  const lastWorkflowFocus = useRef<{ id: string; element: HTMLElement } | null>(null);
  useEffect(() => {
    const rememberFocus = (event: FocusEvent) => {
      const target = event.target;
      if (target !== newConnectedTextarea.current) newConnectedTextarea.current = null;
      const id = target instanceof HTMLElement && stageRef.current?.contains(target)
        ? target.closest<HTMLElement>("[data-workflow-card]")?.dataset.workflowCard : undefined;
      lastWorkflowFocus.current = id && target instanceof HTMLElement ? { id, element: target } : null;
    };
    document.addEventListener("focusin", rememberFocus);
    return () => document.removeEventListener("focusin", rememberFocus);
  }, []);
  useLayoutEffect(() => {
    if ([...selectedCanvasNodeIdsRef.current].some(id => collapsedGenerationAnchors.has(id))) {
      setSelectedCanvasNodeIds(current => new Set([...current].map(id => collapsedGenerationAnchors.get(id)?.id ?? id)));
    }
    const previous = lastWorkflowFocus.current;
    const anchor = previous && collapsedGenerationAnchors.get(previous.id);
    if (anchor && previous && !previous.element.isConnected && document.activeElement === document.body) {
      stageRef.current?.querySelector<HTMLElement>(`[data-canvas-node-id="${CSS.escape(anchor.id)}"]`)?.focus({ preventScroll: true });
    }
  }, [collapsedGenerationAnchors]);
  useEffect(() => {
    clearPeek();
    setPinnedWorkflowCards(new Map());
    setQuickRevision(null);
    setPreviewMember(null);
  }, [clearPeek, projectId, projectRouteRevision]);
  useEffect(() => () => {
    clearTimeout(peekIntent.current);
    clearTimeout(peekClose.current);
  }, []);
  useEffect(() => {
    if (!workflow || (!pinnedWorkflowCards.size && !peekedCard)) return;
    if (peekedCard && peekInteraction.current) {
      const { nodeId, anchorId } = peekedCard;
      const activity = generationActivities.get(nodeId), interaction = peekInteraction.current;
      if (activity?.running && activity.attemptId) interaction.attemptId = activity.attemptId;
      if (!activeGenerationIds.has(nodeId) && (interaction.attemptId && activity?.terminal && interaction.attemptId === activity.attemptId
        || generationCardProjection.anchors.get(nodeId)?.id !== anchorId)) clearPeek();
    }
    let updated: Map<string, CanvasPoint & { attemptId?: string }> | undefined;
    for (const [id, entry] of pinnedWorkflowCards) {
      const activity = generationActivities.get(id);
      if (!activeGenerationIds.has(id) && (!generationCardProjection.anchors.has(id)
        || entry.attemptId && activity?.terminal && entry.attemptId === activity.attemptId)) {
        (updated ??= new Map(pinnedWorkflowCards)).delete(id);
      } else if (activity?.running && activity.attemptId && entry.attemptId !== activity.attemptId) {
        (updated ??= new Map(pinnedWorkflowCards)).set(id, { ...entry, attemptId: activity.attemptId });
      }
    }
    if (updated) setPinnedWorkflowCards(updated);
  }, [workflow, generationCardProjection.anchors, generationActivities, activeGenerationIds, pinnedWorkflowCards, peekedCard, clearPeek]);
  const conversationCardsRef = useRef(conversationCards);
  conversationCardsRef.current = conversationCards;
  const [conversationImageSelection, setConversationImageSelection] = useState<Record<string, { newest: string; selected: string }>>({});
  const conversationImageClickRef = useRef<ReturnType<typeof setTimeout>>();
  function cancelConversationImageClick() {
    clearTimeout(conversationImageClickRef.current);
    conversationImageClickRef.current = undefined;
  }
  useEffect(() => cancelConversationImageClick, [projectId, boardOpen, genEditing]);
  useEffect(() => {
    if (!frequentPicking) return;
    setDrawingTool("select");
    cancelConversationImageClick();
    setPromptMenu(null);
    useStore.getState().closeContextMenu();
  }, [frequentPicking]);
  function conversationImages(id: string) {
    return conversationImagesById.get(id) ?? [];
  }
  const conversationImagesById = useMemo(() => {
    const materials = new Map(shownMaterials.flatMap(node => node.kind === "asset" ? [[node.id, node.asset] as const] : []));
    return new Map([...conversationCards.cards].map(([id, card]) => [id, card.outputs.flatMap(output => {
      const asset = materials.get(output.id);
      return asset ? [asset] : [];
    })]));
  }, [shownMaterials, conversationCards]);
  function selectedConversationImage(id: string, images: CanvasAssetSnapshot[]) {
    const selection = conversationImageSelection[id];
    const newest = images[images.length - 1];
    return (selection?.newest === newest?.id && images.find(image => image.id === selection?.selected)) || newest;
  }
  const selectedConversationOutputs = useMemo(() => new Map([...conversationCards.cards].flatMap(([id, card]) => {
    const selected = selectedConversationImage(id, conversationImages(id));
    const output = selected && (card.allOutputs.find(item => item.id === selected.id) ?? card.allOutputs.find(item => item.assetId === selected.assetId));
    const embedded = output && conversationCards.embedded.get(output.id);
    if (!output) return [];
    const source = { id: output.id, video: isVideoPath(selected?.storePath) };
    return [[id, source] as const, ...(embedded ? [[JSON.stringify([embedded.nodeId, embedded.cellId]), source] as const] : [])];
  })), [conversationCards, conversationImageSelection, conversationImagesById]);
  const imageOnlyConversationIds = useMemo(() => new Set([...conversationCards.cards].flatMap(([id, card]) => {
    const summary = promptNodeSummary(card.latest);
    const running = genJobs[summary.jobId]?.running ?? ["running", "querying", "queued"].includes(summary.status);
    const images = conversationImages(id);
    return images.length && (running ? images.some(image => !isVideoPath(image.storePath))
      : summary.status === "done" || summary.status === "failed") ? [id] : [];
  })), [conversationCards, genJobs, conversationImagesById]);
  function displayedMaterial(node: CanvasNode): CanvasNode {
    if (node.kind !== "asset") return node;
    const shown = selectedConversationImage(node.id, conversationImages(node.id));
    return shown ? { ...node, asset: shown } : node;
  }
  const visibleMaterials = useMemo(() => shownMaterials.filter(node => !containedOutputIds.has(node.id) && !conversationCards.hiddenIds.has(node.id)).map(displayedMaterial), [shownMaterials, containedOutputIds, conversationCards, conversationImagesById, conversationImageSelection]);
  function chooseCanvasTool(tool: typeof drawingTool) {
    if (tool !== "select") clearTimeout(peekIntent.current);
    workflowRef.current?.cancelPlacement();
    setDrawingTool(tool);
  }
  function canvasCardTool(kind: "bubble" | "document" | Exclude<WorkflowKind, "trigger">) {
    const enabled = workflowInteractive || ["text", "document", "bubble"].includes(kind);
    return {
      disabled: !enabled,
      draggable: enabled,
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
  focusedThreadIdRef.current = focusedThreadId;
  timelineScopeRef.current = timelineScope;
  viewModeRef.current = viewMode;
  activeCanvasRef.current = activeCanvas;
  loadingRef.current = opening;
  selectedCanvasNodeIdsRef.current = selectedCanvasNodeIds;

  const nodeFrame = useCanvasFrame(updateNodeDrag);
  const graphNodeFrame = useCanvasFrame(updateGraphNodeDrag);
  const panFrame = useCanvasFrame(updatePan);
  const cameraFrame = useCanvasFrame<void>(() => {
    paintCamera();
    const marquee = marqueePressRef.current;
    if (marquee?.active) updatePan(marquee.cursor);
    clearTimeout(cameraSettleRef.current);
    cameraSettleRef.current = setTimeout(settleCamera, 120);
  });
  useEffect(() => {
    const hold = canvasDragHold.current;
    const move = (event: globalThis.PointerEvent) => hold.move(event.pointerId, { x: event.clientX, y: event.clientY }, event.buttons);
    const end = (event: globalThis.PointerEvent) => hold.end(event.pointerId);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" || event.code === "Space") hold.cancel(); };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("blur", hold.cancel);
    return () => {
      hold.cancel(); canvasExportRef.current?.abort();
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("blur", hold.cancel);
    };
  }, [projectId, projectRouteRevision, projectRoutePending, viewMode, exploring]);
  const readCanvasZoom = useCallback(() => { cameraFrame.flush(); return zoomRef.current; }, [cameraFrame]);
  // The refs own the live camera during gestures; React catches up when input settles.
  const activeDragId = layoutDragId ?? (nodeDragRef.current?.moved ? nodeDragRef.current.nodeId
    : graphNodeDragRef.current?.moved ? graphNodeDragRef.current.nodeId : null);
  const manyCanvasCards = Math.max(graphNodes.length, nodes.length) + workflowNodes.length >= 150;
  useLayoutEffect(() => {
    if (!manyCanvasCards || !planeRef.current || !stageRef.current || loading || viewMode !== "canvas") return;
    const window = canvasPaintWindow(planeRef.current, stageRef.current);
    paintWindow.current = window;
    return () => { window.dispose(); paintWindow.current = null; };
  }, [manyCanvasCards, projectId, loading, viewMode]);
  useLayoutEffect(paintCamera, [pan.x, pan.y, zoom, projectId, loading, viewMode, manyCanvasCards, entryCardIds]);
  useEffect(() => () => {
    clearTimeout(cameraSettleRef.current);
    clearDragProjection(nodeDragRef.current); clearDragProjection(graphNodeDragRef.current);
    nodeFrame.cancel(); graphNodeFrame.cancel(); panFrame.cancel(); cameraFrame.cancel();
    cellHitCacheRef.current?.dispose(); cellHitCacheRef.current = null;
    snapSizeObserverRef.current?.disconnect(); snapSizeObserverRef.current = null;
  }, [projectId, nodeFrame, graphNodeFrame, panFrame, cameraFrame]);

  useEffect(() => {
    setSelectedCanvasNodeIds(new Set());
    setDrawingTool("select");
    setSectionPreview(null);
    sectionDrawRef.current = null;
    setCanvasLightbox(null);
    undoHistoryRef.current = [];
    setCanUndo(false);
    resizeBaselineRef.current.clear();
    lastCardDragEnd.current = -Infinity;
    if (marqueeElement.current) marqueeElement.current.hidden = true;
    marqueePressRef.current = null;
  }, [projectId]);

  const arrangeRequestedNodes = useLatestCallback((event: Event) => {
    const detail = (event as CustomEvent<CanvasArrangeNodesEventDetail>).detail;
    if (!detail || detail.projectId !== activeCanvasRef.current.id || loadingRef.current || useStore.getState().projectRoutePending) return;
    arrangeNodes(detail.nodeIds);
  });
  useEffect(() => {
    window.addEventListener(CANVAS_ARRANGE_NODES_EVENT, arrangeRequestedNodes);
    return () => window.removeEventListener(CANVAS_ARRANGE_NODES_EVENT, arrangeRequestedNodes);
  }, [arrangeRequestedNodes]);

  const changeLayers = useLatestCallback((event: Event) => {
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
    persistGeometries(materials.filter(node => orders.has(node.id)), graph.filter(node => node.kind !== "asset" && orders.has(node.id)));
  });
  useEffect(() => {
    window.addEventListener(CANVAS_LAYER_STEP_EVENT, changeLayers);
    return () => window.removeEventListener(CANVAS_LAYER_STEP_EVENT, changeLayers);
  }, [changeLayers]);

  const assetById = useMemo(() => {
    const map = new Map<string, Asset>();
    for (const asset of promptedAssets) map.set(asset.id, asset);
    for (const asset of assets) map.set(asset.id, asset);
    for (const asset of catalogAssets) map.set(asset.id, asset);
    for (const asset of [...frequentLibrary.items.frequent, ...frequentLibrary.items.pinned]) map.set(asset.id, asset);
    for (const asset of canvasAssets) map.set(asset.id, asset);
    return map;
  }, [assets, canvasAssets, catalogAssets, frequentLibrary.items, promptedAssets]);
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

  function markViewDirty(notify = true) {
    viewDirtyRef.current = true;
    viewRevisionRef.current += 1;
    if (notify) scheduleViewSave();
  }

  function scheduleViewSave() {
    clearTimeout(viewSaveTimer.current);
    if (viewDirtyRef.current && !loadingRef.current) viewSaveTimer.current = setTimeout(() => void queueViewPersistence(false), 220);
  }

  function paintCamera() {
    wheelStageRect.current = undefined;
    const currentPan = panRef.current;
    const currentZoom = zoomRef.current;
    prioritizeEntry.current?.(currentPan, currentZoom);
    if (planeRef.current) {
      paintWindow.current?.paint(currentPan, currentZoom);
      planeRef.current.style.transform = `translate3d(${currentPan.x}px, ${currentPan.y}px, 0) scale(${currentZoom})`;
    }
    if (stageRef.current) {
      // The industrial grid repeats every 80 screen pixels. Pan its own layer
      // without repainting the stage or invalidating inherited styles on every card.
      if (gridElement.current) gridElement.current.style.transform = `translate3d(${currentPan.x % 80}px,${currentPan.y % 80}px,0)`;
    }
    const label = `${Math.round(currentZoom * 100)}%`;
    if (zoomLabelRef.current && zoomLabelRef.current.textContent !== label) zoomLabelRef.current.textContent = label;
  }

  function cancelEditorCenter() {
    if (editorCenterFrameRef.current != null) cancelAnimationFrame(editorCenterFrameRef.current);
    editorCenterFrameRef.current = null;
  }

  function settleCamera() {
    cancelEditorCenter();
    clearTimeout(cameraSettleRef.current);
    cameraFrame.cancel();
    paintCamera();
    mediaZoomHandle.current?.(zoomRef.current);
    scheduleViewSave();
  }

  function scheduleCamera() {
    cameraFrame.push();
    clearTimeout(cameraSettleRef.current);
    clearTimeout(viewSaveTimer.current);
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
    panFrame.flush();
    settleCamera();
    // Pull the editor's latest in-memory ProseMirror document through the
    // persistence callback before waiting on the queue.
    composerDraftFlushRef.current?.();
    flushDocumentCard();
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
      if (inputs.length === 1) await api.projectCanvasNodeCreate(inputs[0]);
      else await api.projectCanvasNodesBatchCreate(draft.id, inputs);
    }
  }

  function persistAddedNodes(assetNodes: CanvasAssetNode[]) {
    const draft = activeCanvasRef.current;
    if (assetNodes.length) pushCanvasUndo({ kind: "paste", projectId: draft.id, nodeIds: assetNodes.map(node => node.id), groupIds: [], workflowIds: [] });
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

  function persistGeometries(materials: readonly CanvasNode[], graph: readonly ProjectGraphNode[] = []) {
    if (!materials.length && !graph.length) return;
    const draft = activeCanvasRef.current;
    void enqueueWrite(async () => {
      await ensureMaterialized(draft);
      const updates = materials.flatMap(node => node.kind === "asset" ? [{ nodeId: node.id, value: projectCanvasNodeLayoutUpdate(node) }] : []);
      for (const node of graph) {
        const { x, y, width, height, zIndex, positionLocked } = node;
        updates.push({ nodeId: node.id, value: { x, y, width, height, zIndex, positionLocked } });
      }
      const groups = materials.flatMap(node => {
        const persisted = node.kind === "folder" ? groupsRef.current.get(node.id) : undefined;
        return node.kind === "folder" && persisted ? [projectCanvasGroupUpdate(persisted, node)] : [];
      });
      if (updates.length + groups.length > 1) await api.projectCanvasNodesBatchUpdate(draft.id, updates, groups);
      else if (updates.length) await api.projectCanvasNodeUpdate(updates[0].nodeId, updates[0].value);
      else if (groups.length) await api.projectCanvasGroupUpdate(groups[0]);
      for (const group of groups) groupsRef.current.set(group.id, group);
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
    readEpoch: number,
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
    setCanvasReadEpoch(readEpoch);
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
      return asset && !isTextAsset(asset) ? [createCanvasAssetSnapshot(asset, canvasId("asset"))] : [];
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

  function agentCardDefaults(): ChatCardDefaults {
    return { ...chatCardDefaults(), provider: useStore.getState().defaultProvider };
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

  async function startLocalChat(request: ChatComposeRequest) {
    const id = activeCanvasRef.current.id;
    const revision = useStore.getState().projectRouteRevision;
    await prepareForGeneration();
    const route = useStore.getState();
    if (!isWorkspaceOperationCurrent(id, route.activeProjectId, route.projectRoutePending, revision, route.projectRouteRevision)) {
      throw new Error("项目已切换，请在原项目重新发送。");
    }
    const bounds = stageRef.current?.getBoundingClientRect();
    const point = bounds ? toBoardPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 3) : { x: 80, y: 80 };
    const placement = placeCanvasCardNearSource({ x: point.x - 172, y: point.y, width: 344, height: 460 }, selectionAnchors().map(anchor => anchor.rect));
    const chat = await useLocalChatStore.getState().send({ projectId: id, text: request.prompt, provider: request.provider, codexOptions: request.codexOptions,
      referenceAssetIds: request.references.map(asset => asset.id), cardDefaults: chatCardDefaults(), placement: { ...placement, width: 344, height: 460, zIndex: Date.now() % 1000000 } }, true);
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
    useLocalFileMode.getState().setProjectContext(projectId);
  }, [projectId]);

  useEffect(() => {
    if (!sourceCollapsed) {
      setSourceCatalogVisited(true);
      useLocalFileMode.getState().setOpen(true);
    }
  }, [sourceCollapsed]);

  useEffect(() => {
    const token = ++loadTokenRef.current;
    const loadRouteRevision = projectRouteRevision;
    let cancelled = false;
    let releasePaint: (() => void) | undefined;
    let cancelPaint: (() => void) | undefined;
    let changedDuringEntry = false;
    const markChanged = () => { changedDuringEntry = true; };
    workflowCardsChanged.current = markChanged;
    setWorkflowEntry(null);
    function enterWorkflow(controller: NonNullable<typeof workflow>, initialRead: Promise<void>) {
      let pending = true;
      async function observe(read: Promise<void>) {
        let error: string | null = null;
        try {
          await read;
          if (!controller.ready) throw new Error(controller.error || "工作流暂时无法加载");
          while (changedDuringEntry && !cancelled && token === loadTokenRef.current) {
            changedDuringEntry = false;
            await controller.refreshExternalCards();
          }
        } catch (reason) { error = String(reason); }
        pending = false;
        if (!cancelled && token === loadTokenRef.current) {
          if (!error) workflowCardsChanged.current = () => {
            if (loadingRef.current && !controller.error) retry();
            else void controller.refreshExternalCards().catch(reportError);
          };
          setWorkflowEntry({ projectId: controller.projectId, revision: loadRouteRevision, error, retry });
        }
      }
      function retry() {
        if (cancelled || pending) return;
        pending = true;
        changedDuringEntry = false;
        workflowCardsChanged.current = markChanged;
        setWorkflowEntry(null);
        // A cached document with a failed save must first preserve those edits.
        const read = !controller.ready ? controller.retryLoad() : controller.error
          ? controller.retrySave().then(() => controller.refreshExternalCards()) : controller.refreshExternalCards();
        void observe(read);
      }
      void observe(initialRead);
    }
    function cleanup() {
      cancelled = true;
      cancelPaint?.();
      releasePaint?.();
      if (loadTokenRef.current === token) loadTokenRef.current += 1;
    }
    // An attempted return or switch can fail at the save barrier and leave
    // this same workspace active. Retag its workflow observer for the new
    // route revision without reopening or replacing the live draft.
    if (projectId && restoredEntry.current?.projectId === projectId && restoredEntry.current.loadRevision === loadRevision) {
      const controller = canvasWorkflowController(projectId);
      const read = !controller.ready ? controller.load(!activeCanvasRef.current.materialized)
        : controller.error ? Promise.reject(new Error(controller.error)) : Promise.resolve();
      enterWorkflow(controller, read);
      return cleanup;
    }
    initialSnapshotRestoredRef.current = false;
    loadingRef.current = true;
    setLoading(true);
    setEntryViewportReady(false);
    entryCandidates.current = null;
    setEntryCardIds(EMPTY_ENTRY_CARDS);
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
          restoredEntry.current = { projectId, loadRevision };
          const controller = canvasWorkflowController(projectId);
          enterWorkflow(controller, controller.load(!activeCanvasRef.current.materialized));
        } else {
          // The native route has already ensured the canvas. Give React a paint
          // before reading it so an obsolete mount never starts duplicate IPC.
          await new Promise<void>(resolve => {
            releasePaint = resolve;
            cancelPaint = afterCanvasPaint(resolve);
          });
          if (cancelled || token !== loadTokenRef.current) return;
          const readEpoch = originalDeletionEpoch();
          const snapshotRead = api.projectCanvasGet(projectId).then(snapshot => {
            if (snapshot.canvas.projectId !== projectId) throw new Error("读取的画板与当前项目不匹配，请重试载入。");
            return snapshot;
          });
          const workflow = canvasWorkflowController(projectId);
          // A cached workflow can gain or lose cards while off screen.
          enterWorkflow(workflow, workflow.ready ? workflow.refreshExternalCards() : workflow.load(false, snapshotRead));
          const snapshot = await snapshotRead;
          if (cancelled || token !== loadTokenRef.current) return;
          const exactAssets = await api.getAssetsByIds(projectCanvasAssetIds(snapshot.nodes));
          if (cancelled || token !== loadTokenRef.current) return;
          if (snapshot.nodes.length >= ENTRY_LIGHT_CARD_LIMIT) {
            await new Promise<void>(resolve => {
              releasePaint = resolve;
              cancelPaint = afterCanvasPaint(resolve);
            });
            if (cancelled || token !== loadTokenRef.current) return;
          }
          initialSnapshotRestoredRef.current = applySnapshot(
            snapshot,
            { restoreView: true },
            exactAssets,
            loadRouteRevision,
            readEpoch,
          );
          if (initialSnapshotRestoredRef.current) {
            restoredEntry.current = { projectId, loadRevision };
          }
        }
      } catch (reason) {
        if (!cancelled && token === loadTokenRef.current) {
          if (project?.provisional) activateProvisional();
          else setLoadFailed(true);
          reportError(reason);
        }
      } finally {
        if (!cancelled && token === loadTokenRef.current) {
          setLoading(false);
        }
      }
    })();
    return cleanup;
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
    let refreshInFlight = false;

    function scheduleRefresh(eventProjectId: string, delay: number) {
      if (timer) clearTimeout(timer);
      const version = ++refreshVersion;
      timer = setTimeout(async () => {
        timer = undefined;
        if (refreshInFlight || !alive) return;
        refreshInFlight = true;
        try {
          await refreshGraph(eventProjectId, version);
        } finally {
          refreshInFlight = false;
          // Several tool batches can arrive while the native snapshot is still being read.
          if (alive && version !== refreshVersion && !timer) scheduleRefresh(eventProjectId, 0);
        }
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
        const readEpoch = originalDeletionEpoch();
        const snapshot = await api.projectCanvasGet(eventProjectId);
        if (!alive || version !== refreshVersion || activeCanvasRef.current.id !== eventProjectId) return;
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
        if (applySnapshot(snapshot, { restoreView: restoreImportedView, restoreDraft: false }, exactAssets, refreshRouteRevision, readEpoch)) {
          restoreImportedView = false;
        }
      } catch (reason) {
        reportError(reason);
      }
    }

    // Deletion changes graph visibility as well as metadata. Use the same
    // journal/gesture/route guards as execution refreshes, preserving the live draft and view.
    const unlistenDeletions = subscribeOriginalDeletionCommits(() => {
      if (projectId && activeCanvasRef.current.materialized) scheduleRefresh(projectId, 0);
    });
    listen<{ overwrittenAudio?: Asset } | null>("library://assets-changed", event => {
      const overwritten = event.payload?.overwrittenAudio;
      const route = useStore.getState();
      if (alive && overwritten && projectId && activeCanvasRef.current.id === projectId
        && isWorkspaceOperationCurrent(projectId, route.activeProjectId, route.projectRoutePending)) {
        audioOverwriteRevision.current++;
        // Update the source key immediately, even when graph hydration is deferred.
        setCanvasAssets(current => current.some(asset => asset.id === overwritten.id)
          ? current.map(asset => asset.id === overwritten.id ? overwritten : asset)
          : current);
      }
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

    listen<{ projectId: string; nativeCanvasChanged?: boolean }>(LOCAL_CHAT_CARDS_CHANGED_EVENT, ({ payload }) => {
      if (!alive || payload.projectId !== projectId) return;
      if (payload.nativeCanvasChanged !== false) scheduleRefresh(payload.projectId, 40);
      workflowCardsChanged.current();
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
      unlistenDeletions();
      unlistenAssets?.();
      unlistenImport?.();
      unlistenChat?.();
      unlistenChatCards?.();
      if (timer) clearTimeout(timer);
    };
  }, [projectId]);

  useEffect(() => {
    if (!focusRequestId || opening || loadFailed) return;
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
    const workflow = projectId ? canvasWorkflowController(projectId) : null;
    if (resolution.state === "pending" && workflow?.ready) {
      const workflowResolution = resolveWorkflowTaskFocus(workflow.document, focusNodeId ?? null, focusThreadId ?? null, threadResolution === "ready");
      if (workflowResolution.state === "ready" && stageRef.current) {
        const node = workflowResolution.node;
        const representative = collapsedGenerationAnchors.get(node.id);
        const target = representative ? { ...nodeRect(representative), id: representative.id }
          : workflowRef.current?.bounds().find(bounds => bounds.id === node.id)
          ?? { ...node, width: workflowCardWidth(node), height: 400 };
        const rect = stageRef.current.getBoundingClientRect();
        const nextPan = { x: rect.width / 2 - (target.x + target.width / 2), y: rect.height / 2 - (target.y + target.height / 2) };
        panRef.current = nextPan; zoomRef.current = 1;
        setPan(nextPan); setZoom(1);
        setSelectedCanvasNodeIds(new Set([target.id]));
        setFocusedNodeId(target.id); setFocusedThreadId(focusThreadId);
        viewModeRef.current = "canvas"; setViewMode("canvas");
        if (projectId && focusThreadId) useStore.getState().clearProjectThreadUnread(projectId, focusThreadId);
        markViewDirty();
      }
      if (workflowResolution.state !== "pending") {
        appliedFocusRequestRef.current = requestKey;
        onFocusConsumed?.(focusRequestId);
        return;
      }
    }
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
  }, [focusNodeId, focusRequestId, focusThreadId, graphNodes, graphEdges, loadFailed, opening, onFocusConsumed, projectId, threads, workflowRevision, workflowInteractive, collapsedGenerationAnchors]);

  useEffect(() => { setCanvasLibraryOpen(false); }, [projectId, setCanvasLibraryOpen]);

  const entryFocusProject = useRef<string | null>(null);
  useEffect(() => {
    if (opening || loadFailed || projectRoutePending || entryFocusProject.current === projectId) return;
    // Wait for the project picker to close and restore its trigger focus first.
    const frame = requestAnimationFrame(() => {
      entryFocusProject.current = projectId;
      if (exploring || viewMode !== "canvas" || !sourceCollapsed || scopedInspectorOpen
        || workspaceRef.current?.closest("[inert]") || document.querySelector('[role="dialog"], [role="menu"]')) return;
      const focused = document.activeElement as HTMLElement | null;
      if (workspaceRef.current?.contains(focused) && focused?.closest('input, textarea, select, [role="combobox"], [contenteditable="true"]')) return;
      stageRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [projectId, opening, loadFailed, projectRoutePending, exploring, viewMode, sourceCollapsed, scopedInspectorOpen]);

  useEffect(() => {
    if (exploring) {
      setSourceCollapsed(true);
    }
  }, [exploring]);

  useEffect(() => {
    if (explainTutorialSources) { useLocalFileMode.getState().selectHierarchy({ kind: "projects", projectId }); setSourceCollapsed(false); }
  }, [explainTutorialSources, exploring]);

  useLayoutEffect(() => {
    if (sourcePanelRef.current) sourcePanelRef.current.inert = sourceCollapsed;
    // Typing in the global search also reveals the library; keep that input focused.
    if (!sourceCollapsed && !document.activeElement?.matches('input, textarea, select, [role="combobox"], [contenteditable="true"]')) {
      sourcePanelRef.current?.focus({ preventScroll: true });
    }
  }, [sourceCollapsed]);

  useEffect(() => {
    function toggleLibrary(event: KeyboardEvent) {
      const sidebarMode = libraryShortcutMode(event.key);
      if ((!sidebarMode && event.key !== "Tab" && event.key !== "Escape") || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing || event.keyCode === 229
        || event.defaultPrevented || exploring || workspaceRef.current?.closest("[inert]")
        || loadingRef.current || useStore.getState().projectRoutePending) return;
      const target = event.target as HTMLElement | null;
      const composerTab = event.key === "Tab" && !event.shiftKey && !!target
        && workspaceRef.current?.contains(target)
        && !!target.closest('.creation-editor .ProseMirror, [data-generation-composer] .ProseMirror');
      if (!composerTab && event.key !== "Escape" && (target?.isContentEditable || target?.closest('input, textarea, select, [role="combobox"], .app-topbar'))) return;
      if (event.key === "Escape" && target?.closest('[data-folder-path-editor], [data-frequent-threshold], [data-library-search]')) return;
      if (target?.closest('[role="dialog"], [role="menu"]')
        || document.querySelector('[role="dialog"], [role="menu"]') || useStore.getState().contextMenu
        || useStore.getState().projectContextMenu) return;
      if (event.key === "Escape" && frequentPickingRef.current) {
        event.preventDefault(); event.stopPropagation();
        frequentPickingRef.current = false; setFrequentPicking(false);
        return;
      }
      const open = useStore.getState().canvasLibraryOpen;
      if (event.key !== "Tab" && !open) return;
      if (event.key === "Tab" && open && target && sourcePanelRef.current?.contains(target) && target !== sourcePanelRef.current) return;
      // Escape belongs to the canvas while it is being used alongside the drawer.
      if (event.key === "Escape" && target && boardShellRef.current?.contains(target)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Escape") { closeSource(); return; }
      if (!open) { openLibrary(); setCanvasLibraryOpen(true); beginOnboardingOperation("expand-source", projectId)(); return; }
      if (event.key === "Tab") { closeSource(); return; }
      if (sidebarMode) { useLocalFileMode.getState().setSidebarMode(sidebarMode); useStore.getState().clearSelect(); }
      requestAnimationFrame(() => sourcePanelRef.current?.focus({ preventScroll: true }));
    }
    window.addEventListener("keydown", toggleLibrary, true);
    return () => window.removeEventListener("keydown", toggleLibrary, true);
  }, [exploring, projectId, setCanvasLibraryOpen]);

  const onWorkspaceKeyDown = useLatestCallback((event: KeyboardEvent) => {
    if (workspaceRef.current?.closest("[inert]")) return;
    const target = event.target as HTMLElement | null;
    if ((useStore.getState().canvasLibraryOpen || useLocalFileMode.getState().open)
      && (!target || !boardShellRef.current?.contains(target))) return;
    const editing = !!target && (
      target.isContentEditable
      || target.tagName === "INPUT"
      || target.tagName === "TEXTAREA"
      || target.tagName === "SELECT"
      || !!target.closest('[role="combobox"]')
    );
    if (document.querySelector("[data-context-owner]") || workflowAgentDetail && target?.closest("[data-project-inspector]")) return;
    const pendingUndo = undoHistoryRef.current[undoHistoryRef.current.length - 1];
    const connectedPrompt = target instanceof HTMLTextAreaElement && target === newConnectedTextarea.current
      && pendingUndo?.kind === "workflow" && !!pendingUndo.connectedGenerationId
      && target.closest("[data-workflow-card]")?.getAttribute("data-workflow-card") === pendingUndo.connectedGenerationId;
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z"
      && (!editing || connectedPrompt || !!target?.closest(".canvas-text-grid")) && !event.defaultPrevented && !scopedInspectorOpen && viewModeRef.current === "canvas"
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
        clearTimeout(peekIntent.current);
        spacePressedRef.current = true;
        setSpacePanReady(true);
      }
      return;
    }
    if (event.key !== "Escape") return;
    const marquee = marqueePressRef.current;
    if (marquee) {
      marqueePressRef.current = null;
      if (marqueeElement.current) marqueeElement.current.hidden = true;
      setSelectedCanvasNodeIds(marquee.baseSelection);
      if (stageRef.current?.hasPointerCapture(marquee.pointerId)) stageRef.current.releasePointerCapture(marquee.pointerId);
    }
    clearDragProjection(nodeDragRef.current); clearDragProjection(graphNodeDragRef.current);
    nodeFrame.cancel(); graphNodeFrame.cancel(); panFrame.cancel();
    snapSizeObserverRef.current?.disconnect(); snapSizeObserverRef.current = null;
    settleCamera();
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
        translateWorkflowSelection(nodeDragRef.current.initialWorkflow, nodeDragRef.current.selectedIds, 0, 0, true);
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
        translateWorkflowSelection(graphNodeDragRef.current.initialWorkflow, graphNodeDragRef.current.selectedIds, 0, 0, true);
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

  });
  useEffect(() => {
    function releaseSpace() {
      spacePressedRef.current = false;
      setSpacePanReady(false);
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.code === "Space") releaseSpace();
    }
    window.addEventListener("keydown", onWorkspaceKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseSpace);
    return () => {
      window.removeEventListener("keydown", onWorkspaceKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseSpace);
    };
  }, [onWorkspaceKeyDown]);

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
    scheduleViewSave();
    return () => clearTimeout(viewSaveTimer.current);
  }, [loading, projectId]);

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

  const titleIme = useImeGuard();
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
    pendingWritesRef.current += 1;
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
        const readEpoch = originalDeletionEpoch();
        const snapshot = await api.projectCanvasGet(operationProjectId);
        if (!isCurrentWorkspace()) return;
        const exactAssets = await api.getAssetsByIds(projectCanvasAssetIds(snapshot.nodes));
        if (!isCurrentWorkspace()) return;
        if (!applySnapshot(snapshot, { restoreView: false }, exactAssets, operationRouteRevision, readEpoch)) return;
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
      pendingWritesRef.current -= 1;
      if (pendingWritesRef.current === 0) setSaving(false);
    }
  }

  const toBoardPoint = useCallback((clientX: number, clientY: number): CanvasPoint => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - panRef.current.x) / zoomRef.current,
      y: (clientY - rect.top - panRef.current.y) / zoomRef.current,
    };
  }, []);

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
      if (note.note_type === "document") return { x: node.x, y: node.y, width: node.width, height: canvasDocumentHeight(node.width) };
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

  function hitContentCell(clientX: number, clientY: number, fresh = false) {
    const stage = stageRef.current;
    if (!stage || !workflowInteractive) return null;
    // A wheel event may have advanced the live camera before its scheduled paint.
    cameraFrame.flush();
    const point = toBoardPoint(clientX, clientY);
    let target: { targetId: string; cellId: string; order: number; rect: CanvasRect } | null = null;
    for (const card of graphNodesRef.current) {
      if (card.kind !== "note" || card.hiddenAt != null || point.x < card.x || point.y < card.y || target && card.zIndex <= target.order) continue;
      const bounds = nodeRect(card);
      if (point.x >= card.x + bounds.width || point.y >= card.y + bounds.height || workflowRef.current?.isLocked(card.id)) continue;
      const element = stage.querySelector<HTMLElement>(`.canvas-note[data-canvas-node-id="${CSS.escape(card.id)}"]`);
      if (!element) continue;
      const cache = cellHitCacheRef.current ??= createCanvasCellHitCache(toBoardPoint, () => zoomRef.current);
      for (const { rect, cellId } of cache.get(element, fresh)) {
        if (point.x < rect.x || point.x >= rect.x + rect.width || point.y < rect.y || point.y >= rect.y + rect.height) continue;
        target = { targetId: card.id, cellId, order: card.zIndex, rect };
        break;
      }
    }
    return target;
  }

  function hoverContentCell(clientX: number, clientY: number, source: WorkflowInput, movingId?: string) {
    const target = hitContentCell(clientX, clientY);
    if (!target) return false;
    setFolderDropTargetId(null);
    setHover({ kind: "cell", key: `cell:${movingId ?? source.assetId}:${target.targetId}:${target.cellId}`, ...target, source, movingId });
    return true;
  }

  function fillHoveredCell(hover: Extract<HoverIntent, { kind: "cell" }>) {
    const projectId = activeCanvasRef.current.id;
    const controller = canvasWorkflowController(projectId);
    const before = graphNodesRef.current.find(node => node.id === hover.targetId);
    const restoredMaterials = nodesRef.current.filter(node => node.id === hover.movingId);
    const pending = hover.source.canvasNodeId
      ? controller.storeCellGeneration(hover.targetId, hover.cellId, hover.source.canvasNodeId, hover.source.assetNodeId)
      : controller.storeCellImages(hover.targetId, hover.cellId, [hover.source.assetId!], hover.movingId);
    void pending.then(async () => {
      const snapshot = await api.projectCanvasGet(projectId);
      const after = snapshot.nodes.find(node => node.id === hover.targetId);
      if (before && after && activeCanvasRef.current.id === projectId) {
        pushCanvasUndo({ kind: "content", projectId, before, after, restoredMaterials });
        await refreshClipboardCanvas(projectId);
      }
    }).catch(error => notifyError(error, "内容未能放入单元格"));
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
    const candidates = current.map(node => ({ id: node.id, order: node.order, rect: nodeRect(node), node }));
    const target = findCanvasHoverTarget(point, candidates)?.node;
    const ordered = [...prepareCanvasSnapAnchors(candidates).ordered];
    let order = next.reduce((max, node) => Math.max(max, node.order), 0) + 1;
    additions.forEach((asset, index) => {
      const size = assetNodeSize(asset);
      const raw = target && index === 0
        ? { x: target.x + target.width, y: target.y, ...size }
        : { x: point.x - size.width / 2 + index * 22, y: point.y - size.height / 2 + index * 22, ...size };
      const snapped = snapCanvasRectPrepared(raw, { ordered }, { enabled: snapEnabledRef.current, zoom: zoomRef.current });
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
      ordered.push({ id: node.id, order: node.order, rect: nodeRect(node) });
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
      return asset && !isTextAsset(asset) ? [createCanvasAssetSnapshot(asset, canvasId("asset"))] : [];
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
      if (isNativeAssetDrag()) return;
      libraryDragActive.current = false;
      externalDragInStage.current = false;
      if (sourceDragFrame.current !== null) cancelAnimationFrame(sourceDragFrame.current);
      sourceDragFrame.current = null;
      setLibraryDragging(false);
      externalInstancesRef.current = null;
      setExternalDragOver(false);
      // Native preparation can finish after a newer ordinary canvas gesture has begun.
      if (!nodeDragRef.current && !graphNodeDragRef.current) {
        setHover(null);
        setFolderDropTargetId(null);
      }
    };
    const dragOverStage = (event: globalThis.DragEvent) => {
      const inside = event.target instanceof Node && !!stageRef.current?.contains(event.target);
      if (inside && !externalDragInStage.current) clearTimeout(peekIntent.current);
      externalDragInStage.current = inside;
    };
    const dragLeavesStage = (event: globalThis.DragEvent) => {
      const stage = stageRef.current;
      if (!(event.target instanceof Node) || !stage?.contains(event.target)) return;
      const next = event.relatedTarget instanceof Node ? event.relatedTarget : document.elementFromPoint(event.clientX, event.clientY);
      if (!stage.contains(next)) externalDragInStage.current = false;
    };
    const drop = () => { externalDragInStage.current = false; };
    // External file import may intercept drag events at the window before they reach the stage.
    window.addEventListener("dragenter", dragOverStage, true);
    window.addEventListener("dragover", dragOverStage, true);
    window.addEventListener("dragleave", dragLeavesStage, true);
    window.addEventListener("drop", drop, true);
    window.addEventListener("dragend", end);
    window.addEventListener(EXTERNAL_DRAG_ENDED, end);
    return () => {
      window.removeEventListener("dragenter", dragOverStage, true);
      window.removeEventListener("dragover", dragOverStage, true);
      window.removeEventListener("dragleave", dragLeavesStage, true);
      window.removeEventListener("drop", drop, true);
      window.removeEventListener("dragend", end);
      window.removeEventListener(EXTERNAL_DRAG_ENDED, end);
      if (sourceDragFrame.current !== null) cancelAnimationFrame(sourceDragFrame.current);
    };
  }, []);

  function onCanvasDragOver(event: DragEvent<HTMLDivElement>) {
    if (event.dataTransfer.types.includes(WORKFLOW_CARD_DRAG_TYPE)) {
      event.preventDefault(); event.dataTransfer.dropEffect = "copy"; return;
    }
    const incoming = draggedSnapshots();
    if ((getDragAssets() ?? []).some(id => { const asset = assetById.get(id); return asset && isTextAsset(asset); })) {
      event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setExternalDragOver(true); setHover(null); setFolderDropTargetId(null); return;
    }
    if (incoming.length === 0) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setExternalDragOver(true);
    if (incoming.length === 1 && incoming[0].assetId && !isVideoPath(incoming[0].storePath) && !isAudioPath(incoming[0].storePath)
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
        if (value.projectId !== projectId || !["text", "document", "bubble", "instruction", "generation", "skill", "agent", "visual-profile", "loop", ...(import.meta.env.DEV ? ["planner"] : [])].includes(value.kind)) return;
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
    const place = prepareExplorerCanvasDrop(event.currentTarget, expectedProject, clientX, clientY);
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
    if (incoming.some(asset => isTextPath(asset.storePath))) {
      try {
        if (!place) throw new Error("画板尚未就绪，请重试");
        const assets = await api.getAssetsByIds(draggedIds);
        if (assets.length !== draggedIds.length) throw new Error("部分所选素材已不存在，请重新选择");
        for (const asset of assets) await place(asset);
      } catch (error) { notifyError(error, "无法添加所选素材"); }
      finally { clearExternalDrag(); }
      return;
    }
    const cell = hitContentCell(clientX, clientY, true);
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
        pushMaterialsUndo(current, next);
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
    const workflowIds = new Set(canvasWorkflowController(activeCanvasRef.current.id).document.nodes.map(node => node.id));
    const archived = new Set(threads.filter((thread) => thread.archivedAt != null).map((thread) => thread.id));
    const agentPrompts = agentPromptGroupMap(graph, graphEdges);
    const contained = containedSessionOutputIds(graph, canvasWorkflowController(activeCanvasRef.current.id).document.nodes);
    const historyIds = hiddenWorkflowSessionIds(canvasWorkflowController(activeCanvasRef.current.id).document.nodes, graph, useStore.getState().genJobs);
    return [
      ...(workflowRef.current?.bounds() ?? []).map(node => ({ id: node.id, order: 9000, rect: node })),
      ...materials.filter(node => !contained.has(node.id) && !conversationCardsRef.current.hiddenIds.has(node.id)).map((node) => ({ id: node.id, order: node.order, rect: nodeRect(node) })),
      ...graph.filter((node) => (node.kind === "prompt" || node.kind === "agent_group" || node.kind === "note")
        && !workflowIds.has(node.id) && !agentPrompts.has(node.id) && !historyIds.has(node.id) && !conversationCardsRef.current.hiddenIds.has(node.id)
        && node.hiddenAt == null && (!node.threadId || !archived.has(node.threadId)))
        .map((node) => ({ id: node.id, order: node.zIndex, rect: nodeRect(node) })),
    ].filter(anchor => !concealedNodeIds.current.has(anchor.id));
  }

  function translateWorkflowSelection(initial: WorkflowGeometry[], ids: Set<string>, dx: number, dy: number, persist = false) {
    const selected = initial.filter(node => ids.has(node.id));
    if (selected.length) workflowRef.current?.position(new Map(selected.map(node => [node.id, { x: node.x + dx, y: node.y + dy }])), persist);
  }

  function persistMovedWorkflowCards(ids: ReadonlySet<string>) {
    const layer = workflowRef.current;
    if (!layer) return ids;
    const positions = new Map(layer.bounds(true).filter(node => ids.has(node.id)).map(node => [node.id, { x: node.x, y: node.y }]));
    for (const [id, anchor] of collapsedGenerationAnchors) {
      if (!ids.has(anchor.id)) continue;
      const point = nodesRef.current.find(node => node.id === anchor.id) ?? graphNodesRef.current.find(node => node.id === anchor.id);
      if (point) positions.set(id, { x: point.x, y: point.y });
    }
    if (positions.size) layer.position(positions, true);
    return new Set([...ids, ...positions.keys()]);
  }

  function translateDrag(drag: DragProjection & { nodeId: string; selectedIds: Set<string> }, materials: CanvasNode[], graph: ProjectGraphNode[],
    workflowGeometry: WorkflowGeometry[], dx: number, dy: number) {
    const apply = () => {
      translateGraphSelection(graph, drag.selectedIds, dx, dy);
      translateMaterialSelection(materials, drag.selectedIds, dx, dy);
      translateWorkflowSelection(workflowGeometry, drag.selectedIds, dx, dy);
    };
    if (drag.preview === undefined) {
      const plane = planeRef.current;
      // Folder names belong to the group ID; use the full layout for that two-identity case.
      drag.preview = plane && !materials.some(node => node.kind === "folder" && drag.selectedIds.has(node.id))
        ? canvasDragPreview(plane, drag.selectedIds, drag.nodeId, () => {
          const pending = drag.apply;
          clearDragProjection(drag);
          setActiveDragId(drag.nodeId);
          pending?.();
        }) : null;
      if (!drag.preview) setActiveDragId(drag.nodeId);
    }
    if (drag.preview) { drag.apply = apply; drag.preview.move(dx, dy); }
    else apply();
  }

  function showDragGuides(next: CanvasSnapGuide[]) {
    setGuides(old => old.length === next.length && old.every((guide, i) =>
      guide.axis === next[i].axis && guide.position === next[i].position) ? old : next);
  }

  function observeSnapSizes() {
    if (snapSizeObserverRef.current) return;
    const observer = new ResizeObserver(() => {
      // Workflow results can grow a stationary card while another card is being dragged.
      if (nodeDragRef.current) nodeDragRef.current.snapAnchors = undefined;
      if (graphNodeDragRef.current) graphNodeDragRef.current.snapAnchors = undefined;
    });
    stageRef.current?.querySelectorAll("[data-workflow-card]").forEach(card => observer.observe(card));
    snapSizeObserverRef.current = observer;
  }

  function translateGraphSelection(initial: ProjectGraphNode[], selectedIds: Set<string>, dx: number, dy: number) {
    const positions = new Map(initial.filter(node => selectedIds.has(node.id)).map(node => [node.id, { x: node.x + dx, y: node.y + dy }]));
    if (!positions.size) return;
    let changed = false;
    const next = graphNodesRef.current.map((node) => {
      const position = positions.get(node.id);
      if (!position || node.x === position.x && node.y === position.y) return node;
      changed = true;
      return { ...node, ...position };
    });
    if (!changed) return;
    graphNodesRef.current = next;
    setGraphNodes(next);
  }

  function translateMaterialSelection(initial: CanvasNode[], selectedIds: Set<string>, dx: number, dy: number) {
    const positions = new Map(initial.filter(node => selectedIds.has(node.id)).map(node => [node.id, { x: node.x + dx, y: node.y + dy }]));
    if (!positions.size) return nodesRef.current;
    let changed = false;
    const next = nodesRef.current.map(node => {
      const position = positions.get(node.id);
      if (!position || node.x === position.x && node.y === position.y) return node;
      changed = true;
      return { ...node, ...position };
    });
    if (changed) commitNodes(next);
    return nodesRef.current;
  }

  function arrangeNodes(nodeIds: Iterable<string>) {
    const aliases = new Map(conversationCardsRef.current.aliases);
    for (const node of nodesRef.current) {
      if (node.kind === "folder") for (const asset of node.assets) aliases.set(asset.id, node.id);
    }
    for (const [id, group] of agentPromptGroupMap(graphNodesRef.current, graphEdges)) aliases.set(id, group.id);
    const sections = graphNodesRef.current.filter(node => node.kind === "note" && node.hiddenAt == null && readCanvasNote(node).note_type === "section");
    const sectionOwners = new Map(sections.flatMap(section => readCanvasNote(section).member_ids.map(id => [id, section.id] as const)));
    const allAnchors = selectionAnchors();
    const anchors = allAnchors.filter(anchor => !sectionOwners.has(anchor.id));
    const resolveAnchor = (id: string) => sectionOwners.get(aliases.get(id) ?? id) ?? aliases.get(id) ?? id;
    const elements = new Map(Array.from(stageRef.current?.querySelectorAll<HTMLElement>("[data-canvas-node-id]") ?? [])
      .map((element) => [element.dataset.canvasNodeId, element]));
    for (const anchor of anchors) {
      const rect = elements.get(anchor.id)?.getBoundingClientRect();
      if (rect) {
        anchor.rect.width = rect.width / zoomRef.current;
        anchor.rect.height = rect.height / zoomRef.current;
      }
    }
    const workflowEdges = workflowArrangementEdges(canvasWorkflowController(activeCanvasRef.current.id).document.nodes, graphNodesRef.current, conversationCardsRef.current, collapsedGenerationAnchors);
    const positions = arrangeCanvasNodes(anchors, [...graphEdges, ...workflowEdges].map((edge) => ({
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
    const beforeMaterials = nodesRef.current, beforeGraph = graphNodesRef.current, beforeWorkflow = workflowRef.current?.bounds(true) ?? [];
    const workflowPositions = new Map(positions);
    for (const [id, offset] of pinnedCardOffsets) {
      const point = workflowPositions.get(id);
      if (point) workflowPositions.set(id, { x: point.x - offset.x, y: point.y - offset.y });
    }
    for (const [id, anchor] of collapsedGenerationAnchors) {
      const point = positions.get(anchor.id);
      if (point) workflowPositions.set(id, point);
    }
    workflowRef.current?.position(workflowPositions, true);
    const next = nodesRef.current.map((node) => positions.has(node.id) ? { ...node, ...positions.get(node.id)! } : node);
    const graph = graphNodesRef.current.map((node) => positions.has(node.id) ? { ...node, ...positions.get(node.id)! } : node);
    commitNodes(next);
    graphNodesRef.current = graph;
    setGraphNodes(graph);
    pushGeometryUndo(beforeMaterials, beforeGraph, beforeWorkflow);
    setSelectedCanvasNodeIds(new Set(positions.keys()));
    persistGeometries(next.filter(node => positions.has(node.id)), graph.filter(node => node.kind !== "asset" && positions.has(node.id)));
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
      const order = Math.max(0, ...nodesRef.current.map(node => node.order), ...graphNodesRef.current.map(node => node.zIndex)) + 1;
      const placements = new Map<string, { nodes: (CanvasAssetNode | ProjectGraphNode)[]; saved: Set<string> }>();
      detail.place = async (asset, sheetName) => {
        const key = JSON.stringify([asset.id, sheetName]);
        const previous = placements.get(key);
        if (previous) {
          if (previous.saved.size !== previous.nodes.length) await retryPendingWrites();
          if (previous.saved.size !== previous.nodes.length) throw new Error("画板卡片尚未保存，请重试");
          return previous.nodes[0].id;
        }
        const index = [...placements.values()].reduce((count, value) => count + value.nodes.length, 0);
        const contents = await readFileContentCards(asset, sheetName);
        const snapshot = createCanvasAssetSnapshot(asset, canvasId("asset"));
        const items = contents ?? [{ payload: null, size: assetNodeSize(snapshot) }];
        let offset = 0;
        const nodes = items.map(({ payload, size }, part): CanvasAssetNode | ProjectGraphNode => {
          const rect = { x: point.x - items[0].size.width / 2 + index * 24 + offset, y: point.y - size.height / 2 + index * 24, ...size };
          offset += size.width + 32;
          return payload ? {
            id: canvasId("document"), projectId, threadId: null, kind: "note", assetId: null, role: null,
            payloadJson: JSON.stringify(payload), ...rect, zIndex: order + index + part,
            positionLocked: false, hiddenAt: null, createdAt: Date.now(), updatedAt: Date.now(),
          } : { kind: "asset", id: snapshot.id, asset: snapshot, ...rect, order: order + index };
        });
        const placement = { nodes, saved: new Set<string>() };
        placements.set(key, placement);
        // Persist to the frozen project even when indexing finishes after navigation.
        await enqueueWrite(async () => {
          await ensureMaterialized(frozenProject);
          for (const node of nodes) {
            if (!placement.saved.has(node.id)) {
              if ("payloadJson" in node) {
                const { hiddenAt: _hidden, createdAt: _created, updatedAt: _updated, ...input } = node;
                await api.projectCanvasNodeCreate(input);
              } else await api.projectCanvasNodeCreate(newProjectCanvasAssetNode(projectId, node));
              placement.saved.add(node.id);
            }
            const route = useStore.getState();
            if (stage?.isConnected && activeCanvasRef.current.id === projectId
              && route.activeProjectId === projectId && !route.projectRoutePending) {
              pushCanvasUndo({ kind: "paste", projectId, nodeIds: [node.id], groupIds: [], workflowIds: [] });
              setCanvasAssets(current => [...current.filter(item => item.id !== asset.id), asset]);
              if ("payloadJson" in node) {
                graphNodesRef.current = [...graphNodesRef.current.filter(existing => existing.id !== node.id), node];
                setGraphNodes(graphNodesRef.current);
              } else commitNodes([...nodesRef.current.filter(existing => existing.id !== node.id), node]);
            }
          }
        });
        if (writeJournalRef.current.failure != null) throw writeJournalRef.current.failure;
        return nodes[0].id;
      };
    }
    stage.addEventListener(EXPLORER_CANVAS_DROP_EVENT, prepareDrop);
    return () => stage.removeEventListener(EXPLORER_CANVAS_DROP_EVENT, prepareDrop);
  }, []);

  useEffect(() => {
    if (!projectId || projectRoutePending) return;
    let alive = true;
    let version = 0;
    let timer: number | undefined;
    let unlisten: (() => void) | undefined;
    function isCurrent(requestVersion: number) {
      const route = useStore.getState();
      return alive && version === requestVersion && isWorkspaceOperationCurrent(projectId ?? "", route.activeProjectId,
        route.projectRoutePending, projectRouteRevision, route.projectRouteRevision);
    }
    async function reload(requestVersion: number, targetProjectId: string) {
      if (!isCurrent(requestVersion)) return;
      try {
        const snapshot = await api.projectCanvasGet(targetProjectId);
        const assetIds = projectCanvasAssetIds(snapshot.nodes);
        while (isCurrent(requestVersion)) {
          const revision = audioOverwriteRevision.current;
          const exact = await api.getAssetsByIds(assetIds);
          // An older file refresh cannot replace a newer overwrite receipt.
          if (revision !== audioOverwriteRevision.current) continue;
          if (isCurrent(requestVersion)) setCanvasAssets(exact);
          return;
        }
      } catch (reason) {
        if (isCurrent(requestVersion)) reportError(reason);
      }
    }
    void listen("external-files://changed", () => {
      const requestVersion = ++version;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void reload(requestVersion, projectId), 120);
    }).then(fn => { if (alive) unlisten = fn; else fn(); })
      .catch(reason => { if (alive) reportError(reason); });
    return () => { alive = false; window.clearTimeout(timer); unlisten?.(); };
  }, [projectId, projectRouteRevision, projectRoutePending]);

  function captureCanvasMenu(
    x: number, y: number, point: CanvasPoint | null, nodeIds: string[], node: ProjectGraphNode | null,
    folderId?: string, sectionNode?: ProjectGraphNode | null,
  ) {
    const note = sectionNode && readCanvasNote(sectionNode);
    const section: CanvasContextMenuState["section"] = sectionNode && note?.note_type === "section" ? {
      id: sectionNode.id,
      name: point ? note.text.trim() || "分区" : note.text,
      kind: note.workflow_container ? "container" : note.artboard ? "artboard" : "section",
      color: note.section_color ?? SECTION_COLORS[0][1],
    } : undefined;
    const { assetIds, images } = canvasMediaForSelection(nodeIds);
    const exportable = new Set(nodeIds.length ? workflowNodes.filter(card => !["trigger", "text", "planner"].includes(card.kind)).map(card => card.id) : []);
    const dissolveTarget = nodeIds.length === 1 ? canvasConversationGroupTarget(conversationCardsRef.current.cards.get(nodeIds[0])) : undefined;
    const model = buildCanvasContextMenu({
      blank: point !== null, nodeCount: nodeIds.length, cardKind: node?.kind ?? null, hasFolder: !!folderId, section,
      assetCount: assetIds.length, imageCount: images.length, hasDissolvableGroup: !!dissolveTarget,
      interactive: workflowInteractive,
      canExportWorkflow: nodeIds.some(id => exportable.has(id)),
      canSaveTemplate: WORKFLOW_TEMPLATE_LIBRARY_ENABLED && [...expandCanvasSections(new Set(nodeIds), graphNodes)].some(id => exportable.has(id)),
      selectionLocked: nodeIds.some(id => workflowRef.current?.isLocked(id)),
      sessionRunning: node?.kind === "prompt" && nodeIds.length === 1 && promptSessionJobs(node).some(job => job.running),
    });
    setPromptMenu({
      x, y, point, node, nodeIds, folderId, section, projectId: activeCanvasRef.current.id, sourceProjectId: projectId,
      assetIds, images, canAdjustLayer: nodeIds.length > 0 && canAdjustMenuLayers(nodeIds), dissolveTarget, model,
    });
  }

  function openCanvasNodeMenu(event: React.MouseEvent<HTMLElement>, nodeId: string, node: ProjectGraphNode | null = null) {
    event.preventDefault();
    event.stopPropagation();
    useStore.getState().closeContextMenu();
    const nodeIds = selectedCanvasNodeIdsRef.current.has(nodeId) ? [...selectedCanvasNodeIdsRef.current] : [nodeId];
    const folder = nodesRef.current.find((candidate): candidate is CanvasFolderNode => candidate.id === nodeId && candidate.kind === "folder");
    const section = graphNodesRef.current.find(candidate => candidate.id === nodeId && candidate.kind === "note");
    captureCanvasMenu(event.clientX, event.clientY, null, nodeIds, node, folder?.id, section);
  }

  function selectCanvasMenuAction(action: CanvasMenuAction, menu: CanvasContextMenuState) {
    if (menu.projectId !== activeCanvasRef.current.id || useStore.getState().projectRoutePending) {
      setPromptMenu(null);
      return;
    }
    switch (action) {
      case "draft":
        if (menu.point) newDraftAt(menu.point);
        return;
      case "artboard":
        if (menu.point) createCanvasNote({ ...menu.point, width: 480, height: 360 }, "section", { base_asset_id: null });
        break;
      case "import-package":
        workflowRef.current?.templates(true);
        break;
      case "paste": {
        const point = menu.point ?? toBoardPoint(menu.x, menu.y);
        void navigator.clipboard.readText().catch(() => canvasClipboardText).then(text => {
          const value = parseCanvasClipboard(text);
          if (value) return pasteCanvasSelection(value, point);
          notify("剪贴板中没有可粘贴的画板卡片", "info");
        });
        break;
      }
      case "copy":
        void copyCanvasSelection(menu.nodeIds);
        break;
      case "encapsulate":
        workflowRef.current?.saveTemplate(menu.nodeIds, "container");
        break;
      case "save-template":
        workflowRef.current?.saveTemplate(menu.nodeIds);
        break;
      case "export-package":
        workflowRef.current?.saveTemplate(menu.nodeIds, "package");
        break;
      case "reuse":
        if (menu.node) reuseCanvasPrompt(menu.node);
        return;
      case "remove-section":
        if (menu.section) removeNodes([menu.section.id]);
        break;
      case "ungroup-folder":
        if (menu.folderId) ungroupFolder(menu.folderId);
        break;
      case "remove-nodes":
        removeNodes(menu.nodeIds);
        break;
      case "delete-session":
        if (menu.node) deletePromptSession(menu.node);
        return;
    }
    setPromptMenu(null);
  }

  function setCanvasMenuSectionColor(sectionId: string, color: string) {
    const section = graphNodesRef.current.find(node => node.id === sectionId && node.kind === "note" && node.hiddenAt == null);
    if (!section) return;
    const note = readCanvasNote(section);
    if (note.note_type === "section" && !note.artboard && !note.workflow_container && (note.section_color ?? SECTION_COLORS[0][1]) !== color) {
      updateCanvasNote(section.id, { ...note, section_color: color });
    }
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
            pushCanvasUndo({ kind: "paste", projectId: project.id, nodeIds: [node.id], groupIds: [], workflowIds: [] });
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

  function armCanvasAssetHold(event: PointerEvent<HTMLElement>, nodeId: string, asset: CanvasAssetSnapshot, member = false) {
    const route = useStore.getState();
    if (!isTauri() || event.button !== 0 || isNativeAssetDrag() || !asset.assetId || !asset.storePath
      || isCanvasPanGesture(event.button, spacePressedRef.current, drawingTool === "pan")
      || loadingRef.current || route.projectRoutePending || frequentPickingRef.current) return;
    const element = event.currentTarget, pointerId = event.pointerId;
    const expectedProject = activeCanvasRef.current.id, revision = route.projectRouteRevision;
    const selection = nodeDragRef.current?.pointerId === pointerId ? nodeDragRef.current.selectedIds
      : graphNodeDragRef.current?.pointerId === pointerId ? graphNodeDragRef.current.selectedIds : new Set([nodeId]);
    const assets = member || selection.size === 1 ? [asset] : [...selection].flatMap(id => {
      const shown = selectedConversationImage(id, conversationImages(id));
      if (shown) return [shown];
      const node = nodesRef.current.find(item => item.id === id);
      return node ? node.kind === "asset" ? [node.asset] : node.assets : [];
    });
    const ids = [...new Set(assets.flatMap(item => item.assetId && item.storePath && !hideCanvasOriginal(item.assetId, item.storePath) ? [item.assetId] : []))];
    if (!ids.length) return;
    element.setPointerCapture(pointerId);
    canvasDragHold.current.start(pointerId, { x: event.clientX, y: event.clientY }, () => {
      const current = useStore.getState();
      if (!element.isConnected || !element.hasPointerCapture(pointerId) || loadingRef.current || isNativeAssetDrag()
        || !isWorkspaceOperationCurrent(expectedProject, current.activeProjectId, current.projectRoutePending, revision, current.projectRouteRevision)) return;
      // Nothing has moved: relinquish the pending canvas gesture before the OS takes the pointer.
      nodeFrame.cancel(); graphNodeFrame.cancel();
      nodeDragRef.current = null; graphNodeDragRef.current = null;
      cancelConversationImageClick(); suppressNodeClickRef.current = true;
      setActiveDragId(null); setGuides([]); setHover(null); setFolderDropTargetId(null);
      element.releasePointerCapture(pointerId);
      const controller = new AbortController(); canvasExportRef.current = controller;
      void startExternalDrag(ids, "hold", { source: "canvas", signal: controller.signal,
        sourceRect: (element.querySelector("img, video") ?? element).getBoundingClientRect() }).finally(() => {
        if (canvasExportRef.current === controller) canvasExportRef.current = null;
      });
    });
  }

  function beginNodeDrag(event: PointerEvent<HTMLElement>, node: CanvasNode) {
    if (isCanvasPanGesture(event.button, spacePressedRef.current, drawingTool === "pan") || event.button !== 0) return;
    clearTimeout(peekIntent.current);
    suppressNodeClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
    window.getSelection()?.removeAllRanges();
    event.currentTarget.focus({ preventScroll: true });
    const point = toBoardPoint(event.clientX, event.clientY);
    const toggleSelection = event.ctrlKey || event.metaKey;
    const selectedIds = expandMovableSelection(toggleSelection || selectedCanvasNodeIdsRef.current.has(node.id)
      ? new Set([...selectedCanvasNodeIdsRef.current, node.id])
      : new Set([node.id]));
    nodeDragRef.current = {
      nodeId: node.id,
      toggleSelection,
      selectedIds,
      initialNodes: nodesRef.current,
      initialGraphNodes: graphNodesRef.current,
      initialWorkflow: workflowRef.current?.bounds(true) ?? [],
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
    if (node.kind === "asset") armCanvasAssetHold(event, node.id, node.asset);
  }

  function beginGraphNodeDrag(event: PointerEvent<HTMLElement>, node: { id: string; x: number; y: number; kind: string }) {
    if (isCanvasPanGesture(event.button, spacePressedRef.current, drawingTool === "pan") || event.button !== 0) return;
    clearTimeout(peekIntent.current);
    suppressNodeClickRef.current = false;
    setPendingNewCards(pending => pending.filter(id => id !== node.id));
    // Readonly rich text can opt back into selection inside a draggable card.
    event.preventDefault();
    event.stopPropagation();
    window.getSelection()?.removeAllRanges();
    const point = toBoardPoint(event.clientX, event.clientY);
    const toggleSelection = event.ctrlKey || event.metaKey;
    const initialWorkflow = workflowRef.current?.bounds(true) ?? [];
    const isWorkflow = initialWorkflow.some(item => item.id === node.id);
    if (isWorkflow) stageRef.current?.focus({ preventScroll: true });
    else event.currentTarget.focus({ preventScroll: true });
    graphNodeDragRef.current = {
      nodeId: node.id,
      toggleSelection,
      initialNodes: graphNodesRef.current,
      initialMaterialNodes: nodesRef.current,
      initialWorkflow,
      selectedIds: expandMovableSelection(toggleSelection || selectedCanvasNodeIdsRef.current.has(node.id)
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
    if (drag?.pointerId !== event.pointerId) return;
    drag.crossedThreshold ||= exceedsCanvasDragThreshold({ x: drag.startClientX, y: drag.startClientY }, { x: event.clientX, y: event.clientY });
    graphNodeFrame.push(canvasPointerSample(event));
  }

  function updateGraphNodeDrag(event: CanvasPointerSample) {
    const drag = graphNodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved) {
      if (!drag.crossedThreshold && !exceedsCanvasDragThreshold(
        { x: drag.startClientX, y: drag.startClientY },
        { x: event.clientX, y: event.clientY },
      )) return;
      drag.moved = true;
      dismissPeekForDrag(drag.selectedIds);
      if (drag.toggleSelection) setSelectedCanvasNodeIds(drag.selectedIds);
    }
    const origin = drag.initialNodes.find((node) => node.id === drag.nodeId) ?? drag.initialWorkflow.find(node => node.id === drag.nodeId);
    if (!origin) return;
    const point = toBoardPoint(event.clientX, event.clientY);
    if (snapEnabledRef.current) observeSnapSizes();
    const snapped = snapCanvasRectPrepared(
      {
        x: point.x - drag.offsetX,
        y: point.y - drag.offsetY,
        width: origin.width,
        height: origin.height,
      },
      snapEnabledRef.current ? drag.snapAnchors ??= prepareCanvasSnapAnchors(selectionAnchors(drag.initialMaterialNodes, drag.initialNodes).filter(node => !drag.selectedIds.has(node.id))) : { ordered: [] },
      { enabled: snapEnabledRef.current, zoom: zoomRef.current },
    );
    showDragGuides(snapped.guides);
    translateDrag(drag, drag.initialMaterialNodes, drag.initialNodes, drag.initialWorkflow, snapped.x - origin.x, snapped.y - origin.y);
    const conversation = conversationCardsRef.current.cards.get(drag.nodeId);
    if (conversation && drag.selectedIds.size === 1) {
      const latest = conversation.latest;
      const selected = selectedConversationImage(drag.nodeId, conversationImages(drag.nodeId));
      const output = selected && conversation.outputs.find(node => node.id === selected.id);
      const summary = promptNodeSummary(latest);
      const selectedSession = output && (summary.status === "done" || imageOnlyConversationIds.has(drag.nodeId))
        ? conversation.sessions.find(session => canvasSessionImages(session, graphNodesRef.current).some(item => item.id === output.id)) : undefined;
      const source = { canvasNodeId: selectedSession?.id ?? latest.id, cellId: "image", ...(selectedSession && output ? { assetNodeId: output.id } : {}) };
      if (hoverContentCell(event.clientX, event.clientY, source, drag.nodeId)) return;
    }
    setHover(null);
  }

  function persistGraphNodeGeometry(node: ProjectGraphNode) {
    persistGeometries([], [node]);
  }

  function endGraphNodeDrag(event: PointerEvent<HTMLElement>, cancelled = false) {
    const drag = graphNodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    clearDragProjection(drag);
    drag.snapAnchors = undefined;
    if (cancelled) graphNodeFrame.cancel();
    else graphNodeFrame.finish(canvasPointerSample(event));
    if (drag.moved) lastCardDragEnd.current = performance.now();
    snapSizeObserverRef.current?.disconnect(); snapSizeObserverRef.current = null;
    const isWorkflow = drag.initialWorkflow.some(node => node.id === drag.nodeId);
    if (cancelled && !isWorkflow) suppressNodeClickRef.current = true;
    const node = graphNodesRef.current.find((candidate) => candidate.id === drag.nodeId) ?? drag.initialWorkflow.find(candidate => candidate.id === drag.nodeId);
    if (!cancelled && !drag.moved && drag.toggleSelection) {
      toggleCanvasNodeSelection(drag.nodeId);
      if (!isWorkflow) suppressNodeClickRef.current = true;
    }
    const hover = hoverRef.current;
    const cell = !cancelled && drag.moved && drag.selectedIds.size === 1 ? hitContentCell(event.clientX, event.clientY, true) : null;
    const drop = cell && hover?.ready && hover.intent.kind === "cell" && hover.intent.movingId === drag.nodeId
      && hover.intent.source.canvasNodeId && hover.intent.targetId === cell.targetId && hover.intent.cellId === cell.cellId ? hover.intent : null;
    if (cancelled && drag.moved) {
      translateGraphSelection(drag.initialNodes, drag.selectedIds, 0, 0);
      translateWorkflowSelection(drag.initialWorkflow, drag.selectedIds, 0, 0, true);
      commitNodes(drag.initialMaterialNodes);
    } else if (drop) {
      suppressNodeClickRef.current = true;
      // The cell owns presentation only after its save succeeds; preserve the source geometry.
      translateGraphSelection(drag.initialNodes, drag.selectedIds, 0, 0);
      commitNodes(drag.initialMaterialNodes);
      fillHoveredCell(drop);
    } else if (drag.moved && node) {
      suppressNodeClickRef.current = true;
      const moved = persistMovedWorkflowCards(drag.selectedIds);
      pushGeometryUndo(drag.initialMaterialNodes.filter((candidate) => drag.selectedIds.has(candidate.id)),
        drag.initialNodes.filter((candidate) => drag.selectedIds.has(candidate.id)), drag.initialWorkflow.filter(node => moved.has(node.id)));
      persistGeometries(nodesRef.current.filter(node => drag.selectedIds.has(node.id)),
        graphNodesRef.current.filter(node => node.kind !== "asset" && node.hiddenAt == null && drag.selectedIds.has(node.id)));
    }
    graphNodeDragRef.current = null;
    if (drag.moved && peekedCard && drag.selectedIds.has(peekedCard.anchorId)) closePeekAfterLeave();
    setHover(null);
    setActiveDragId(null);
    setGuides([]);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function canvasMediaForSelection(nodeIds: Iterable<string>) {
    const ids = new Set(nodeIds);
    if (!ids.size) return { assetIds: [], images: [] };
    for (const id of [...ids]) {
      const card = conversationCardsRef.current.cards.get(id);
      if (card?.anchor.kind !== "asset") for (const output of card?.outputs ?? []) ids.add(output.id);
    }
    const assetIds = new Set<string>();
    const images = new Map<string, CanvasMenuImage>();
    for (const node of shownMaterials) {
      if (!ids.has(node.id)) continue;
      for (const asset of node.kind === "asset" ? [(displayedMaterial(node) as CanvasAssetNode).asset] : node.assets) {
        if (!asset.assetId) continue;
        assetIds.add(asset.assetId);
        if (asset.storePath && !isVideoPath(asset.storePath) && !isAudioPath(asset.storePath) && !isTextPath(asset.storePath) && !images.has(asset.assetId)) {
          images.set(asset.assetId, { assetId: asset.assetId, canvasNodeId: asset.id });
        }
      }
    }
    return { assetIds: [...assetIds], images: [...images.values()] };
  }

  function addCanvasImagesToBoard(images: readonly CanvasMenuImage[]) {
    if (loadingRef.current || useStore.getState().projectRoutePending) return;
    setPromptMenu(null);
    for (const asset of images) {
      window.dispatchEvent(new CustomEvent(BOARD_ASSET_PICK_EVENT, { detail: asset }));
    }
    setSelectedCanvasNodeIds(new Set());
  }

  async function prepareCanvasProjectRemoval(ids: string[], nodeIds: Iterable<string>) {
    const project = activeCanvasRef.current;
    await flushCanvasWrites(false);
    if (activeCanvasRef.current.id !== project.id || useStore.getState().projectRoutePending) {
      throw new Error("项目已切换，请返回原画布重试");
    }
    const assets = new Set(ids);
    const affected = graphNodesRef.current.filter(node => node.hiddenAt == null && node.assetId && assets.has(node.assetId));
    if ([...nodeIds, ...affected.map(node => node.id)].some(id => workflowRef.current?.isLocked(id))) {
      throw new Error("卡片正在使用，请先停止对应任务再删除");
    }
  }

  const removeMenuNodes = useLatestCallback(removeNodes);

  function canAdjustMenuLayers(nodeIds: readonly string[]) {
    const workflowCards = workflowRef.current?.bounds();
    return !nodeIds.some(id => workflowCards?.some(node => node.id === id));
  }

  function generationOrigin(imageId: string) {
    const card = generationCardProjection.origins.get(imageId);
    return card && generationCardProjection.anchors.has(card.id) ? card : undefined;
  }

  function peekEditor() {
    return planeRef.current?.querySelector<HTMLElement>("[data-workflow-peek]");
  }

  function peekIsLocked(editor = peekEditor()) {
    if (peekedCard && (activeGenerationIds.has(peekedCard.nodeId) || workflow?.startingAction(peekedCard.nodeId))) return true;
    return !!editor && (editor.matches(':focus-within,[aria-busy="true"]') || !!peekInteraction.current?.composing
      || !!editor.querySelector('[aria-haspopup="listbox"][aria-expanded="true"]'));
  }

  function dismissPeekForDrag(selectedIds: ReadonlySet<string>) {
    if (peekedCard && !selectedIds.has(peekedCard.anchorId) && !peekIsLocked()) clearPeek();
  }

  function peekAnchorIsDragging() {
    if (!peekedCard) return false;
    const anchorId = peekedCard.anchorId;
    const materialDrag = nodeDragRef.current, graphDrag = graphNodeDragRef.current;
    return materialDrag?.moved && materialDrag.selectedIds.has(anchorId)
      || graphDrag?.moved && graphDrag.selectedIds.has(anchorId);
  }

  const closePeekAfterLeave = useLatestCallback(() => {
    clearTimeout(peekClose.current);
    const interaction = peekInteraction.current;
    if (!interaction || peekIsLocked() || peekAnchorIsDragging()) return;
    peekClose.current = setTimeout(() => {
      const editor = peekEditor();
      if (peekInteraction.current === interaction && !peekIsLocked(editor) && !peekAnchorIsDragging()
        && !interaction.anchor.matches(":hover") && !editor?.matches(":hover")) clearPeek();
    }, 220);
  });

  function canStartPeek() {
    return workflowInteractive && !useStore.getState().projectRoutePending && !loadingRef.current
      && !spacePressedRef.current && drawingTool !== "pan" && zoomRef.current >= 0.35
      && !panDragRef.current && !nodeDragRef.current && !graphNodeDragRef.current && !activeDragId
      && performance.now() - lastCardDragEnd.current >= 250
      && !libraryDragging && !libraryDragActive.current && !externalDragInStage.current && !isNativeAssetDrag()
      && resizeBaselineRef.current.size === 0 && !canvasExportRef.current
      && !marqueePressRef.current && !sectionDrawRef.current && !workflowRef.current?.isConnecting()
      && !promptMenu && !quickRevision && !useStore.getState().contextMenu
      && !document.querySelector('[role="menu"], [role="dialog"][aria-modal="true"]');
  }

  const openPeek = useLatestCallback((anchorId: string, anchor: HTMLElement) => {
    if (!canStartPeek() || !anchor.isConnected || !anchor.matches(":hover") || peekIsLocked()) return;
    const origin = generationCardProjection.origins.get(anchorId);
    if (!origin || generationCardProjection.anchors.get(origin.id)?.id !== anchorId || pinnedCardOffsets.has(origin.id)
      || activeGenerationIds.has(origin.id) || workflow?.startingAction(origin.id)) return;
    clearTimeout(peekClose.current);
    peekInteraction.current = { anchor, composing: false };
    setPeekedCard({ nodeId: origin.id, anchorId });
  });

  function startPeek(event: PointerEvent<HTMLElement>, anchorId: string) {
    if (event.pointerType === "touch" || event.buttons !== 0 || !canStartPeek()) {
      clearTimeout(peekIntent.current);
      return;
    }
    if (peekedCard?.anchorId === anchorId) { clearTimeout(peekClose.current); return; }
    if (!generationCardProjection.origins.has(anchorId)) return;
    clearTimeout(peekIntent.current);
    const anchor = event.currentTarget;
    peekIntent.current = setTimeout(() => openPeek(anchorId, anchor), 160);
  }

  function leavePeekAnchor() {
    clearTimeout(peekIntent.current);
    closePeekAfterLeave();
  }

  function generationContextMenuKey(event: React.KeyboardEvent<HTMLElement>, anchorId: string) {
    if (event.target !== event.currentTarget || !generationCardProjection.origins.has(anchorId)
      || (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))) return;
    event.preventDefault();
    event.stopPropagation();
    const anchor = event.currentTarget;
    const bounds = anchor.getBoundingClientRect();
    anchor.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2,
      clientX: bounds.left + bounds.width / 2, clientY: bounds.top + Math.min(24, bounds.height / 2) }));
  }

  const onPeekInteraction = useLatestCallback((kind: "enter" | "leave" | "blur" | "compose" | "commit") => {
    if (kind === "enter") { clearTimeout(peekClose.current); return; }
    const interaction = peekInteraction.current;
    if (!interaction) return;
    if (kind === "compose") { interaction.composing = true; return; }
    if (kind === "commit") interaction.composing = false;
    if (kind === "blur") queueMicrotask(closePeekAfterLeave);
    else closePeekAfterLeave();
  });

  function previewAsset(image: CanvasAssetSnapshot): Asset | undefined {
    if (!image.assetId) return undefined;
    return assetByIdRef.current.get(image.assetId) ?? { id: image.assetId, name: image.name,
      store_path: image.storePath, thumb_path: image.thumbPath, width: image.width, height: image.height };
  }

  function outputJob(image: CanvasAssetSnapshot) {
    const output = outputNodesById.get(image.id);
    if (!output || output.hiddenAt != null) return undefined;
    let jobId: string | undefined;
    try { jobId = JSON.parse(output.payloadJson).execution?.job_id; } catch { return undefined; }
    return jobId ? useStore.getState().genJobs[jobId] : undefined;
  }

  function closeQuickRevision() {
    const invoker = quickRevision?.invoker;
    setQuickRevision(null);
    if (invoker?.isConnected) requestAnimationFrame(() => invoker.focus({ preventScroll: true }));
  }

  useEffect(() => {
    if (!quickRevision) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape" || event.isComposing) return;
        event.stopPropagation();
        event.preventDefault();
        closeQuickRevision();
      } else if (event.target instanceof Node && !quickRevisionPanel.current?.contains(event.target)
        && !quickRevision.invoker?.contains(event.target)) {
        setQuickRevision(null);
      }
    };
    document.addEventListener("keydown", close, true);
    document.addEventListener("pointerdown", close, true);
    return () => {
      document.removeEventListener("keydown", close, true);
      document.removeEventListener("pointerdown", close, true);
    };
  }, [quickRevision]);

  function unpinGenerationCard(nodeId: string) {
    setPinnedWorkflowCards(current => {
      if (!current.has(nodeId)) return current;
      const next = new Map(current);
      next.delete(nodeId);
      return next;
    });
    const anchor = generationCardProjection.anchors.get(nodeId);
    if (anchor) {
      setSelectedCanvasNodeIds(current => current.has(nodeId) ? new Set([...current].filter(id => id !== nodeId).concat(anchor.id)) : current);
      requestAnimationFrame(() => stageRef.current?.querySelector<HTMLElement>(`[data-canvas-node-id="${CSS.escape(anchor.id)}"]`)?.focus({ preventScroll: true }));
    }
  }

  function focusPinnedGenerationPrompt(nodeId: string, newConnectionPrompt = false) {
    const stage = stageRef.current;
    const revision = useStore.getState().projectRouteRevision;
    requestAnimationFrame(() => {
      const route = useStore.getState();
      if (!stage?.isConnected || stageRef.current !== stage || !isWorkspaceOperationCurrent(projectId, route.activeProjectId,
        route.projectRoutePending, revision, route.projectRouteRevision)) return;
      const card = stage.querySelector<HTMLElement>(`[data-workflow-card="${CSS.escape(nodeId)}"]`);
      const prompt = card?.querySelector<HTMLElement>('[aria-label="卡片指令"]:is([contenteditable="true"],textarea:not(:disabled))');
      if (!prompt) return;
      if (newConnectionPrompt && prompt instanceof HTMLTextAreaElement) {
        newConnectedTextarea.current = prompt;
        // Native text undo consumes its own keystroke after keydown, so only a fresh untouched field can fall back here.
        prompt.addEventListener("input", () => {
          if (newConnectedTextarea.current === prompt) newConnectedTextarea.current = null;
        }, { once: true });
      }
      prompt.focus({ preventScroll: true });
    });
  }

  function pinGenerationCard(nodeId: string, connectedAnchorId?: string) {
    const anchor = generationCardProjection.anchors.get(nodeId);
    const card = workflowRef.current?.bounds(true).find(item => item.id === nodeId);
    if (!anchor || !card) return;
    if (connectedAnchorId && (anchor.id !== connectedAnchorId || activeGenerationIds.has(nodeId) || workflow?.startingAction(nodeId))) return;
    if (peekedCard?.nodeId === nodeId && peekAnchorPoint && peekInteraction.current) {
      const { x, y } = peekAnchorPoint;
      const { attemptId } = peekInteraction.current;
      setPinnedWorkflowCards(current => new Map(current).set(nodeId,
        { x: x - card.width - 12 - card.x, y: y - card.y, attemptId }));
      clearPeek();
      if (connectedAnchorId) {
        setSelectedCanvasNodeIds(new Set([nodeId]));
        focusPinnedGenerationPrompt(nodeId);
      }
      return;
    }
    const anchors = selectionAnchors();
    const imageRect = anchors.find(item => item.id === anchor.id)?.rect ?? anchor;
    const visible = pinnedCardOffsets.has(nodeId) && anchors.find(item => item.id === nodeId)?.rect;
    const leftOfMedia = { ...card, x: imageRect.x - card.width - 12, y: imageRect.y };
    const position = visible || (connectedAnchorId ? leftOfMedia : placeCanvasCardNearSource(leftOfMedia,
      anchors.filter(item => item.id !== card.id).map(item => item.rect)));
    setPinnedWorkflowCards(current => current.has(nodeId) ? current : new Map(current).set(nodeId,
      { x: position.x - card.x, y: position.y - card.y }));
    setQuickRevision(null);
    setSelectedCanvasNodeIds(new Set([nodeId]));
    const stage = stageRef.current;
    if (stage) {
      const rect = stage.getBoundingClientRect();
      const left = Math.min(position.x, imageRect.x), top = Math.min(position.y, imageRect.y);
      const context = { x: left, y: top, width: Math.max(position.x + card.width, imageRect.x + imageRect.width) - left,
        height: Math.max(position.y + card.height, imageRect.y + imageRect.height) - top };
      const next = canvasViewForNewCard(context, { x: 40, y: 40, width: Math.max(200, rect.width - 80), height: Math.max(200, rect.height - 220) },
        panRef.current, zoomRef.current, true);
      if (next) { panRef.current = next.pan; zoomRef.current = next.zoom; setPan(next.pan); setZoom(next.zoom); markViewDirty(); }
    }
    const mountingForConnection = !!connectedAnchorId && !stage?.querySelector(`[data-workflow-card="${CSS.escape(nodeId)}"]`);
    focusPinnedGenerationPrompt(nodeId, mountingForConnection);
  }

  const toggleGenerationPin = useLatestCallback((nodeId: string) => {
    if (pinnedCardOffsets.has(nodeId)) unpinGenerationCard(nodeId);
    else pinGenerationCard(nodeId);
  });
  const pinConnectedGeneration = useLatestCallback((nodeId: string, anchorId: string) => pinGenerationCard(nodeId, anchorId));

  function createCardFromImage(image: CanvasAssetSnapshot, anchorId: string) {
    const anchor = selectionAnchors().find(item => item.id === anchorId)?.rect;
    if (!anchor || !image.assetId) return;
    const point = placeCanvasCardNearSource({ x: anchor.x + anchor.width + 32, y: anchor.y,
      width: workflowCardWidth({ kind: "generation" }), height: 330 }, selectionAnchors().map(item => item.rect));
    workflowRef.current?.createImageCard(image.id, image.assetId, point);
    setQuickRevision(null);
  }

  function generationMediaActions(anchorId: string, image: CanvasAssetSnapshot): {
    pin?: () => void; revise?: (invoker?: HTMLElement) => void; create?: () => void;
  } {
    if (!workflowInteractive || !image.storePath || isAudioPath(image.storePath) || isTextPath(image.storePath)) return {};
    const origin = generationOrigin(image.id);
    const pin = origin ? () => pinGenerationCard(origin.id) : undefined;
    if (isVideoPath(image.storePath)) return { pin };
    const canContinue = !!previewAsset(image)?.generation_session_id || !!outputJob(image)?.sessionId;
    const actions = {
      pin,
      revise: canContinue ? (invoker?: HTMLElement) => setQuickRevision({ anchorId, image, invoker }) : undefined,
      create: !origin && !canContinue ? () => createCardFromImage(image, anchorId) : undefined,
    };
    return actions;
  }

  function renderGenerationImageActions(anchorId: string, image?: CanvasAssetSnapshot) {
    if (!image) return null;
    const actions = generationMediaActions(anchorId, image);
    const revision = quickRevision?.anchorId === anchorId ? quickRevision : null;
    const asset = revision && previewAsset(revision.image);
    if (!actions.revise && !asset) return null;
    return <>
      <div className="canvas-generation-actions" aria-label="生成图片操作" onPointerDown={event => event.stopPropagation()}>
        {actions.revise && <button type="button" title="继续修改" aria-label="继续修改" aria-expanded={!!revision}
          onClick={event => { event.stopPropagation(); if (revision) closeQuickRevision(); else actions.revise?.(event.currentTarget); }}><MessageSquarePlus size={15} aria-hidden="true" /></button>}
      </div>
      {asset && revision && <section className="canvas-generation-revision" role="dialog" aria-label="继续修改此图" tabIndex={-1}
        ref={quickRevisionPanel}
        onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
        onContextMenu={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
        <CanvasImageContinuation key={asset.id} asset={asset} projectId={projectId ?? null} job={outputJob(revision.image)} parentNodeId={revision.image.id}
          onSent={closeQuickRevision} onUnavailable={actions.pin ?? (() => createCardFromImage(revision.image, anchorId))} />
      </section>}
    </>;
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
    const card = conversationCardsRef.current.cards.get(selectionNode.id);
    const members = selectionNode.kind === "folder" ? selectionNode.assets : card?.outputs;
    const storedFolder = selectionNode.kind === "folder" ? nodesRef.current.find(node => node.id === selectionNode.id) : undefined;
    const onlyMember = (storedFolder?.kind === "folder" ? storedFolder.assets.length : members?.length) === 1;
    const itemId = selectedAsset.id;
    const groupTarget = members && (selectionNode.kind === "folder" || members.length > 1) ? {
      assetIds: [...new Set(members.flatMap(member => member.assetId ? [member.assetId] : []))],
      count: selectionNode.kind === "folder" && storedFolder?.kind === "folder" ? storedFolder.assets.length : members.length,
      removeFromCanvas: () => removeMenuNodes([selectionNode.id]),
    } : undefined;
    const nodeIds = [...selectedIds];
    const { assetIds, images } = canvasMediaForSelection(nodeIds);
    const targets = selectedIds.size > 1 ? assetIds : [selectedAsset.assetId];
    openContextMenu(event.clientX, event.clientY, selectedAsset.assetId, {
      generationGroup: canvasConversationGroupTarget(card),
      ungroupCanvasFolder: selectionNode.kind === "folder" ? () => ungroupFolder(selectionNode.id) : undefined,
      addCanvasImagesToBoard: {
        count: images.length,
        run: () => addCanvasImagesToBoard(images),
      },
      asset: assetById.get(selectedAsset.assetId),
      canvasSelection: {
        projectId: activeCanvasRef.current.id,
        nodeIds,
        canAdjustLayer: canAdjustMenuLayers(nodeIds),
        generationActions: nodeIds.length === 1 && selectionNode.kind === "asset" ? generationMediaActions(selectionNode.id, selectedAsset) : undefined,
        removeSelectionFromCanvas: nodeIds.length > 1 ? () => removeMenuNodes(nodeIds) : undefined,
        deletionTargets: {
          item: { assetIds: [selectedAsset.assetId], removeFromCanvas: () => removeMenuNodes([onlyMember ? selectionNode.id : itemId], onlyMember) },
          group: groupTarget,
        },
        prepareProjectRemoval: ids => prepareCanvasProjectRemoval(ids, [selectionNode.id]),
        assetIds: targets,
        assets: targets.flatMap(id => {
          const asset = assetById.get(id);
          return asset ? [asset] : [];
        }),
        imageOnly: nodeIds.length > 1 && targets.length > 0 && images.length === targets.length,
      },
    });
  }

  function openCellAssetContextMenu(event: React.MouseEvent<HTMLElement>, node: ProjectGraphNode, assetId: string, asset?: Asset, outputId?: string) {
    event.preventDefault(); event.stopPropagation(); cancelConversationImageClick(); setPromptMenu(null);
    const cellId = event.currentTarget.closest<HTMLElement>("[data-canvas-cell]")?.dataset.canvasCell;
    const cell = readCanvasNote(node).cells.flat().find(item => item.id === cellId);
    const session = cell?.generation_ref?.session_node_id;
    const anchor = session && conversationCardsRef.current.aliases.get(session);
    const card = anchor ? conversationCardsRef.current.cards.get(anchor) : undefined;
    const assetIds = [...new Set(card?.allOutputs.flatMap(output => output.assetId ? [output.assetId] : []) ?? cell?.image_refs?.map(ref => ref.asset_id) ?? [])];
    function clearCell(ids: string[]) {
      const current = graphNodesRef.current.find(item => item.id === node.id);
      if (!current || !cellId || canvasWorkflowController(activeCanvasRef.current.id).isLocked(node.id)) return;
      const value = readCanvasNote(current);
      updateCanvasNote(node.id, { ...value, cells: value.cells.map(row => row.map(item => item.id !== cellId ? item : {
        ...item, generation_ref: undefined, image_refs: item.image_refs?.filter(ref => !ids.includes(ref.asset_id)),
      })) });
    }
    const mediaPath = asset?.store_path ?? event.currentTarget.dataset.filePath;
    openContextMenu(event.clientX, event.clientY, assetId, {
      asset, singleAsset: true, generationGroup: canvasConversationGroupTarget(card),
      canvasSelection: {
        projectId: activeCanvasRef.current.id, nodeIds: [], assetIds: [assetId],
        prepareProjectRemoval: ids => prepareCanvasProjectRemoval(ids, [node.id]),
        deletionTargets: {
          item: { assetIds: [assetId], removeFromCanvas: () => {
            if (outputId && card && card.allOutputs.length > 1) {
              if (!canvasWorkflowController(node.projectId).isLocked(node.id)) removeMenuNodes([outputId], false);
            } else clearCell([assetId]);
          } },
          group: assetIds.length > 1 ? { assetIds, count: assetIds.length, removeFromCanvas: () => clearCell(assetIds) } : undefined,
        },
      },
      addCanvasImagesToBoard: {
        count: mediaPath && !isVideoPath(mediaPath) && !isAudioPath(mediaPath) && !isTextPath(mediaPath) ? 1 : 0,
        run: () => window.dispatchEvent(new CustomEvent(BOARD_ASSET_PICK_EVENT, { detail: assetId })),
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
            savedAsset ??= await saveVideoFrame({ path, time, dataUrl }, project.id);
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
              pushCanvasUndo({ kind: "paste", projectId: project.id, nodeIds: [node.id], groupIds: [], workflowIds: [] });
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

  const collectedVideoSaves = useRef(new Map<string, () => Promise<void>>());
  async function addCollectedVideo({ asset, projectId, operationId }: VideoCollectionCanvasDetail, sourceId?: string) {
    let save = collectedVideoSaves.current.get(operationId);
    if (!save) {
      const stage = stageRef.current, project = activeCanvas;
      if (!stage || project.id !== projectId || loadingRef.current || useStore.getState().projectRoutePending) throw new Error("请等待目标画板加载完成");
      const bounds = stage.getBoundingClientRect(), center = toBoardPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      const snapshot = createCanvasAssetSnapshot(asset, canvasId("asset")), size = assetNodeSize(snapshot);
      const anchors = sourceId ? selectionAnchors() : [];
      const source = anchors.find(anchor => anchor.id === sourceId)?.rect;
      if (sourceId && !source) throw new Error("来源导演台已移除，导出的素材已保存在项目中");
      const origin = source ? { x: source.x + source.width + 32, y: source.y }
        : { x: center.x - size.width / 2, y: center.y - size.height / 2 };
      const position = placeCanvasCardNearSource({ ...origin, ...size }, source ? anchors.map(anchor => anchor.rect) : nodesRef.current.map(nodeRect));
      const node: CanvasAssetNode = { kind: "asset", id: snapshot.id, asset: snapshot, ...position, ...size,
        order: nodesRef.current.reduce((max, node) => Math.max(max, node.order), 0) + 1 };
      let queued = false, completed = false;
      save = async () => {
        await retryPendingWrites();
        if (completed) return;
        if (!queued) {
          queued = true;
          await enqueueWrite(async () => {
            await ensureMaterialized(project);
            await api.projectCanvasNodeCreate(newProjectCanvasAssetNode(projectId, node));
            completed = true;
            const current = useStore.getState();
            if (stage.isConnected && activeCanvasRef.current.id === projectId && current.activeProjectId === projectId && !current.projectRoutePending) {
              pushCanvasUndo({ kind: "paste", projectId, nodeIds: [node.id], groupIds: [], workflowIds: [] });
              setCanvasAssets(assets => [...assets.filter(item => item.id !== asset.id), asset]);
              commitNodes([...nodesRef.current.filter(item => item.id !== node.id), node]);
            }
          });
        }
        if (writeJournalRef.current.failure != null) throw writeJournalRef.current.failure;
      };
      collectedVideoSaves.current.set(operationId, save);
    }
    await save();
    collectedVideoSaves.current.delete(operationId);
  }

  const saveCollectedRef = useRef(addCollectedVideo);
  saveCollectedRef.current = addCollectedVideo;
  const saveFrameRef = useRef(addVideoFrame);
  saveFrameRef.current = addVideoFrame;
  useEffect(() => {
    const save = (event: Event) => {
      const detail = (event as CustomEvent<VideoFrameCanvasDetail>).detail;
      if (detail.projectId === activeCanvasRef.current.id && useStore.getState().activeProjectId === detail.projectId) {
        detail.result = saveFrameRef.current(detail.frame);
      }
    };
    window.addEventListener(VIDEO_FRAME_CANVAS_EVENT, save);
    const saveCollected = (event: Event) => {
      const detail = (event as CustomEvent<VideoCollectionCanvasDetail>).detail;
      if (detail.projectId === activeCanvasRef.current.id && useStore.getState().activeProjectId === detail.projectId) detail.result = saveCollectedRef.current(detail);
    };
    window.addEventListener(VIDEO_COLLECTION_CANVAS_EVENT, saveCollected);
    const prepareCollection = (event: Event) => {
      const detail = (event as CustomEvent<VideoCollectionProjectDetail>).detail;
      if (detail.projectId === activeCanvasRef.current.id && useStore.getState().activeProjectId === detail.projectId && !useStore.getState().projectRoutePending) {
        detail.result = ensureMaterialized(activeCanvasRef.current).then(() => {});
      }
    };
    window.addEventListener(VIDEO_COLLECTION_PROJECT_EVENT, prepareCollection);
    return () => {
      window.removeEventListener(VIDEO_FRAME_CANVAS_EVENT, save); window.removeEventListener(VIDEO_COLLECTION_CANVAS_EVENT, saveCollected);
      window.removeEventListener(VIDEO_COLLECTION_PROJECT_EVENT, prepareCollection);
    };
  }, []);

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
                pushCanvasUndo({ kind: "paste", projectId: project.id, nodeIds: [node.id], groupIds: [], workflowIds: [] });
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

  function activateCanvasMaterial(node: CanvasNode) {
    node = displayedMaterial(node);
    if (node.kind === "folder") {
      setFolderExpanded(node.id, true);
      return;
    }
    if (isVideoPath(node.asset.storePath) && node.asset.storePath) {
      setCanvasLightbox({ images: [node.asset.storePath], assetIds: [node.asset.assetId], canvasNodeId: node.asset.id, index: 0 });
      return;
    }
    if (isAudioPath(node.asset.storePath)) return;
    const state = useStore.getState();
    if (node.asset.assetId || canvasPrimaryMaterialAction(state.boardOpen, !!state.genEditing) === "compose") {
      // Library image clicks are arbitrated once at the workspace boundary in both modes.
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
      assetIds: available.map(candidate => candidate.id),
      index: selectedIndex >= 0 ? selectedIndex : 0,
    });
  }, []);

  function moveNode(event: PointerEvent<HTMLDivElement>) {
    const drag = nodeDragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    drag.crossedThreshold ||= exceedsCanvasDragThreshold({ x: drag.startClientX, y: drag.startClientY }, { x: event.clientX, y: event.clientY });
    nodeFrame.push(canvasPointerSample(event));
  }

  function updateNodeDrag(event: CanvasPointerSample) {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const originMoving = drag.initialNodes.find((node) => node.id === drag.nodeId);
    if (!originMoving) return;
    if (!drag.moved) {
      if (!drag.crossedThreshold && !exceedsCanvasDragThreshold(
        { x: drag.startClientX, y: drag.startClientY },
        { x: event.clientX, y: event.clientY },
      )) return;
      drag.moved = true;
      dismissPeekForDrag(drag.selectedIds);
      if (drag.toggleSelection) setSelectedCanvasNodeIds(drag.selectedIds);
    }
    const point = toBoardPoint(event.clientX, event.clientY);
    const raw = {
      x: point.x - drag.offsetX,
      y: point.y - drag.offsetY,
      width: nodeRect(originMoving).width,
      height: nodeRect(originMoving).height,
    };
    if (snapEnabledRef.current) observeSnapSizes();
    const snapped = snapCanvasRectPrepared(
      raw,
      snapEnabledRef.current ? drag.snapAnchors ??= prepareCanvasSnapAnchors(selectionAnchors(drag.initialNodes, drag.initialGraphNodes).filter(node => !drag.selectedIds.has(node.id))) : { ordered: [] },
      { enabled: snapEnabledRef.current, zoom: zoomRef.current },
    );
    showDragGuides(snapped.guides);
    translateDrag(drag, drag.initialNodes, drag.initialGraphNodes, drag.initialWorkflow, snapped.x - originMoving.x, snapped.y - originMoving.y);
    const moving = originMoving;
    if (drag.selectedIds.size > 1 || moving?.kind !== "asset") {
      setHover(null);
      setFolderDropTargetId(null);
      return;
    }
    if (moving.asset.assetId && !isVideoPath(moving.asset.storePath) && !isAudioPath(moving.asset.storePath)
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
    clearDragProjection(drag);
    drag.snapAnchors = undefined;
    if (cancelled) nodeFrame.cancel();
    else nodeFrame.finish(canvasPointerSample(event));
    if (drag.moved) lastCardDragEnd.current = performance.now();
    snapSizeObserverRef.current?.disconnect(); snapSizeObserverRef.current = null;
    const moving = nodesRef.current.find((node) => node.id === drag.nodeId);
    if (moving?.kind === "asset" && isAudioPath(moving.asset.storePath)
      && (cancelled || drag.moved || drag.toggleSelection)) {
      suppressNodeClickRef.current = true;
      event.currentTarget.focus({ preventScroll: true });
    }
    const hover = hoverRef.current;
    const cell = !cancelled && drag.moved && drag.selectedIds.size === 1 ? hitContentCell(event.clientX, event.clientY, true) : null;
    const target = !cancelled && drag.moved && drag.selectedIds.size === 1
      ? hitNode(toBoardPoint(event.clientX, event.clientY), drag.nodeId)
      : null;
    const voiceTarget = !cancelled && drag.moved && drag.selectedIds.size === 1 && moving?.kind === "asset" && isAudioPath(moving.asset.storePath)
      ? document.elementsFromPoint(event.clientX, event.clientY).map(el => el.closest<HTMLElement>(".workflow-card.is-voice")).find(Boolean)?.dataset.workflowCard
      : undefined;
    if (voiceTarget && moving?.kind === "asset" && moving.asset.assetId && workflowRef.current?.bindRecording(voiceTarget, moving.asset.assetId, moving.id)) {
      commitNodes(drag.initialNodes);
    } else if (cancelled && drag.moved) {
      commitNodes(drag.initialNodes);
      translateGraphSelection(drag.initialGraphNodes, drag.selectedIds, 0, 0);
      translateWorkflowSelection(drag.initialWorkflow, drag.selectedIds, 0, 0, true);
    } else if (!cancelled && !drag.moved && moving) {
      if (drag.toggleSelection) toggleCanvasNodeSelection(moving.id);
      else if (!creationImage.handlesVideo(event.currentTarget)) activateCanvasMaterial(moving);
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
        pushMaterialsUndo(drag.initialNodes, next);
        commitNodes(next);
        const group = next.find((node): node is CanvasFolderNode => node.kind === "folder"
          && node.assets.some((asset) => asset.id === moving.id));
        if (group && target.kind === "folder") persistGroupMembership(group, [], moving);
        else if (group) persistCreatedGroup(group, [], moving);
      }
    } else if (moving && drag.moved) {
      const moved = persistMovedWorkflowCards(drag.selectedIds);
      pushGeometryUndo(drag.initialNodes.filter((candidate) => drag.selectedIds.has(candidate.id)),
        drag.initialGraphNodes.filter((candidate) => drag.selectedIds.has(candidate.id)), drag.initialWorkflow.filter(node => moved.has(node.id)));
      persistGeometries(nodesRef.current.filter(node => drag.selectedIds.has(node.id)),
        graphNodesRef.current.filter(node => node.kind !== "asset" && node.hiddenAt == null && drag.selectedIds.has(node.id)));
    }
    nodeDragRef.current = null;
    if (drag.moved && peekedCard && drag.selectedIds.has(peekedCard.anchorId)) closePeekAfterLeave();
    setActiveDragId(null);
    setGuides([]);
    setHover(null);
    setFolderDropTargetId(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function updateCanvasNote(nodeId: string, value: CanvasNotePayload, size?: { width: number; height: number }, history: "edit" | "typing" | "layout" = "edit") {
    const payloadJson = JSON.stringify(value);
    const node = graphNodesRef.current.find(candidate => candidate.id === nodeId);
    if (!node) return;
    const minimum = value.note_type === "document" ? { width: 280, height: canvasDocumentHeight(Math.max(280, size?.width ?? node.width)) } : value.note_type !== "section" ? canvasTextMinSize(value.cells, value.note_type === "images", value.note_type === "bubble") : node;
    const updated = { ...node, payloadJson, width: Math.max(size?.width ?? node.width, minimum.width), height: Math.max(size?.height ?? node.height, minimum.height) };
    if (value.note_type === "document") updated.height = minimum.height;
    if (node.payloadJson === updated.payloadJson && !canvasGeometryDiffers(node, updated)) return;
    const top = undoHistoryRef.current[undoHistoryRef.current.length - 1];
    if (history === "layout") {
      if (top?.kind === "content" && top.after.id === nodeId && top.after.payloadJson === node.payloadJson) top.after = updated;
    } else if (history === "typing" && top?.kind === "content" && top.after.id === nodeId
      && top.after.payloadJson === node.payloadJson && top.typedAt && Date.now() - top.typedAt < 800) {
      top.after = updated; top.typedAt = Date.now();
    } else {
      pushCanvasUndo({ kind: "content", projectId: node.projectId, before: node, after: updated, typedAt: history === "typing" ? Date.now() : undefined });
    }
    graphNodesRef.current = graphNodesRef.current.map(candidate => candidate.id === nodeId ? updated : candidate);
    setGraphNodes(graphNodesRef.current);
    void enqueueWrite(async () => { await api.projectCanvasNoteUpdate(nodeId, payloadJson); });
    if (updated.width !== node.width || updated.height !== node.height) persistGraphNodeGeometry(updated);
  }

  function resizeCanvasGraphNode(nodeId: string, size: { width: number; height: number; x?: number; y?: number }, finished: boolean, cancelled = false) {
    const node = graphNodesRef.current.find(candidate => candidate.id === nodeId);
    if (!node) return;
    const baseline = resizeBaselineRef.current.get(nodeId)?.graph ?? node;
    if (!resizeBaselineRef.current.has(nodeId)) {
      resizeBaselineRef.current.set(nodeId, { graph: baseline });
      clearTimeout(peekIntent.current);
      cancelConversationImageClick();
    }
    const updated = cancelled ? { ...node, x: baseline.x, y: baseline.y, width: baseline.width, height: baseline.height }
      : { ...node, ...size, height: node.kind === "prompt" && size.width === baseline.width ? baseline.height : size.height };
    if (canvasGeometryDiffers(node, updated)) {
      graphNodesRef.current = graphNodesRef.current.map(candidate => candidate.id === nodeId ? updated : candidate);
      setGraphNodes(graphNodesRef.current);
    }
    setActiveDragId(finished ? null : nodeId);
    if (finished) {
      resizeBaselineRef.current.delete(nodeId);
      if (!cancelled && (updated.kind === "note" || canvasGeometryDiffers(baseline, updated))) {
        pushGeometryUndo([], [baseline]);
        persistGraphNodeGeometry(updated);
        if (updated.kind === "note") {
          const value = readCanvasNote(updated);
          if (value.note_type === "section" && !value.workflow_container && !value.artboard) updateCanvasNote(nodeId, { ...value, member_ids: claimSectionMembers(updated, nodeId) }, undefined, "layout");
        }
      }
    }
  }

  function saveDocumentCard(document: TextWorkspaceDocument) {
    stageDocumentCard(document);
    flushDocumentCard();
  }

  function flushDocumentCard() {
    pendingDocumentInput.current?.();
    pendingDocumentInput.current = undefined;
    clearTimeout(documentSaveTimer.current);
    const pending = documentSaveRef.current;
    documentSaveRef.current = null;
    if (pending) void enqueueWrite(async () => { await api.projectCanvasNoteUpdate(pending.nodeId, pending.payloadJson); });
  }

  function stageDocumentCard(document: TextWorkspaceDocument) {
    if (!documentEditor || activeCanvasRef.current.id !== documentEditor.projectId) throw new Error("项目已切换，请重新打开文本卡片");
    const node = graphNodesRef.current.find(node => node.id === documentEditor.nodeId && node.hiddenAt == null);
    if (!node) throw new Error("文本卡片已删除，内容仍保留在编辑器中");
    const note = readCanvasNote(node);
    if (note.title === document.title && note.text === document.markdown) return;
    documentEditorRevision.current++;
    const payloadJson = JSON.stringify({ ...note, title: document.title, text: document.markdown });
    const after = { ...node, payloadJson };
    const top = undoHistoryRef.current[undoHistoryRef.current.length - 1];
    if (top?.kind === "content" && top.after.id === node.id && top.after.payloadJson === node.payloadJson
      && top.typedAt && Date.now() - top.typedAt < 800) {
      top.after = after; top.typedAt = Date.now();
    } else pushCanvasUndo({ kind: "content", projectId: node.projectId, before: node, after, typedAt: Date.now() });
    graphNodesRef.current = graphNodesRef.current.map(item => item.id === node.id ? { ...item, payloadJson } : item);
    setGraphNodes(graphNodesRef.current);
    documentSaveRef.current = { nodeId: node.id, payloadJson };
    clearTimeout(documentSaveTimer.current);
    documentSaveTimer.current = setTimeout(flushDocumentCard, 450);
  }

  function resizeCanvasMaterial(nodeId: string, size: { width: number; height: number }, finished: boolean, cancelled = false) {
    const node = nodesRef.current.find(candidate => candidate.id === nodeId);
    if (!node) return;
    if (!resizeBaselineRef.current.has(nodeId)) {
      resizeBaselineRef.current.set(nodeId, { material: node });
      clearTimeout(peekIntent.current);
    }
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

  function expandMovableSelection(ids: Set<string>) {
    const expanded = expandArtboardSelection(ids);
    if (!graphNodesRef.current.some(node => ids.has(node.id) && node.kind === "note" && readCanvasNote(node).note_type === "section")) return expanded;
    const sections = graphNodesRef.current.filter(node => node.kind === "note" && node.hiddenAt == null
      && readCanvasNote(node).note_type === "section");
    const { aliases, cards } = conversationCardsRef.current;
    const owners = new Map<string, string>();
    const ordinary = sections.filter(section => {
      const note = readCanvasNote(section);
      for (const member of note.member_ids) {
        const anchor = aliases.get(member) ?? member;
        owners.set(anchor, section.id);
        if (anchor !== member && ids.has(section.id) && !ids.has(member)) expanded.delete(member);
      }
      return !note.artboard && !note.workflow_container;
    }).reverse();
    // A generated result can appear after the section was drawn, or replace its saved member's visible identity.
    const generated = new Set([...cards.keys(), ...aliases.values()]);
    for (const node of graphNodesRef.current) if (node.kind === "asset" && node.role === "output") generated.add(node.id);
    for (const anchor of selectionAnchors()) {
      if (!generated.has(anchor.id)) continue;
      const owner = owners.get(anchor.id) ?? ordinary.find(section =>
        canvasSectionMembers(section, [anchor]).length > 0)?.id;
      if (owner && ids.has(owner)) expanded.add(anchor.id);
    }
    return expanded;
  }

  function expandArtboardSelection(ids: Set<string>) {
    if (!graphNodesRef.current.some(node => ids.has(node.id) && node.kind === "note" && readCanvasNote(node).artboard))
      return expandCanvasSections(ids, graphNodesRef.current);
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

  const createFromImage = useLatestCallback((event: Event) => {
    const detail = (event as CustomEvent<{ projectId: string; nodeIds: string[]; assetId: string }>).detail;
    if (!detail || detail.projectId !== activeCanvasRef.current.id || loadingRef.current || useStore.getState().projectRoutePending) return;
    const node = nodesRef.current.find(node => detail.nodeIds.includes(node.id) && node.kind === "asset" && node.asset.assetId === detail.assetId);
    const asset = assetById.get(detail.assetId);
    if (!node || !asset?.store_path || isVideoPath(asset.store_path)) return;
    const width = Math.max(320, node.width), height = width * (asset.height || 1) / (asset.width || 1);
    createCanvasNote({ x: node.x + node.width + 48, y: node.y, width, height }, "section", { base_asset_id: asset.id });
  });
  useEffect(() => {
    window.addEventListener(CANVAS_ARTBOARD_FROM_IMAGE, createFromImage);
    return () => window.removeEventListener(CANVAS_ARTBOARD_FROM_IMAGE, createFromImage);
  }, [createFromImage]);

  function createCanvasNote(rect: CanvasRect, noteType: "text" | "section" | "bubble" | "document", artboard?: { base_asset_id: string | null }) {
    const draft = activeCanvasRef.current;
    const members = noteType === "section" && !artboard ? claimSectionMembers(rect) : [];
    const value: CanvasNotePayload = { schema_version: 1, text: artboard ? "画板" : noteType === "section" ? "分区" : "", note_type: noteType,
      ...(artboard ? { artboard } : {}),
      cells: noteType !== "section" && noteType !== "document" ? [[emptyCanvasCell()]] : [], member_ids: members,
      ...(noteType === "document" ? { title: "文本" } : {}),
      ...(noteType === "bubble" ? { bubble_tail: { side: "bottom" as const, position: 25 } } : {}) };
    const node: ProjectGraphNode = { id: canvasId(noteType), projectId: draft.id, threadId: null, kind: "note", assetId: null, role: null,
      payloadJson: JSON.stringify(value), ...rect, zIndex: Math.max(0, ...selectionAnchors().map(anchor => anchor.order)) + 1, positionLocked: false, hiddenAt: null, createdAt: Date.now(), updatedAt: Date.now() };
    pushCanvasUndo({ kind: "paste", projectId: draft.id, nodeIds: [node.id], groupIds: [], workflowIds: [] });
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

  function placeCanvasCard(kind: "bubble" | "document" | Exclude<WorkflowKind, "trigger">, point: CanvasPoint) {
    chooseCanvasTool("select");
    if (kind === "document") {
      createCanvasNote({ ...point, width: 420, height: canvasDocumentHeight(420) }, "document");
    } else if (kind === "text" || kind === "bubble") {
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
    clearTimeout(peekIntent.current);
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
          const press: CanvasMarqueePress = {
            pointerId: event.pointerId,
            origin: toBoardPoint(event.clientX, event.clientY),
            cursor: canvasPointerSample(event),
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
    const marquee = marqueePressRef.current;
    if (marquee?.pointerId === event.pointerId) marquee.crossedThreshold ||= exceedsCanvasDragThreshold(
      { x: marquee.startClientX, y: marquee.startClientY }, { x: event.clientX, y: event.clientY }, 4);
    if (sectionDrawRef.current || marqueePressRef.current || panDragRef.current) panFrame.push(canvasPointerSample(event));
  }

  function updatePan(event: CanvasPointerSample) {
    const drawing = sectionDrawRef.current;
    if (drawing?.pointerId === event.pointerId) {
      setSectionPreview(canvasRectFromPoints(drawing.start, toBoardPoint(event.clientX, event.clientY)));
      return;
    }
    const marqueePress = marqueePressRef.current;
    if (marqueePress?.pointerId === event.pointerId) {
      if (!marqueePress.active) {
        if (!marqueePress.crossedThreshold && !exceedsCanvasDragThreshold(
          { x: marqueePress.startClientX, y: marqueePress.startClientY },
          { x: event.clientX, y: event.clientY },
          4,
        )) {
          return;
        }
        marqueePress.active = true;
      }
      const stageRect = event.currentTarget.getBoundingClientRect();
      marqueePress.cursor = event;
      const pan = panRef.current, zoom = zoomRef.current;
      const selection = canvasRectFromPoints(marqueePress.origin, {
        x: (event.clientX - stageRect.left - pan.x) / zoom,
        y: (event.clientY - stageRect.top - pan.y) / zoom,
      });
      const overlay = marqueeElement.current;
      if (overlay) {
        overlay.hidden = false;
        overlay.style.left = `${selection.x * zoom + pan.x}px`;
        overlay.style.top = `${selection.y * zoom + pan.y}px`;
        overlay.style.width = `${selection.width * zoom}px`;
        overlay.style.height = `${selection.height * zoom}px`;
      }
      const sections = marqueePress.sectionIds ??= new Set(graphNodesRef.current.filter(node => node.kind === "note"
        && readCanvasNote(node).note_type === "section").map(node => node.id));
      const selected = canvasNodeIdsInRect(
        selection,
        (marqueePress.anchors ??= selectionAnchors()).filter(anchor => !sections.has(anchor.id) || canvasSectionMembers(selection, [anchor]).length > 0),
      );
      const next = new Set(
        marqueePress.additive ? [...marqueePress.baseSelection, ...selected] : selected,
      );
      setSelectedCanvasNodeIds(previous => previous.size === next.size && [...next].every(id => previous.has(id)) ? previous : next);
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
    markViewDirty(false);
    paintCamera();
  }

  function endPan(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    if (cancelled) panFrame.cancel();
    else panFrame.finish(canvasPointerSample(event));
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
      }
      if (cancelled || marqueePress.active) blankPressCount.current = 0;
      marqueePressRef.current = null;
      if (marqueeElement.current) marqueeElement.current.hidden = true;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      return;
    }
    if (panDragRef.current?.pointerId !== event.pointerId) return;
    if (panDragRef.current.moved) markViewDirty();
    settleCamera();
    // 平移手势从节点或节点按钮起步时，即使没有明显位移也不能落成一次 click。
    suppressNodeClickRef.current = true;
    window.setTimeout(() => { suppressNodeClickRef.current = false; }, 0);
    panDragRef.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function consumeSuppressedNodeClick(event: React.MouseEvent<HTMLElement>) {
    if (!suppressNodeClickRef.current) return false;
    suppressNodeClickRef.current = false;
    return event.detail !== 0;
  }

  function zoomAround(clientX: number, clientY: number, requested: number, rect = stageRef.current?.getBoundingClientRect()) {
    if (!rect) return;
    const nextZoom = clampCanvasZoom(requested);
    const point = { x: (clientX - rect.left - panRef.current.x) / zoomRef.current,
      y: (clientY - rect.top - panRef.current.y) / zoomRef.current };
    const nextPan = {
      x: clientX - rect.left - point.x * nextZoom,
      y: clientY - rect.top - point.y * nextZoom,
    };
    zoomRef.current = nextZoom;
    panRef.current = nextPan;
    markViewDirty(false);
    scheduleCamera();
  }

  function centerCanvasEditor(event: React.MouseEvent<HTMLDivElement>) {
    const stage = stageRef.current;
    if (!stage || event.button !== 0 || event.defaultPrevented || spacePressedRef.current
      || drawingTool !== "select" || loadingRef.current || useStore.getState().projectRoutePending) return;
    const target = event.target;
    const editor = target instanceof HTMLElement ? target.closest<HTMLElement>('input,textarea,[contenteditable]') : null;
    if (!editor || !stage.contains(editor) || editor.closest(".is-section-name,[data-workflow-peek]") || !editor.closest('[data-canvas-node],[data-card-name]')
      || editor.closest('[role="toolbar"]') || editor === centeredEditorRef.current
      || !editor.contains(document.activeElement)) return;
    if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
      if (editor.readOnly || editor.matches(':disabled')
        || editor instanceof HTMLInputElement && !["text", "search", "url", "tel", "email"].includes(editor.type)) return;
    } else if (!editor.isContentEditable) return;

    cancelEditorCenter();
    clearTimeout(cameraSettleRef.current);
    cameraFrame.flush();
    const bounds = stage.getBoundingClientRect();
    const field = editor.getBoundingClientRect();
    if (!field.width || !field.height) return;
    // Measure once; the frame loop only paints the camera transform.
    let left = bounds.left + 64, right = bounds.right - 24, bottom = bounds.bottom - 24;
    const top = bounds.top + 72;
    const library = useStore.getState().canvasLibraryOpen && sourcePanelRef.current?.getBoundingClientRect();
    if (library && library.right > bounds.left && library.left < bounds.right) left = Math.max(left, library.right + 16);
    const inspector = boardShellRef.current?.querySelector('.project-inspector-shell:not(.is-editing)')?.getBoundingClientRect();
    if (inspector && inspector.width > 0) right = Math.min(right, inspector.left - 16);
    const composer = boardShellRef.current?.querySelector('.canvas-composer-host')?.getBoundingClientRect();
    if (composer && composer.height > 0) bottom = Math.min(bottom, composer.top - 16);
    if (right <= left || bottom <= top) return;
    const fromPan = panRef.current, fromZoom = zoomRef.current;
    const center = {
      x: (field.left + field.width / 2 - bounds.left - fromPan.x) / fromZoom,
      y: (field.top + field.height / 2 - bounds.top - fromPan.y) / fromZoom,
    };
    const nextZoom = clampCanvasZoom(Math.max(fromZoom, Math.min(1.2,
      (right - left) * fromZoom / field.width, (bottom - top) * fromZoom / field.height)));
    const nextPan = {
      x: (left + right) / 2 - bounds.left - center.x * nextZoom,
      y: (top + bottom) / 2 - bounds.top - center.y * nextZoom,
    };
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 280;
    const started = performance.now();
    let livePan = fromPan, liveZoom = fromZoom;
    const animate = (now: number) => {
      // A new camera owner (navigation, fit, placement) takes precedence.
      if (panRef.current !== livePan || zoomRef.current !== liveZoom) { cancelEditorCenter(); return; }
      if (!stage.contains(editor) || !editor.contains(document.activeElement) || viewModeRef.current !== "canvas"
        || loadingRef.current || useStore.getState().projectRoutePending) { settleCamera(); return; }
      const progress = duration ? Math.max(0, Math.min(1, (now - started) / duration)) : 1;
      const eased = 1 - (1 - progress) ** 3;
      liveZoom = zoomRef.current = fromZoom + (nextZoom - fromZoom) * eased;
      livePan = panRef.current = { x: fromPan.x + (nextPan.x - fromPan.x) * eased, y: fromPan.y + (nextPan.y - fromPan.y) * eased };
      markViewDirty(false);
      paintCamera();
      if (progress < 1) editorCenterFrameRef.current = requestAnimationFrame(animate);
      else { centeredEditorRef.current = editor; settleCamera(); }
    };
    if (duration) editorCenterFrameRef.current = requestAnimationFrame(animate);
    else animate(started);
  }

  function onCanvasWheel(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      zoomAround(event.clientX, event.clientY, zoomRef.current * Math.exp(-event.deltaY * 0.0015),
        wheelStageRect.current ??= event.currentTarget.getBoundingClientRect());
    } else {
      const next = { x: panRef.current.x - event.deltaX, y: panRef.current.y - event.deltaY };
      panRef.current = next;
      markViewDirty(false);
      scheduleCamera();
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
    const readEpoch = originalDeletionEpoch();
    const snapshot = await api.projectCanvasGet(project);
    const exact = await api.getAssetsByIds(projectCanvasAssetIds(snapshot.nodes));
    applySnapshot(snapshot, { restoreView: false, restoreDraft: false }, exact, routeRevision, readEpoch);
  }

  async function pasteCanvasSelection(value: CanvasClipboard, point?: CanvasPoint) {
    if (pastingRef.current || !workflowInteractive || !value.selection.length) return;
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
        const nodeIds = new Set(existing.nodes.map(item => item.id));
        const groupIds = new Set(existing.groups.map(item => item.id));
        const nodesToCreate = cloned.nodes.filter(node => !nodeIds.has(node.id));
        const groupsToCreate = cloned.groups.filter(group => !groupIds.has(group.id)).map(value => ({
          value, nodeIds: cloned.items.filter(item => item.groupId === value.id).map(item => item.nodeId),
        }));
        if (nodesToCreate.length || groupsToCreate.length) {
          await api.projectCanvasNodesBatchCreate(draft.id, nodesToCreate, groupsToCreate);
        }
        if (ids.length) {
          if (controller.document.nodes.some(node => ids.includes(node.id))) {
            if (controller.error) await controller.retrySave();
          } else await controller.edit([...controller.document.nodes, ...cloned.workflow]);
        }
        await refreshClipboardCanvas(draft.id);
        if (!completed && activeCanvasRef.current.id === draft.id) {
          completed = true;
          pushCanvasUndo({ kind: "paste", projectId: draft.id, nodeIds: cloned.nodes.map(node => node.id), groupIds: cloned.groups.map(group => group.id), workflowIds: ids });
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
      return !event.defaultPrevented && !target?.closest('input,textarea,select,[role="combobox"],[contenteditable="true"]')
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
      if (value) {
        event.preventDefault(); event.stopPropagation(); void pasteCanvasSelection(value); return;
      }
      const stage = stageRef.current;
      if (!stage || !(event.target instanceof Node) || !stage.contains(event.target)) return;
      const files = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith("image/"));
      if (!files.length) return;
      event.preventDefault(); event.stopPropagation();
      const state = useStore.getState(), projectId = activeCanvasRef.current.id;
      const bounds = stage.getBoundingClientRect();
      const last = lastImportPointRef.current;
      const point = last?.projectId === projectId ? last : { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      const place = prepareExplorerCanvasDrop(stage, projectId, point.x, point.y);
      if (!place) { notifyError(null, "画布尚未准备好，请稍后再粘贴"); return; }
      void (async () => {
        await prepareMediaImport(projectId, state.projectRouteRevision);
        for (const file of files) {
          try { await place(await importDroppedMedia(file, projectId, "clipboard")); }
          catch (error) { notifyError(error, "粘贴图片到画布失败"); }
        }
      })().catch(error => notifyError(error, "粘贴图片到画布失败"));
    };
    window.addEventListener("copy", copy, true); window.addEventListener("paste", paste, true);
    return () => { window.removeEventListener("copy", copy, true); window.removeEventListener("paste", paste, true); };
  }, [scopedInspectorOpen, workflowInteractive]);

  function removeNodes(nodeIds: Iterable<string>, expandConversations = true) {
    if (!workflowInteractive) return; // Deletion also checks locks on connected workflow cards.
    const ids = new Set(nodeIds);
    for (const id of [...ids]) {
      const card = expandConversations && conversationCardsRef.current.cards.get(id);
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
    if ([...ids].some(id => workflowRef.current?.isLocked(id) || workflowRef.current?.isLocked(conversationCardsRef.current.aliases.get(id) ?? id))) {
      notify("卡片正在使用，请先停止对应任务再删除", "info"); return;
    }
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
    const changedFolders = nodesRef.current.filter((node): node is CanvasFolderNode =>
      node.kind === "folder" && !ids.has(node.id) && node.assets.some(asset => ids.has(asset.id)));
    pushCanvasUndo({ kind: "removal", projectId: draft.id, materials, graph, changedFolders, groups: new Map(groupsRef.current), workflow });
    commitNodes(nodesRef.current.filter(node => !ids.has(node.id)).map(node =>
      node.kind === "folder" && changedFolders.includes(node) ? { ...node, assets: node.assets.filter(asset => !ids.has(asset.id)) } : node));
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
      ? graphNodesRef.current === graphNodes ? promptByAgentGroupId.get(node.id)
        : [...agentPromptGroupMap(graphNodesRef.current, graphEdges)].find(([, group]) => group.id === node.id)?.[0]
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
    const workflowBefore = workflow.filter(before => { const after = workflowRef.current?.bounds(true).find(node => node.id === before.id); return after && (before.x !== after.x || before.y !== after.y); });
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
    pushCanvasUndo({ kind: "geometry", projectId: draft.id, materials: materialBefore, graph: graphBefore, workflow: workflowBefore });
  }

  function undoCanvasAction() {
    if (undoInFlightRef.current) return false;
    flushDocumentCard();
    const entry = undoHistoryRef.current[undoHistoryRef.current.length - 1];
    if (!entry || entry.projectId !== activeCanvasRef.current.id) return false;
    undoInFlightRef.current = true;
    void applyCanvasUndo(entry).catch(error => notifyError(error, "画板撤销未完成")).finally(() => {
      undoInFlightRef.current = false;
    });
    return true;
  }

  async function applyCanvasUndo(entry: CanvasUndoEntry) {
    if (entry.kind === "gallery") {
      await api.undoGenerationGalleryMerge(entry.edit).then(() => {
        const history = undoHistoryRef.current;
        const index = history.indexOf(entry);
        if (index >= 0) {
          history.splice(index, 1);
          setCanUndo(history.length > 0);
        }
      }).catch(error => notifyError(error, "合组撤销未完成"));
      return;
    }
    if (entry.kind === "names") {
      const controller = canvasWorkflowController(entry.projectId);
      const cardNames = { ...controller.document.cardNames };
      for (const [id, name] of Object.entries(entry.before)) {
        if (name === undefined) delete cardNames[id]; else cardNames[id] = name;
      }
      popCanvasUndo();
      await controller.save({ ...controller.document, cardNames }).catch(error => notifyError(error, "名称撤销未完成"));
      return;
    }
    if (entry.kind === "content") {
      const controller = canvasWorkflowController(entry.projectId);
      if (controller.isLocked(entry.before.id)) return;
      const live = graphNodesRef.current.find(node => node.id === entry.before.id && node.hiddenAt == null);
      if (!live) return;
      popCanvasUndo();
      const restored = { ...live, payloadJson: restoreCanvasNoteEdit(live.payloadJson, entry.before.payloadJson, entry.after.payloadJson),
        width: live.width === entry.after.width ? entry.before.width : live.width,
        height: live.height === entry.after.height ? entry.before.height : live.height };
      graphNodesRef.current = graphNodesRef.current.map(node => node.id === live.id ? restored : node);
      setGraphNodes(graphNodesRef.current);
      await enqueueWrite(async () => {
        await api.projectCanvasNoteUpdate(restored.id, restored.payloadJson);
        await api.projectCanvasNodeUpdate(restored.id, { x: restored.x, y: restored.y, width: restored.width, height: restored.height, zIndex: restored.zIndex, positionLocked: restored.positionLocked });
        for (const node of entry.restoredMaterials ?? []) await api.projectCanvasNodeRestore(entry.projectId, node.id);
        if (entry.restoredMaterials?.length) await refreshClipboardCanvas(entry.projectId);
      });
      return;
    }
    if (entry.kind === "materials") {
      popCanvasUndo();
      const affected = new Set([...entry.before, ...entry.after].map(node => node.id));
      commitNodes([...nodesRef.current.filter(node => !affected.has(node.id)), ...entry.before]);
      await enqueueWrite(async () => {
        for (const node of entry.after) if (node.kind === "folder") {
          await api.projectCanvasGroupDelete(node.id); groupsRef.current.delete(node.id);
        }
        const assetNodes = entry.before.flatMap(node => node.kind === "asset" ? [node] : node.assets.map((asset, i) => groupedAssetNode(asset, node, i)));
        const retained = new Set(assetNodes.map(node => node.id));
        for (const node of entry.after) for (const id of node.kind === "asset" ? [node.id] : node.assets.map(asset => asset.id)) {
          if (!retained.has(id)) await api.projectCanvasNodeRemove(id);
        }
        if (assetNodes.length) {
          await api.projectCanvasNodesBatchUpdate(entry.projectId, assetNodes.map(node => ({ nodeId: node.id, value: projectCanvasNodeLayoutUpdate(node) })));
        }
        for (const node of entry.before) if (node.kind === "folder") {
          const original = entry.groups.get(node.id);
          const group = await api.projectCanvasGroupCreate(original ? projectCanvasGroupUpdate(original, node) : newProjectCanvasGroup(entry.projectId, node), node.assets.map(asset => asset.id));
          groupsRef.current.set(node.id, group);
        }
      });
      return;
    }
    if (entry.kind === "workflow") {
      const controller = canvasWorkflowController(entry.projectId);
      if (controller.error) { notify("请先重试保存工作流，再撤销卡片操作", "info"); return; }
      const before = controller.document;
      const restored = restoreWorkflowEdit(before.nodes, entry.edit);
      const pending = controller.edit(restored, entry.edit);
      if (controller.document !== before) popCanvasUndo();
      await pending.catch(error => notifyError(error, "工作流撤销未完成"));
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
      popCanvasUndo();
      await enqueueWrite(async () => {
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
    let workflowUndo: Promise<void> | undefined;
    if (entry.kind === "removal" && entry.workflow) {
      const controller = canvasWorkflowController(entry.projectId);
      if (controller.error) { notify("请先重试保存工作流，再撤销卡片操作", "info"); return; }
      const before = controller.document;
      const pending = controller.edit(restoreWorkflowEdit(before.nodes, entry.workflow), entry.workflow);
      workflowUndo = pending.then(() => {}, error => { notifyError(error, "工作流撤销未完成"); });
      if (controller.document === before) return workflowUndo;
    }
    popCanvasUndo();
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
      persistGeometries(nodesRef.current.filter(node => materialBefore.has(node.id)),
        next.filter(node => node.kind !== "asset" && graphBefore.has(node.id)));
      // 分区几何恢复后按还原范围重新圈定成员；等 DOM 提交后再取实际显示尺寸。
      window.requestAnimationFrame(() => {
        if (activeCanvasRef.current.id !== entry.projectId) return;
        for (const node of graphNodesRef.current) {
          if (node.kind !== "note" || node.hiddenAt != null || !graphBefore.has(node.id)) continue;
          const value = readCanvasNote(node);
          if (value.note_type === "section" && !value.workflow_container && !value.artboard) updateCanvasNote(node.id, { ...value, member_ids: claimSectionMembers(node, node.id) }, undefined, "layout");
        }
      });
      await writeQueueRef.current;
      if (entry.workflow.length) await canvasWorkflowController(entry.projectId).flush();
      return;
    }
    const ids = new Set(entry.graph.map((node) => node.id));
    const currentIds = new Set(nodesRef.current.map((node) => node.id));
    const folders = new Map(entry.changedFolders?.map(folder => [folder.id, folder]));
    commitNodes([...nodesRef.current.map(node => folders.get(node.id) ?? node), ...entry.materials.filter((node) => !currentIds.has(node.id))]);
    const graphIds = new Set(graphNodesRef.current.map((node) => node.id));
    const next = [...graphNodesRef.current.map((node) => ids.has(node.id) ? { ...node, hiddenAt: null } : node),
      ...entry.graph.filter((node) => !graphIds.has(node.id))];
    graphNodesRef.current = next;
    setGraphNodes(next);
    const draft = activeCanvasRef.current;
    await enqueueWrite(async () => {
      await ensureMaterialized(draft);
      const restored = new Set<string>();
      for (const original of entry.graph) {
        if (!await api.projectCanvasNodeRestore(entry.projectId, original.id)) {
          const { hiddenAt: _hidden, createdAt: _created, updatedAt: _updated, ...input } = original;
          await api.projectCanvasNodeCreate(input);
        }
        restored.add(original.id);
      }
      for (const folder of folders.values()) await api.projectCanvasGroupSetItems(folder.id, folder.assets.map(asset => asset.id));
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
    await workflowUndo;
  }

  const undoGenerationConnection = useLatestCallback((nodeId: string) => {
    const entry = undoHistoryRef.current[undoHistoryRef.current.length - 1];
    const route = useStore.getState();
    if (!entry || entry.kind !== "workflow" || entry.connectedGenerationId !== nodeId
      || entry.projectId !== activeCanvasRef.current.id || !isWorkspaceOperationCurrent(entry.projectId, route.activeProjectId, route.projectRoutePending)
      || workspaceRef.current?.closest("[inert]")
      || scopedInspectorOpen || viewModeRef.current !== "canvas" || nodeDragRef.current || graphNodeDragRef.current
      || document.querySelector('[data-context-owner], [role="dialog"][aria-modal="true"]')) return false;
    return undoCanvasAction();
  });

  function pushMaterialsUndo(before: CanvasNode[], after: CanvasNode[]) {
    const previous = new Map(before.map(node => [node.id, node])), next = new Map(after.map(node => [node.id, node]));
    const changed = new Set([...previous.keys(), ...next.keys()].filter(id => previous.get(id) !== next.get(id)
      && JSON.stringify(previous.get(id)) !== JSON.stringify(next.get(id))));
    if (changed.size) pushCanvasUndo({ kind: "materials", projectId: activeCanvasRef.current.id,
      before: before.filter(node => changed.has(node.id)), after: after.filter(node => changed.has(node.id)), groups: new Map(groupsRef.current) });
  }

  function ungroupFolder(id: string) {
    const folder = nodesRef.current.find(node => node.id === id);
    if (folder?.kind !== "folder") return;
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
    const next = [...nodesRef.current.filter((node) => node.id !== folder.id), ...restored];
    pushMaterialsUndo(nodesRef.current, next);
    commitNodes(next);
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
    const before = nodesRef.current;
    const next = translateCanvasSelection(
      nodesRef.current,
      selectedIds,
      snapped.x - node.x,
      snapped.y - node.y,
    );
    const workflowBefore = workflowRef.current?.bounds(true) ?? [];
    commitNodes(next);
    const moved = persistMovedWorkflowCards(selectedIds);
    pushGeometryUndo(before.filter(node => selectedIds.has(node.id)), [], workflowBefore.filter(node => moved.has(node.id)));
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
  const focusedThreadIsArchived = !!focusedThreadId && archivedThreadIds.has(focusedThreadId);
  const activeGraph = useMemo(
    () => projectGraphVisibility(shownGraph, graphEdges, archivedThreadIds),
    [archivedThreadIds, graphEdges, shownGraph],
  );
  const activeGraphNodes = activeGraph.nodes;
  const agentPromptGroups = useMemo(() => agentPromptGroupMap(graphNodes, graphEdges), [graphNodes, graphEdges]);
  const promptByAgentGroupId = useMemo(() => {
    const prompts = new Map<string, string>();
    for (const [promptId, group] of agentPromptGroups) if (!prompts.has(group.id)) prompts.set(group.id, promptId);
    return prompts;
  }, [agentPromptGroups]);
  const liveGraphNodes = useMemo(
    () => projectGraphNodesWithLiveLayout(activeGraphNodes.filter((node) => !agentPromptGroups.has(node.id) && !containedOutputIds.has(node.id) && !workflowHistoryIds.has(node.id) && !conversationCards.hiddenIds.has(node.id)), shownMaterials),
    [activeGraphNodes, agentPromptGroups, shownMaterials, containedOutputIds, workflowHistoryIds, conversationCards],
  );
  const graphNodeById = useMemo(
    () => new Map(liveGraphNodes.map((node) => [node.id, node])),
    [liveGraphNodes],
  );
  const visibleGraphNodeIds = useMemo(() => new Set(liveGraphNodes.map(node => node.id)), [liveGraphNodes]);
  useEffect(() => {
    const current = selectedCanvasNodeIdsRef.current;
    if (!current.size) return;
    const workflowIds = new Set(workflowNodes.map(node => node.id));
    const available = new Set([...visibleMaterials.map(node => node.id),
      ...liveGraphNodes.filter(node => node.hiddenAt == null && (node.kind === "note" || node.kind === "prompt" || node.kind === "agent_group") && !workflowIds.has(node.id)).map(node => node.id),
      ...workflowNodes.filter(node => node.kind !== "text").map(node => node.id)]);
    if ([...current].some(id => !available.has(id))) {
      setSelectedCanvasNodeIds(selection => new Set([...selection].filter(id => available.has(id))));
    }
  }, [visibleMaterials, liveGraphNodes, workflowNodes]);
  const supersededTaskIds = useMemo(
    () => supersededProjectTaskIds(activeGraph.nodes, activeGraph.edges),
    [activeGraph],
  );
  const promptGraphNodes = useMemo(
    () => activeGraphNodes.filter((node) => node.kind === "prompt" && node.hiddenAt == null && !agentPromptGroups.has(node.id) && !workflowHistoryIds.has(node.id) && !conversationCards.hiddenIds.has(node.id)),
    [activeGraphNodes, agentPromptGroups, workflowHistoryIds, conversationCards],
  );
  const sessionHeights = useMemo(() => new Map(promptGraphNodes.map(node => [node.id, nodeRect(node).height])),
    [promptGraphNodes, imageOnlyConversationIds, conversationImagesById, conversationImageSelection]);
  const agentGraphNodes = useMemo(
    () => activeGraphNodes.filter((node) => node.kind === "agent_group" && node.hiddenAt == null),
    [activeGraphNodes],
  );
  const chatGraphNodes = useMemo(() => activeGraphNodes.filter(node => node.hiddenAt == null && canvasChatId(node) && !workflowNodes.some(workflow => workflow.id === node.id)), [activeGraphNodes, workflowNodes]);
  const workflowSettled = currentWorkflowEntry !== null;
  const startEntryMount = useLatestCallback(() => {
    const mounted = entryCardIdsRef.current;
    if (!mounted || !projectId) return;
    const token = loadTokenRef.current;
    const stage = stageRef.current;
    const candidates = new Map([
      ...[...graphNodes.filter(node => node.kind === "note" && node.hiddenAt == null), ...promptGraphNodes, ...agentGraphNodes, ...chatGraphNodes]
        .map(node => ({ ...node, weight: ENTRY_HEAVY_CARD_WEIGHT })),
      ...visibleMaterials.map(node => ({ ...node,
        weight: node.kind === "asset" && !isVideoPath(node.asset.storePath) && !isAudioPath(node.asset.storePath) && !isTextPath(node.asset.storePath) ? 1 : ENTRY_HEAVY_CARD_WEIGHT })),
      ...workflowNodes.filter(node => node.kind !== "text").map(node => ({ ...node, width: workflowCardWidth(node), height: 330, weight: ENTRY_HEAVY_CARD_WEIGHT })),
    ].map(card => [card.id, card]));
    const wires: Array<[string, string]> = graphEdges.map(edge => [edge.fromNodeId, edge.toNodeId]);
    for (const node of workflowNodes) {
      const target = node.textTarget?.nodeId ?? node.textSource ?? node.id;
      for (const binding of Object.values(node.inputs).flat()) {
        const source = binding.canvasNodeId ?? binding.assetNodeId ?? binding.nodeId ?? binding.groupId;
        if (source) wires.push([source, target]);
      }
    }
    entryCandidates.current = new Set(candidates.keys());
    let committed = new Set(mounted);
    let remaining = new Set([...candidates.keys()].filter(id => !committed.has(id)));
    let nearby: string[] = [];
    let lastView: { x: number; y: number; zoom: number; width: number; height: number } | undefined;
    let initialViewReady = entryViewportReady;
    let expected: ReadonlySet<string> | null = mounted;
    let lastCommitted: ReadonlySet<string> | null = mounted;
    let active = true;
    let cancelBatch: (() => void) | undefined;
    let resume: number | undefined;
    let idle: number | undefined;
    let batchBudget = ENTRY_LIGHT_CARD_LIMIT;
    let batchStarted: number | undefined;
    let viewportBatchCommitted = mounted.size > 0;
    let width = stage?.clientWidth ?? 0;
    let height = stage?.clientHeight ?? 0;
    function priority(pan: CanvasPoint, zoom: number) {
      if (lastView?.x === pan.x && lastView.y === pan.y && lastView.zoom === zoom
        && lastView.width === width && lastView.height === height) return;
      lastView = { ...pan, zoom, width, height };
      const buffer = 200;
      const inView = new Set([...remaining].filter(id => {
        const card = candidates.get(id)!;
        return pan.x + card.x * zoom <= width + buffer && pan.x + (card.x + card.width) * zoom >= -buffer
          && pan.y + card.y * zoom <= height + buffer && pan.y + (card.y + card.height) * zoom >= -buffer;
      }));
      // A wire can cross the viewport even when its two cards are outside it.
      for (const [fromId, toId] of wires) {
        const from = candidates.get(fromId), to = candidates.get(toId);
        if (!from || !to || (!remaining.has(fromId) && !remaining.has(toId))) continue;
        const left = Math.min(from.x, to.x), right = Math.max(from.x + from.width, to.x + to.width);
        const bend = Math.max(50, (right - left) * .45);
        if (pan.x + (left - bend) * zoom > width + buffer || pan.x + (right + bend) * zoom < -buffer
          || pan.y + Math.min(from.y, to.y) * zoom > height + buffer
          || pan.y + Math.max(from.y + from.height, to.y + to.height) * zoom < -buffer) continue;
        if (remaining.has(fromId)) inView.add(fromId);
        if (remaining.has(toId)) inView.add(toId);
      }
      const distanceToViewportStart = (id: string) => {
        const card = candidates.get(id)!;
        const x = pan.x + card.x * zoom, y = pan.y + card.y * zoom;
        const intersects = x <= width && x + card.width * zoom >= 0 && y <= height && y + card.height * zoom >= 0;
        return (intersects ? 0 : width + height) + Math.max(0, x) + Math.max(0, y);
      };
      nearby = [...inView].sort((a, b) => distanceToViewportStart(a) - distanceToViewportStart(b));
      if (nearby.length && (resume !== undefined || idle !== undefined)) {
        window.clearTimeout(resume);
        resume = undefined;
        if (idle !== undefined) window.cancelIdleCallback(idle);
        idle = undefined;
        cancelBatch?.();
        cancelBatch = afterCanvasPaint(mountBatch);
      }
    }
    function scheduleBatch() {
      if (initialViewReady && nearby.length === 0) {
        // Offscreen cards can wait until input has settled and the browser is idle.
        resume = window.setTimeout(() => {
          resume = undefined;
          if (typeof window.requestIdleCallback !== "function") { mountBatch(); return; }
          idle = window.requestIdleCallback(() => { idle = undefined; mountBatch(); }, { timeout: 250 });
        }, 100);
      } else cancelBatch = afterCanvasPaint(mountBatch);
    }
    function mountBatch() {
      const route = useStore.getState();
      if (!active || loadTokenRef.current !== token || route.projectRoutePending
        || route.activeProjectId !== projectId || route.projectRouteRevision !== projectRouteRevision) return;
      const current = entryCardIdsRef.current;
      if (current !== expected) {
        if (current === lastCommitted) {
          scheduleBatch();
          return;
        }
        if (!current) return;
        // Workflow readiness can restart the scheduler while the preceding
        // transition is already committing. Continue from the painted set.
        expected = current;
        committed = new Set(current);
        remaining = new Set([...candidates.keys()].filter(id => !committed.has(id)));
        batchStarted = undefined;
        lastView = undefined;
        priority(panRef.current, zoomRef.current);
      }
      lastCommitted = current;
      if (initialViewReady && (nodeDragRef.current || graphNodeDragRef.current || panDragRef.current)) {
        scheduleBatch();
        return;
      }
      if (initialViewReady && !nearby.length && performance.now() - inputDuringEntry.current < 650) {
        scheduleBatch();
        return;
      }
      if (batchStarted !== undefined) {
        viewportBatchCommitted = true;
        const elapsed = entryCommitAt.current - batchStarted;
        if (elapsed > ENTRY_FRAME_BUDGET_MS) batchBudget = Math.max(ENTRY_MIN_BATCH_WEIGHT, Math.floor(batchBudget * .75));
        else if (elapsed < ENTRY_FRAME_BUDGET_MS / 2) batchBudget = Math.min(ENTRY_LIGHT_CARD_LIMIT, batchBudget + ENTRY_HEAVY_CARD_WEIGHT);
        batchStarted = undefined;
      }
      const ids: string[] = [];
      let weight = 0;
      const prioritized = nearby.length > 0;
      for (const id of prioritized ? nearby : initialViewReady ? remaining : []) {
        const cost = candidates.get(id)!.weight;
        if (ids.length > 0 && weight + cost > batchBudget) break;
        ids.push(id);
        weight += cost;
      }
      if (prioritized) nearby.splice(0, ids.length);
      for (const id of ids) { committed.add(id); remaining.delete(id); }
      // The first viewport batch makes the shell interactive. Neighboring
      // cards and their wires continue to mount before the offscreen queue.
      const ready = !initialViewReady && (viewportBatchCommitted || nearby.length === 0);
      const done = workflowSettled && remaining.size === 0;
      if (ready) {
        initialViewReady = true;
        inputDuringEntry.current = performance.now();
      }
      const next = done ? null : ids.length ? new Set(committed) : expected;
      if (ids.length) batchStarted = performance.now();
      expected = next;
      // The paint scheduler already yields between small commits. A transition
      // here can keep a background batch pending behind live workspace updates.
      if (ready || done) setEntryViewportReady(previous => active ? true : previous);
      if (next !== current) setEntryCardIds(previous => active && previous === current ? next : previous);
      if (done) {
        prioritizeEntry.current = undefined;
        resize.disconnect();
      } else if (remaining.size && (initialViewReady || nearby.length)) scheduleBatch();
    }
    prioritizeEntry.current = priority;
    const resize = new ResizeObserver(([entry]) => {
      width = entry.contentRect.width;
      height = entry.contentRect.height;
      priority(panRef.current, zoomRef.current);
    });
    if (stage) resize.observe(stage);
    priority(panRef.current, zoomRef.current);
    cancelBatch = afterCanvasPaint(mountBatch);
    return () => {
      active = false;
      prioritizeEntry.current = undefined;
      resize.disconnect();
      cancelBatch?.();
      window.clearTimeout(resume);
      if (idle !== undefined) window.cancelIdleCallback(idle);
    };
  });
  useEffect(() => {
    if (loading || loadFailed || projectRoutePending) return;
    return startEntryMount();
  }, [loading, loadFailed, projectId, projectRouteRevision, projectRoutePending, startEntryMount, workflowSettled]);
  const deferredCandidateIds = entryCandidates.current;
  const cardMounted = (id: string) => entryCardIds === null || entryCardIds.has(id) || (!!deferredCandidateIds && !deferredCandidateIds.has(id));
  const entryCardContext = useMemo(() => ({}), [graphNodes, visibleMaterials, workflowInteractive, genJobs]);
  const lookupPromptReferences = useMemo(() => canvasPromptReferenceLookup(shownGraph, graphEdges), [shownGraph, graphEdges]);
  const promptReferences = useMemo(() => {
    const cache = new Map<string, ReturnType<typeof lookupPromptReferences>>();
    return (node: ProjectGraphNode) => {
      if (node.hiddenAt != null) return [];
      const cached = cache.get(node.id);
      if (cached) return cached;
      const references = lookupPromptReferences(node.id, assetById).filter(asset => !hideCanvasOriginal(asset.id, asset.store_path));
      cache.set(node.id, references);
      return references;
    };
  }, [lookupPromptReferences, assetById, hideCanvasOriginal, pendingOriginals]);
  // ReadonlyPrompt creates its content in an effect; measure after it has mounted.
  useEffect(() => {
    const nodeId = pendingNewCards[0];
    if (!nodeId || opening || projectRoutePending || panning || activeDragId) return;
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
      const repositioned = moved.x !== target.x || moved.y !== target.y ? [moved, ...references] : references;
      persistGeometries([], repositioned);
      for (const reference of references) {
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
  }, [pendingNewCards, promptGraphNodes, agentGraphNodes, opening, projectRoutePending, panning, activeDragId, viewMode, scopedInspectorOpen]);
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
  function openWorkflowGeneration(node: ProjectGraphNode, focusId = node.id) {
    focusGraphNode(focusId);
    const { jobId, turnKey, status } = promptNodeSummary(node);
    const job = useStore.getState().genJobs[jobId];
    const latest = job?.turns[job.turns.length - 1];
    if (job && (status !== "failed" || (latest?.turnKey === turnKey && latest.error))) {
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
  const materialByNodeOrAssetId = useMemo(() => {
    const index = new Map<string, CanvasNode>();
    for (const node of nodes) {
      const ids = node.kind === "asset" ? [node.id, node.asset.id] : [node.id, ...node.assets.map(asset => asset.id)];
      for (const id of ids) if (!index.has(id)) index.set(id, node);
    }
    return index;
  }, [nodes]);
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
        ? projectGraphVisibility(shownGraph, graphEdges, archivedThreadIds, focusedThreadId)
        : activeGraph;
      return projectTimelineProjection(visible.nodes, visible.edges, timelineScope, focusedThreadId);
    },
    [activeGraph, archivedThreadIds, focusedThreadId, focusedThreadIsArchived, graphEdges, shownGraph, timelineScope],
  );
  const timelineNodes = timelineProjection.nodes;
  const timelineEdges = timelineProjection.edges;

  const workflowMaterials = useMemo(() => visibleMaterials.flatMap<MaterialAnchor>(node => node.kind === "folder"
    ? [{ id: node.id, groupId: node.id, assetIds: [...new Set(node.assets.filter(asset => !isVideoPath(asset.storePath) && !isAudioPath(asset.storePath)).flatMap(asset => asset.assetId ? [asset.assetId] : []))], mediaAssetIds: [...new Set(node.assets.flatMap(asset => asset.assetId ? [asset.assetId] : []))], ...nodeRect(node) }]
    : node.kind === "asset" && node.asset.assetId ? [{ id: node.id, assetId: node.asset.assetId, video: isVideoPath(node.asset.storePath), audio: isAudioPath(node.asset.storePath), ...nodeRect(node) }] : []),
  [visibleMaterials, expandedFolderIds, showAssetNames]);
  const materialSelection = useMemo(() => {
    if (selectedCanvasNodeIds.size < 2) return null;
    const members = [
      ...workflowMaterials.filter(item => selectedCanvasNodeIds.has(item.id)),
      ...promptGraphNodes.filter(node => selectedCanvasNodeIds.has(node.id) && imageOnlyConversationIds.has(node.id))
        .map(node => ({ id: node.id, x: node.x, y: node.y, width: node.width, height: sessionHeights.get(node.id) ?? node.height })),
    ];
    if (members.length < 2) return null;
    members.sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
    const left = Math.min(...members.map(item => item.x)), top = Math.min(...members.map(item => item.y));
    const width = Math.max(...members.map(item => item.x + item.width)) - left;
    const height = Math.max(...members.map(item => item.y + item.height)) - top;
    return { ids: members.map(item => item.id), left, top, width, height };
  }, [selectedCanvasNodeIds, workflowMaterials, promptGraphNodes, imageOnlyConversationIds, sessionHeights]);
  type WorkflowProps = ComponentProps<typeof CanvasWorkflowLayer>;
  const workflowOnSelect = useLatestCallback<Parameters<WorkflowProps["onSelect"]>, void>((id, additive) => {
    if (additive) toggleCanvasNodeSelection(id); else setSelectedCanvasNodeIds(new Set([id]));
  });
  const workflowOnNodesChanged = useCallback(() => setWorkflowRevision(value => value + 1), []);
  const workflowOnEdited = useLatestCallback<Parameters<WorkflowProps["onEdited"]>, void>((before, after, connectedGenerationId) => {
    if (activeCanvasRef.current.id !== projectId) return;
    const edit = workflowEditUndo(before, after);
    if (edit) pushCanvasUndo({ kind: "workflow", projectId, edit, connectedGenerationId });
    else {
      const changed = Object.keys(after.cardNames ?? {}).filter(id => before.cardNames?.[id] !== after.cardNames?.[id]);
      if (changed.length) pushCanvasUndo({ kind: "names", projectId, before: Object.fromEntries(changed.map(id => [id, before.cardNames?.[id]])) });
    }
  });
  const workflowOnOpenAgent = useLatestCallback((nodeId: string, conversationId?: string, entryKey?: string, applyPrompt?: (text: string) => Promise<void>) => {
    setH3ChatEditor(projectId && conversationId && applyPrompt ? { projectId, chatId: conversationId, apply: applyPrompt } : null);
    if (conversationId) { openLocalChat(conversationId); return; }
    const chat = !entryKey && Object.values(useLocalChatStore.getState().summaries).find(chat => chat.projectId === projectId && chat.nodeId === nodeId);
    if (chat) openLocalChat(chat.id);
    else { setGenPanelOpen(false); setWorkflowAgentDetail({ projectId: projectId!, nodeId, entryKey }); }
  });
  const workflowOnOpenGeneration = useLatestCallback(openWorkflowGeneration);
  const workflowOnNewAgentChat = useCallback((previousId: string) => {
    setSelectedChatId(current => current === previousId ? null : current);
  }, []);
  const workflowOnDragStart = useLatestCallback(beginGraphNodeDrag);
  const workflowOnDragMove = useLatestCallback(moveGraphNode);
  const workflowOnDragEnd = useLatestCallback(endGraphNodeDrag);
  const workflowOnNodeMenu = useLatestCallback(openCanvasNodeMenu);
  const workflowOnRemove = useLatestCallback((id: string) => removeNodes(selectedCanvasNodeIdsRef.current.has(id) ? selectedCanvasNodeIdsRef.current : [id]));
  const workflowOnPlaced = useLatestCallback((card: CanvasRect) => {
    const stage = stageRef.current; if (!stage || useStore.getState().activeProjectId !== projectId) return;
    const bounds = stage.getBoundingClientRect();
    const next = canvasViewForNewCard(card, { x: 80, y: 60, width: Math.max(200, bounds.width - 120), height: Math.max(200, bounds.height - 270) }, panRef.current, zoomRef.current, true);
    if (!next) return;
    panRef.current = next.pan; zoomRef.current = next.zoom; setPan(next.pan); setZoom(next.zoom); markViewDirty();
  });
  const workflowEnsureMaterialized = useLatestCallback(async () => {
    const draft = activeCanvasRef.current; if (!draft) throw new Error("项目尚未就绪");
    await ensureMaterialized(draft); await flushCanvasWrites(false);
  });

  const { gesture: creationImage, preview: creationImagePreview } = useCreationImageInteraction({
    root: workspaceRef, enabled: !loading && !loadFailed, scope: `${projectId}:${viewMode}`,
    resolve: creationImageTarget, onCapture: cancelConversationImageClick,
    onCanvasVideoPreview: (path, media, asset) => {
      if (!stageRef.current?.contains(media)) return false;
      const canvasNodeId = creationImageTarget(media)?.canvasNodeId;
      setCanvasLightbox({ images: [path], assetIds: [asset.id], canvasNodeId, index: 0 });
      return true;
    },
  });
  const previewOpenedId = creationImagePreview?.canvasNodeId;
  const previewAnchorId = previewOpenedId ? conversationCards.aliases.get(previewOpenedId) ?? previewOpenedId : undefined;
  const previewGallery = previewAnchorId ? conversationImages(previewAnchorId) : [];
  const selectedPreviewMember = previewMember && previewMember.openedId === previewOpenedId
    ? previewGallery.find(image => image.id === previewMember.nodeId) : undefined;
  const previewMaterial = previewOpenedId ? shownMaterials.find(node => node.id === previewOpenedId) : undefined;
  const currentPreviewImage = selectedPreviewMember ?? previewGallery.find(image => image.id === previewOpenedId)
    ?? (previewMaterial?.kind === "asset" ? previewMaterial.asset : undefined);
  const currentPreviewAsset = (currentPreviewImage && previewAsset(currentPreviewImage)) ?? creationImagePreview?.asset;
  const currentPreviewOrigin = currentPreviewImage && generationOrigin(currentPreviewImage.id);
  const previewIndex = currentPreviewImage ? previewGallery.findIndex(image => image.id === currentPreviewImage.id) : -1;
  function closeCreationPreview() { setPreviewMember(null); creationImage.close(); }
  const lightboxPath = canvasLightbox?.images[canvasLightbox.index];
  const lightboxAssetId = canvasLightbox?.assetIds?.[canvasLightbox.index];
  const lightboxMedia = lightboxPath && (isVideoPath(lightboxPath) || isAudioPath(lightboxPath))
    ? (lightboxAssetId ? assetById.get(lightboxAssetId) : [...assetById.values()].find(asset => asset.store_path === lightboxPath))
    : undefined;
  const lightboxVideo = isVideoPath(lightboxPath) ? lightboxMedia : undefined;
  const lightboxAudio = isAudioPath(lightboxPath) ? lightboxMedia : undefined;
  const lightboxVideoJob = lightboxVideo && lightboxPath
    ? Object.values(genJobs).find(job => job.turns.some(turn => turn.images.includes(lightboxPath)))
    : undefined;
  const lightboxOrigin = canvasLightbox?.canvasNodeId ? generationOrigin(canvasLightbox.canvasNodeId) : undefined;

  const editingCardContext = useMemo(() => ({}), [
    entryCardContext, activeDragId, assetById, boardOpen, captionedIds, chatSummaries, cloudAgentRuns, concealedNodeIds,
    conversationCards, conversationImageSelection, conversationImagesById, dismissed, drawingTool, expandedFolderIds,
    focusedNodeId, folderDropTargetId, genEditing, generationActivities, generationCardProjection, graphEdges, hoverReady, hoverTargetId,
    imageOnlyConversationIds, layerWorkspaceIds, lookupPromptReferences, mediaFilter, nodes, pan, pinnedWorkflowCards, projectId,
    quickRevision, selectedCanvasNodeIds, showAssetNames, smartFilter, supersededTaskIds, workflowForegroundZ, workflowRevision, writerFailureKeys, zoom,
  ]);
  const stagedCardContext = useCanvasEntryCardContext(entryCardContext, opening, editingCardContext);

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

  function frequentPickTarget(target: EventTarget | null) {
    if (!frequentPickingRef.current || loadingRef.current || useStore.getState().projectRoutePending
      || useStore.getState().activeProjectId !== projectId || !(target instanceof Element)
      || !workspaceRef.current?.contains(target) || target.closest('[inert], [role="dialog"], [role="menu"]')) return null;
    const material = target.closest<HTMLElement>('[data-frequent-asset-id], [data-asset-id], [data-file-path]');
    if (!material || !(sourcePanelRef.current?.contains(material) || stageRef.current?.contains(material))) return null;
    const control = target.closest('button, input, textarea, select, a, [contenteditable="true"]');
    if (control && control !== material) return null;
    const assetId = material.dataset.frequentAssetId ?? material.dataset.assetId, path = material.dataset.filePath;
    return assetId || path ? { assetId, path } : null;
  }
  function captureFrequentMaterial(event: SyntheticEvent) {
    const material = frequentPickTarget(event.target);
    if (material) { event.preventDefault(); event.stopPropagation(); }
    return material;
  }
  async function pinFrequentMaterial(material: { assetId?: string; path?: string }) {
    let assetId = material.assetId;
    if (!assetId && material.path) {
      try { assetId = (await externalFiles.index(material.path)).id; }
      catch (error) { notifyError(error, "无法添加此素材，请重试。"); return; }
      if (useStore.getState().activeProjectId !== projectId) return;
    }
    if (assetId) await frequentLibrary.pinAsset(assetId);
  }

  function creationImageTarget(media: HTMLElement) {
    const state = useStore.getState();
    if (frequentPickingRef.current || loadingRef.current) return null;
    const onCanvas = !!stageRef.current?.contains(media);
    if (onCanvas && (spacePressedRef.current || drawingTool !== "select")) return null;
    if (!onCanvas && (state.mode === "manage" || state.collectionAddTargetId)) return null;
    const nodeId = media.closest<HTMLElement>('[data-canvas-node-id]')?.dataset.canvasNodeId;
    const anchor = nodesRef.current.find(item => item.id === nodeId);
    const node = anchor && displayedMaterial(anchor);
    const assetId = creationImageAssetId(media);
    const material = node?.kind === "asset" ? node.asset : node?.kind === "folder"
      ? node.assets.find(item => media.dataset.canvasFolderAssetId ? item.id === media.dataset.canvasFolderAssetId : item.assetId === assetId)
      : nodeId ? selectedConversationImage(nodeId, conversationImages(nodeId)) : undefined;
    // Cell media shares the image gesture without binding the parent table as an image.
    if (onCanvas && media.closest("[data-canvas-cell]") && assetId) return { assetId, asset: assetByIdRef.current.get(assetId) };
    if (onCanvas && !material) return null;
    const asset = assetByIdRef.current.get(assetId ?? material?.assetId ?? "") ?? (material ? {
      id: material.assetId ?? material.id, name: material.name, store_path: material.storePath,
      thumb_path: material.thumbPath, width: material.width, height: material.height,
    } : undefined);
    const id = asset?.id ?? assetId;
    return id ? { assetId: id, asset, canvasNodeId: onCanvas ? material?.id : undefined,
      suppressClick: onCanvas && suppressNodeClickRef.current } : null;
  }

  return (
    <div
      ref={workspaceRef}
      data-onboarding-project={projectId ?? undefined}
      className={`canvas-workspace canvas-tactical${sourceCollapsed ? " is-source-collapsed" : " is-library-open"}${libraryDragging ? " is-library-dragging" : ""}${frequentPicking ? " is-picking-frequent" : ""}${projectRoutePending ? " is-route-pending" : ""}`}
      aria-busy={opening || projectRoutePending}
      onWheelCapture={entryCardIds === null ? undefined : () => { inputDuringEntry.current = performance.now(); }}
      onFocusCapture={opening ? event => {
        const status = openingStatus.current;
        if (status && event.target !== status) status.focus({ preventScroll: true });
      } : undefined}
      onPointerDownCapture={event => {
        if (entryCardIds !== null) inputDuringEntry.current = performance.now();
        creationImage.pointerDown(event);
        if (event.button === 0 && !isCanvasPanGesture(event.button, spacePressedRef.current, drawingTool === "pan")) captureFrequentMaterial(event);
      }}
      onPointerMoveCapture={creationImage.pointerMove}
      onClickCapture={event => {
        if (event.button !== 0) return;
        if (spacePressedRef.current || drawingTool === "pan") { creationImage.click(event); return; }
        const material = captureFrequentMaterial(event);
        if (material && event.detail < 2) void pinFrequentMaterial(material);
        if (!material) creationImage.click(event);
      }}
      onDoubleClickCapture={event => { if (!captureFrequentMaterial(event)) creationImage.click(event, true); }}
      onDragStartCapture={event => { creationImage.cancel(); captureFrequentMaterial(event); }}
      onContextMenuCapture={event => { creationImage.cancel(); captureFrequentMaterial(event); }}
      onKeyDownCapture={event => {
        if (entryCardIds !== null) inputDuringEntry.current = performance.now();
        if (creationImage.keyDown(event)) return;
        if (!["Enter", " ", "Delete", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
        const material = captureFrequentMaterial(event);
        if (material && !event.repeat && (event.key === "Enter" || event.key === " ")) void pinFrequentMaterial(material);
      }}
    >
      <aside ref={sourcePanelRef} id={sourcePanelId} className="canvas-source-panel library-browser" aria-label="画板素材库"
        data-file-import-project-id={browseProjectId ?? ""}
        aria-hidden={sourceCollapsed} tabIndex={-1} onDragStart={event => {
          if (!(event.target as HTMLElement).closest('[data-asset-id]') || !getDragAssets()?.length) return;
          clearTimeout(peekIntent.current);
          libraryDragActive.current = true;
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
          {(sourceCatalogVisited || !sourceCollapsed) && <LibraryCatalog key={projectId} media={libraryMedia} projectId={projectId} semanticSearchEnabled={!sourceCollapsed}
            onClose={closeSource} onAssetsChange={setCatalogAssets}/>}
        </div>
        <CanvasFrequentAssets library={frequentLibrary} projectId={projectId} picking={frequentPicking} onPickingChange={setFrequentPicking}/>
      </aside>
      <CanvasLibraryResize panelId={sourcePanelId} collapsed={sourceCollapsed} onClose={closeSource} />
      {frequentPicking && <div className="canvas-frequent-pick-banner" role="status">
        <div><strong>正在添加常用素材</strong><span>点击素材库或画板中的素材，可连续添加</span></div>
        <button type="button" onClick={() => setFrequentPicking(false)}>完成添加</button>
      </div>}

      <section ref={boardShellRef} className={`canvas-board-shell${(selectedChatId || scopedInspectorOpen && !inspectorEditing || workflowAgentDetail?.projectId === projectId && !loading && !genPanelOpen) ? " has-project-inspector" : ""}`}>
        {opening && <div ref={openingStatus} className="canvas-opening" role="status" tabIndex={-1} onKeyDown={event => {
          if (event.key === "Escape" && onExit) { event.stopPropagation(); onExit(); }
        }}><LoaderCircle aria-hidden="true" size={18} />正在打开项目</div>}
        <button
          type="button"
          className={`canvas-source-toggle ${sourceCollapsed ? "canvas-source-expand" : "canvas-source-collapse"}`}
          aria-label={sourceCollapsed ? "展开画板素材库" : "收起画板素材库"}
          title={sourceCollapsed ? "展开素材库" : "收起素材库"}
          aria-expanded={!sourceCollapsed}
          aria-controls={`${sourcePanelId}-content`}
          onClick={() => {
            if (sourceCollapsed) openLibrary();
            setSourceCollapsed(!sourceCollapsed);
            if (sourceCollapsed) beginOnboardingOperation("expand-source", projectId)();
          }}
        >{sourceCollapsed ? <PanelLeftOpen size={16} aria-hidden="true" /> : <PanelLeftClose size={16} aria-hidden="true" />}</button>
        {(boardOpen || genEditing) && <CreationModeIndicator className="canvas-creation-mode-indicator"/>}
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
                onCompositionStart={titleIme.onCompositionStart}
                onCompositionEnd={titleIme.onCompositionEnd}
                onKeyDown={(event) => {
                  if (titleIme.isComposing(event.nativeEvent)) { event.stopPropagation(); return; }
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
            <small className={`canvas-save-state${!opening && savingVisible ? " is-visible" : ""}`} aria-hidden={opening || !savingVisible}>
              <LoaderCircle size={12} /> 保存中
            </small>
            {!loading && currentWorkflowEntry?.error !== null && (currentWorkflowEntry?.error
              ? <small className="canvas-save-error" role="alert">工作流加载失败
                  <button type="button" className="ml-2 underline" onClick={currentWorkflowEntry.retry}>{workflow?.ready && workflow.error ? "重试保存工作流" : "重新加载工作流"}</button></small>
              : <small className="canvas-save-state is-visible" role="status">正在加载工作流…</small>)}
            {error && <small className="canvas-save-error" title={userErrorMessage(error, "画板未能保存，请重试保存。")}>保存失败，修改仍保留在当前画面
              {writeJournalRef.current.failure != null && <button type="button" className="ml-2 underline" onClick={() => { void retryPendingWrites().catch(error => notifyError(error, "画板保存失败")); }}>重试保存画板</button>}
            </small>}
          </div>
          <div className="canvas-zoom-controls" aria-label="画布缩放">
            {viewMode === "timeline" && threads.length > 0 && (
              <TacticalSelect
                aria-label="时间线范围"
                value={timelineScope === "all" ? "__all" : focusedThreadId ?? "__all"}
                onValueChange={(value) => {
                  if (value === "__all") {
                    setProjectTimelineScope("all");
                  } else {
                    setFocusedThreadId(value);
                    setProjectTimelineScope("focused");
                    useStore.getState().clearProjectThreadUnread(activeCanvas.id, value);
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
              </TacticalSelect>
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
            <span ref={zoomLabelRef}>{Math.round(zoomRef.current * 100)}%</span>
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
          data-overlay-scrollbars-suspended={opening || activeDragId ? "" : undefined}
          className={`canvas-stage ${drawingTool !== "select" && drawingTool !== "pan" ? "is-drawing" : ""} ${drawingTool === "pan" ? "is-hand" : ""} ${externalDragOver ? "is-drag-over" : ""} ${spacePanReady ? "is-pan-ready" : ""} ${panning ? "is-panning" : ""} ${boardOpen || genEditing ? "is-creation-mode" : ""} ${viewMode !== "canvas" ? "is-view-hidden" : ""}`}
          style={{
            backgroundPosition: `${panRef.current.x}px ${panRef.current.y}px`,
            backgroundSize: `${72 * zoomRef.current}px ${72 * zoomRef.current}px`,
          }}
          onPointerDownCapture={event => {
            if (editorCenterFrameRef.current != null) settleCamera();
            cameraFrame.flush();
            // Stage pointer capture can retarget clicks from a wire or a marquee to the background.
            if (event.target === event.currentTarget && event.button === 0
              && drawingTool === "select" && !spacePressedRef.current && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
              blankPressCount.current++;
            } else blankPressCount.current = 0;
            if (event.button === 0 && !(event.target as HTMLElement).closest('button,input,textarea,select,[contenteditable="true"]')) {
              lastImportPointRef.current = { projectId: activeCanvasRef.current.id, x: event.clientX, y: event.clientY };
            }
            beginDrawing(event);
          }}
          onPointerDown={beginPan}
          onClickCapture={centerCanvasEditor}
          onDoubleClick={event => {
            if (blankPressCount.current < 2 || event.defaultPrevented || drawingTool !== "select" || spacePressedRef.current
              || loadingRef.current || useStore.getState().projectRoutePending
              || event.target !== event.currentTarget) return;
            blankPressCount.current = 0;
            const point = toBoardPoint(event.clientX, event.clientY);
            if (sectionUnderPoint(point)) return;
            // Some displayed wires deliberately pass pointer events through to the stage.
            const wires = event.currentTarget.querySelectorAll<SVGPathElement>(".canvas-graph-edges path,.workflow-wires path");
            if (Array.from(wires).some(wire => wire.isPointInStroke(point))) return;
            workflowRef.current?.openCardMenu(event.clientX, event.clientY, point);
          }}
          onBlurCapture={event => {
            if (editorCenterFrameRef.current != null) settleCamera();
            if (centeredEditorRef.current?.contains(event.target as Node)) centeredEditorRef.current = null;
          }}
          onWheelCapture={() => { if (editorCenterFrameRef.current != null) settleCamera(); }}
          onKeyDown={(event) => {
            // Mac's backward Delete reports Backspace; also support forward Delete keyboards.
            const deleteKey = event.key === "Delete" && !event.metaKey;
            const macDeleteKey = /Mac/i.test(navigator.platform) && event.metaKey
              && (event.key === "Backspace" || event.key === "Delete");
            if ((!deleteKey && !macDeleteKey) || event.defaultPrevented || event.repeat || event.nativeEvent.isComposing
              || event.ctrlKey || event.altKey || event.shiftKey) return;
            const target = event.target as HTMLElement;
            if (target.isContentEditable || target.closest('input, textarea, select, [role="combobox"]')) return;
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
            captureCanvasMenu(event.clientX, event.clientY, point, [...selectedCanvasNodeIdsRef.current], null, undefined, section);
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
          <div ref={gridElement} className="canvas-camera-grid" aria-hidden="true" />
          <div className="canvas-drawing-tools" role="toolbar" aria-label="画板工具" onPointerDown={event => event.stopPropagation()}>
            <button data-tip="选择" aria-label="选择工具" aria-pressed={drawingTool === "select"} onClick={() => chooseCanvasTool("select")}><MousePointer2 size={18} /></button>
            <button data-tip="抓手 · 按住左键平移视图（Esc 退出）" aria-label="抓手工具" aria-pressed={drawingTool === "pan"} onClick={() => chooseCanvasTool("pan")}><Hand size={18} /></button>
            <button data-tip="分区 · 拖拽画框" aria-label="分区工具" aria-pressed={drawingTool === "section"} onClick={() => chooseCanvasTool("section")}><Frame size={18} /></button>
            <button data-tip="画板 · 拖框后拼放图片" aria-label="画板工具" aria-pressed={drawingTool === "artboard"} onClick={() => chooseCanvasTool("artboard")}><Scan size={18} /></button>
            <hr />
            <button data-tip="内容卡片 · 拖入画布或选中后点击放置" aria-label="内容卡片工具" {...canvasCardTool("text")}><Table2 size={18} /></button>
            <button data-tip="文本卡片 · 拖入画布或选中后点击放置" aria-label="文本卡片工具" {...canvasCardTool("document")}><FileText size={18} /></button>
            <button data-tip="气泡便签 · 拖入画布或选中后点击放置" aria-label="气泡便签工具" {...canvasCardTool("bubble")}><MessageCircle size={18} /></button>
            <button data-tip="指令卡片 · 拖入画布或选中后点击放置" aria-label="新增指令卡片" {...canvasCardTool("instruction")}><List size={18} /></button>
            <button data-tip="循环卡片 · 拖入画布或选中后点击放置" aria-label="新增循环卡片" {...canvasCardTool("loop")}><Repeat2 size={18} /></button>
            <button data-tip="生成卡片 · 拖入画布或选中后点击放置" aria-label="新增生成卡片" {...canvasCardTool("generation")}><Images size={18} /></button>
            {WORKFLOW_SKILL_ENABLED && <button data-tip="技能卡片 · 拖入画布或选中后点击放置" aria-label="新增技能卡片" {...canvasCardTool("skill")}><Sparkles size={18} /></button>}
            {WORKFLOW_PLANNER_ENABLED && import.meta.env.DEV && <button data-tip="工作流助手 · 拖入画布或选中后点击放置" aria-label="新增工作流助手" {...canvasCardTool("planner")}><Sparkles size={18} /></button>}
            <button data-tip="Agent 卡片 · 拖入画布或选中后点击放置" aria-label="新增 Agent 卡片" {...canvasCardTool("agent")}><TextCursorInput size={18} /></button>
            <button data-tip="视觉规范卡片 · 拖入画布或选中后点击放置" aria-label="新增视觉规范卡片" {...canvasCardTool("visual-profile")}><Palette size={18} /></button>
            {WORKFLOW_TEMPLATE_LIBRARY_ENABLED && <button disabled={!workflowInteractive} data-tip="模板库 · 子流程与分享" aria-label="工作流模板库" onClick={() => workflowRef.current?.templates()}><Copy size={18} /></button>}
            <button disabled={!workflowInteractive} data-tip="发条 · 卡片上吸附，空白处创建" aria-label="发条触发器"
              onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); setDrawingTool("select"); workflowRef.current?.arm(event.clientX, event.clientY); }}
              onClick={event => { if (event.detail === 0) { setDrawingTool("select"); workflowRef.current?.arm(); } }}><WindingKey size={21} /></button>
            <hr />
            <CanvasToolbox workflowReady={workflowInteractive} onOpenVoice={() => chooseCanvasTool("voice")} onOpenReplication={() => { setDrawingTool("select"); if (projectId) setReplicationProjectId(projectId); }} onOpenLocalVideo={() => chooseCanvasTool("comfy-video")} />
            <hr />
            <div className="canvas-assist-tools" role="group" aria-label="辅助">
              <span>辅助</span>
              <button type="button" data-tip="撤销（Ctrl / ⌘ Z）" aria-label="撤销画布操作" disabled={!canUndo}
                onPointerDown={event => event.preventDefault()} onClick={undoCanvasAction}><Undo2 size={18} /></button>
              <button type="button" data-tip={snapEnabled ? "关闭吸附对齐" : "开启吸附对齐"} aria-label="吸附对齐" aria-pressed={snapEnabled} onClick={() => {
                const next = !snapEnabled;
                snapEnabledRef.current = next;
                setSnapEnabled(next);
                setGuides([]);
                try { localStorage.setItem(CANVAS_SNAP_ENABLED_KEY, String(next)); } catch { /* Keep the toggle usable when storage is unavailable. */ }
              }}><Magnet size={18} /></button>
            </div>
          </div>
          <CanvasMediaProvider key={loading ? "loading" : projectId} zoom={zoomRef.current} zoomHandle={mediaZoomHandle} planeId={planeId}><div
            id={planeId}
            ref={planeRef}
            className="canvas-plane"
            style={{ transform: `translate3d(${panRef.current.x}px, ${panRef.current.y}px, 0) scale(${zoomRef.current})`,
              "--canvas-workflow-foreground-z": workflowForegroundZ } as CSSProperties}
          >
            {projectId && workflowInteractive && <CanvasWorkflowLayer key={projectId} ref={workflowRef} projectId={projectId} provisional={!activeCanvas.materialized} toBoardPoint={toBoardPoint} getZoom={readCanvasZoom} settledZoom={zoom} opening={opening} entryCardIds={entryCardIds} deferredCandidateIds={deferredCandidateIds} graphNodes={nonChatGraphNodes} visibleGraphNodeIds={visibleGraphNodeIds} conversationCards={conversationCards} selectedConversationOutputs={selectedConversationOutputs} imageOnlyConversationIds={imageOnlyConversationIds} sessionHeights={sessionHeights} generationCardAnchors={generationCardProjection.anchors} pinnedCardOffsets={pinnedCardOffsets}
              generationCardOrigins={generationCardProjection.origins}
              peekCard={peekedCard && peekAnchorPoint ? { ...peekedCard, point: peekAnchorPoint } : undefined}
              generationActivities={generationActivities} activeGenerationIds={activeGenerationIds}
              onPeekInteraction={onPeekInteraction} onToggleGenerationPin={toggleGenerationPin} onConnectCollapsedGeneration={pinConnectedGeneration}
              onUndoGenerationConnection={undoGenerationConnection}
              diagnosticTarget={diagnosticTarget} selectedIds={selectedCanvasNodeIds} panReady={spacePanReady || drawingTool === "pan"} onSelect={workflowOnSelect}
              onNodesChanged={workflowOnNodesChanged} onEdited={workflowOnEdited}
              onOpenAgent={workflowOnOpenAgent} getChatCardDefaults={agentCardDefaults} onNewAgentChat={workflowOnNewAgentChat} onOpenGeneration={workflowOnOpenGeneration}
              onDragStart={workflowOnDragStart} onDragMove={workflowOnDragMove} onDragEnd={workflowOnDragEnd} onNodeMenu={workflowOnNodeMenu}
              onRemove={workflowOnRemove} onPlaced={workflowOnPlaced}
              ensureMaterialized={workflowEnsureMaterialized} materials={workflowMaterials} />}
            {workflowInteractive && materialSelection && <div className="canvas-material-selection" data-canvas-selection-frame={materialSelection.ids[0]}
              style={{ left: materialSelection.left, top: materialSelection.top, width: materialSelection.width, height: materialSelection.height }}>
              <CanvasConnectionHandle side="output" active aria-label="连接所选素材" title="连接所选素材"
                onPointerDown={event => {
                  if (event.button !== 0) return;
                  event.preventDefault(); event.stopPropagation();
                  workflowRef.current?.connectSelection(materialSelection.ids, event.clientX, event.clientY);
                }}
                onClick={event => {
                  if (event.detail !== 0) return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  workflowRef.current?.connectSelection(materialSelection.ids, rect.left + rect.width / 2, rect.top + rect.height / 2, true);
                }} />
            </div>}
            {renderCanvasCards(graphNodes.filter(node => node.kind === "note" && node.hiddenAt == null && cardMounted(node.id) && !canvasChatId(node)), stagedCardContext, savedNode => {
              const value = resolveGenerationCells(readCanvasNote(savedNode), graphNodes);
              const minimum = value.note_type === "text" || value.note_type === "images" ? canvasTextMinSize(value.cells) : savedNode;
              const node = { ...savedNode, width: Math.max(savedNode.width, minimum.width), height: value.note_type === "document" ? canvasDocumentHeight(savedNode.width) : Math.max(savedNode.height, minimum.height) };
              const section = value.note_type === "section";
              const plainSection = section && !value.artboard && !value.workflow_container;
              const selected = selectedCanvasNodeIds.has(node.id);
              const openDocument = () => { documentEditorSession.current++; setDocumentEditor({ nodeId: node.id, projectId: node.projectId, initialDocument: { title: value.title || "文本", markdown: value.text } }); };
              const writerFailures = writerFailureKeys.get(node.id) ?? [];
              return <div key={node.id} data-canvas-node data-canvas-node-id={node.id} data-workflow-container={value.workflow_container ? node.id : undefined} tabIndex={0}
                className={`canvas-note ${section ? "is-section" : value.note_type === "bubble" ? "is-bubble" : "is-text is-content-card"} ${value.note_type === "document" ? "is-document-card" : ""} ${value.artboard ? "is-artboard" : ""} ${selected ? "is-selected" : ""} ${writerFailures.length ? "canvas-card-error" : ""}`}
                style={{ "--section-color": value.section_color, width: node.width, height: node.height,
                  ...(plainSection ? { left: node.x, top: node.y } : { transform: `translate3d(${node.x}px, ${node.y}px, 0)`, zIndex: section ? 0 : activeDragId === node.id || (activeDragId != null && selected) ? CANVAS_DRAG_Z_LIFT + node.zIndex : node.zIndex }) } as CSSProperties & { "--section-color"?: string }}
                onPointerDown={event => beginGraphNodeDrag(event, node)} onPointerMove={moveGraphNode}
                onPointerUp={endGraphNodeDrag} onPointerCancel={event => endGraphNodeDrag(event, true)}
                onLostPointerCapture={event => endGraphNodeDrag(event, true)}
                onContextMenu={event => openCanvasNodeMenu(event, node.id)}
                onDoubleClick={value.note_type === "document" ? event => { if ((event.target as Element).closest("button")) return; event.stopPropagation(); openDocument(); } : undefined}>
                {writerFailures.length > 0 && <button type="button" className="canvas-note-dismiss-error"
                  onPointerDown={event => event.stopPropagation()} onClick={event => {
                    event.stopPropagation(); writerFailures.forEach(key => canvasWorkflowController(node.projectId).dismissCardFailure(key));
                  }}>关闭错误提示</button>}
                {section ? <>
                  {value.artboard?.base_asset_id && !hideCanvasOriginal(value.artboard.base_asset_id, assetById.get(value.artboard.base_asset_id)?.store_path) && assetById.get(value.artboard.base_asset_id)?.store_path && <CanvasImage className="canvas-artboard-base" data-frequent-asset-id={value.artboard.base_asset_id} draggable={false}
                    path={assetById.get(value.artboard.base_asset_id)!.store_path} sourceWidth={assetById.get(value.artboard.base_asset_id)!.width} sourceHeight={assetById.get(value.artboard.base_asset_id)!.height} alt="画板基底" />}
                  <div className="canvas-section-heading" title={value.artboard ? "拖动画板" : "拖动分区"}><GripHorizontal size={17} />
                    {value.workflow_container && <span className="canvas-workflow-container-badge">封装 · {value.member_ids.length}</span>}
                  </div>
                  {value.artboard && <button type="button" className="canvas-artboard-compose" style={node.width < 300 ? { bottom: "calc(100% + 36px)" } : undefined} onPointerDown={event => event.stopPropagation()}
                    onClick={event => { event.stopPropagation(); openArtboardComposition(node); }}><Sparkles size={14} />合成画板中的内容</button>}
                  {["top", "bottom", "left", "right"].map(edge => <div key={edge} className={`canvas-section-edge ${edge}`} />)}
                  {selected && !value.workflow_container && ([["nw", "左上角"], ["ne", "右上角"], ["sw", "左下角"], ["se", "右下角"]] as const).map(([corner, label]) => (
                    <CanvasResizeHandle key={corner} label={`调整${value.artboard ? "画板" : "分区"}大小（${label}）`} corner={corner} size={node} position={{ x: node.x, y: node.y }} zoom={zoomRef.current} getZoom={readCanvasZoom}
                      minimum={{ width: 120, height: 80 }} onResize={(size, finished, cancelled) => resizeCanvasGraphNode(node.id, size, finished, cancelled)} />
                  ))}
                </> : value.note_type === "document" ? <CanvasDocumentCard value={value} editing={documentEditor?.nodeId === node.id}
                  onEdit={openDocument}
                  onConnect={!workflowInteractive ? undefined : (port, x, y, keyboard) => workflowRef.current?.connectCell(node.id, port, x, y, keyboard)}/>
                : <CanvasTextCard value={value} hideOriginal={hideCanvasOriginal} selected={selected} width={node.width} height={node.height} zoom={zoomRef.current} getZoom={readCanvasZoom}
                  readCurrentValue={() => {
                    const current = graphNodesRef.current.find(item => item.id === node.id);
                    return current && current !== savedNode ? resolveGenerationCells(readCanvasNote(current), graphNodesRef.current) : value;
                  }}
                  onOpenPreview={openCanvasSourcePreview}
                  onMediaContextMenu={(event, asset) => openCellAssetContextMenu(event, node, asset.id, asset)}
                  onOpenGeneration={cell => {
                    const session = graphNodes.find(item => item.id === cell.generation_ref?.session_node_id && item.hiddenAt == null);
                    if (session) openWorkflowGeneration(session);
                  }}
                  renderGeneration={cell => {
                    const session = graphNodes.find(item => item.id === cell.generation_ref?.session_node_id && item.hiddenAt == null);
                    const anchorId = session && conversationCards.aliases.get(session.id);
                    const card = anchorId && conversationCards.cards.get(anchorId);
                    const images = card ? card.allOutputs.flatMap(output => {
                      const material = nodes.find(item => item.kind === "asset" && item.id === output.id);
                      return material?.kind === "asset" ? [material.asset] : [];
                    }) : [];
                    if (anchorId && images.length && (images.length > 1 || images[0].assetId !== cell.image_refs?.[0]?.asset_id)) return <CanvasConversationImages images={images} imageOnly
                      selectedId={selectedConversationImage(anchorId, images)?.id}
                      onSelect={selected => { cancelConversationImageClick(); setConversationImageSelection(previous => ({ ...previous, [anchorId]: { newest: images[images.length - 1].id, selected } })); }}
                      onPointerDown={event => event.stopPropagation()}
                      onClick={event => {
                        cancelConversationImageClick();
                        if (event.detail < 2 && session) conversationImageClickRef.current = setTimeout(() => openWorkflowGeneration(card ? card.latest : session), event.detail === 0 ? 0 : 350);
                      }}
                      onDoubleClick={(_event, shown) => { cancelConversationImageClick(); const path = shown.storePath ?? shown.thumbPath; if (path) setCanvasLightbox({ images: [path], assetIds: [shown.assetId], index: 0 }); }}
                      onContextMenu={(event, shown) => { if (shown.assetId) openCellAssetContextMenu(event, node, shown.assetId, assetById.get(shown.assetId), shown.id); }}/>
                    if (cell.image_refs?.length) return null;
                    const summary = session && promptNodeSummary(session);
                    const running = summary && (genJobs[summary.jobId]?.running ?? ["running", "querying", "queued"].includes(summary.status));
                    const failureKey = session && summary?.status === "failed" && !running ? generationFailureKey(session, summary) : null;
                    const showFailure = !!failureKey && !dismissed.has(failureKey);
                    return <><button type="button" className={`canvas-cell-generation ${running ? "canvas-card-running" : ""} ${showFailure ? "is-failed" : ""}`}
                      data-cell-generation={cell.generation_ref?.session_node_id} aria-label="查看单元格生成会话" aria-busy={!!running}
                      onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); if (session) openWorkflowGeneration(session); }}>
                      <span><strong>生成会话</strong><small>{summary?.provider} · {running ? <GenerationJobProgress jobId={summary?.jobId} /> : failureKey ? showFailure ? "生成失败" : "查看详情" : summary?.status === "done" ? "等待结果图片" : summary?.status === "cancelled" ? "已取消" : "等待生成"}</small></span>
                      <p>{summary?.text ?? "生成会话已不可用"}</p>
                    </button>{showFailure && dismissFailureButton(failureKey)}</>;
                  }}
                  onConnectCell={!workflowInteractive ? undefined : (cellId, x, y, keyboard) => workflowRef.current?.connectCell(node.id, cellId, x, y, keyboard)}
                  onInput={!workflowInteractive ? undefined : (cellId, disconnect, type, point, keyboard) => workflowRef.current?.inputText(node.id, cellId, disconnect, type, point, keyboard)}
                  inputLocked={workflowRef.current?.isLocked(node.id)}
                  onResize={(size, finished, cancelled) => resizeCanvasGraphNode(node.id, size, finished, cancelled)} onSelect={() => setSelectedCanvasNodeIds(new Set([node.id]))}
                  onChange={(next, size, history) => updateCanvasNote(node.id, next, size, history)} />}
              </div>;
            })}
            {sectionPreview && <div className="canvas-section-preview" style={{ left: sectionPreview.x, top: sectionPreview.y, width: sectionPreview.width, height: sectionPreview.height }} />}
            {hoverIntent?.kind === "cell" && <div key={hoverIntent.key} className={`canvas-cell-drop-target ${hoverReady ? "is-ready" : ""}`} style={{ left: hoverIntent.rect.x, top: hoverIntent.rect.y, width: hoverIntent.rect.width, height: hoverIntent.rect.height }}>
              <span className="canvas-folder-hint" role="tooltip">{hoverReady ? "松开放入单元格" : "悬停以放入单元格"}</span>
            </div>}
            <svg className="canvas-graph-edges" aria-hidden="true">
              {drawableEdges.map(({ edge, from, to }) => {
                const fromMaterial = materialByNodeOrAssetId.get(from.id);
                const toMaterial = materialByNodeOrAssetId.get(to.id);
                if (!cardMounted(fromMaterial?.id ?? from.id) || !cardMounted(toMaterial?.id ?? to.id)) return null;
                const x1 = from.x + (fromMaterial ? nodeRect(fromMaterial).width : from.width);
                const y1 = from.y + (fromMaterial ? nodeRect(fromMaterial).height : nodeRect(from).height) / 2;
                const x2 = to.x;
                const y2 = to.y + (toMaterial ? nodeRect(toMaterial).height : nodeRect(to).height) / 2;
                return (
                  <path
                    key={edge.id}
                    className={`is-${edge.kind}${selectedCanvasNodeIds.has(fromMaterial?.id ?? from.id) || selectedCanvasNodeIds.has(toMaterial?.id ?? to.id) ? " is-selected" : ""}`}
                    {...dragWire({ x: x1, y: y1, owner: fromMaterial?.id ?? from.id }, { x: x2, y: y2, owner: toMaterial?.id ?? to.id }, graphWirePath)}
                  />
                );
              })}
            </svg>
            {renderCanvasCards(chatGraphNodes.filter(node => cardMounted(node.id)), stagedCardContext, node => {
              const chatId = canvasChatId(node)!;
              const chat = chatSummaries[chatId];
              return <div key={node.id} data-canvas-node data-canvas-node-id={node.id} data-local-chat-id={chatId}
                role="button" tabIndex={0} aria-label={`对话 · ${chat?.title ?? "正在读取"}`} aria-busy={localChatRunning(chat)}
                className={`canvas-chat-node${selectedCanvasNodeIds.has(node.id) ? " is-selected" : ""}${selectedChatId === chatId ? " is-focused" : ""}${localChatRunning(chat) ? " canvas-card-running" : ""}`}
                style={{ width: node.width, minHeight: node.height, transform: `translate3d(${node.x}px, ${node.y}px, 0)`, zIndex: activeDragId === node.id ? CANVAS_DRAG_Z_LIFT + node.zIndex : node.zIndex }}
                onPointerDown={event => beginGraphNodeDrag(event, node)} onPointerMove={moveGraphNode}
                onPointerUp={endGraphNodeDrag} onPointerCancel={event => endGraphNodeDrag(event, true)}
                onContextMenu={event => openCanvasNodeMenu(event, node.id)}
                onClick={event => {
                  if (consumeSuppressedNodeClick(event) || event.ctrlKey || event.metaKey || spacePressedRef.current || drawingTool === "pan") return;
                  openLocalChat(chatId);
                }}
                onKeyDown={event => {
                  if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) { event.preventDefault(); openLocalChat(chatId); }
                }}>
                {chat ? <LocalChatCard conversation={chat} /> : <div className="local-chat-card-content"><strong>对话</strong><p>打开对话详情</p></div>}
              </div>;
            })}
            {renderCanvasCards(promptGraphNodes.filter(node => cardMounted(node.id)), stagedCardContext, node => {
              const conversation = conversationCards.cards.get(node.id);
              const latest = conversation?.latest ?? node;
              const images = conversationImages(node.id);
              const imageOnly = imageOnlyConversationIds.has(node.id);
              const shownImage = selectedConversationImage(node.id, images);
              const selectedVideo = isVideoPath(shownImage?.storePath);
              const openConversation = () => openWorkflowGeneration(latest, node.id);
              const summary = promptNodeSummary(latest);
              const running = genJobs[summary.jobId]?.running ?? ["running", "querying", "queued"].includes(summary.status);
              const failureKey = !running && summary.status === "failed" ? generationFailureKey(latest, summary) : null;
              const acknowledged = !!failureKey && dismissed.has(failureKey);
              return (
                <div
                  key={node.id}
                  data-canvas-node
                  data-canvas-node-id={node.id}
                  data-creation-conversation={!imageOnly || selectedVideo ? "" : undefined}
                  role="button"
                  data-canvas-filter={images.length ? materialFilterState(selectedConversationImage(node.id, images)!) : undefined}
                  tabIndex={0}
                  aria-busy={running}
                  aria-label={imageOnly ? `${selectedConversationImage(node.id, images)?.name ?? "生成图片"}，${selectedVideo ? "点击播放视频" : boardOpen || genEditing ? "单击预览，双击添加引用" : "点击预览图片"}` : undefined}
                  className={`canvas-prompt-node ${imageOnly ? "is-image-only" : ""} ${conversation?.outputs.length ? "has-conversation-images" : ""} ${running ? "canvas-card-running" : ""} ${selectedCanvasNodeIds.has(node.id) ? "is-selected" : ""} ${acknowledged ? "" : `is-${summary.status}`} ${focusedNodeId === node.id ? "is-focused" : ""} ${activeDragId === node.id || (activeDragId != null && selectedCanvasNodeIds.has(node.id)) ? "is-moving" : ""} ${supersededTaskIds.has(latest.id) ? "is-superseded" : ""}`}
                  onContextMenu={(event) => {
                    const material = imageOnly && shownImage ? materialByNodeOrAssetId.get(shownImage.id) : undefined;
                    if (material?.kind === "asset") openCanvasAssetContextMenu(event, { ...material, id: node.id }, material.asset);
                    else openCanvasNodeMenu(event, node.id, latest);
                  }}
                  onPointerEnter={imageOnly ? event => startPeek(event, node.id) : undefined}
                  onPointerLeave={imageOnly ? leavePeekAnchor : undefined}
                  style={{
                    width: node.width,
                    minHeight: nodeRect(node).height,
                    height: imageOnly ? nodeRect(node).height : undefined,
                    transform: `translate3d(${node.x}px, ${node.y}px, 0)`,
                    zIndex: quickRevision?.anchorId === node.id ? workflowForegroundZ + 3 : activeDragId === node.id || (activeDragId != null && selectedCanvasNodeIds.has(node.id)) ? CANVAS_DRAG_Z_LIFT + node.zIndex : node.zIndex,
                  }}
                  onPointerDown={(event) => {
                    beginGraphNodeDrag(event, node);
                  }}
                  onPointerMove={moveGraphNode}
                  onPointerUp={endGraphNodeDrag}
                  onPointerCancel={(event) => endGraphNodeDrag(event, true)}
                  onClick={(event) => {
                    if (consumeSuppressedNodeClick(event)) return;
                    if (imageOnly) { event.currentTarget.querySelector<HTMLElement>(".canvas-conversation-images")?.click(); return; }
                    openConversation();
                  }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    generationContextMenuKey(event, node.id);
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.currentTarget.click();
                  }}
                >
                  {!imageOnly && <div><span>{conversation?.outputs.length ? "生成会话" : "生成指令"}</span><small>{summary.provider} · <span role={running ? "status" : undefined}>{running ? <GenerationJobProgress jobId={summary.jobId} /> : acknowledged ? "查看详情" : generationStatusLabel(summary.status)}</span></small>{failureKey && !acknowledged && dismissFailureButton(failureKey)}</div>}
                  {imageOnly && running && <span className="canvas-generation-stage" role="status">{<GenerationJobProgress jobId={summary.jobId} />}</span>}
                  {imageOnly && renderGenerationImageActions(node.id, shownImage)}
                  <GenerationJobPreview jobId={running && !imageOnly ? summary.jobId : undefined} turnKey={summary.turnKey}>
                  {conversation && <CanvasConversationImages images={images} imageOnly={imageOnly}
                    selectedId={selectedConversationImage(node.id, images)?.id}
                    onSelect={selected => { cancelConversationImageClick(); setConversationImageSelection(previous => ({ ...previous, [node.id]: { newest: images[images.length - 1].id, selected } })); }} onPointerDown={event => {
                    cancelConversationImageClick();
                    // Capture on the image region so a click is not retargeted to the conversation card.
                    beginGraphNodeDrag(event, node);
                    const shown = selectedConversationImage(node.id, images);
                    if (shown) armCanvasAssetHold(event, node.id, shown);
                  }} onClick={(event, asset) => {
                    if (consumeSuppressedNodeClick(event)) return;
                    if (isVideoPath(asset.storePath) && asset.storePath) {
                      cancelConversationImageClick();
                      setCanvasLightbox({ images: [asset.storePath], assetIds: [asset.assetId], canvasNodeId: asset.id, index: 0 });
                      return;
                    }
                    const activate = () => {
                      if (!graphNodesRef.current.some(item => item.id === node.id && item.hiddenAt == null)) return;
                      const state = useStore.getState();
                      if (imageOnly && canvasPrimaryMaterialAction(state.boardOpen, !!state.genEditing) === "compose") {
                        if (asset.assetId) window.dispatchEvent(new CustomEvent(BOARD_ASSET_PICK_EVENT, { detail: { assetId: asset.assetId, canvasNodeId: asset.id } }));
                      } else if (imageOnly && summary.status === "failed") {
                        const path = asset.storePath ?? asset.thumbPath;
                        if (path) setCanvasLightbox({ images: [path], index: 0 });
                      } else if (imageOnly) openConversation();
                      else {
                        const material = materialByNodeOrAssetId.get(asset.id);
                        if (material?.kind === "asset") activateCanvasMaterial(material);
                      }
                    };
                    cancelConversationImageClick();
                    if (!imageOnly || event.detail === 0) activate();
                    else if (event.detail === 1) conversationImageClickRef.current = setTimeout(activate, 350);
                  }} onDoubleClick={(event, asset) => {
                    cancelConversationImageClick();
                    if (!imageOnly || event.ctrlKey || event.metaKey || spacePressedRef.current || drawingTool === "pan") return;
                    const path = asset.storePath ?? asset.thumbPath;
                    if (path) setCanvasLightbox({ images: [path], assetIds: [asset.assetId], index: 0 });
                  }} onContextMenu={(event, asset) => {
                    cancelConversationImageClick();
                    const material = materialByNodeOrAssetId.get(asset.id);
                    if (material?.kind === "asset") openCanvasAssetContextMenu(event, { ...material, id: node.id }, material.asset);
                  }} />}
                  {!imageOnly && <section className="canvas-prompt-content"><ReadonlyPrompt prompt={summary.text} references={promptReferences(latest)} /></section>}
                  </GenerationJobPreview>
                  {imageOnly && failureKey && <span className={`canvas-conversation-failure${acknowledged ? " is-acknowledged" : ""}`}><button type="button"
                    onPointerDown={event => { event.stopPropagation(); cancelConversationImageClick(); }}
                    onClick={event => { event.stopPropagation(); if (!consumeSuppressedNodeClick(event)) openConversation(); }}>{acknowledged ? "查看会话详情" : "本轮生成失败 · 查看详情"}</button>{!acknowledged && dismissFailureButton(failureKey)}</span>}
                  {imageOnly && (shownImage?.storePath || shownImage?.thumbPath) && <CanvasResizeHandle label="调整素材大小"
                    size={nodeRect(node)} zoom={zoomRef.current} getZoom={readCanvasZoom} minimum={{ width: 96, height: 32 }}
                    constrain={(start, delta) => {
                      const ratio = start.height / start.width;
                      const change = Math.abs(delta.width) >= Math.abs(delta.height / ratio) ? delta.width : delta.height / ratio;
                      if (!change) return start;
                      const width = Math.max(96, 32 / ratio, start.width + change);
                      return { width, height: width * ratio };
                    }} onResize={(size, finished, cancelled) => resizeCanvasGraphNode(node.id, size, finished, cancelled)} />}
                </div>
              );
            })}
            {renderCanvasCards(agentGraphNodes.filter(node => cardMounted(node.id)), stagedCardContext, node => {
              const summary = agentGroupSummary(node);
              const run = summary.runId ? cloudAgentRuns[summary.runId] : undefined;
              const running = ["queued", "running", "cancel_requested", "awaiting_local_task"].includes(run?.status ?? summary.status);
              const status = run?.status ?? summary.status;
              const failureKey = status === "failed" ? JSON.stringify(["agent", summary.runId || node.id]) : null;
              const acknowledged = !!failureKey && dismissed.has(failureKey);
              const resultCount = run ? selectCloudAgentResultArtifacts(run.snapshot.artifacts, run.snapshot.renderManifest, run.snapshot.events).length : summary.artifactCount;
              return (
                <div
                  key={node.id}
                  role="button"
                  tabIndex={0}
                  data-canvas-node
                  data-canvas-node-id={node.id}
                  aria-busy={running}
                  className={`canvas-agent-node ${running ? "canvas-card-running" : ""} ${selectedCanvasNodeIds.has(node.id) ? "is-selected" : ""} ${acknowledged ? "" : `is-${status}`} ${focusedNodeId === node.id ? "is-focused" : ""} ${activeDragId === node.id || (activeDragId != null && selectedCanvasNodeIds.has(node.id)) ? "is-moving" : ""} ${supersededTaskIds.has(node.id) ? "is-superseded" : ""}`}
                  onContextMenu={(event) => openCanvasNodeMenu(event, node.id, node)}
                  style={{
                    width: node.width,
                    minHeight: node.height,
                    transform: `translate3d(${node.x}px, ${node.y}px, 0)`,
                    zIndex: activeDragId === node.id || (activeDragId != null && selectedCanvasNodeIds.has(node.id)) ? CANVAS_DRAG_Z_LIFT + node.zIndex : node.zIndex,
                  }}
                  onPointerDown={(event) => {
                    beginGraphNodeDrag(event, node);
                  }}
                  onPointerMove={moveGraphNode}
                  onPointerUp={endGraphNodeDrag}
                  onPointerCancel={(event) => endGraphNodeDrag(event, true)}
                  onClick={event => {
                    if (consumeSuppressedNodeClick(event)) return;
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
                  <div><span>Agent 执行组</span><small>{acknowledged ? "已结束" : cloudAgentStatusLabel(status)}</small>{failureKey && !acknowledged && dismissFailureButton(failureKey)}</div>
                  <strong>{cloudAgentStepLabel(summary.currentStep ?? "")}</strong>
                  {(() => {
                    const prompt = graphNodes.find(candidate => agentPromptGroups.get(candidate.id)?.id === node.id);
                    return prompt ? <section className="canvas-prompt-content"><ReadonlyPrompt prompt={promptNodeSummary(prompt).text} references={promptReferences(prompt)} /></section> : null;
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
                  ? { left: guide.position, width: 1 / zoomRef.current, backgroundSize: `100% ${12 / zoomRef.current}px` }
                  : { top: guide.position, height: 1 / zoomRef.current, backgroundSize: `${12 / zoomRef.current}px 100%` }}
              />
            ))}
            {renderCanvasCards(visibleMaterials.filter(node => cardMounted(node.id)), stagedCardContext, node => {
              const gallery = node.kind === "asset" ? conversationImages(node.id) : [];
              const galleryIndex = gallery.findIndex(asset => asset.id === (node.kind === "asset" ? node.asset.id : ""));
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
                  data-frequent-asset-id={node.kind === "asset" ? node.asset.assetId ?? undefined : undefined}
                  tabIndex={0}
                  aria-label={`${node.kind === "asset" ? `${node.asset.name}，${boardOpen || genEditing ? "单击查看，双击添加引用" : isAudioPath(node.asset.storePath) ? "点击查看音频详情" : "点击放大"}` : `素材组，${node.assets.length} 个素材，${expanded ? "已展开" : "点击展开"}`}${selectedCanvasNodeIds.has(node.id) ? "，已选中" : ""}`}
                  aria-expanded={node.kind === "folder" ? expanded : undefined}
                  data-canvas-filter={node.kind === "asset" ? materialFilterState(node.asset) : undefined}
                  className={`canvas-node generation-group is-${node.kind} ${node.kind === "asset" && isVideoPath(node.asset.storePath) ? "is-video" : ""} ${expanded ? "is-expanded" : ""} ${!showAssetNames ? "is-name-hidden" : ""} ${focusedNodeId === node.id ? "is-focused" : ""} ${selectedCanvasNodeIds.has(node.id) ? "is-selected" : ""} ${movingWithSelection ? "is-moving" : ""} ${holding ? "is-folder-target" : ""} ${directFolderTarget ? "is-folder-drop-target" : ""} `}
                  style={{
                    width: nodeRect(node).width,
                    height: nodeRect(node).height,
                    transform: `translate3d(${node.x}px, ${node.y}px, 0)`,
                    zIndex: quickRevision?.anchorId === node.id ? workflowForegroundZ + 3 : movingWithSelection ? CANVAS_DRAG_Z_LIFT + node.order : node.order,
                  }}
                  onPointerDown={(event) => beginNodeDrag(event, node)}
                  onPointerEnter={node.kind === "asset" ? event => startPeek(event, node.id) : undefined}
                  onPointerLeave={node.kind === "asset" ? leavePeekAnchor : undefined}
                  onClickCapture={event => {
                    if ((event.target as HTMLElement).closest(".audio-waveform-wave") && consumeSuppressedNodeClick(event)) {
                      event.preventDefault(); event.stopPropagation();
                    }
                  }}
                  onPointerMove={moveNode}
                  onPointerUp={endNodeDrag}
                  onPointerCancel={(event) => endNodeDrag(event, true)}
                  onLostPointerCapture={(event) => endNodeDrag(event, true)}
                  onContextMenu={node.kind === "asset"
                    ? (event) => openCanvasAssetContextMenu(event, node, node.asset)
                    : (event) => node.assets[0] ? openCanvasAssetContextMenu(event, node, node.assets[0]) : openCanvasNodeMenu(event, node.id)}
                  onKeyDown={(event) => {
                    if ((event.target as HTMLElement).closest(".generation-group-arrow,.canvas-generation-actions,.canvas-generation-revision")) return;
                    generationContextMenuKey(event, node.id);
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
                      <GenerationGroupControls index={galleryIndex} count={gallery.length} onSelect={index => {
                        setConversationImageSelection(previous => ({ ...previous, [node.id]: { newest: gallery[gallery.length - 1].id, selected: gallery[index].id } }));
                      }} />
                      {isAudioPath(node.asset.storePath) && node.asset.assetId && node.asset.storePath ? <AudioWaveform className="canvas-audio-waveform" assetId={node.asset.assetId} path={node.asset.storePath} name={node.asset.name} version={videoSourceKey(assetById.get(node.asset.assetId)) ?? node.asset.storePath} onWavePointerDown={event => beginNodeDrag(event, node)} /> : isVideoPath(node.asset.storePath) ? <VideoPoster path={node.asset.storePath} poster={node.asset.thumbPath} alt={node.asset.name} draggable={false} /> : path ? (
                        <CanvasImage path={node.asset.storePath} thumbPath={node.asset.thumbPath} sourceWidth={node.asset.width} sourceHeight={node.asset.height} alt={node.asset.name} draggable={false} />
                      ) : (
                        <div className="canvas-node-placeholder">{node.asset.name.slice(0, 1)}</div>
                      )}
                      {isVideoPath(node.asset.storePath) && !generationCardProjection.origins.has(node.id)
                        && <span className="canvas-video-badge" role="img" aria-label="视频" />}
                      <div className="pointer-events-none absolute left-1 top-1 z-10 flex items-center gap-1">
                        {node.asset.assetId && layerWorkspaceIds.has(node.asset.assetId) && <span className="rounded-full bg-black/70 px-1.5 py-1 text-white backdrop-blur" title="有分层工程" aria-label="有分层工程"><Layers size={12} /></span>}
                        {node.asset.assetId && captionedIds.has(node.asset.assetId) && (
                          <DimensionBadge assetId={node.asset.assetId} />
                        )}
                      </div>
                          {renderGenerationImageActions(node.id, node.asset)}
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
                            const Member = isAudioPath(asset.storePath) ? "div" : "button";
                            return <Member key={asset.id} role={Member === "div" ? "group" : undefined} tabIndex={0} data-canvas-folder-asset-id={asset.id} data-frequent-asset-id={asset.assetId ?? undefined}
                              data-canvas-filter={materialFilterState(asset)}
                              className="canvas-folder-asset" aria-label={asset.name}
                              onPointerDown={(event) => { if (!isCanvasPanGesture(event.button, spacePressedRef.current, drawingTool === "pan")) { event.stopPropagation(); if (event.button === 0) suppressNodeClickRef.current = false; armCanvasAssetHold(event, node.id, asset, true); } }}
                              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " " || event.key.startsWith("Arrow")) event.stopPropagation(); }}
                              onClick={(event) => { if (!consumeSuppressedNodeClick(event)) activateCanvasMaterial(groupedAssetNode(asset, node, index)); }}
                              onContextMenu={(event) => openCanvasAssetContextMenu(event, node, asset)}>
                              {isAudioPath(asset.storePath) && asset.assetId && asset.storePath ? <AudioWaveform className="canvas-audio-waveform" assetId={asset.assetId} path={asset.storePath} name={asset.name} version={videoSourceKey(assetById.get(asset.assetId)) ?? asset.storePath} /> : isVideoPath(asset.storePath) ? <VideoPoster path={asset.storePath} poster={asset.thumbPath} alt={asset.name} draggable={false} /> : assetPath ? <CanvasImage path={asset.storePath} thumbPath={asset.thumbPath} sourceWidth={asset.width} sourceHeight={asset.height} alt="" draggable={false} />
                                : <span className="canvas-folder-asset-placeholder">{asset.name.slice(0, 1)}</span>}
                              {showAssetNames && <span className="canvas-folder-asset-name">{asset.name}</span>}
                            </Member>;
                          })}
                        </div>
                      </> : <>
                        <FolderPreview node={node} filterState={materialFilterState} onAssetPointerDown={(event, asset) => { beginNodeDrag(event, node); armCanvasAssetHold(event, node.id, asset, true); }} onAssetContextMenu={(event, asset) => openCanvasAssetContextMenu(event, node, asset)} />
                        <span className="canvas-folder-name"><Folder size={13} /> 素材组 · {node.assets.length}</span>
                      </>}
                    </>
                  )}
                  {holding && <span className="canvas-folder-hint" role="tooltip">{hoverReady ? "松开创建素材组" : "悬停以创建素材组"}</span>}
                  {directFolderTarget && <span className="canvas-folder-hint" role="tooltip">松手移入素材组</span>}
                  {!expanded && <CanvasResizeHandle label={node.kind === "asset" ? "调整素材大小" : "调整素材组大小"} size={nodeRect(node)} zoom={zoomRef.current} getZoom={readCanvasZoom}
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
          <CanvasMediaHover root={stageRef}/></div></CanvasMediaProvider>

          <CanvasTacticalOverlay key={projectId} stageRef={stageRef} active={viewMode === "canvas" && !opening && !projectRoutePending} />
          <div ref={marqueeElement} className="canvas-selection-marquee" aria-hidden="true" hidden />

          {shownMaterials.length === 0 && promptGraphNodes.length === 0 && agentGraphNodes.length === 0 && chatGraphNodes.length === 0
            && !graphNodes.some(node => node.kind === "note" && node.hiddenAt == null)
            && !workflowNodes.some(node => node.kind !== "text") && workflowInteractive && (
            <div className="canvas-empty-state" aria-hidden="true">
              <span><Move size={20} /></span>
              <strong>把左侧素材拖到这里</strong>
              <p>素材靠近时会自动吸附；在另一素材上停留 1 秒后松开，即可建立透明素材组。</p>
            </div>
          )}
          {externalDragOver && <div className="canvas-drop-label">松开放到画布</div>}
        </div>
        {viewMode === "timeline" && !opening && (
          <CreativeTimeline
            nodes={timelineNodes}
            edges={timelineEdges}
            selectedNodeId={focusedNodeId}
            onSelect={id => { const node = graphNodes.find(node => node.id === id); const chatId = node && canvasChatId(node); if (chatId) openLocalChat(chatId); else focusGraphNode(id); }}
            onLocate={locateGraphNode}
          />
        )}
        {!selectedChatId && shouldMountProjectComposer(opening, activeSessionKind === "generation" && !!genEditing) && (
          <CreativeComposer
            key={`${activeCanvas.id}:${composerDraftRevision}`}
            projectId={activeCanvas.id}
            draftJson={activeCanvas.draftJson}
            initialAssetIds={composerSeedIds}
            continuationCandidates={continuationCandidates}
            focusedContinuationNodeId={focusedNodeId}
            focusedContinuationThreadId={focusedThreadId}
            promptLoadRequest={documentPromptLoad ?? promptLoadRequest}
            onPromptLoadConsumed={id => { if (documentPromptLoad?.id === id) setDocumentPromptLoad(null); else onLaunchConsumed?.(id); }}
            onDraftChange={draftJson => { if (activeCanvasRef.current.id === activeCanvas.id) persistComposerDraft(draftJson); }}
            onOpenLibrary={() => {
              if (!useStore.getState().canvasLibraryOpen) {
                openLibrary();
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
            onGenerateLocalVideo={!workflowInteractive ? undefined : async request => {
              const workflow = workflowRef.current;
              const bounds = stageRef.current?.getBoundingClientRect();
              if (!workflow || !bounds) throw new Error("画板正在载入，请稍后重试");
              const point = toBoardPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 3);
              const position = placeCanvasCardNearSource({ ...point, width: workflowCardWidth({ kind: "comfy-video" }), height: 360 }, selectionAnchors().map(anchor => anchor.rect));
              await workflow.startLocalVideo(request, position);
            }}
            onOptimizeLocalVideo={optimizeComposerLocalVideo}
            resolveCreativeThread={resolveCreativeThread}
          />
        )}
        {selectedChatId && projectId && !loading && <LocalChatPanel key={selectedChatId} conversationId={selectedChatId} projectId={projectId}
          onApplyPrompt={h3ChatEditor?.projectId === projectId && h3ChatEditor.chatId === selectedChatId ? h3ChatEditor.apply : undefined}
          onClose={() => { setSelectedChatId(null); setH3ChatEditor(null); useStore.getState().setBoardActive(false); }}
          onSelectConversation={openLocalChat}
          onNewConversation={newLocalChat}
          getCardDefaults={agentCardDefaults} onLocateCards={locateChatCards} onUndoCards={undoChatCards}
          onOpenLibrary={() => { openLibrary(); setCanvasLibraryOpen(true); useStore.getState().setBoardActive(true); }} />}
        {chatHistoryOpen && projectId && <div id="project-chat-history" className="canvas-chat-history"><LocalChatHistory projectId={projectId}
          activeConversationId={selectedChatId ?? undefined} onOpen={openLocalChat} onClose={() => setChatHistoryOpen(false)} /></div>}
        {workflowAgentDetail && workflowAgentDetail.projectId === projectId && workflowInteractive && !genPanelOpen && <WorkflowAgentDetail
          key={`${projectId}:${workflowAgentDetail.nodeId}:${workflowAgentDetail.entryKey ?? "latest"}`} projectId={workflowAgentDetail.projectId} nodeId={workflowAgentDetail.nodeId} initialEntry={workflowAgentDetail.entryKey}
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
        {transfer.dialogs}
        {promptMenu && <CanvasContextMenu key={`${promptMenu.x}:${promptMenu.y}`} menu={promptMenu} transfer={transfer}
          onClose={() => setPromptMenu(current => current === promptMenu ? null : current)}
          onSelect={action => selectCanvasMenuAction(action, promptMenu)} onAddImages={addCanvasImagesToBoard}
          onSectionColor={setCanvasMenuSectionColor} />}
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
          onAddAnalysis={async output => {
            const project = activeCanvasRef.current, stage = stageRef.current;
            const check = () => { if (activeCanvasRef.current.id !== project.id || project.id !== replicationProjectId || useStore.getState().projectRoutePending) throw new Error("项目已切换，请返回原画板重试"); };
            check(); if (!stage) throw new Error("画板尚未准备完成");
            await ensureMaterialized(project); await flushCanvasWrites(false); check();
            const nodeId = `replication-analysis-${output.id}`;
            const existing = await api.projectCanvasGet(project.id); check();
            if (!existing.nodes.some(node => node.id === nodeId)) {
              const rows = [];
              for (const row of output.rows) {
                check();
                const asset = await api.importImageBytes({ dataUrl: row.dataUrl, projectId: project.id, source: "video-frame", fileName: `镜头-${row.index + 1}.jpg` });
                check(); rows.push({ ...row, assetId: asset.id });
              }
              const bounds = stage.getBoundingClientRect();
              const center = toBoardPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
              const payload = replicationAnalysisNote(rows);
              const rect = placeCanvasCardNearSource({ x: center.x - 320, y: center.y - 160, width: 640, height: Math.max(300, rows.length * 180 + 46) }, selectionAnchors().map(item => item.rect));
              check();
              await api.projectCanvasNodeCreate({ id: nodeId, projectId: project.id, threadId: null, kind: "note", assetId: null, role: null,
                payloadJson: JSON.stringify(payload), ...rect, width: 640, height: Math.max(300, rows.length * 180 + 46), zIndex: Math.max(0, ...selectionAnchors().map(anchor => anchor.order)) + 1, positionLocked: false });
              check(); pushCanvasUndo({ kind: "paste", projectId: project.id, nodeIds: [nodeId], groupIds: [], workflowIds: [] });
            }
            check(); const snapshot = await api.projectCanvasGet(project.id); check();
            graphNodesRef.current = snapshot.nodes; setGraphNodes(snapshot.nodes); setSelectedCanvasNodeIds(new Set([nodeId]));
          }}
          onAddVideo={async (path, operationId) => {
            const project = activeCanvasRef.current;
            if (project.id !== replicationProjectId || useStore.getState().projectRoutePending) throw new Error("项目已切换，请重新打开工具");
            await ensureMaterialized(project);
            const [asset] = await api.importFiles([path], project.id, true);
            if (!asset) throw new Error("视频未能加入素材库，请重试");
            if (activeCanvasRef.current.id !== project.id || useStore.getState().projectRoutePending) throw new Error("视频已保存到素材库，项目已切换，请返回原画板重试");
            await addCollectedVideo({ asset, projectId: project.id, operationId });
          }}
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
            pushCanvasUndo({ kind: "paste", projectId: draft.id, nodeIds: built.notes.filter(node => !existing.nodes.some(item => item.id === node.id)).map(node => node.id), groupIds: [], workflowIds: built.nodes.map(node => node.id) });
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
        {documentEditor && <Suspense fallback={null}><TextWorkspace key={documentEditor.nodeId} initialDocument={documentEditor.initialDocument} projectId={documentEditor.projectId}
          origin={{ key: `canvas-document:${documentEditor.nodeId}`, version: JSON.stringify([documentEditor.initialDocument.title, documentEditor.initialDocument.markdown]), followsChanges: true }}
          onPendingInput={capture => { documentEditorRevision.current++; pendingDocumentInput.current = capture; }}
          onChange={(document, context) => { pendingDocumentInput.current = undefined; documentEditorRevision.current++; if (context.isSourceDocument) stageDocumentCard(document); }}
          onClose={document => { saveDocumentCard(document); documentEditorSession.current++; setDocumentEditor(null); }}
          onAddToComposer={async (document, context) => {
            const expected = documentEditor.projectId;
            const session = documentEditorSession.current, revision = documentEditorRevision.current;
            const prompt = await documentToPromptLoad(document);
            if (documentEditorSession.current !== session || activeCanvasRef.current.id !== expected) return;
            if (documentEditorRevision.current !== revision) throw new Error("文本已有新的更改，请再次添加；当前内容已保留。");
            if (context.isSourceDocument) saveDocumentCard(document); else flushDocumentCard();
            setDocumentPromptLoad({ ...prompt, id: canvasId("document-prompt") });
            setSelectedChatId(null); useStore.getState().setBoardActive(true); documentEditorSession.current++; setDocumentEditor(null);
          }}/></Suspense>}
        {creationImagePreview && (isVideoPath(creationImagePreview.asset.store_path) || isAudioPath(creationImagePreview.asset.store_path)
          ? <LibraryVideoPreview asset={creationImagePreview.asset} job={creationImagePreview.job} path={creationImagePreview.asset.store_path!} sourceKey={videoSourceKey(creationImagePreview.asset)} projectId={projectId ?? null} onClose={creationImage.close}/>
          : <CreationImagePreview asset={currentPreviewAsset ?? creationImagePreview.asset} projectId={projectId}
              job={currentPreviewImage ? outputJob(currentPreviewImage) : creationImagePreview.job}
              parentNodeId={currentPreviewImage?.id ?? creationImagePreview.canvasNodeId} onClose={closeCreationPreview}
              workflowOrigin={currentPreviewOrigin ? {
                nodeId: currentPreviewOrigin.id, title: workflow?.document.cardNames?.[currentPreviewOrigin.id],
              } : undefined}
              onCreateWorkflowFromAsset={currentPreviewImage && previewAnchorId ? asset => {
                const image = previewGallery.find(item => item.assetId === asset.id) ?? (asset.id === currentPreviewImage.assetId ? currentPreviewImage : undefined);
                if (image) createCardFromImage(image, previewAnchorId);
              } : undefined}
              navigation={previewGallery.length > 1 && previewIndex >= 0 && previewOpenedId
                ? { index: previewIndex, count: previewGallery.length, assetIds: previewGallery.map(image => image.assetId ?? ""),
                  onIndexChange: index => { const image = previewGallery[index]; if (image) setPreviewMember({ openedId: previewOpenedId, nodeId: image.id }); } }
                : undefined} />)}
        {canvasLightbox && (
          lightboxPath && lightboxAudio ? <LibraryVideoPreview asset={lightboxAudio} path={lightboxPath}
            sourceKey={videoSourceKey(lightboxAudio)} projectId={projectId} onClose={() => setCanvasLightbox(null)}
            navigation={{ index: canvasLightbox.index, count: canvasLightbox.images.length,
              onIndexChange: index => setCanvasLightbox(current => current ? { ...current, index } : null) }}/>
          : lightboxPath && lightboxVideo ? <CreationImagePreview asset={lightboxVideo} projectId={projectId} job={lightboxVideoJob}
            workflowOrigin={lightboxOrigin ? { nodeId: lightboxOrigin.id, title: workflow?.document.cardNames?.[lightboxOrigin.id] } : undefined}
            onClose={() => setCanvasLightbox(null)} video={{ path: lightboxPath, sourceKey: videoSourceKey(lightboxVideo), onAddFrame: addVideoFrame, onSaveTrim: saveVideoTrim }}
            navigation={{ index: canvasLightbox.index, count: canvasLightbox.images.length,
              onIndexChange: index => setCanvasLightbox(current => current ? { ...current, index } : null) }}/>
          : <Lightbox
            onAddVideoFrame={addVideoFrame}
            onSaveVideoTrim={saveVideoTrim}
            images={canvasLightbox.images}
            index={canvasLightbox.index}
            onClose={() => setCanvasLightbox(null)}
            onIndexChange={(index) => setCanvasLightbox((current) => current ? { ...current, index } : null)}
          />
        )}
      </section>
      {/* Outside the transformed plane, but inside the project's visibility and interaction boundary. */}
      <div ref={setDiagnosticTarget} data-workflow-diagnostics />
    </div>
  );
}
