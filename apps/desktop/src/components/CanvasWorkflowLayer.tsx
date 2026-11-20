import { userErrorMessage } from "../lib/userError";
import { useProjectChatSummaries, useLocalChatStore } from "../lib/localChatStore";
import { agentChatOptions, localChat, localChatRunning, localChatStatusLabel, type ChatCardDefaults, type ChatProvider } from "../lib/localChat";
import { AgentCardConversation } from "./AgentCardConversation";
import { AgentCardQuestion } from "./AgentCardQuestion";
import { AgentChatControls } from "./AgentChatControls";
import { createdChatTurnCards, terminalDshTurnFailure, workflowAgentProvider } from "../lib/workflowAgentChat";
import { chatDshStatus, chatQuote } from "../lib/chatCapabilities";
import { profileExtractionIssue, profileInputKey, workflowProviderIssue } from "../lib/workflowProviderIssue";
import { useWorkflowLayerIssue } from "./useWorkflowLayerIssue";
import { cloneCanvasClipboard } from "../lib/canvasClipboard";
import type { ProviderIssue } from "../lib/generationAvailability";
import { ProviderIssueNotice } from "./creation/ProviderIssueNotice";
import { ConfirmDialog } from "./ConfirmDialog";
import type { canvasConversationCards } from "../lib/canvasConversationCards";
import { forwardRef, memo, startTransition, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore as useSnapshot } from "zustand";
import { createPortal } from "react-dom";
import { shallow } from "zustand/shallow";
import { Clapperboard, Images, List, MessageCirclePlus, Palette, Play, Repeat2, Sparkles, Square, Timer, Workflow, X, Copy, ImagePlus, MousePointer2, CalendarClock, CheckCheck, ChevronUp } from "lucide-react";
import { api } from "../lib/api";
import { comfyVideoMode, DEFAULT_COMFY_VIDEO } from "../lib/comfyVideo";
import { startComposerLocalVideo } from "../lib/composerLocalVideo";
import { activeCanvasNameCounts, assignCanvasCardNames, canvasCardNameError } from "../lib/canvasCardNames";
import { CanvasCardName } from "./CanvasCardName";
import { CanvasConnectionHandle } from "./CanvasConnectionHandle";
import { ContextMenu, ContextSubmenu } from "./ContextMenu";
import { automaticValueMedia, canvasAutomaticOutputs, workflowAssetMedia, workflowSourceMediaLabel } from "../lib/workflowCanvasCapabilities";
import { planAutomaticConnection, contentCardAcceptsMedia, type AutomaticOutput } from "../lib/workflowAutoConnect";
import { TacticalSelect } from "./TacticalSelect";
import { WorkflowDisconnectMenu, type DisconnectChoice } from "./WorkflowDisconnectMenu";
import { WorkflowLoopCard, WorkflowLoopActions } from "./WorkflowLoopCard";
import { workflowLoopItems, workflowLoopRows } from "../lib/workflowLoop";
import { WorkflowLoopFrame } from "./WorkflowLoopFrame";
import { exceedsCanvasDragThreshold } from "../lib/canvasLogic";
import { WorkflowGenerationReferences, WorkflowMediaThumbnail } from "./WorkflowGenerationReferences";
import { canvasDocumentHeight, expandCanvasSections, readCanvasNote } from "../lib/canvasNotes";
import { contentInputPort } from "../lib/canvasContentInput";
import { contentTableRows } from "../lib/contentTable";
import { canvasInputAssetIds, canvasInputValue, canvasWorkflowInputState, canvasSessionImages, workflowBindingAssetIds, workflowGenerationResultAnchor, hiddenWorkflowSessionIds, workflowSessionIds, completedCanvasSessions, workflowImageGenerationActivity } from "../lib/canvasSessionOutputs";
import { generationProgressLabel } from "../lib/generationProgress";
import { useStore } from "../store";
import { canvasWirePath as path, dragWire, type DragOffset } from "../lib/canvasDragPreview";
import { useWorkflowPortGeometry, type WorkflowPortTarget } from "../lib/useWorkflowPortGeometry";
import { getDragAssets } from "../lib/dragPayload";
import { notifyError, notifySuccess } from "../lib/notify";
import { canvasWorkflowController } from "../lib/canvasWorkflowRuntime";
import { workflowDiagnosticReport } from "../lib/workflowDiagnostics";
import { removeWorkflowNodes, retryWorkflowSave } from "../lib/workflowRemoval";
import { H3_VIDEO_AUDIO_PORT, WORKFLOW_CARD_DRAG_TYPE, workflowDisconnectId, workflowBindingKey, compileGenerationPrompt, selectWorkflowVideoProvider, generationInputNode, generationReferencePreviewOrder, h3RunReferences, lastGenerationRunInput, disconnectGenerationReference, reorderGenerationReferences, isWorkflowGenerationResult, workflowInputValues, workflowOrder } from "../lib/canvasWorkflow";
import { assertWorkflowAcyclic, invalidateWorkflow, newWorkflowNode, normalizeWorkflowInputSlots, workflowNodeRun, workflowRuns, workflowInputProducers, workflowConnectionError, workflowInputs, workflowOutputs,
  workflowPortY, workflowTitle, workflowCardWidth, WORKFLOW_SKILLS, type CanvasWorkflow, type WorkflowInput, type WorkflowKind, type WorkflowLoopItem, type WorkflowNode, type WorkflowPort } from "../lib/canvasWorkflow";
import type { Asset, CanvasNode, VisualProfileSummary } from "../lib/types";
import { H3OptimizationActions } from "./creation/H3OptimizationActions";
import { H3_IMAGE } from "../lib/genProviders";
import { generationPromptNodeId } from "../lib/projectNodeIds";
import { ProviderSelect } from "./creation/ProviderSelect";
import { RatioSelect } from "./creation/RatioSelect";
import { VideoControls } from "./creation/VideoControls";
import { DEFAULT_VIDEO_OPTIONS, isVideoPath, resolveVideoOptions } from "../lib/videoGeneration";
import { materializeVideoFrameOutput, videoFrameInputValues, videoFrameOutputPreview } from "../lib/workflowVideoFrames";
import { isWorkspaceOperationCurrent } from "../lib/workspaceRoute";
import { isAudioPath } from "../lib/audioMedia";
import { CloudAgentSession } from "./CloudAgentPanel";
import { ModalShell } from "./ModalShell";
import { WorkflowPromptEditor } from "./WorkflowPromptEditor";
import { CanvasTextarea } from "./CanvasTextarea";
import { WorkflowDescribeOption } from "./WorkflowDescribeOption";
import { WorkflowTriggerSchedule } from "./WorkflowTriggerSchedule";
import { workflowTriggerMode } from "../lib/workflowTriggerSchedule";
import { WorkflowGenerationHistory } from "./WorkflowGenerationHistory";
import { ComfyEnvironmentControl, ComfyGenerationProgress, ComfyVideoCard, type ComfyEnvironmentState } from "./ComfyVideoCard";
import { VoiceCard } from "./VoiceCard";
import { readVoiceDraft } from "../lib/voiceStudioDraft";
import { VoiceEnvironmentControl } from "./VoiceEnvironmentControl";
import { AudioLines } from "lucide-react";
import { WorkflowPlannerCard } from "./WorkflowPlannerCard";
import { WorkflowTemplateLibrary } from "./WorkflowTemplateLibrary";
import { SaveWorkflowTemplateDialog } from "./SaveWorkflowTemplateDialog";
import "./CanvasWorkflow.css";

function AgentCardIcon({ size }: { size: number }) {
  return <svg className="agent-card-icon" xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 1024 1024">
    <path fill="#1296db" d="M788.96 795.208c3.288-1.72 6.536-3.504 9.76-5.344 8.144-5.104 16.528-9.944 24.408-15.44A319.936 319.936 0 0 0 960 512c0-176.728-143.272-320-320-320H384C207.272 192 64 335.272 64 512s143.408 316.936 320 324c100 4 112 4 192-4v80l72.944-40L672 859.36 788.96 795.2zM225.616 670.4q-32.8-32.8-49.88-75.936Q160 554.72 160 512q0-42.72 15.728-82.456 17.072-43.128 49.88-75.936 32.8-32.8 75.936-49.88Q341.28 288 420 288h200q42.72 0 102.456 15.728 43.128 17.072 75.936 49.88 32.8 32.8 49.88 75.936Q864 469.28 864 512q0 55.424-25.84 104.448C802.056 684.936 664.688 746.944 600 782.416V736c-95.96 14.928-205.128 21.216-298.456-15.728Q258.416 703.2 225.608 670.4zM440 420v120a36 36 0 1 0 72 0v-120a36 36 0 1 0-72 0z m224 0v120a36 36 0 1 0 72 0v-120a36 36 0 1 0-72 0z" />
  </svg>;
}

const WORKFLOW_CARD_PRESENTATION = {
  instruction: { icon: List, code: "CMD", title: "指令处理" },
  generation: { icon: Images, code: "GEN", title: "图片生成" },
  agent: { icon: AgentCardIcon, code: "AGT", title: "Agent" },
  loop: { icon: Repeat2, code: "LOOP", title: "循环处理" },
  "visual-profile": { icon: Palette, code: "VIS", title: "视觉规范" },
  trigger: { icon: Timer, code: "TRG", title: "触发器" },
  director3d: { icon: Clapperboard, code: "3D", title: "3D 导演台" },
  voice: { icon: AudioLines, code: "VOX", title: "角色声音" },
  "comfy-video": { icon: Clapperboard, code: "VID", title: "视频生成" },
  skill: { icon: Sparkles, code: "MOD", title: "技能卡片" },
  planner: { icon: Sparkles, code: "MOD", title: "工作流助手" },
  text: { icon: Workflow, code: "MOD", title: "工作流" },
};
const NEW_AGENT_CHAT_TOOLTIP = "在新建对话中运行指令，消除上下文影响";

type DisconnectTarget = { nodeId: string; port?: string; cellId?: string; wireKey?: string };
const disconnectKey = (node: WorkflowNode, port: string, binding: WorkflowInput) =>
  workflowDisconnectId(binding) ?? JSON.stringify([node.id, port, workflowBindingKey(binding)]);

function comfyCheckKey(node: WorkflowNode) {
  return JSON.stringify([node.id, node.comfyVideo?.endpoint ?? DEFAULT_COMFY_VIDEO.endpoint, comfyVideoMode(node.comfyVideo)]);
}

function isH3ImageCard(node: WorkflowNode) {
  return node.kind === "generation" && node.generation?.media !== "video" && node.provider === H3_IMAGE;
}
function CardComfyEnvironment({ node, disabled, onChange, onStatus }: {
  node: WorkflowNode; disabled: boolean; onChange: (changes: Partial<WorkflowNode>) => void;
  onStatus: (key: string, message: string | null) => void;
}) {
  const key = comfyCheckKey(node);
  const report = useCallback((result: ComfyEnvironmentState) => onStatus(key, result.ready ? null : result.message), [key, onStatus]);
  return <ComfyEnvironmentControl node={node} disabled={disabled} onChange={onChange} onStatusChange={report} />;
}
const TRIGGER_MODES = [
  { id: "manual", label: "手动点击", icon: MousePointer2 },
  { id: "daily", label: "每天定时", icon: CalendarClock },
  { id: "once", label: "一次定时", icon: Timer },
  { id: "completion", label: "上游完成", icon: CheckCheck },
] as const;

export function WindingKey({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 10C9 2 2 4 3 8s6 5 9 2Zm0 0c3-8 10-6 9-2s-6 5-9 2ZM12 10v10m-3 0h6m-3-4h3" />
  </svg>;
}
export interface WorkflowGeometry { id: string; x: number; y: number; width: number; height: number }
export interface WorkflowLayerHandle {
  bindRecording: (nodeId: string, assetId: string, assetNodeId?: string) => boolean;
  startLocalVideo: (request: import("../lib/comfyVideo").ComposerLocalVideoRequest, point: { x: number; y: number }) => Promise<void>;
  templates: (importPackage?: boolean) => void;
  saveTemplate: (ids: string[], mode?: "template" | "package" | "container") => void;
  inputText: (nodeId: string, cellId?: string, disconnect?: boolean, type?: "text" | "image" | "auto", point?: { x: number; y: number }, keyboard?: boolean) => void;
  connectSelection: (nodeIds: string[], clientX: number, clientY: number, keyboard?: boolean) => void;
  connectCell: (nodeId: string, cellId: string, clientX: number, clientY: number, keyboard?: boolean) => void;
  openCardMenu: (x: number, y: number, point: { x: number; y: number }) => void;
  add: (kind: WorkflowKind, x: number, y: number) => void; arm: (x?: number, y?: number) => void;
  cancelPlacement: () => void;
  bounds: (includeHidden?: boolean) => WorkflowGeometry[];
  createImageCard: (sourceId: string, assetId: string, point: { x: number; y: number }) => void;
  position: (positions: ReadonlyMap<string, { x: number; y: number }>, persist?: boolean) => void;
  isLocked: (id: string) => boolean;
}
export interface MaterialAnchor { id: string; assetId?: string; video?: boolean; audio?: boolean; groupId?: string; assetIds?: string[]; mediaAssetIds?: string[]; x: number; y: number; width: number; height: number }
interface Props {
  provisional?: boolean;
  diagnosticTarget?: HTMLElement | null;
  graphNodes: CanvasNode[];
  visibleGraphNodeIds?: ReadonlySet<string>;
  conversationCards?: ReturnType<typeof canvasConversationCards>;
  selectedConversationOutputs?: ReadonlyMap<string, { id: string; video: boolean }>;
  imageOnlyConversationIds?: ReadonlySet<string>;
  sessionHeights?: ReadonlyMap<string, number>;
  imageCardAnchors?: ReadonlyMap<string, CanvasNode>;
  expandedImageCards?: ReadonlyMap<string, { x: number; y: number }>;
  onCollapseImageCard?: (nodeId: string) => void;
  selectedIds: Set<string>;
  panReady: boolean;
  onSelect: (id: string, additive?: boolean) => void;
  onNodesChanged: () => void;
  onEdited: (before: CanvasWorkflow, after: CanvasWorkflow) => void;
  onOpenGeneration: (node: CanvasNode) => void;
  getChatCardDefaults?: () => ChatCardDefaults;
  onOpenAgent: (nodeId: string, conversationId?: string, entryKey?: string) => void;
  onNewAgentChat?: (previousId: string) => void;
  onDragStart: (event: React.PointerEvent<HTMLElement>, node: WorkflowNode) => void;
  onDragMove: (event: React.PointerEvent<HTMLElement>) => void;
  onDragEnd: (event: React.PointerEvent<HTMLElement>, cancelled?: boolean) => void;
  onNodeMenu: (event: React.MouseEvent<HTMLElement>, id: string) => void;
  onRemove: (id: string) => void;
  projectId: string; zoom?: number; materials: MaterialAnchor[];
  ensureMaterialized: () => Promise<unknown>;
  toBoardPoint: (clientX: number, clientY: number) => { x: number; y: number };
  onPlaced: (rect: { x: number; y: number; width: number; height: number }) => void;
}
type Connection = WorkflowInput & { type: WorkflowPort["type"] };
type AutomaticTarget = { nodeId?: string; canvasNodeId?: string; cellId?: string };
type PendingConnectionCard = {
  projectId: string; node: WorkflowNode; inputs: WorkflowNode["inputs"]; target: AutomaticTarget; connectionId: string;
};
type AutomaticGesture = { id: string; side: "input" | "output"; outputs: AutomaticOutput[]; target: AutomaticTarget;
  start: { x: number; y: number }; dragged: boolean; latest?: boolean; scope?: string; trigger?: HTMLElement | null };
type VideoReferencePosition = NonNullable<WorkflowInput["videoFrame"]>["position"];
const VIDEO_REFERENCE_OPTIONS = [
  { label: "引用完整视频", frame: undefined },
  { label: "引用首帧画面", frame: "first" },
  { label: "引用尾帧画面", frame: "last" },
] as const;
type VideoReferenceTarget = { output: AutomaticOutput; target: AutomaticTarget; created?: WorkflowNode };
type ConnectionMenuState = { gesture: AutomaticGesture; x: number; y: number; video?: VideoReferenceTarget };

function singleVideoOutput(outputs: AutomaticOutput[]) {
  const [output] = outputs;
  return outputs.length === 1 && !output.selectionWireId && !!output.binding.assetId
    && (output.media === "video" || Array.isArray(output.media) && output.media.length === 1 && output.media[0] === "video")
    ? output : undefined;
}
const CONNECTION_CARDS: { label: string; kind: WorkflowKind; media?: "image" | "video"; action?: WorkflowNode["action"] }[] = [
  { label: "图片生成", kind: "generation", media: "image" }, { label: "视频生成", kind: "generation", media: "video" },
  { label: "图片反推", kind: "instruction", action: "describe" }, { label: "复用提示词", kind: "instruction", action: "reuse" },
  { label: "分层拆分", kind: "instruction", action: "layers" }, { label: "Agent", kind: "agent" },
  { label: "视觉规范", kind: "visual-profile" }, { label: "角色声音", kind: "voice" },
];
function connectionForType(source: Connection, type?: WorkflowPort["type"]): Connection {
  return ["*latest", "*latest-image"].includes(source.cellId ?? "") && (type === "text" || type === "image")
    ? { ...source, cellId: type === "image" ? "*latest-image" : "*latest", type } : source;
}
export const CanvasWorkflowLayer = memo(forwardRef<WorkflowLayerHandle, Props>(function CanvasWorkflowLayer({ projectId, provisional = false, diagnosticTarget = window.document.body, materials, graphNodes, visibleGraphNodeIds, conversationCards, selectedConversationOutputs, imageOnlyConversationIds, sessionHeights, imageCardAnchors, expandedImageCards, onCollapseImageCard, ensureMaterialized, toBoardPoint, onPlaced, selectedIds, panReady, onSelect, onNodesChanged, onEdited, onOpenGeneration, onOpenAgent, getChatCardDefaults, onNewAgentChat, onDragStart, onDragMove, onDragEnd, onNodeMenu, onRemove }, ref) {
  const controller = useMemo(() => canvasWorkflowController(projectId), [projectId]);
  const [, redraw] = useState(0);
  const pendingCards = useRef(new Map<string, PendingConnectionCard>());
  const activeController = useRef<typeof controller | null>(controller);
  const currentSelection = useRef(selectedIds); currentSelection.current = selectedIds;
  useLayoutEffect(() => {
    activeController.current = controller;
    return () => { activeController.current = null; };
  }, [controller]);
  const wireElement = useRef<SVGSVGElement>(null);
  const draftElement = useRef<SVGPathElement>(null);
  const ghostElement = useRef<HTMLDivElement>(null);
  const cardElements = useRef(new Map<string, HTMLElement>());
  const agentDetailPress = useRef<{ nodeId: string; x: number; y: number } | null>(null);
  const cardHeights = useRef(new Map<string, number>());
  const nodesChanged = useRef(onNodesChanged); nodesChanged.current = onNodesChanged;
  const [armed, setArmed] = useState(false);
  const cursor = useRef({ x: 0, y: 0 });
  const cursorFrame = useRef(0);
  const updateCursor = useRef(() => {});
  function setCursor(point: { x: number; y: number }) {
    cursor.current = point;
    if (!cursorFrame.current) cursorFrame.current = requestAnimationFrame(() => {
      cursorFrame.current = 0; updateCursor.current();
    });
  }
  useEffect(() => () => cancelAnimationFrame(cursorFrame.current), []);
  const [connection, setConnection] = useState<Connection | null>(null);
  const connectionRef = useRef(connection); connectionRef.current = connection;
  const [automatic, setAutomatic] = useState<AutomaticGesture | null>(null);
  const automaticPressTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(automaticPressTimer.current), []);
  const automaticRef = useRef<AutomaticGesture | null>(null);
  const swallowAutomaticClick = useRef(false);
  const [connectionMenu, setConnectionMenu] = useState<ConnectionMenuState | null>(null);
  const [blankCardMenu, setBlankCardMenu] = useState<{ x: number; y: number; point: { x: number; y: number } } | null>(null);
  const cardMenu = connectionMenu ?? blankCardMenu;
  const videoConnection = connectionMenu?.video;
  const [connectionHover, setConnectionHover] = useState<{ id: string; error: string | null } | null>(null);
  const connectionHoverRef = useRef(connectionHover);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [agentOpen, setAgentOpen] = useState(false);
  const [retryReview, setRetryReview] = useState<{ projectId: string; cardNames: string[]; confirm: () => Promise<void> } | null>(null);
  const [localRunReview, setLocalRunReview] = useState<{ projectId: string; nodeId: string; single: boolean } | null>(null);
  const agentActionLocks = useRef(new Set<string>());
  const [pendingAgentCards, setPendingAgentCards] = useState<ReadonlySet<string>>(() => new Set());
  const [templateLibrary, setTemplateLibrary] = useState<{ instanceRoot?: string; importPackage?: boolean } | null>(null);
  const [templateSelection, setTemplateSelection] = useState<{ projectId: string; ids: string[]; nodes: WorkflowNode[]; canvas: CanvasNode[]; bounds: WorkflowGeometry[]; mode: "template" | "container" | "package" } | null>(null);
  const [keyHover, setKeyHover] = useState<{ id: string; x: number; y: number; anchor: HTMLElement; rect: DOMRect; focus: boolean } | null>(null);
  const [disconnectMenu, setDisconnectMenu] = useState<({ x: number; y: number } & DisconnectTarget) | null>(null);
  const [profiles, setProfiles] = useState<VisualProfileSummary[]>([]);
  const hoveredMaterialRef = useRef<string | null>(null);
  const hoveredHotspot = useRef<Element | null>(null);
  const hoveredMaterial = hoveredMaterialRef.current;
  const state = useStore(state => ({ visualProfiles: state.visualProfiles, activeGenProvider: state.activeGenProvider,
    defaultProvider: state.defaultProvider, codexHealth: state.codexHealth, dreaminaHealth: state.dreaminaHealth,
    cloudAuth: state.cloudAuth, cloudEntitlement: state.cloudEntitlement, openVisualProfile: state.openVisualProfile }), shallow);
  const document = controller.document;
  const genJobs = useStore(state => state.genJobs);
  const chatSummaries = useProjectChatSummaries(projectId);
  const activeVideoJobs = useStore(state => Object.values(state.genJobs).filter(job => job.media === "video" && job.running).map(job => job.id), shallow);
  const h3AutoOptimize = useStore(state => state.settings?.h3_auto_optimize_prompt === true);
  const quote = useSnapshot(chatQuote.store), dsh = useSnapshot(chatDshStatus.store);
  const [voiceIssue, setVoiceIssue] = useState<string | null>("正在检查本机配音环境…");
  const [comfyIssues, setComfyIssues] = useState<Record<string, string | null>>({});
  const reportComfy = useCallback((key: string, message: string | null) => {
    setComfyIssues(previous => previous[key] === message ? previous : { ...previous, [key]: message });
  }, []);
  const serviceIssues = useMemo(() => {
    const byId = new Map<string, ProviderIssue>();
    for (const node of document.nodes) {
      const chat = node.kind !== "agent" ? undefined : node.chatConversationId ? chatSummaries[node.chatConversationId]
        : Object.values(chatSummaries).find(chat => chat.projectId === projectId && chat.nodeId === node.id);
      const issue = workflowProviderIssue(node, state, chat?.provider, quote, dsh);
      if (issue) byId.set(node.id, issue);
      else if (node.kind === "voice" && voiceIssue) byId.set(node.id, { message: voiceIssue });
      else if (node.kind === "comfy-video" && comfyIssues[comfyCheckKey(node)] !== null) {
        byId.set(node.id, { message: comfyIssues[comfyCheckKey(node)] ?? "正在检查本地 H3 视频环境…" });
      }
    }
    return byId;
  }, [document.nodes, state, chatSummaries, projectId, quote, dsh, comfyIssues, voiceIssue]);
  const nodeById = useMemo(() => new Map(document.nodes.map(node => [node.id, node])), [document.nodes]);
  // Pending cards are a view of an in-flight gesture. Only validated nodes enter saves and undo.
  const pending = [...pendingCards.current.values()].filter(card => card.projectId === projectId && !nodeById.has(card.node.id));
  const renderedNodes = pending.length ? [...document.nodes, ...pending.map(({ node, inputs }) => ({ ...node, inputs }))] : document.nodes;
  const collapsedAnchor = (id: string) => expandedImageCards?.has(id) ? undefined : imageCardAnchors?.get(id);
  const collapsedAnchorIds = new Set([...(imageCardAnchors ?? [])].filter(([id]) => !expandedImageCards?.has(id)).map(([, anchor]) => anchor.id));
  const displayPoint = (node: WorkflowNode) => {
    const offset = expandedImageCards?.get(node.id);
    return offset ? { x: node.x + offset.x, y: node.y + offset.y } : node;
  };
  const generationResultAnchors = useMemo(() => new Map(document.nodes
    .filter(node => (node.kind === "generation" || node.kind === "comfy-video") && node.outputs.image)
    .map(node => [node.id, workflowGenerationResultAnchor(node, graphNodes, conversationCards)])), [document.nodes, graphNodes, conversationCards]);
  const graphById = useMemo(() => new Map(graphNodes.filter(node => node.hiddenAt == null).map(node => [node.id, node])), [graphNodes]);
  // Keep history available to bindings; only visible cards receive names and hover targets.
  const visibleGraphNodes = useMemo(() => visibleGraphNodeIds ? graphNodes.filter(node => visibleGraphNodeIds.has(node.id)) : graphNodes, [graphNodes, visibleGraphNodeIds]);
  const placedAudioAssets = useMemo(() => new Set(graphNodes.flatMap(item => item.kind === "asset" && item.hiddenAt == null && item.assetId ? [item.assetId] : [])), [graphNodes]);
  const materialById = useMemo(() => new Map(materials.map(item => [item.id, item])), [materials]);
  const groupById = useMemo(() => new Map(materials.filter(item => item.groupId).map(item => [item.groupId!, item])), [materials]);
  const materialByAsset = useMemo(() => {
    const result = new Map<string, MaterialAnchor>();
    for (const item of materials) if (item.assetId && !result.has(item.assetId)) result.set(item.assetId, item);
    return result;
  }, [materials]);
  const sessionOwners = useMemo(() => {
    const result = new Map<string, WorkflowNode>();
    for (const node of document.nodes) for (const id of workflowSessionIds([node])) {
      if ((hiddenWorkflowSessionIds([node]).has(id) || conversationCards?.routedIds.has(id)) && !result.has(id)) result.set(id, node);
    }
    return result;
  }, [document.nodes, conversationCards]);
  const portTargets: WorkflowPortTarget[] = [];
  const addPort = (id: string | undefined, kind: WorkflowPortTarget["kind"], port: string | undefined, image = false) => {
    const node = id && graphById.get(id);
    if (node && node.kind === "note" && port !== undefined) portTargets.push({ node, kind, port, image });
  };
  const sourcePort = (binding: WorkflowInput) => {
    if (binding.canvasNodeId && binding.cellId) addPort(binding.canvasNodeId, "cell", binding.cellId);
    if (binding.canvasNodeId) addPort(binding.canvasNodeId, "output", binding.cellId === "*latest-image" ? "*latest" : binding.cellId);
    const producer = binding.nodeId ? nodeById.get(binding.nodeId) : undefined;
    if (producer?.textTarget) addPort(producer.textTarget.nodeId, "output", producer.textTarget.image ? "*" : "*text");
  };
  for (const node of document.nodes) for (const [port, inputs] of Object.entries(node.inputs)) {
    for (const binding of inputs) sourcePort(binding);
    if (inputs.length && node.textTarget) {
      const target = graphById.get(node.textTarget.nodeId);
      if (target && node.textTarget.cellId) addPort(target.id, "cell", node.textTarget.cellId);
      if (target) addPort(target.id, "input", contentInputPort(readCanvasNote(target), node.textTarget), port === "image");
    }
  }
  for (const target of conversationCards?.embedded.values() ?? []) addPort(target.nodeId, "cell", target.cellId);
  if (connection) sourcePort(connection);
  if (automatic?.scope) addPort(automatic.id, "cell", automatic.scope);
  if (automatic) addPort(automatic.id, automatic.side === "output" ? "output" : "input", "*auto");
  const videoCardIds = new Set(materials.filter(item => item.video).map(item => item.id));
  const audioCardIds = new Set(materials.filter(item => item.audio).map(item => item.id));
  const nameCards = [
    ...document.nodes.filter(node => !node.textTarget && !node.textSource).map(node => ({ id: node.id, title: workflowTitle(node) })),
    ...graphNodes.map(node => ({ id: node.id, title: node.kind === "note" ? (readCanvasNote(node).artboard ? "画板" : { text: "内容卡片", images: "内容卡片", document: "文本卡片", bubble: "气泡", section: "分区" }[readCanvasNote(node).note_type] ?? "内容卡片") : node.kind === "asset" ? audioCardIds.has(node.id) ? "音频卡片" : videoCardIds.has(node.id) ? "视频卡片" : "图片卡片" : "会话卡片" })),
    ...materials.filter(item => item.groupId).map(item => ({ id: item.groupId!, title: "素材组" })),
  ];
  const cardNames = assignCanvasCardNames(document.cardNames, nameCards);
  const renderedNames = pending.length ? assignCanvasCardNames(cardNames, pending.map(({ node }) => ({ id: node.id, title: workflowTitle(node) }))) : cardNames;
  const activeNameIds = new Set([
    ...document.nodes.filter(node => !node.textTarget && !node.textSource).map(node => node.id),
    ...graphNodes.filter(node => node.hiddenAt == null).map(node => node.id),
    ...materials.flatMap(item => item.groupId ? [item.groupId] : []),
  ]);
  const nameCounts = activeCanvasNameCounts(cardNames, activeNameIds);
  function nameEditor(id: string, style?: React.CSSProperties, busy = false, section = false) {
    return <CanvasCardName key={`name-${id}`} id={id} name={renderedNames[id]} names={renderedNames} activeIds={activeNameIds} nameCounts={nameCounts} style={style}
      sectionMenu={section ? onNodeMenu : undefined} disabled={!controller.ready || !!controller.error || busy} onSave={async name => {
        const current = assignCanvasCardNames(controller.document.cardNames, nameCards);
        const error = canvasCardNameError(id, name, current, activeNameIds);
        if (error) throw new Error(error);
        const before = controller.document;
        await controller.save({ ...before, cardNames: { ...current, [id]: name } });
        onEdited(before, controller.document);
      }} />;
  }
  useEffect(() => {
    if (!controller.ready || controller.error || provisional || JSON.stringify(cardNames) === JSON.stringify(document.cardNames ?? {})) return;
    handle(controller.save({ ...controller.document, cardNames }));
  }, [controller, document, graphNodes, materials, provisional]);
  const sessionIds = hiddenWorkflowSessionIds(document.nodes);
  const issue = controller.issue;
  const deliveryRunIds = new Set(workflowRuns(document).filter(run => {
    if (run.status !== "waiting" || run.loop) return false;
    const failed = run.order.filter(id => run.steps[id]?.status === "failed");
    const pending = failed.length ? failed : run.order.filter(id => run.steps[id]?.status !== "done").slice(0, 1);
    return pending.length > 0 && pending.every(id => document.nodes.some(node => node.id === id && node.textTarget));
  }).map(run => run.id));
  const nodeDiagnostic = (nodeId: string) => {
    const failure = controller.cardFailure(nodeId);
    return failure?.dismissed ? undefined : failure?.diagnostic;
  };
  const issueSourceId = issue?.source?.nodeId ?? issue?.source?.canvasNodeId ?? issue?.source?.assetNodeId;
  const issueSourceLabel = (() => {
    if (!issue?.source) return "";
    const sourceNode = document.nodes.find(node => node.id === issueSourceId);
    if (sourceNode) return cardNames[sourceNode.textSource ?? sourceNode.id] ?? workflowTitle(sourceNode);
    const source = graphNodes.find(node => node.id === issueSourceId && node.hiddenAt == null);
    if (source?.kind === "note") {
      const note = readCanvasNote(source), cellId = issue.source.cellId;
      const row = note.cells.findIndex(row => row.some(cell => cell.id === cellId));
      const column = row >= 0 ? note.cells[row].findIndex(cell => cell.id === cellId) : -1;
      return `${cardNames[source.id] ?? "内容卡片"} · ${row >= 0 ? `第 ${row + 1} 行，第 ${column + 1} 列` : cellId === "*" ? "全部图片" : cellId === "*text" ? "全部文本" : cellId?.startsWith("*latest") ? "输出最新" : "目标单元格已删除"}`;
    }
    return issue.source.canvasNodeId ? "来源内容卡片当前不可定位" : "";
  })();
  const locateIssue = (id: string) => {
    const workflow = document.nodes.find(node => node.id === id);
    const tableId = workflow?.textTarget?.nodeId ?? workflow?.textSource;
    const table = graphNodes.find(node => node.id === (tableId ?? id) && node.hiddenAt == null);
    if (table) { onSelect(table.id); onPlaced(table); }
    else if (workflow) { onSelect(workflow.id); onPlaced({ ...workflow, width: workflowCardWidth(workflow), height: cardElements.current.get(id)?.offsetHeight ?? 400 }); }
  };
  const sourceImages = useCallback((input: WorkflowInput): string[] => {
    if (input.groupId) { const group = groupById.get(input.groupId); return (input.autoConnect || input.mediaFilter?.includes("audio") ? group?.mediaAssetIds : group?.assetIds) ?? group?.assetIds ?? []; }
    return workflowBindingAssetIds(input, nodeById.get(input.nodeId ?? ""), graphById.get(input.canvasNodeId ?? ""), graphNodes);
  }, [groupById, graphById, graphNodes, nodeById]);
  const inputImages = useCallback((input: WorkflowInput) => {
    const ids = sourceImages(input);
    return input.excludedAssetIds?.length ? ids.filter(id => !input.excludedAssetIds!.includes(id)) : ids;
  }, [sourceImages]);
  function inputMediaLabel(binding: WorkflowInput) {
    return workflowSourceMediaLabel(inputImages(binding), assets, nodeById.get(binding.nodeId ?? ""));
  }
  function portMediaLabel(bindings: WorkflowInput[]) {
    const label = inputMediaLabel(bindings[0]);
    return bindings.slice(1).every(binding => inputMediaLabel(binding) === label) ? label : "素材";
  }
  function referencePreviewValues(node: WorkflowNode, includeText = false) {
    return {
      image: (node.inputs.image ?? []).map(input => ({ type: "image" as const, assetIds: sourceImages(input) })),
      text: (node.inputs.text ?? []).map(input => {
        const card = graphById.get(input.canvasNodeId ?? "");
        const value = includeText ? (card ? canvasInputValue(card, input.cellId ?? "", graphNodes) : nodeById.get(input.nodeId ?? "")?.outputs[input.portId ?? ""]) : undefined;
        return { ...value, type: "text" as const, assetIds: sourceImages(input) };
      }),
    };
  }
  function disconnectReference(nodeId: string, assetId: string) {
    const current = controller.document.nodes.find(node => node.id === nodeId);
    if (!current || (current.kind !== "generation" && current.kind !== "agent") || controller.isLocked(nodeId)) return;
    patch(nodeId, disconnectGenerationReference(current, referencePreviewValues(current, true), assetId));
  }
  function moveReference(nodeId: string, fromId: string, toId: string) {
    const current = controller.document.nodes.find(node => node.id === nodeId);
    if (!current || (current.kind !== "generation" && current.kind !== "agent") || controller.isLocked(nodeId)) return;
    const values = referencePreviewValues(current);
    const order = generationReferencePreviewOrder(current, values, controller.document.nodes);
    const from = order.indexOf(fromId), to = order.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return;
    order.splice(from, 1);
    order.splice(to, 0, fromId);
    patch(nodeId, { inputs: reorderGenerationReferences(current, values, order) });
  }
  const layerInputs = useMemo(() => document.nodes.flatMap(node => {
    if (node.kind !== "instruction" || node.action !== "layers") return [];
    const ids = (node.inputs.image ?? []).flatMap(inputImages);
    return ids.length === 1 ? [{ nodeId: node.id, assetId: ids[0] }] : [];
  }), [document.nodes, inputImages]);
  const workspaceIds = useStore(state => state.layerWorkspaceIds);
  const layerIssue = useWorkflowLayerIssue(layerInputs.map(input => input.assetId), state.cloudAuth, workspaceIds);
  const providerIssues = useMemo(() => {
    const result = new Map(serviceIssues);
    const extractionIssue = profileExtractionIssue(state);
    if (extractionIssue) for (const node of document.nodes) {
      // Keep connected text, unresolved upstream media and stored profiles readable offline.
      // The runtime compares their fully resolved input before any new extraction.
      if (node.kind !== "visual-profile" || node.profileId || !node.profileCache || node.inputs.text?.length) continue;
      const images = node.inputs.image ?? [];
      if (images.every(input => input.assetId) && profileInputKey(images.map(input => input.assetId!), node.prompt.trim()) !== node.profileCache.inputKey) {
        result.set(node.id, extractionIssue);
      }
    }
    for (const { nodeId, assetId } of layerInputs) {
      const issue = layerIssue(assetId);
      if (issue) result.set(nodeId, issue);
    }
    return result;
  }, [serviceIssues, layerInputs, layerIssue, state, document.nodes]);
  const flowIssues = useMemo(() => {
    const result = new Map<string, ProviderIssue>();
    if (!providerIssues.size) return result;
    for (const node of document.nodes) {
      if (!node.trigger && node.kind !== "trigger" && node.kind !== "loop") continue;
      try {
        const scope = workflowOrder(document.nodes, node.id);
        const blocked = scope.find(id => providerIssues.has(id));
        if (blocked) result.set(node.id, providerIssues.get(blocked)!);
      } catch { /* Connection errors are reported by the controller when the user starts the flow. */ }
    }
    return result;
  }, [document.nodes, providerIssues]);
  const loopPreviews = new Map<string, { items?: WorkflowLoopItem[]; notice: string }>();
  const currentRows = new Map<string, { source: CanvasNode; first: string; last: string; index: number; total: number }>();
  for (const node of document.nodes.filter(node => node.kind === "loop")) {
    try {
      const rows: { first?: string; last?: string }[] = [];
      const items = node.loopMode === "rows"
        ? workflowLoopRows(node, document.nodes, graphNodes, (first, last) => rows.push({ first, last }))
        : workflowLoopItems({ ...node, inputs: { ...node.inputs,
        image: node.inputs.image?.map(input => input.groupId ? { ...input, assetIds: inputImages(input) } : input) ?? [],
      } }, document.nodes, graphNodes);
      loopPreviews.set(node.id, { items, notice: "" });
      const sourceId = node.inputs.text?.[0]?.canvasNodeId;
      const source = sourceId && graphById.get(sourceId);
      const run = workflowNodeRun(document, node.id);
      const loop = run?.loop?.nodeId === node.id ? run.loop : undefined;
      const index = loop ? loop.index : (node.loopStartItem ?? 1) - 1;
      const { first, last } = rows[index] ?? {};
      if (source && first && last && (!loop || (run?.status !== "done" && loop.items &&
        JSON.stringify(loop.items[index]) === JSON.stringify(items[index])))) {
        currentRows.set(node.id, { source, first, last, index, total: loop?.items?.length ?? items.length });
        addPort(source.id, "cell", first);
        addPort(source.id, "cell", last);
      }
    } catch (error) { loopPreviews.set(node.id, { notice: userErrorMessage(error, "暂时无法预览循环内容，请检查输入后重试。") }); }
  }
  const portRect = useWorkflowPortGeometry(wireElement, portTargets);
  const frames = new Map<string, { x: number; y: number; width: number; height: number; index: number; total: number }>();
  for (const [id, row] of currentRows) {
    const first = portRect(row.source, "cell", row.first);
    const last = portRect(row.source, "cell", row.last);
    if (first && last) frames.set(id, { x: first.x - 3, y: first.y, width: last.x + last.width - first.x + 6,
      height: first.height, index: row.index, total: row.total });
  }

  const handle = (promise: Promise<unknown>) => { void promise.catch(error => notifyError(error, "工作流操作未完成")); };
  async function openOptimizationChat(nodeId: string, runId: string) {
    const before = useStore.getState();
    const chat = await localChat.openH3Optimization(projectId, nodeId, runId);
    const current = useStore.getState();
    if (activeController.current !== controller || current.cloudAuth?.user_id !== before.cloudAuth?.user_id
      || !isWorkspaceOperationCurrent(projectId, current.activeProjectId, current.projectRoutePending,
        before.projectRouteRevision, current.projectRouteRevision)) return;
    useLocalChatStore.getState().applyConversation(chat);
    onOpenAgent(nodeId, chat.id);
  }
  function runCard(nodeId: string, single: boolean, confirmed = false) {
    const board = controller.document;
    const node = board.nodes.find(card => card.id === nodeId);
    if (!node || controller.startingAction(nodeId) || controller.isLocked(nodeId)) return;
    if (!confirmed && (node.kind === "comfy-video" || isH3ImageCard(node))) {
      const others = board.nodes.filter(card => card.id !== nodeId);
      const runs = workflowRuns(board);
      const anotherCardRunning = others.some(card => {
        if (card.kind !== "comfy-video" && !isH3ImageCard(card)) return false;
        return controller.startingAction(card.id) === "run" || runs.some(run => {
          const step = run.steps[card.id];
          return run.status === "running" && run.order.includes(card.id)
            && (step?.status === "running" || step?.status === "pending" && run.startId === card.id)
            && (!step.comfyOptimization || !!step.comfyAutoGeneration);
        });
      });
      // Image workflow steps hand off to the generation session before the GPU job finishes.
      const sessions = workflowSessionIds(others);
      const anotherImageJobRunning = Object.values(useStore.getState().genJobs).some(job =>
        job.running && job.provider === H3_IMAGE && job.turns.some(turn =>
          !!turn.turnKey && sessions.has(generationPromptNodeId(job.id, turn.turnKey))));
      if (anotherCardRunning || anotherImageJobRunning) {
        setLocalRunReview({ projectId, nodeId, single });
        return;
      }
    }
    handle(controller.start(nodeId, single));
  }
  const retryLoop = async (runId: string, confirmedRequestIds?: string[]) => {
    const review = await controller.retryLoop(runId, confirmedRequestIds);
    if (review) setRetryReview({ projectId, cardNames: review.cardNames, confirm: () => retryLoop(runId, review.requestIds) });
  };
  async function handleAgentCard(node: WorkflowNode, conversationId: string | undefined, action: "run" | "new" | ChatProvider, confirmedRequestId?: string) {
    const locks = agentActionLocks.current;
    if (locks.has(node.id) || controller.isLocked(node.id)) return;
    const store = useLocalChatStore.getState();
    if (conversationId && localChatRunning(store.summaries[conversationId])) return;
    locks.add(node.id);
    setPendingAgentCards(new Set(locks));
    try {
      if (action === "run") {
        const run = workflowNodeRun(controller.document, node.id);
        const previous = run?.steps[node.id], input = previous?.chatInput;
        if (confirmedRequestId && input?.requestId !== confirmedRequestId) return;
        if (previous?.status === "failed" && previous.chatTurnId && input?.provider === "dsh-local" && previous.chatConversationId === conversationId) {
          const chat = await localChat.getByRequest(input.requestId);
          if (!chat || chat.id !== conversationId || chat.nodeId !== node.id || chat.projectId !== projectId || !chat.submittedTurnId || chat.submittedTurnId !== previous.chatTurnId) {
            throw new Error("无法核对原 Agent 轮次，请打开对话详情查看。");
          }
          if (!confirmedRequestId && terminalDshTurnFailure(chat, chat.submittedTurnId, previous.confirmedFailedChatTurnId)) {
            const cards = createdChatTurnCards(chat, chat.submittedTurnId);
            if (cards.length) {
              setRetryReview({ projectId, cardNames: cards.map(card => card.title), confirm: () => handleAgentCard(node, conversationId, action, input.requestId) });
              return;
            }
          }
        }
        if (conversationId && (store.summaries[conversationId]?.turnCount ?? 0) > 0) {
          await controller.flush();
          const options = store.drafts[conversationId]?.codexOptions ?? store.summaries[conversationId]?.codexOptions ?? node.chatCodexOptions;
          const chat = await localChat.newOnCard(projectId, node.id, conversationId, agentChatOptions(workflowAgentProvider(node), options));
          store.applyConversation(chat);
          await controller.refreshExternalCards();
          if (chat.id !== conversationId) onNewAgentChat?.(conversationId);
        }
        await controller.start(node.id, true);
        return;
      }
      const provider = action === "new" ? undefined : action;
      if (conversationId) {
        await controller.flush();
        const options = provider ? agentChatOptions(provider) : store.drafts[conversationId]?.codexOptions ?? store.summaries[conversationId]?.codexOptions ?? node.chatCodexOptions;
        const chat = await localChat.newOnCard(projectId, node.id, conversationId, options, provider);
        store.applyConversation(chat);
        if (provider && chat.id === conversationId) {
          const draft = useLocalChatStore.getState().drafts[conversationId];
          if (draft) store.setDraft(conversationId, { text: draft.text, referenceAssetIds: draft.referenceAssetIds });
        }
        await controller.refreshExternalCards();
        if (chat.id !== conversationId) onNewAgentChat?.(conversationId);
        if (action === "new") {
          const current = controller.document.nodes.find(card => card.id === node.id);
          if (current?.chatConversationId !== chat.id || workflowAgentProvider(current) !== chat.provider) {
            throw new Error("卡片的对话已切换，请重新打开卡片");
          }
        }
      } else if (provider) {
        patch(node.id, { chatProvider: provider, chatCodexOptions: agentChatOptions(provider), chatDshSkill: undefined });
      } else {
        await controller.flush();
      }
      if (action === "new") notifySuccess("已开启新对话，点击「运行」发送");
    } finally {
      locks.delete(node.id);
      setPendingAgentCards(new Set(locks));
    }
  }
  useEffect(() => {
    const refresh = () => { redraw(value => value + 1); nodesChanged.current(); };
    return controller.subscribe((urgent, promptEditor) => {
      const focused = window.document.activeElement;
      if (promptEditor && focused?.matches(".comfy-video-prompt") && focused.closest<HTMLElement>("[data-workflow-card]")?.dataset.workflowCard === promptEditor) return;
      if (urgent) { redraw(value => value + 1); return; }
      // A save acknowledgement arrives outside the input event's transition.
      if (focused?.closest(".workflow-card textarea, .workflow-card [contenteditable=true]")) startTransition(refresh);
      else refresh();
    });
  }, [controller]);
  useEffect(() => { handle(controller.syncCanvasReferences(graphNodes)); }, [controller, graphNodes]);
  useEffect(() => { setConnection(null); setArmed(false); clearAutomatic(); setAgentOpen(false); setKeyHover(null); setTemplateLibrary(null); setTemplateSelection(null); setDisconnectMenu(null); setLocalRunReview(null); }, [projectId]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.workflowCard!;
        const height = entry.borderBoxSize[0]?.blockSize ?? (entry.target as HTMLElement).offsetHeight;
        controller.measureCard(id, (entry.target as HTMLElement).offsetWidth, height);
        if (cardHeights.current.get(id) !== height) { cardHeights.current.set(id, height); changed = true; }
      }
      if (changed) redraw(value => value + 1);
    });
    for (const card of cardElements.current.values()) observer.observe(card);
    return () => observer.disconnect();
  }, [document.nodes]);
  useEffect(() => {
    if (!keyHover) return;
    const close = () => setKeyHover(null);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    // A captured pointer, removed key, or canvas transform need not emit mouseleave.
    // Keep the portal tied to the actual anchor for its entire visible lifetime.
    const { anchor, rect, focus } = keyHover;
    let frame = 0;
    const checkAnchor = () => {
      const current = anchor.getBoundingClientRect();
      if (!anchor.isConnected || !anchor.matches(focus ? ":focus-visible" : ":hover")
        || current.x !== rect.x || current.y !== rect.y || current.width !== rect.width || current.height !== rect.height) {
        close(); return;
      }
      frame = requestAnimationFrame(checkAnchor);
    };
    frame = requestAnimationFrame(checkAnchor);
    const dismissEvents = ["pointerdown", "pointercancel", "dragstart", "wheel", "scroll", "resize", "blur"] as const;
    dismissEvents.forEach(type => window.addEventListener(type, close, true));
    window.addEventListener("keydown", escape, true);
    window.document.addEventListener("pointerleave", close);
    return () => {
      cancelAnimationFrame(frame);
      dismissEvents.forEach(type => window.removeEventListener(type, close, true));
      window.removeEventListener("keydown", escape, true);
      window.document.removeEventListener("pointerleave", close);
    };
  }, [keyHover]);
  useEffect(() => {
    let alive = true;
    void api.visualProfileList(null).then(list => { if (alive) setProfiles(list.filter(p => p.status === "confirmed")); }).catch(() => {});
    return () => { alive = false; };
  }, [state.visualProfiles, projectId]);
  const automaticAssetIds = useMemo(() => [
    ...materials.flatMap(item => item.groupId ? item.mediaAssetIds ?? item.assetIds ?? [] : item.assetId ? [item.assetId] : []),
    ...graphNodes.filter(node => node.kind === "note" && node.hiddenAt == null).flatMap(node =>
      canvasInputAssetIds(node, "*text", graphNodes)),
  ], [graphNodes, materials]);
  const assetKey = [...new Set([...automaticAssetIds, ...[...loopPreviews.values()].flatMap(preview => preview.items?.flatMap(item => item.assetIds) ?? []), ...workflowRuns(document).flatMap(run => [...(run.loop?.items?.flatMap(item => item.assetIds) ?? []), ...(run.loop?.completed.flatMap(item => Object.values(item.outputs).flatMap(outputs => Object.values(outputs).flatMap(value => value.assetIds ?? []))) ?? [])]), ...document.nodes.flatMap(node => [
    ...Object.values(node.inputs).flat().flatMap(inputImages),
    ...Object.values(node.outputs).flatMap(output => output.assetIds ?? []),
  ]), ...graphNodes.filter(node => node.kind === "asset" && node.role === "output").flatMap(node => node.assetId ? [node.assetId] : [])])].sort().join("|");
  useEffect(() => {
    let current = true;
    void api.getAssetsByIds(assetKey ? assetKey.split("|") : []).then(value => { if (current) setAssets(value); }).catch(() => {});
    return () => { current = false; };
  }, [assetKey]);

  function edit(nodes: WorkflowNode[], draftNodeId?: string, editorOnly = false) {
    const before = controller.document;
    const pending = controller.edit(nodes, undefined, draftNodeId, editorOnly);
    // edit validates locks before synchronously applying its optimistic snapshot.
    if (controller.document !== before) onEdited(before, controller.document);
    return pending;
  }
  function patch(id: string, update: Partial<WorkflowNode>, invalidate = true) {
    const draft = pendingCards.current.get(id);
    if (draft && !controller.document.nodes.some(node => node.id === id)) {
      Object.assign(draft.node, update);
      redraw(value => value + 1);
      return;
    }
    const previous = controller.document.nodes;
    const nodes = previous.map(node => node.id === id ? { ...node, ...update } : node);
    const promptOnly = Object.keys(update).length === 1 && typeof update.prompt === "string";
    const next = invalidate && (!promptOnly || previous.some(node => Object.keys(node.outputs).length))
      ? invalidateWorkflow(nodes, id) : nodes;
    const edited = promptOnly && previous.find(node => node.id === id);
    const lastPrompt = edited && edited.kind === "comfy-video" ? lastGenerationRunInput(controller.document, id)?.prompt : undefined;
    // Native typing paints this field. Other cards only change when an output
    // is invalidated, or the draft changes an available action.
    const editorOnly = !!edited && edited.kind === "comfy-video" && !!edited.prompt.trim() === !!update.prompt!.trim()
      && (edited.prompt === lastPrompt) === (update.prompt === lastPrompt)
      && !previous.some((node, index) => node.outputs !== next[index].outputs && Object.keys(node.outputs).length > 0);
    const saved = edit(next, promptOnly ? id : undefined, editorOnly);
    handle(saved.then(() => {
      if (promptOnly) {
        const current = controller.document.nodes.find(node => node.id === id);
        if (current?.kind === "comfy-video" || current?.prompt !== update.prompt) return;
      }
      return controller.syncCanvasReferences(graphNodes);
    }));
  }
  function sourceLabel(binding: WorkflowInput) {
    if (binding.dimension) return { label: "维度文本 · " + binding.dimension.title, detail: binding.dimension.body };
    const workflow = document.nodes.find(node => node.id === binding.nodeId);
    const id = workflow?.textSource ?? binding.nodeId ?? binding.canvasNodeId ?? binding.assetNodeId ?? binding.groupId
      ?? materials.find(item => item.assetId === binding.assetId)?.id;
    const native = graphNodes.find(node => node.id === binding.canvasNodeId);
    const label = (id && cardNames[id]) || assets.find(asset => asset.id === binding.assetId)?.name || "来源已移除";
    if (binding.videoFrame) return { label, detail: binding.videoFrame.position === "first" ? "首帧画面" : "尾帧画面" };
    const media = inputMediaLabel(binding);
    let detail = workflow ? workflowOutputs(workflow).find(port => port.id === binding.portId)?.label ?? "输出" : binding.groupId ? `全部${media}` : media;
    if (binding.portId === "image" && /图片/.test(detail)) detail = detail.replace("图片", media);
    if (native?.kind === "note") {
      const note = readCanvasNote(native);
      const row = note.cells.findIndex(row => row.some(cell => cell.id === binding.cellId));
      const column = row < 0 ? -1 : note.cells[row].findIndex(cell => cell.id === binding.cellId);
      detail = row >= 0 ? `第 ${row + 1} 行，第 ${column + 1} 列` : binding.cellId === "*" ? `全部${media}` : binding.cellId === "*text" ? "全部文本" : binding.cellId?.startsWith("*latest") ? "输出最新" : "单元格已删除";
    }
    return { label, detail };
  }
  function selectedMediaOutputs(id: string) {
    const selected = selectedConversationOutputs?.get(id);
    if (!selected) return;
    const outputs = canvasAutomaticOutputs(selected.id, controller.document.nodes, graphNodes, materials, assets);
    return selected.video ? outputs.map(output => ({ ...output, media: "video" as const })) : outputs;
  }
  function automaticOutputs(id: string, latest = false) {
    const selected = selectedMediaOutputs(id);
    if (selected) return selected;
    const group = conversationCards?.cards.get(id);
    const sourceId = group?.latest.kind === "prompt" ? group.latest.id : id;
    return canvasAutomaticOutputs(sourceId, controller.document.nodes, graphNodes, materials, assets, latest).map(output => {
      const member = output.binding.assetNodeId && conversationCards?.cards.get(output.binding.assetNodeId)?.outputs
        .find(node => node.assetId === output.binding.assetId);
      return member ? { ...output, binding: { ...output.binding, assetNodeId: member.id } } : output;
    });
  }
  function automaticTarget(id: string): AutomaticTarget {
    return controller.document.nodes.some(node => node.id === id) ? { nodeId: id } : { canvasNodeId: id };
  }
  function gestureOutputs(gesture: AutomaticGesture, otherId: string) {
    if (gesture.side === "output") return gesture.outputs;
    if (nodeById.get(gesture.id)?.kind === "trigger") {
      const anchor = conversationCards?.cards.get(otherId)?.anchor;
      if (anchor?.kind === "prompt") return [{ type: "image" as const, binding: { canvasNodeId: anchor.id, cellId: "image" } }];
    }
    return automaticOutputs(otherId);
  }
  function clearAutomatic() {
    window.clearTimeout(automaticPressTimer.current);
    automaticRef.current = null; setAutomatic(null); setConnectionMenu(null);
    connectionHoverRef.current = null; setConnectionHover(null);
  }
  function startAutomaticDrag(gesture: AutomaticGesture) {
    window.clearTimeout(automaticPressTimer.current);
    const dragging = { ...gesture, dragged: true };
    automaticRef.current = dragging; setAutomatic(dragging);
  }
  function beginAutomatic(id: string, side: AutomaticGesture["side"], point: { x: number; y: number }, keyboard = false, latest = false, scope?: string, selectionOutputs?: AutomaticOutput[]) {
    if (panReady || !controller.ready) return;
    clearAutomatic();
    setConnection(null); connectionRef.current = null; setArmed(false); setDisconnectMenu(null);
    const gesture: AutomaticGesture = { id, side, outputs: selectionOutputs ?? (side === "output" ? automaticOutputs(id, latest) : []),
      target: automaticTarget(id), start: point, dragged: false, latest,
      trigger: window.document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>(".canvas-connection-handle,[data-workflow-input]") };
    if (side === "output" && !gesture.outputs.length) return;
    if (scope) Object.assign(gesture, scopedAutomatic(gesture, scope));
    automaticRef.current = gesture; setAutomatic(gesture); setCursor(point);
    setConnectionMenu(keyboard ? { gesture, ...point } : null);
    if (!keyboard) automaticPressTimer.current = window.setTimeout(() => {
      if (automaticRef.current === gesture) startAutomaticDrag(gesture);
    }, 180);
  }
  useEffect(() => {
    function startDimension(event: Event) {
      if (useStore.getState().activeProjectId !== projectId || panReady || !controller.ready) return;
      const { assetId, nodeId, section, start } = (event as CustomEvent<{
        assetId: string; nodeId?: string; section: NonNullable<WorkflowInput["dimension"]>; start: { x: number; y: number };
      }>).detail;
      const material = nodeId ? materialById.get(nodeId) : materialByAsset.get(assetId);
      const assetNodeId = material?.assetId === assetId ? material.id : graphNodes.find(node => node.id === nodeId && node.assetId === assetId)?.id;
      const binding = { assetId, assetNodeId };
      clearAutomatic();
      setConnection(null); connectionRef.current = null; setArmed(false); setDisconnectMenu(null);
      startAutomaticDrag({ id: nodeId ?? assetNodeId ?? assetId, side: "output", start, dragged: true, latest: false,
        target: {}, outputs: [{ type: "text", binding: { ...binding, dimension: section } }, { type: "image", media: "image", binding }] });
      setCursor(start);
      event.preventDefault();
    }
    window.addEventListener("bowerbird://dimension-wire", startDimension);
    return () => window.removeEventListener("bowerbird://dimension-wire", startDimension);
  }, [projectId, panReady, controller, materialById, materialByAsset, graphNodes]);

  function lockedOutput(outputs: AutomaticOutput[], extractFrame = false) {
    return outputs.some(({ binding }) => [binding.nodeId, binding.canvasNodeId, binding.assetNodeId,
      ...workflowInputProducers(controller.document.nodes, binding)]
      .some(id => id && (extractFrame ? controller.isLocked(id) : controller.isWriteLocked(id))));
  }
  function automaticError(outputs: AutomaticOutput[], target: AutomaticTarget) {
    const controlWire = nodeById.get(target.nodeId ?? "")?.kind === "trigger" || outputs.length > 0 && outputs.every(output => output.type === "signal");
    if (!controlWire && lockedOutput(outputs)) return "来源卡片正在使用";
    if (target.nodeId) {
      if (controller.isLocked(target.nodeId) && !controlWire) return "这张卡片正在运行";
      return planAutomaticConnection(controller.document.nodes, outputs, target.nodeId).error;
    }
    const card = graphById.get(target.canvasNodeId ?? "");
    if (!card || card.kind !== "note" || !["text", "images"].includes(readCanvasNote(card).note_type)) return "这张卡片不能接收内容";
    if (controller.isLocked(card.id)) return "这张卡片正在使用";
    if (outputs.some(output => output.binding.canvasNodeId === card.id || output.binding.assetNodeId === card.id)) return "不能连接卡片自身";
    const note = readCanvasNote(card), axis = /^(row|column):/.test(target.cellId ?? "");
    const cell = target.cellId && !axis ? note.cells.flat().find(cell => cell.id === target.cellId) : undefined;
    if (target.cellId && !axis && !cell) return "接收位置已删除";
    const compatible = outputs.filter(output => (output.type === "text" || output.type === "image")
      && (!cell || output.type === (cell.content_type ?? "text")) && (note.note_type !== "images" || output.type === "image")
      && contentCardAcceptsMedia(output));
    if (outputs.some(output => output.selectionWireId) && compatible.length !== outputs.length) return "此位置无法接收全部选中的素材";
    if (!compatible.length) return "没有可接收的内容";
    if (cell && controller.document.nodes.some(node => node.textTarget?.nodeId === card.id && node.textTarget.cellId === cell.id
      && !compatible.some(output => Object.values(node.inputs).flat().some(input => workflowBindingKey(input) === workflowBindingKey(output.binding))))) return "此位置已有输入，请先断开原连接";
    return null;
  }
  function videoReferenceError(video: VideoReferenceTarget, frame?: VideoReferencePosition) {
    const output = frame ? videoFrameOutputPreview(video.output, frame) : video.output;
    if ((frame || video.created) && lockedOutput([output], !!frame)) return "来源卡片正在使用";
    if (!video.created) return automaticError([output], video.target);
    return planAutomaticConnection([...controller.document.nodes, video.created], [output], video.created.id).error;
  }
  function receiverError(outputs: AutomaticOutput[], target: AutomaticTarget, created?: WorkflowNode) {
    const video = singleVideoOutput(outputs);
    if (!video) return created ? planAutomaticConnection([...controller.document.nodes, created], outputs, created.id).error : automaticError(outputs, target);
    const reference = { output: video, target, created };
    const fullError = videoReferenceError(reference);
    return fullError && videoReferenceError(reference, "first") && videoReferenceError(reference, "last") ? fullError : null;
  }
  function chooseAutomaticReceiver(gesture: AutomaticGesture, outputs: AutomaticOutput[], target: AutomaticTarget,
    point: { x: number; y: number }, created?: WorkflowNode) {
    const video = singleVideoOutput(outputs);
    if (video) {
      setConnectionMenu({ gesture, ...point, video: { output: video, target, created } });
      connectionHoverRef.current = null; setConnectionHover(null);
    } else commitAutomatic(outputs, target, created ? [created] : []);
  }
  function commitAutomatic(outputs: AutomaticOutput[], target: AutomaticTarget, createNodes: WorkflowNode[] = [], frame?: VideoReferencePosition) {
    clearAutomatic();
    const owner = controller;
    const routeRevision = useStore.getState().projectRouteRevision;
    const sameRoute = () => {
      const state = useStore.getState();
      return activeController.current === owner && isWorkspaceOperationCurrent(projectId, state.activeProjectId,
        state.projectRoutePending, routeRevision, state.projectRouteRevision);
    };
    const created = createNodes[0];
    const connectionId = crypto.randomUUID();
    function publishPending(outputs: AutomaticOutput[]) {
      if (!created) return;
      let inputs = created.inputs;
      if (created.id === target.nodeId) {
        const plan = planAutomaticConnection([...controller.document.nodes, created], outputs, created.id);
        if (plan.error) { notifyError(null, plan.error); return; }
        inputs = { ...inputs };
        for (const { inputId, binding } of plan.bindings) (inputs[inputId] ??= []).push({ ...binding, autoConnect: binding.autoConnect ?? connectionId });
        inputs = normalizeWorkflowInputSlots({ ...created, inputs }).inputs;
      }
      pendingCards.current.set(created.id, { projectId, node: created, inputs, target, connectionId });
      onSelect(created.id);
      redraw(value => value + 1);
    }
    if (!frame) publishPending(outputs);
    handle((async () => {
      try {
        // Native endpoints may still be in the canvas journal. Workflow-only edits use their own queue.
        if (frame || provisional || !target.nodeId || outputs.some(({ binding }) =>
          !binding.nodeId || binding.canvasNodeId || binding.assetNodeId || binding.groupId)) await ensureMaterialized();
        if (frame) {
          if (!sameRoute()) return;
          const [source] = outputs;
          const sourceId = source.binding.assetNodeId;
          if (sourceId) {
            const nodes = await api.projectCanvasVisibleNodes(projectId, [sourceId]);
            if (!nodes.some(node => node.id === sourceId && node.assetId === source.binding.assetId)) throw new Error("来源卡片已不存在");
          }
          const reference = { output: source, target, created };
          const error = videoReferenceError(reference, frame);
          if (error) throw new Error(error);
          const preview = videoFrameOutputPreview(source, frame);
          if (target.nodeId && !created && !planAutomaticConnection(controller.document.nodes, [preview], target.nodeId).bindings.length) return;
          try {
            outputs = [await materializeVideoFrameOutput(projectId, source, frame, sameRoute)];
          } catch (error) {
            if (!sameRoute()) return;
            throw error;
          }
          if (!sameRoute()) return;
          publishPending(outputs);
        }
        await owner.connectAutomatic(outputs, target, {
          createNodes, connectionId, onEdited(before, after) {
            if (created) pendingCards.current.delete(created.id);
            if (activeController.current === owner) onEdited(before, after);
          },
        });
      } finally {
        if (created && pendingCards.current.delete(created.id)) {
          if (activeController.current === owner) {
            if (!owner.document.nodes.some(node => node.id === created.id) && currentSelection.current.has(created.id)) onSelect(created.id, true);
            redraw(value => value + 1);
          }
        }
      }
    })());
  }
  function disconnectAutomatic(id: string) {
    handle((async () => {
      const result = await controller.disconnectAutomatic(id);
      onEdited(result.before, result.after);
    })());
  }
  function disconnectChoices({ nodeId, port: onlyPort, cellId, wireKey }: DisconnectTarget) {
    const card = graphById.get(nodeId);
    const note = card?.kind === "note" ? readCanvasNote(card) : undefined;
    const choices = new Map<string, DisconnectChoice>();
    const inScope = new Set<string>();
    for (const node of controller.document.nodes) {
      const target = node.textTarget;
      if (node.id !== nodeId && target?.nodeId !== nodeId) continue;
      const matchesCell = !cellId || (target && note && (contentInputPort(note, target) === cellId || target.cellId === cellId || target.cellIds?.includes(cellId)));
      let destination = "";
      if (target && note) {
        const row = note.cells.findIndex(line => line.some(cell => cell.id === target.cellId));
        destination = row < 0 ? "新行" : `第 ${row + 1} 行，第 ${note.cells[row].findIndex(cell => cell.id === target.cellId) + 1} 列`;
      }
      for (const [port, bindings] of Object.entries(node.inputs)) for (const binding of bindings) {
        const key = disconnectKey(node, port, binding);
        if (wireKey && wireKey !== key) continue;
        if (matchesCell && (!onlyPort || onlyPort === port)) inScope.add(key);
        const ids = inputImages(binding), previous = choices.get(key);
        const connectionLocked = () => port !== "completion" && port !== "signal"
          && (controller.isLocked(node.id) || !!binding.nodeId && controller.isLocked(binding.nodeId));
        const disabled = connectionLocked();
        const source = sourceLabel(binding);
        const media = port === "image" ? inputMediaLabel(binding) : "文本";
        const slot = binding.slot && (port === "text" || port === "image") ? `${media}${port === "text" ? "" : "来源"} ${binding.slot}` : "";
        const detail = [slot, source.detail === media && slot ? "" : source.detail].filter(Boolean).join(" · ") + (destination ? ` → ${destination}` : "");
        if (previous) {
          previous.assetIds = [...new Set([...previous.assetIds, ...ids])];
          previous.disabled ||= disabled;
          if (detail !== previous.detail) previous.detail += ` / ${detail}`;
          continue;
        }
        choices.set(key, { key, label: source.label, detail,
          assetIds: [...new Set(ids)], disabled, disconnect: () => {
            const current = controller.document.nodes.find(item => item.id === node.id);
            if (!current || connectionLocked()) return;
            if (binding.autoConnect) { disconnectAutomatic(key); return; }
            const remaining = (current.inputs[port] ?? []).filter(input => disconnectKey(current, port, input) !== key);
            if (remaining.length === current.inputs[port]?.length) return;
            if (current.textTarget && port !== "signal") handle(edit(invalidateWorkflow(controller.document.nodes, current.id).filter(item => item.id !== current.id)));
            else patch(current.id, { inputs: { ...current.inputs, [port]: remaining } }, port !== "signal" && port !== "completion");
          } });
      }
    }
    if (note && !wireKey && (!cellId || cellId === `column:${note.cells[0][0].id}`)) {
      for (const producer of controller.document.nodes.filter(node => node.resultNodeIds?.includes(nodeId))) {
        const port = workflowOutputs(producer).find(port => !onlyPort || port.type === onlyPort);
        if (!port) continue;
        inScope.add(producer.id);
        const binding = { nodeId: producer.id, portId: port.id };
        choices.set(producer.id, { key: producer.id, ...sourceLabel(binding), assetIds: inputImages(binding), disabled: controller.isLocked(producer.id),
          disconnect: () => {
            if (controller.isLocked(producer.id)) return;
            handle(edit(invalidateWorkflow(controller.document.nodes, producer.id).map(node => node.id === producer.id ? { ...node, resultNodeIds: node.resultNodeIds?.filter(id => id !== nodeId) } : node)));
          } });
      }
    }
    return [...choices.values()].filter(choice => inScope.has(choice.key));
  }
  function chooseDisconnect(target: DisconnectTarget, point: { x: number; y: number }, quick = false) {
    setConnection(null); connectionRef.current = null;
    const choices = disconnectChoices(target);
    if (quick && choices.length === 1 && !choices[0].disabled) { setDisconnectMenu(null); choices[0].disconnect(); }
    else setDisconnectMenu(choices.length ? { ...target, ...point } : null);
  }
  function connectionCard(option: typeof CONNECTION_CARDS[number], point: { x: number; y: number }) {
    const node = newWorkflowNode(option.kind, point.x, point.y, state.activeGenProvider || state.defaultProvider);
    if (option.media) node.generation = { ...node.generation, media: option.media };
    if (option.action) node.action = option.action;
    return node;
  }
  function addCard(node: WorkflowNode) {
    if (!controller.ready) { notifyError(null, "工作流正在载入"); return; }
    handle((async () => {
      if (provisional) await ensureMaterialized();
      const nodes = controller.document.nodes;
      if (node.kind === "voice" && !nodes.some(item => item.kind === "voice")) {
        const draft = readVoiceDraft(projectId);
        node.prompt = draft.text;
        node.voice = draft.sourceId ? { clip: { assetId: draft.sourceId, start: draft.start, end: draft.end, name: draft.name, transcript: draft.transcript } } : { id: draft.voiceId || undefined };
        if (draft.sourceId) node.inputs.image = [{ assetId: draft.sourceId }];
      }
      const before = controller.document;
      const saved = edit([...nodes, node]);
      if (controller.document !== before) onSelect(node.id);
      await saved;
    })());
  }
  function newConnectionError(gesture: AutomaticGesture, node: WorkflowNode) {
    if (gesture.side === "output") return node.kind !== "trigger" && gesture.outputs.some(output => output.type !== "signal") && lockedOutput(gesture.outputs) ? "来源卡片正在使用"
      : receiverError(gesture.outputs, { nodeId: node.id }, node);
    const outputs = canvasAutomaticOutputs(node.id, [node], [], [], []);
    if (gesture.target.nodeId && controller.isLocked(gesture.target.nodeId) && node.kind !== "trigger") return "这张卡片正在运行";
    if (gesture.target.nodeId) return planAutomaticConnection([...controller.document.nodes, node], outputs, gesture.target.nodeId).error;
    return automaticError(outputs, gesture.target);
  }
  function createConnected(option: typeof CONNECTION_CARDS[number]) {
    if (!connectionMenu) return;
    const { gesture, x, y } = connectionMenu;
    const point = toBoardPoint(x, y);
    const anchor = cardPoint(gesture.id, gesture.side);
    if (!gesture.dragged && anchor) { point.x = anchor.x + (gesture.side === "output" ? 110 : -workflowCardWidth({ kind: option.kind }) - 110); point.y = anchor.y - 100; }
    const node = connectionCard(option, point);
    if (gesture.side === "output") chooseAutomaticReceiver(gesture, gesture.outputs, { nodeId: node.id }, { x, y }, node);
    else commitAutomatic(canvasAutomaticOutputs(node.id, [node], [], [], []), gesture.target, [node]);
  }
  function scopedAutomatic(previous: AutomaticGesture, cellId?: string): AutomaticGesture {
    const card = graphById.get(previous.id);
    if (!card) return previous;
    const value = cellId && previous.side === "output" ? canvasInputValue(card, cellId, graphNodes) : undefined;
    const media = automaticValueMedia(value, assets, controller.document.nodes.some(node => node.textTarget?.nodeId === card.id && node.textTarget.cellId === cellId));
    const selectedOutputs = cellId ? selectedMediaOutputs(JSON.stringify([card.id, cellId])) : undefined;
    return { ...previous, scope: cellId, latest: false,
      outputs: previous.side === "output" ? selectedOutputs ?? (value ? [{ binding: { canvasNodeId: card.id, cellId }, type: value.type, ...(media ? { media } : {}) }] : automaticOutputs(card.id)) : [],
      target: { ...previous.target, cellId: previous.side === "input" ? cellId : undefined } };
  }
  function selectConnectionScope(cellId?: string) {
    if (!connectionMenu) return;
    const gesture = scopedAutomatic(connectionMenu.gesture, cellId);
    automaticRef.current = gesture; setAutomatic(gesture); setConnectionMenu({ ...connectionMenu, gesture });
  }
  function connect(toId: string, inputId: string) {
    const draft = connectionRef.current;
    if (!draft || inputId !== "*auto" && inputId !== "completion" && draft.type !== "signal" && controller.isLocked(toId)) return;
    if (inputId === "*auto") {
      connectionRef.current = null; setConnection(null);
      const { type, ...binding } = draft;
      commitAutomatic([{ binding, type }], { nodeId: toId });
      return;
    }
    const nodes = controller.document.nodes;
    const node = nodes.find(node => node.id === toId)!;
    const port = workflowInputs(node).find(port => port.id === inputId);
    const source = connectionForType(draft, port?.type);
    if (node.kind === "trigger" && inputId === "completion") {
      const { type, ...binding } = source;
      commitAutomatic([{ type, binding }], { nodeId: toId });
      connectionRef.current = null; setConnection(null);
      return;
    }
    if (source.type !== "signal" && source.nodeId && controller.isLocked(source.nodeId)) { notifyError(null, "来源卡片正在使用"); return; }
    const latest = source.cellId === "*latest" || source.cellId === "*latest-image";
    const producers = workflowInputProducers(nodes, source);
    const error = (latest ? [] : producers).map(producer => workflowConnectionError(nodes, producer, source.portId ?? source.type, toId, inputId)).find(Boolean)
      ?? (port?.type !== source.type ? "只能连接相同类型的端口" : null);
    if (error) { notifyError(null, error); return; }
    if (node.kind === "visual-profile" && node.profileId) { notifyError(null, "请先切换到从输入提炼"); return; }
    const { type: _type, ...binding } = source;
    if (node.kind === "comfy-video" && port?.type === "image") {
      const audioPort = inputId === H3_VIDEO_AUDIO_PORT;
      const ids = inputImages(audioPort ? { ...binding, mediaFilter: ["audio"] } : binding);
      const media = ids.map(id => {
        const material = materialByAsset.get(id);
        return material?.audio ? "audio" : material?.video ? "video" : workflowAssetMedia(assets.find(asset => asset.id === id));
      });
      const producerMedia = source.nodeId && automaticOutputs(source.nodeId).find(output => output.binding.portId === source.portId)?.media;
      const knownMedia = media.length && media.every(Boolean) ? media : !media.length && producerMedia ? [producerMedia].flat() : [];
      if (audioPort) {
        if (binding.videoFrame || (knownMedia.length && !knownMedia.includes("audio")) || media.filter(type => type === "audio").length > 1) {
          notifyError(null, "请选择一段音频作为参考录音"); return;
        }
        binding.mediaFilter = ["audio"];
      } else if (knownMedia.length && knownMedia.every(type => type === "audio")) {
        notifyError(null, "请将录音连接到音频输入"); return;
      }
    }
    if (node.kind === "voice" && inputId === "image") {
      const ids = inputImages(binding);
      if (ids.length > 1 || ids.some(id => { const asset = assets.find(item => item.id === id); return asset && !isAudioPath(asset.store_path); })) {
        notifyError(null, "请选择一段音频作为参考录音"); return;
      }
    }
    const current = node.inputs[inputId] ?? [];
    if (current.some(input => binding.groupId ? input.groupId === binding.groupId : workflowBindingKey(input) === workflowBindingKey(binding))) { setConnection(null); connectionRef.current = null; return; }
    // An explicit new connection can replace a deleted source on its old pipe.
    const missing = (node.kind === "generation" || node.kind === "agent")
      ? current.filter(input => canvasWorkflowInputState(input, graphNodes, nodes) === "missing").sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))[0] : undefined;
    const connected = missing ? current.map(input => input === missing ? { ...binding, slot: missing.slot } : input) : [...current, binding];
    const documentSource = source.canvasNodeId && graphNodes.find(card => card.id === source.canvasNodeId && card.kind === "note" && readCanvasNote(card).note_type === "document");
    const reference = !missing && documentSource && node.kind === "generation" && (source.type === "text" || source.type === "image")
      ? { id: crypto.randomUUID(), type: source.type, input: binding, label: source.type === "text" ? "文档文本" : "文档图片" } : null;
    if (latest) {
      try { assertWorkflowAcyclic(nodes.map(item => item.id === toId ? { ...item, inputs: { ...item.inputs, [inputId]: connected } } : item), toId); }
      catch (error) { notifyError(error, "这条连接会形成循环"); return; }
    }
    patch(toId, { ...(reference ? { prompt: `${node.prompt}${node.prompt ? "\n" : ""}@[${reference.id}]`, promptReferences: [...(node.promptReferences ?? []), reference] } : {}),
      inputs: { ...node.inputs, [inputId]: (node.kind === "voice" && inputId === "image") || (node.kind === "comfy-video" && inputId !== "text") || (node.kind === "instruction" && node.action !== "describe") || (inputId === "visual-profile" || node.kind === "loop" && node.loopMode === "rows") ? [binding] : connected } });
    setConnection(null); connectionRef.current = null;
  }
  function connectSignal(targetId: string, native = false) {
    const source = connectionRef.current;
    if (source?.type !== "signal" || !source.nodeId) return;
    const nodes = controller.document.nodes;
    const card = native && graphNodes.find(node => node.id === targetId && node.kind === "note" && node.hiddenAt == null && ["text", "images"].includes(readCanvasNote(node).note_type));
    const target = native ? nodes.find(node => node.textSource === targetId) ?? (card ? { ...newWorkflowNode("text", card.x, card.y, ""), textSource: targetId } : null) : nodes.find(node => node.id === targetId);
    if (!target) return;
    const candidates = nodes.some(node => node.id === target.id) ? nodes : [...nodes, target];
    const error = workflowConnectionError(candidates, source.nodeId, "signal", target.id, "signal");
    if (error) { notifyError(null, error); return; }
    const inputs = target.inputs.signal ?? [];
    if (!inputs.some(input => input.nodeId === source.nodeId)) handle(edit(candidates.map(node => node.id === target.id ? { ...node, trigger: false, inputs: { ...node.inputs, signal: [...inputs, { nodeId: source.nodeId, portId: "signal" }] } } : node)));
    setConnection(null); connectionRef.current = null;
  }
  function inputText(nodeId: string, cellId?: string, disconnect = false, inputType?: "text" | "image" | "auto", point = cursor.current, keyboard = false) {
    if (inputType === "auto") {
      if (disconnect) chooseDisconnect({ nodeId, cellId }, point);
      else beginAutomatic(nodeId, "input", point, keyboard, false, cellId);
      return;
    }
    const source = connectionRef.current && connectionForType(connectionRef.current, inputType);
    if (!disconnect && source) {
      if (inputType && source.type !== inputType) { notifyError(null, inputType === "image" ? "此端口接收图片" : "此端口接收文字"); return; }
      if (source.type !== "image" && source.type !== "text") { notifyError(null, "文本卡片只接收文本或图片"); return; }
      const { type, ...binding } = source;
      setConnection(null); connectionRef.current = null;
      handle(controller.bindTextInput(nodeId, cellId, binding, type));
      return;
    }
    if (disconnect) chooseDisconnect({ nodeId, cellId, port: inputType }, point);
  }
  useEffect(() => {
    const textCard = (target: EventTarget | null) => {
      const id = (target as HTMLElement | null)?.closest<HTMLElement>("[data-canvas-node-id]")?.dataset.canvasNodeId;
      return graphNodes.find(node => node.id === id && node.kind === "note" && node.hiddenAt == null && ["text", "images"].includes(readCanvasNote(node).note_type));
    };
    const attach = (card: CanvasNode, previousKey?: string) => {
      const nodes = controller.document.nodes;
      const existing = nodes.find(node => node.textSource === card.id);
      if ((existing && controller.isLocked(existing.id)) || (previousKey && controller.isLocked(previousKey))) return;
      const node = existing ?? { ...newWorkflowNode("text", card.x, card.y, ""), textSource: card.id };
      handle(edit([...nodes.filter(item => item.id !== node.id).map(item => item.id === previousKey ? { ...item, trigger: false } : item), { ...node, trigger: true, inputs: { ...node.inputs, signal: [] } }]));
      setArmed(false);
    };
    const down = (event: globalThis.PointerEvent) => {
      const card = armed && event.button === 0 && textCard(event.target);
      if (card) { event.preventDefault(); event.stopPropagation(); attach(card); }
    };
    const dragOver = (event: DragEvent) => { if (textCard(event.target) && event.dataTransfer?.types.includes("text/plain")) event.preventDefault(); };
    const drop = (event: DragEvent) => {
      const value = event.dataTransfer?.getData("text/plain") ?? "";
      const previousKey = value.startsWith("bowerbird-winding-key:") ? value.slice(22) : "";
      const card = textCard(event.target);
      if (card && document.nodes.some(node => node.id === previousKey && node.trigger)) {
        event.preventDefault(); event.stopPropagation(); attach(card, previousKey);
      }
    };
    window.addEventListener("pointerdown", down, true); window.addEventListener("dragover", dragOver, true); window.addEventListener("drop", drop, true);
    return () => { window.removeEventListener("pointerdown", down, true); window.removeEventListener("dragover", dragOver, true); window.removeEventListener("drop", drop, true); };
  }, [armed, controller, document, graphNodes]);
  useEffect(() => {
    const finishAutomatic = (event: globalThis.PointerEvent, gesture: AutomaticGesture) => {
      const element = window.document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const target = element?.closest<HTMLElement>("[data-workflow-card],[data-canvas-node-id],[data-workflow-material]");
      const id = target?.dataset.workflowCard ?? target?.dataset.canvasNodeId ?? target?.dataset.workflowMaterial;
      if (id === gesture.id && element?.closest(".canvas-connection-handle,[data-workflow-input='completion']")) {
        setConnectionMenu({ gesture, x: event.clientX, y: event.clientY });
      } else if (id) {
        const outputs = gestureOutputs(gesture, id);
        const receiver = gesture.side === "output" ? automaticTarget(id) : gesture.target;
        const error = id === gesture.id ? "不能连接卡片自身" : receiverError(outputs, receiver);
        if (error) { clearAutomatic(); notifyError(null, error); }
        else chooseAutomaticReceiver(gesture, outputs, receiver, { x: event.clientX, y: event.clientY });
      } else if (element?.closest(".canvas-stage") && !element.closest(".canvas-toolbar,.canvas-creation-dock,[role=menu]")) {
        setCursor({ x: event.clientX, y: event.clientY });
        setConnectionMenu({ gesture, x: event.clientX, y: event.clientY });
      } else clearAutomatic();
    };
    const down = () => { swallowAutomaticClick.current = false; };
    const click = (event: MouseEvent) => {
      if (!swallowAutomaticClick.current) return;
      swallowAutomaticClick.current = false;
      if (event.detail === 0) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    const move = (event: globalThis.PointerEvent) => {
      const gesture = automaticRef.current;
      if (armed || connectionRef.current || gesture && !connectionMenu) setCursor({ x: event.clientX, y: event.clientY });
      if (gesture && !connectionMenu) {
        if (event.buttons === 0) { clearAutomatic(); return; }
        const dragging = gesture.dragged || Math.hypot(event.clientX - gesture.start.x, event.clientY - gesture.start.y) > 5;
        if (!gesture.dragged && dragging) startAutomaticDrag(gesture);
        const element = window.document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-workflow-card],[data-canvas-node-id],[data-workflow-material]");
        const id = element?.dataset.workflowCard ?? element?.dataset.canvasNodeId ?? element?.dataset.workflowMaterial;
        const next = dragging && id && id !== gesture.id ? { id, error: receiverError(gestureOutputs(gesture, id),
          gesture.side === "output" ? automaticTarget(id) : gesture.target) } : null;
        if (next?.id !== connectionHoverRef.current?.id || next?.error !== connectionHoverRef.current?.error) {
          connectionHoverRef.current = next; setConnectionHover(next);
        }
      }
      const target = event.target instanceof Element && !event.buttons ? event.target.closest<HTMLElement>("[data-workflow-material],[data-canvas-node-id]") : null;
      const hovered = target?.dataset.workflowMaterial ?? target?.dataset.canvasNodeId ?? null;
      if (hovered !== hoveredMaterialRef.current || hoveredHotspot.current?.isConnected === false) {
        hoveredHotspot.current?.classList.remove("is-hovered");
        hoveredMaterialRef.current = hovered;
        const hotspot = hovered ? wireElement.current?.parentElement?.querySelector(`[data-workflow-material="${CSS.escape(hovered)}"]`) : null;
        hoveredHotspot.current = hotspot ?? null;
        hotspot?.classList.add("is-hovered");
      }
    };
    const end = (event: globalThis.PointerEvent) => {
      if (event.button !== 0) return;
      const gesture = automaticRef.current;
      if (gesture && !connectionMenu) {
        window.clearTimeout(automaticPressTimer.current);
        swallowAutomaticClick.current = true;
        if (!gesture.dragged) setConnectionMenu({ gesture, x: event.clientX, y: event.clientY });
        else finishAutomatic(event, gesture);
        return;
      }
      if (armed && event.button === 0) {
        const element = window.document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
        const workflowId = element?.closest<HTMLElement>("[data-workflow-card]")?.dataset.workflowCard;
        const nativeId = element?.closest<HTMLElement>("[data-canvas-node-id]")?.dataset.canvasNodeId;
        const native = graphNodes.find(node => node.id === nativeId && node.kind === "note" && node.hiddenAt == null && ["text", "images"].includes(readCanvasNote(node).note_type));
        if (workflowId || native) {
          const node = controller.document.nodes.find(node => workflowId ? node.id === workflowId : node.textSource === native!.id)
            ?? (native ? { ...newWorkflowNode("text", native.x, native.y, ""), textSource: native.id } : null);
          if (node && node.kind !== "planner" && !controller.isLocked(node.id)) {
            setArmed(false);
            handle(edit([...controller.document.nodes.filter(item => item.id !== node.id), { ...node, trigger: true, inputs: { ...node.inputs, signal: [] } }]));
          }
        } else if (element?.closest(".canvas-stage") && !element.closest("button,input,textarea,[data-canvas-node],.canvas-toolbar,.canvas-creation-dock")) {
          setArmed(false);
          const point = toBoardPoint(event.clientX, event.clientY);
          handle((async () => { await ensureMaterialized(); const node = newWorkflowNode("trigger", point.x, point.y, ""); await edit([...controller.document.nodes, node]); onSelect(node.id); })());
        }
        return;
      }
      if (!connectionRef.current) return;
      if (connectionRef.current.type === "signal") {
        const target = window.document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-workflow-card],[data-canvas-node-id]");
        if (target && target.dataset.workflowCard !== connectionRef.current.nodeId) connectSignal(target.dataset.workflowCard ?? target.dataset.canvasNodeId!, !target.dataset.workflowCard);
        return;
      }
      const textInput = window.document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-workflow-text-input]");
      const textNode = textInput?.closest<HTMLElement>("[data-canvas-node-id]")?.dataset.canvasNodeId;
      if (textNode && connectionRef.current) {
        if (textInput!.dataset.contentInputType === "auto") {
          const { type, ...binding } = connectionRef.current; connectionRef.current = null; setConnection(null);
          commitAutomatic([{ type, binding }], { canvasNodeId: textNode });
        } else inputText(textNode, textInput!.dataset.workflowTextInput || undefined, false, textInput!.dataset.contentInputType as "image" | undefined);
        return;
      }
      const input = window.document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-workflow-input]");
      if (input && connectionRef.current) connect(input.dataset.workflowNode!, input.dataset.workflowInput!);
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { connectionRef.current = null; setConnection(null); setArmed(false); clearAutomatic(); } };
    const cancel = () => { swallowAutomaticClick.current = false; clearAutomatic(); };
    const wheel = (event: WheelEvent) => { if (!(event.target instanceof Element && event.target.closest("[data-context-owner]"))) clearAutomatic(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", down, true); window.addEventListener("click", click, true);
    window.addEventListener("pointercancel", cancel); window.addEventListener("blur", cancel); window.addEventListener("wheel", wheel, true);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("keydown", key);
      window.removeEventListener("pointerdown", down, true); window.removeEventListener("click", click, true);
      window.removeEventListener("pointercancel", cancel); window.removeEventListener("blur", cancel); window.removeEventListener("wheel", wheel, true); };
  }, [armed, controller, document, graphNodes, assets, materials, connectionMenu]);
  useEffect(() => {
    const plane = wireElement.current?.closest(".canvas-plane");
    if (automatic) plane?.setAttribute("data-canvas-connecting", "");
    const id = automatic && CSS.escape(automatic.id);
    const sources = id ? plane?.querySelectorAll(`[data-canvas-node-id="${id}"], [data-workflow-card="${id}"], [data-workflow-material="${id}"]`) : undefined;
    const cellSources = automatic?.scope ? Array.from(sources ?? []).flatMap(source => Array.from(source.querySelectorAll(`[data-canvas-cell="${CSS.escape(automatic.scope!)}"]`))) : [];
    const markers = cellSources.length ? cellSources : Array.from(sources ?? []);
    markers.forEach(source => source.setAttribute("data-canvas-connection-source", automatic!.side));
    if (automatic?.dragged && !connectionMenu) markers.forEach(source => source.setAttribute("data-canvas-connection-dragging", automatic.side));
    return () => { plane?.removeAttribute("data-canvas-connecting"); markers.forEach(source => {
      source.removeAttribute("data-canvas-connection-source"); source.removeAttribute("data-canvas-connection-dragging");
    }); };
  }, [automatic, connectionMenu]);
  useEffect(() => {
    let cancelledByRightClick = false;
    const cancel = () => { connectionRef.current = null; setConnection(null); clearAutomatic(); };
    const cancelRightClick = (event: MouseEvent) => {
      if (!connectionRef.current && !automaticRef.current && !cancelledByRightClick) return;
      cancelledByRightClick = true;
      event.preventDefault(); event.stopPropagation();
      cancel();
    };
    const down = (event: MouseEvent) => {
      if (event.button !== 2) { cancelledByRightClick = false; return; }
      cancelRightClick(event);
    };
    // Cancelling the first pointerdown can suppress compatibility mousedown;
    // a second button then arrives as pointermove with the right-button bit set.
    const chord = (event: globalThis.PointerEvent) => { if (event.buttons & 2) cancelRightClick(event); };
    const context = (event: MouseEvent) => {
      if (!connectionRef.current && !cancelledByRightClick) return;
      event.preventDefault(); event.stopPropagation();
      cancelledByRightClick = false;
      cancel();
    };
    // A second mouse button during a left-button drag emits mousedown, not pointerdown.
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", chord, true);
    window.addEventListener("mousedown", down, true);
    window.addEventListener("contextmenu", context, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", chord, true);
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("contextmenu", context, true);
    };
  }, [projectId]);
  useImperativeHandle(ref, () => ({
    async startLocalVideo(request, point) {
      await ensureMaterialized();
      const node = await startComposerLocalVideo(controller, request, point, edit);
      onSelect(node.id);
    },
    templates(importPackage = false) { setTemplateLibrary({ importPackage }); },
    saveTemplate(ids, mode = "template") { setTemplateSelection({ projectId, ids: [...expandCanvasSections(new Set(ids), graphNodes)], nodes: structuredClone(controller.document.nodes), canvas: structuredClone(graphNodes), mode,
      bounds: [...materials, ...graphNodes.filter(node => node.hiddenAt == null), ...controller.document.nodes.map(node => ({ id: node.id, x: node.x, y: node.y, width: workflowCardWidth(node), height: cardElements.current.get(node.id)?.offsetHeight ?? 330 }))] }); },
    inputText,
    connectSelection(nodeIds, clientX, clientY, keyboard) {
      const sources = [...new Set(nodeIds)].map(id => automaticOutputs(id));
      if (sources.length < 2 || sources.some(outputs => !outputs.length)) {
        notifyError(null, "选中的素材中有不可用的输出");
        return;
      }
      // The selection is temporary. Each source gets its own durable, detachable wire.
      const outputs = sources.flat().map(output => ({ ...output, selectionWireId: crypto.randomUUID() }));
      beginAutomatic("selection-output", "output", { x: clientX, y: clientY }, keyboard, false, undefined, outputs);
    },
    connectCell(nodeId, cellId, clientX, clientY, keyboard) {
      if (cellId === "*auto") { beginAutomatic(nodeId, "output", { x: clientX, y: clientY }, keyboard); return; }
      const card = graphNodes.find(node => node.id === nodeId);
      if (card?.kind === "note" && ["text", "images"].includes(readCanvasNote(card).note_type)) { beginAutomatic(nodeId, "output", { x: clientX, y: clientY }, keyboard, false, cellId); return; }
      const value: Connection = { canvasNodeId: nodeId, cellId, type: card && canvasInputValue(card, cellId, graphNodes)?.type === "image" ? "image" : "text" };
      connectionRef.current = value; setConnection(value); setCursor({ x: clientX, y: clientY });
    },
    bindRecording(nodeId, assetId, assetNodeId) {
      const card = controller.document.nodes.find(item => item.id === nodeId);
      if (card?.kind !== "voice" || card.voice?.id || controller.isLocked(nodeId)) return false;
      patch(nodeId, { inputs: { ...card.inputs, image: [{ assetId, assetNodeId }] } });
      return true;
    },
    add(kind, x, y) {
      addCard(newWorkflowNode(kind, x, y, state.activeGenProvider || state.defaultProvider));
    },
    openCardMenu(x, y, point) {
      if (!armed && !automaticRef.current && !connectionRef.current) setBlankCardMenu({ x, y, point });
    },
    createImageCard(sourceId, assetId, point) {
      if (graphById.get(sourceId)?.assetId !== assetId && materialById.get(sourceId)?.assetId !== assetId) return;
      const node = connectionCard(CONNECTION_CARDS[0], point);
      commitAutomatic([{ type: "image", media: "image", binding: { assetId, assetNodeId: sourceId } }], { nodeId: node.id }, [node]);
    },
    arm(x, y) { clearAutomatic(); setArmed(value => !value); connectionRef.current = null; setConnection(null); if (x !== undefined && y !== undefined) setCursor({ x, y }); },
    cancelPlacement() { setArmed(false); setConnection(null); clearAutomatic(); },
    bounds(includeHidden = false) {
      return controller.document.nodes.filter(node => node.kind !== "text" && (includeHidden || !collapsedAnchor(node.id))).map(node => {
        const { x, y } = includeHidden ? node : displayPoint(node);
        return { id: node.id, x, y, width: workflowCardWidth(node), height: cardHeights.current.get(node.id) ?? cardElements.current.get(node.id)?.offsetHeight ?? 330 };
      });
    },
    isLocked(id) {
      const node = controller.document.nodes.find(node => node.id === id);
      const chat = node?.kind === "agent" && (node.chatConversationId ? chatSummaries[node.chatConversationId]
        : Object.values(chatSummaries).find(chat => chat.projectId === projectId && chat.nodeId === id));
      return controller.isLocked(id) || !!chat && localChatRunning(chat) || agentActionLocks.current.has(id)
        || node?.planning?.status === "waiting"
        || !!node && workflowImageGenerationActivity(node, workflowNodeRun(controller.document, id)?.steps[id], graphNodes, genJobs).running
        || controller.document.nodes.some(node => (node.textSource === id || node.textTarget?.nodeId === id || node.resultNodeIds?.includes(id)) && controller.isLocked(node.id));
    },
    position(positions, persist = false) {
      let changed = false;
      const nodes = controller.document.nodes.map(node => {
        const point = positions.get(node.id);
        if (!point || (node.x === point.x && node.y === point.y)) return node;
        changed = true; return { ...node, x: point.x, y: point.y };
      });
      if (changed) { controller.document = { ...controller.document, nodes }; redraw(value => value + 1); }
      if (persist && nodes.some(node => positions.has(node.id))) handle(controller.save());
    },
  }));

  function wireSelected(id: string | undefined) {
    if (!id) return false;
    const node = nodeById.get(id);
    return selectedIds.has(id) || selectedIds.has(conversationCards?.aliases.get(id) ?? id)
      || !!node?.textSource && selectedIds.has(node.textSource)
      || !!node?.textTarget && selectedIds.has(node.textTarget.nodeId);
  }
  function sessionOwnerPoint(id: string) {
    const owner = sessionOwners.get(id);
    return owner ? cardPoint(owner.id, "output") : null;
  }
  function cardPoint(id: string, side: "input" | "output") {
    id = collapsedAnchor(id)?.id ?? id;
    id = conversationCards?.aliases.get(id) ?? id;
    const node = nodeById.get(id) ?? pendingCards.current.get(id)?.node;
    if (node && !node.textTarget && !node.textSource) {
      const point = displayPoint(node);
      return { x: point.x + (side === "output" ? workflowCardWidth(node) : 0),
        y: point.y + (cardHeights.current.get(id) ?? 300) / 2, owner: id, selected: wireSelected(id) };
    }
    const nativeId = node?.textTarget?.nodeId ?? node?.textSource ?? id;
    const card = materialById.get(nativeId) ?? graphById.get(nativeId) ?? groupById.get(nativeId);
    if (!card) return null;
    const note = "kind" in card && card.kind === "note" ? readCanvasNote(card) : null;
    const height = sessionHeights?.get(nativeId) ?? (note?.note_type === "document" ? canvasDocumentHeight(card.width) : card.height);
    return { x: card.x + (side === "output" ? card.width : 0), y: card.y + height / 2, owner: card.id, selected: wireSelected(id) };
  }
  function scopedPoint(id: string, side: "input" | "output", scope?: string) {
    const node = nodeById.get(id);
    if (side === "input" && node?.kind === "trigger") return { x: node.x, y: workflowPortY(node, side, "completion"), owner: id, selected: wireSelected(id) };
    const rect = scope && portRect(graphById.get(id), "cell", scope);
    return rect ? { x: rect.x + (side === "output" ? rect.width : 0), y: rect.y + rect.height / 2, owner: id, selected: wireSelected(id) } : cardPoint(id, side);
  }
  function sourcePoint(binding: WorkflowInput, receiver?: WorkflowNode) {
    const node = binding.nodeId ? nodeById.get(binding.nodeId) : undefined;
    if (node && receiver && receiver.kind !== "trigger" && !receiver.textTarget && isWorkflowGenerationResult(binding, node)) {
      const result = generationResultAnchors.get(node.id);
      const point = result && (!visibleGraphNodeIds || visibleGraphNodeIds.has(result.nodeId) || materialById.has(result.nodeId))
        && scopedPoint(result.nodeId, "output", result.cellId);
      if (point) return { ...point, selected: point.selected || wireSelected(node.id) };
    }
    if (binding.autoConnect) {
      const id = binding.nodeId ?? binding.canvasNodeId ?? binding.assetNodeId ?? binding.groupId;
      if (id) { const point = scopedPoint(id, "output", binding.cellId); if (point) return point; }
    }
    const contained = embeddedPoint(binding.canvasNodeId ?? binding.assetNodeId ?? "");
    if (contained) return contained;
    if (binding.canvasNodeId) {
      const owner = sessionOwnerPoint(binding.canvasNodeId);
      if (owner) return owner;
      const session = graphById.get(binding.canvasNodeId);
      if (session?.kind === "prompt") {
        const anchor = conversationCards?.cards.get(conversationCards.aliases.get(session.id) ?? session.id)?.anchor ?? session;
        return cardPoint(anchor.id, "output");
      }
      const rect = portRect(session, "output", binding.cellId === "*latest-image" ? "*latest" : binding.cellId ?? "");
      return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, owner: binding.canvasNodeId, selected: wireSelected(binding.canvasNodeId) } : null;
    }
    if (node?.textTarget) {
      const rect = portRect(graphById.get(node.textTarget.nodeId), "output", node.textTarget.image ? "*" : "*text");
      return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, owner: node.textTarget.nodeId, selected: wireSelected(node.id) } : null;
    }
    if (node) return node.kind === "trigger" ? { x: node.x + workflowCardWidth(node), y: workflowPortY(node, "output", binding.portId!), owner: node.id, selected: wireSelected(node.id) } : cardPoint(node.id, "output");
    const candidate = binding.groupId ? groupById.get(binding.groupId) : binding.assetNodeId ? materialById.get(binding.assetNodeId)
      : binding.assetId ? materialByAsset.get(binding.assetId) : undefined;
    const material = candidate && (binding.groupId || candidate.assetId === binding.assetId) ? candidate : undefined;
    if (material) return { x: material.x + material.width, y: material.y + material.height / 2, owner: material.id, selected: wireSelected(material.id) };
    // Existing single-image connections keep their exact source after its card is folded.
    const output = binding.assetId && graphNodes.find(item => item.assetId === binding.assetId
      && (!binding.assetNodeId || item.id === binding.assetNodeId) && conversationCards?.aliases.has(item.id));
    const anchor = output && conversationCards?.cards.get(conversationCards.aliases.get(output.id)!)?.anchor;
    return (output && embeddedPoint(output.id)) || (anchor && sessionOwnerPoint(anchor.id)) || (anchor ? { x: anchor.x + anchor.width, y: anchor.y + 50, owner: anchor.id, selected: wireSelected(anchor.id) } : null);
  }
  function embeddedPoint(id: string, input = false) {
    const target = conversationCards?.embedded.get(id);
    if (!target) return null;
    const table = graphById.get(target.nodeId);
    const rect = portRect(table, "cell", target.cellId);
    if (rect) {
      return { x: rect.x + (input ? 0 : rect.width), y: rect.y + rect.height / 2, owner: target.nodeId, selected: selectedIds.has(target.nodeId) };
    }
    return table ? { x: table.x + (input ? 0 : table.width), y: table.y + table.height / 2, owner: table.id, selected: selectedIds.has(table.id) } : null;
  }
  function outputPath(from: { x: number; y: number }, to: { x: number; y: number }, drag?: DragOffset) {
    // Compact sibling grids need a lane around earlier columns, not through their media.
    let bottom = -Infinity;
    for (const rect of materials) {
      const moved = drag?.ids.has(rect.id);
      const x = rect.x + (moved ? drag!.dx : 0), y = rect.y + (moved ? drag!.dy : 0);
      if (x > from.x && x + rect.width < to.x && y < Math.max(from.y, to.y) && y + rect.height > Math.min(from.y, to.y))
        bottom = Math.max(bottom, y + rect.height);
    }
    if (bottom === -Infinity) return path(from, to);
    const lane = bottom + 16;
    return `M${from.x},${from.y} H${from.x + 16} V${lane} H${to.x - 16} V${to.y} H${to.x}`;
  }
  updateCursor.current = () => {
    const gesture = automaticRef.current;
    if (gesture && draftElement.current) {
      const anchor = scopedPoint(gesture.id, gesture.side, gesture.scope) ?? toBoardPoint(gesture.start.x, gesture.start.y), cursorPoint = toBoardPoint(cursor.current.x, cursor.current.y);
      if (anchor) draftElement.current.setAttribute("d", gesture.side === "output" ? path(anchor, cursorPoint) : path(cursorPoint, anchor));
    }
    const value = connectionRef.current;
    const from = value && sourcePoint(value);
    if (from && draftElement.current) draftElement.current.setAttribute("d", path(from, toBoardPoint(cursor.current.x, cursor.current.y)));
    if (ghostElement.current) {
      ghostElement.current.style.left = `${cursor.current.x + 16}px`;
      ghostElement.current.style.top = `${cursor.current.y + 16}px`;
    }
  };
  useLayoutEffect(() => updateCursor.current());

  function automaticButton(id: string, side: "input" | "output", disabled = false) {
    return <CanvasConnectionHandle side={side} disabled={disabled || panReady} active={automatic?.id === id && automatic.side === side}
      aria-label={side === "input" ? "添加上游" : "添加下游"}
      data-workflow-node={id} data-workflow-input={side === "input" ? "*auto" : undefined}
      onPointerDown={event => { if (event.button !== 0) return; event.stopPropagation(); event.preventDefault(); beginAutomatic(id, side, { x: event.clientX, y: event.clientY }); }}
      onClick={event => {
        if (event.detail !== 0) return;
        if (side === "input" && connectionRef.current?.type === "signal") { connectSignal(id); return; }
        const rect = event.currentTarget.getBoundingClientRect();
        const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        const gesture = automaticRef.current;
        if (gesture && gesture.side !== side) {
          chooseAutomaticReceiver(gesture, side === "input" ? gesture.outputs : automaticOutputs(id),
            side === "input" ? automaticTarget(id) : gesture.target, point);
          return;
        }
        beginAutomatic(id, side, point, true);
      }}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); if (side === "input") chooseDisconnect({ nodeId: id }, { x: event.clientX, y: event.clientY }); }} />;
  }
  function portButton(node: WorkflowNode, port: WorkflowPort, side: "input" | "output", _index: number) {
    const completionInput = side === "input" && node.kind === "trigger" && port.id === "completion";
    const busy = node.kind !== "trigger" && controller.isLocked(node.id);
    return <button key={port.id} className={`workflow-port is-${side} is-${port.type}`} style={{ top: workflowPortY(node, side, port.id) - node.y - 10 }}
      aria-label={`${side === "input" ? "输入" : "输出"}：${port.label}`} title={completionInput ? "拖到上游卡片或生成会话，或点击选择来源" : port.type === "session" ? "运行后自动连接生成会话卡片" : side === "input" ? "连接输入；右键断开此端口" : "拖到输入端口，或点击后选择输入端口"}
      data-workflow-node={node.id} data-workflow-input={side === "input" ? port.id : undefined}
      onPointerDown={event => {
        event.stopPropagation(); event.preventDefault(); if ((busy && side === "input") || port.type === "session") return;
        if (completionInput && event.button === 0 && !connectionRef.current && !automaticRef.current) beginAutomatic(node.id, side, { x: event.clientX, y: event.clientY });
        if (side === "output") { const value = { nodeId: node.id, portId: port.id, type: port.type }; connectionRef.current = value; setConnection(value); setCursor({ x: event.clientX, y: event.clientY }); }
      }}
      onClick={event => {
        if (event.detail !== 0 || (busy && side === "input") || port.type === "session") return;
        if (side === "input" && automaticRef.current?.side === "output") commitAutomatic(automaticRef.current.outputs, { nodeId: node.id });
        else if (completionInput && !connectionRef.current) {
          const rect = event.currentTarget.getBoundingClientRect();
          beginAutomatic(node.id, side, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, true);
        }
        else if (side === "input") connect(node.id, port.id);
        else if (automaticRef.current?.side === "input" && port.type === "signal") {
          commitAutomatic([{ binding: { nodeId: node.id, portId: port.id }, type: port.type }], automaticRef.current.target);
        } else { const value = { nodeId: node.id, portId: port.id, type: port.type }; connectionRef.current = value; setConnection(value); }
      }}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); if (!busy && side === "input") chooseDisconnect({ nodeId: node.id, port: port.id }, { x: event.clientX, y: event.clientY }); }}>
      <i /><span>{node.kind === "comfy-video" && port.id === "last-frame" ? "尾帧" : port.label}</span>
    </button>;
  }
  function showProgress(id: string, anchor: HTMLElement, beside = false, focus = false) {
    const rect = anchor.getBoundingClientRect();
    setKeyHover({ id, x: beside ? rect.right : rect.left, y: beside ? rect.top : rect.bottom, anchor, rect, focus });
  }
  function keyButton(node: WorkflowNode) {
    const busy = controller.isLocked(node.id);
    const issue = flowIssues.get(node.id);
    return <button className={`workflow-key ${workflowRuns(document).some(item => item.startId === node.id && item.status === "running") ? "is-running" : ""}`} draggable={!busy}
          onPointerDown={event => event.stopPropagation()}
          aria-label="上发条，运行工作流" aria-disabled={!!issue} title={issue?.message} aria-describedby={keyHover?.id === node.id ? "workflow-progress" : undefined}
          onMouseEnter={event => { if (!event.buttons) showProgress(node.id, event.currentTarget); }}
          onMouseLeave={() => setKeyHover(null)}
          onFocus={event => { if (event.currentTarget.matches(":focus-visible")) showProgress(node.id, event.currentTarget, false, true); }} onBlur={() => setKeyHover(null)}
          onDragStart={event => { event.stopPropagation(); event.dataTransfer.setData("text/plain", `bowerbird-winding-key:${node.id}`); }}
          onClick={() => { if (!busy && !issue) runCard(node.id, false); }}
          onContextMenu={event => { event.preventDefault(); event.stopPropagation(); if (!busy) patch(node.id, { trigger: false }, false); }}><WindingKey size={32} /></button>;
  }
  function gearButton(node: WorkflowNode) {
    const points = Array.from({ length: 25 }, (_, i) => {
      const angle = Math.PI + i * Math.PI / 24, radius = i % 4 === 1 || i % 4 === 2 ? 20 : 16;
      return `${20 + Math.cos(angle) * radius},${24 + Math.sin(angle) * radius}`;
    });
    return <button className="workflow-key workflow-gear" aria-label="断开触发器连接" title="触发器已连接 · 右键齿轮断开"
      onPointerDown={event => event.stopPropagation()}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); chooseDisconnect({ nodeId: node.id, port: "signal" }, { x: event.clientX, y: event.clientY }); }}>
      <svg width="36" height="32" viewBox="0 0 40 32" aria-hidden="true"><path d={`M${points.join(" L")} L29,24 A9,9 0 0 0 11,24 Z`} fill="currentColor" /></svg>
    </button>;
  }
  const statusLabels = { pending: "等待上游", running: "执行中", waiting: "等待继续", done: "已完成", failed: "失败" };
  const automaticWires = new Set<string>();
  return <>
    {visibleGraphNodes.filter(node => node.hiddenAt == null && (node.kind !== "asset" || materials.some(item => item.id === node.id)) && !sessionIds.has(node.id) && !conversationCards?.hiddenIds.has(node.id)).map(node => {
      if (node.kind === "prompt" && collapsedAnchorIds.has(node.id)) return null;
      const note = node.kind === "note" ? readCanvasNote(node) : null;
      if (note?.note_type === "section" && !note.artboard && !note.workflow_container) {
        return nameEditor(node.id, { left: `calc(${node.x}px + 22px * var(--section-title-scale))`, top: node.y,
          "--section-color": note.section_color, maxWidth: `clamp(80px, calc(${node.width}px / var(--section-title-scale) - 22px), 320px)` } as React.CSSProperties, false, true);
      }
      return nameEditor(node.id, { left: node.x + (note?.note_type === "section" ? 24 : 0), top: node.y - 28, maxWidth: node.width });
    })}
    {materials.filter(item => item.groupId).map(item => nameEditor(item.groupId!, { left: item.x, top: item.y - 28, maxWidth: item.width }))}
    {disconnectMenu && <WorkflowDisconnectMenu {...disconnectMenu} choices={disconnectChoices(disconnectMenu)} assets={assets} onClose={() => setDisconnectMenu(null)} />}
    {Array.from(frames, ([id, frame]) => <WorkflowLoopFrame key={id} {...frame} />)}
    <svg ref={wireElement} className="workflow-wires">
      {document.nodes.filter(node => !collapsedAnchor(node.id) && (node.kind === "agent" || node.kind === "generation" && node.generation?.media !== "video")).flatMap(node => (node.sessionNodeIds ?? []).map(id => {
        const current = node.kind === "generation" && node.outputs.image?.nodeIds?.includes(id)
          ? generationResultAnchors.get(node.id) : undefined;
        const anchorId = current?.nodeId ?? conversationCards?.aliases.get(id) ?? id;
        const session = graphById.get(anchorId);
        const embedded = embeddedPoint(id, true);
        if (!embedded && (conversationCards?.routedIds.has(id) || visibleGraphNodeIds && !visibleGraphNodeIds.has(anchorId) && !materialById.has(anchorId))) return null;
        return session && <path key={`agent-session-${node.id}-${id}`} className={`is-image${wireSelected(node.id) || wireSelected(anchorId) ? " is-selected" : ""}`} data-workflow-session-link={id}
          data-workflow-generator={node.id} {...dragWire(cardPoint(node.id, "output")!, embedded ?? cardPoint(anchorId, "input")!)} />;
      }))}
      {document.nodes.filter(node => node.kind === "generation" || node.kind === "comfy-video").flatMap(node => {
        const hiddenSessions = hiddenWorkflowSessionIds([node]);
        if (!hiddenSessions.size) return [];
        return graphNodes.filter(session => hiddenSessions.has(session.id)).flatMap(session =>
          canvasSessionImages(session, graphNodes).flatMap(output => {
            const anchorId = conversationCards?.aliases.get(output.id) ?? output.id;
            const visible = materialById.get(anchorId) ?? conversationCards?.cards.get(anchorId)?.anchor;
            if (!visible || output.hiddenAt != null || conversationCards?.hiddenIds.has(anchorId)) return [];
            return <path key={`generated-${node.id}-${output.id}`} className={`is-image${wireSelected(node.id) || wireSelected(visible.id) ? " is-selected" : ""}`} data-workflow-generated-link={output.id}
              data-workflow-generator={node.id} {...dragWire(cardPoint(node.id, "output")!, cardPoint(anchorId, "input")!, outputPath, true)} />;
          }));
      })}
      {document.nodes.map(node => {
        const group = node.resultGroupId && groupById.get(node.resultGroupId);
        return group && <path key={`group-${node.id}`} className={`is-image${wireSelected(node.id) || wireSelected(group.id) ? " is-selected" : ""}`} data-workflow-product-link={group.id} {...dragWire(cardPoint(node.id, "output")!, { x: group.x, y: group.y + group.height / 2, owner: group.id })} />;
      })}
      {document.nodes.filter(node => !collapsedAnchor(node.id)).flatMap(node => (node.resultNodeIds ?? []).map(id => {
        const result = graphById.get(id);
        const type = node.kind === "voice" || node.kind === "comfy-video" || node.kind === "generation" || node.action === "layers" ? "image" : "text";
        return result && <path key={id} className={`is-${type}${wireSelected(node.id) || wireSelected(id) ? " is-selected" : ""}`} data-workflow-result-link={id} {...dragWire(cardPoint(node.id, "output")!, cardPoint(result.id, "input")!, outputPath, true)} />;
      }))}
      {renderedNodes.flatMap(node => Object.entries(node.kind === "comfy-video" ? generationInputNode(node).inputs : node.inputs).flatMap(([port, inputs]) => inputs.map((binding, index) => {
        if (node.kind === "trigger" && port === "completion" && workflowTriggerMode(node) !== "completion") return null;
        const automaticKey = binding.autoConnect && `${binding.autoConnect}:${node.textTarget?.nodeId ?? node.id}`;
        if (automaticKey && automaticWires.has(automaticKey)) return null;
        if (automaticKey) automaticWires.add(automaticKey);
        const frame = port === "text" ? frames.get(node.id) : undefined;
        const from = frame ? { x: frame.x + frame.width, y: frame.y + frame.height / 2, selected: wireSelected(binding.canvasNodeId) } : sourcePoint(binding, node);
        if (!from) return null;
        let to = node.kind === "trigger" ? { x: node.x, y: workflowPortY(node, "input", port) } : cardPoint(node.id, "input") ?? { x: node.x, y: node.y };
        if (port === "signal") {
          const card = node.textSource && graphById.get(node.textSource);
          if (node.textSource && !card) return null;
          to = { x: (card ? card.x + card.width : node.x + workflowCardWidth(node)) - 34, y: (card ? card.y : node.y) - 18 };
        }
        if (node.textTarget) {
          const target = node.textTarget;
          const nativeCard = graphById.get(target.nodeId);
          const inputPort = nativeCard ? contentInputPort(readCanvasNote(nativeCard), target) : undefined;
          const rect = inputPort === undefined ? undefined : portRect(nativeCard, "input", inputPort, port === "image");
          const automaticPoint = binding.autoConnect && scopedPoint(target.nodeId, "input", target.cellId);
          if (automaticPoint) to = automaticPoint;
          else if (rect) to = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          else return null;
        }
        const diagnostic = nodeDiagnostic(node.id);
        const failedWire = diagnostic?.source && (workflowBindingKey(diagnostic.source) === workflowBindingKey(binding)
          || inputs.length === 1 && node.promptReferences?.some(ref => ref.type === port && ref.label === diagnostic.referenceLabel));
        return <path key={`${node.id}-${port}-${index}`} {...dragWire(from, { ...to, owner: node.textTarget?.nodeId ?? node.textSource ?? collapsedAnchor(node.id)?.id ?? node.id })} style={frame && !failedWire ? { stroke: "#66baff", opacity: 1 } : undefined} data-auto-connection={binding.autoConnect} data-workflow-target={node.id} data-workflow-signal-link={port === "signal" ? node.id : undefined} data-workflow-text-link={node.textTarget?.cellId} className={`is-${binding.autoConnect ? "automatic" : port}${failedWire ? " is-error" : ""}${from.selected || wireSelected(collapsedAnchor(node.id)?.id ?? node.id) ? " is-selected" : ""}`}
          onContextMenu={event => {
            if (!binding.autoConnect && port !== "signal") return;
            event.preventDefault(); event.stopPropagation();
            chooseDisconnect({ nodeId: node.textTarget?.nodeId ?? node.id, wireKey: disconnectKey(node, port, binding) }, { x: event.clientX, y: event.clientY });
          }} />;
      })))}
      {pending.filter(card => card.target.nodeId !== card.node.id).map(({ node, target, connectionId }) => {
        const from = cardPoint(node.id, "output"), to = scopedPoint(target.nodeId ?? target.canvasNodeId!, "input", target.cellId);
        return from && to && <path key={connectionId} data-auto-connection={connectionId} data-workflow-target={target.nodeId} className="is-automatic" d={path(from, to)} />;
      })}
      {connection && (() => { const from = sourcePoint(connection); return from && <path ref={draftElement} className="is-draft" d={path(from, toBoardPoint(cursor.current.x, cursor.current.y))} />; })()}
      {automatic?.dragged && !connectionMenu && (() => { const anchor = scopedPoint(automatic.id, automatic.side, automatic.scope) ?? toBoardPoint(automatic.start.x, automatic.start.y), point = toBoardPoint(cursor.current.x, cursor.current.y); return anchor && <path ref={draftElement} className="is-draft" d={automatic.side === "output" ? path(anchor, point) : path(point, anchor)} />; })()}
    </svg>
    {document.nodes.filter(node => node.textSource && (node.trigger || node.inputs.signal?.length)).map(node => {
      const card = graphNodes.find(card => card.id === node.textSource && card.hiddenAt == null);
      return card && <div key={node.id} className="workflow-material-hotspot workflow-text-key" data-workflow-text-key={card.id} style={{ left: card.x, top: card.y, width: card.width, height: card.height }}>{node.inputs.signal?.length ? gearButton(node) : keyButton(node)}</div>;
    })}
    {visibleGraphNodes.filter(card => card.kind === "prompt" && card.hiddenAt == null && !sessionIds.has(card.id) && !conversationCards?.hiddenIds.has(card.id)).map(card =>
      <div key={`session-${card.id}`} data-workflow-material={card.id} className={`workflow-material-hotspot ${imageOnlyConversationIds?.has(card.id) ? "is-image-session" : ""} ${hoveredMaterial === card.id ? "is-hovered" : ""} ${selectedIds.has(card.id) ? "is-selected" : ""}`} style={{ left: card.x, top: card.y, width: card.width, height: sessionHeights?.get(card.id) ?? card.height }}>
        {automaticButton(card.id, "output")}
      </div>)}
    {materials.map(material => <div key={material.id} data-workflow-material={material.id} className={`workflow-material-hotspot ${hoveredMaterial === material.id ? "is-hovered" : ""} ${selectedIds.has(material.id) ? "is-selected" : ""}`} style={{ left: material.x, top: material.y, width: material.width, height: material.height }}>
      {automaticButton(material.id, "output")}
    </div>)}
    {renderedNodes.filter(node => node.kind !== "text" && !collapsedAnchor(node.id)).map(node => {
      const creating = !nodeById.has(node.id);
      const run = workflowNodeRun(document, node.id);
      const step = run?.steps[node.id];
      const imageActivity = workflowImageGenerationActivity(node, step, graphNodes, genJobs);
      const failure = controller.cardFailure(node.id, run);
      const imageFailure = !failure && imageActivity.failed && imageActivity.session;
      const agentChat = node.kind === "agent" ? (node.chatConversationId ? chatSummaries[node.chatConversationId] : Object.values(chatSummaries).find(chat => chat.projectId === projectId && chat.nodeId === node.id)) : undefined;
      const hasAgentMessages = !!agentChat?.turnCount;
      const agentRunPrompts = new Map<string, string>();
      const agentHistory = node.kind === "agent" ? workflowRuns(document).flatMap((execution, index) => {
        const label = `运行 ${index + 1}`;
        const past = execution.loop?.completed.flatMap((item, i) => {
          const step = item.steps[node.id];
          if (step?.chatTurnId && step.agentInput) agentRunPrompts.set(step.chatTurnId, step.agentInput.prompt);
          return step ? [{ key: `${execution.id}:${i}`, label: `${label} · 第 ${(execution.loop!.startIndex ?? 0) + i + 1} 轮`, conversationId: step.chatConversationId }] : [];
        }) ?? [];
        const step = execution.steps[node.id];
        if (step?.chatTurnId && step.agentInput) agentRunPrompts.set(step.chatTurnId, step.agentInput.prompt);
        return step && !(execution.loop && execution.status === "done" && past.length)
          ? [...past, { key: `${execution.id}:current`, label, conversationId: step.chatConversationId }] : past;
      }) : [];
      const chatBusy = localChatRunning(agentChat);
      const conversationId = agentChat?.id ?? node.chatConversationId;
      const starting = controller.startingAction(node.id);
      const queuedTrigger = node.kind === "trigger" && run?.status === "waiting" && !run.order.length && run.triggerQueue?.[0] === node.id;
      const triggerExecuting = node.kind === "trigger" && (run?.status === "running" || run?.status === "waiting") && run.order.includes(node.id);
      const activeWorkflow = run && (queuedTrigger || triggerExecuting || controller.isLocked(node.id) && run.order.includes(node.id)) ? run : undefined;
      const retryDelivery = !!activeWorkflow && deliveryRunIds.has(activeWorkflow.id) && node.id === activeWorkflow.startId;
      const continueWorkflow = activeWorkflow?.status === "waiting" && !Object.values(activeWorkflow.steps).some(step => step.status === "failed")
        && (activeWorkflow.order.find(id => activeWorkflow.steps[id].status !== "done")
          ?? (activeWorkflow.triggerQueue?.length ? activeWorkflow.startId : null)) === node.id;
      const stopAgent = node.kind !== "agent" ? undefined : starting ? () => controller.cancelStarting(node.id)
        : chatBusy && agentChat && !controller.isLocked(node.id) ? () => useLocalChatStore.getState().stop(agentChat.id)
          : activeWorkflow ? () => controller.stop(activeWorkflow.id) : undefined;
      const busy = creating || node.kind !== "trigger" && (!!starting || imageActivity.running || controller.isLocked(node.id) || chatBusy || pendingAgentCards.has(node.id) || node.planning?.status === "waiting");
      const providerIssue = (node.kind === "loop" || node.kind === "trigger" ? flowIssues.get(node.id) : providerIssues.get(node.id)) ?? null;
      const loop = node.kind === "loop" && run?.loop?.nodeId === node.id ? run.loop : undefined;
      const restartIssue = loop && run?.status === "stopped" ? loop.bodyIds.map(id => providerIssues.get(id)).find(Boolean) : null;
      // A saved request may only need a status query. Block retries known to submit again.
      const retryIssue = loop && run?.status === "waiting" ? Object.entries(run.steps).flatMap(([id, step]) => {
        if (step.status !== "failed") return [];
        const job = step.jobId && useStore.getState().genJobs[step.jobId];
        const last = job ? job.turns[job.turns.length - 1] : undefined;
        const confirmed = step.confirmedFailedChatTurnId || (job && !job.running && last && last.turnKey === step.turnKey && last.error)
          || (step.retrySafe && !step.jobId && !step.chatInput && !step.localDsRequestId && !step.agentRunId);
        const issue = confirmed && providerIssues.get(id);
        return issue ? [issue] : [];
      })[0] : null;
      const removableLocalVideo = controller.canDiscardLocalVideo(node.id);
      const removableWaitingVideo = node.kind === "generation" && node.generation?.media === "video"
        && run?.status === "waiting" && step?.status === "waiting" && !!step.jobId && !step.videoJobActive && !activeVideoJobs.includes(step.jobId);
      const loopItems = loopPreviews.get(node.id)?.items, loopInputNotice = loopPreviews.get(node.id)?.notice ?? "";
      const loopStartInvalid = node.kind === "loop" && (loopItems
        ? (node.loopStartItem ?? 1) > loopItems.length
        : node.loopMode !== "count" && !node.inputs[node.loopMode === "rows" ? "text" : "image"]?.length);
      const triggerMode = workflowTriggerMode(node);
      const inputPorts = node.kind === "trigger" && triggerMode !== "completion" ? [] : workflowInputs(node), outputPorts = workflowOutputs(node);
      const visibleInputs = node.kind === "comfy-video" ? generationInputNode(node).inputs : node.kind === "trigger" && triggerMode !== "completion" ? {} : node.inputs;
      const localVideo = node.kind === "comfy-video";
      const videoCard = localVideo || node.kind === "generation" && node.generation?.media === "video";
      const localImage = isH3ImageCard(node);
      const height = node.kind === "voice" ? 0 : node.kind === "generation" || node.kind === "comfy-video" ? 210 : node.kind === "trigger" ? 0 : node.kind === "loop" ? 260 : Math.max(330, 130 + Math.max(inputPorts.length, outputPorts.length) * 30);
      const outputImageIds = node.kind === "generation" || node.kind === "agent" ? [] : Object.values(node.outputs).flatMap(value => value.assetIds ?? []);
      const profileId = node.profileId || node.profileCache?.profileId || step?.profileId;
      const referenceCard = node.kind === "generation" || node.kind === "agent";
      const inputIds = node.kind === "trigger" || referenceCard ? [] : Object.values(visibleInputs).flat().flatMap(inputImages);
      const referenceIds = referenceCard ? generationReferencePreviewOrder(node, referencePreviewValues(node), document.nodes) : [];
      const generationCard = node.kind === "generation" || localVideo;
      const lastGenerationInput = generationCard ? lastGenerationRunInput(document, node.id) : undefined;
      let generationAction = "运行";
      if (lastGenerationInput?.prompt === node.prompt) {
        const current = generationInputNode(node, document.nodes);
        const currentReferences = localVideo
          ? h3RunReferences(Object.fromEntries(Object.entries(current.inputs).map(([port, inputs]) =>
            [port, inputs.map(input => ({ type: "image" as const, assetIds: inputImages(input) }))])))
          : [generationReferencePreviewOrder(current, referencePreviewValues(current), document.nodes)];
        if (JSON.stringify(lastGenerationInput.references) === JSON.stringify(currentReferences)) generationAction = "重试";
      }
      const references = referenceIds.map(id => assets.find(asset => asset.id === id)).filter((asset): asset is Asset => !!asset);
      const selectedImages = [...new Set(outputImageIds.length ? outputImageIds : inputIds)].map(id => assets.find(asset => asset.id === id)).filter((asset): asset is Asset => !!asset);
      let videoOptions = resolveVideoOptions(node.generation?.videoOptions ?? DEFAULT_VIDEO_OPTIONS, []);
      if (node.kind === "generation" && node.generation?.media === "video") {
        try {
          const draft = { ...node, inputs: { text: node.inputs.text ?? [],
            image: (node.inputs.image ?? []).map(input => input.groupId ? { ...input, assetIds: sourceImages(input) } : input) } };
          const inputNode = generationInputNode(draft, document.nodes);
          const values = workflowInputValues(document.nodes, inputNode, (id, cell) => {
            const source = graphById.get(id); return source ? canvasInputValue(source, cell, graphNodes) : undefined;
          });
          for (const [index, input] of (inputNode.inputs.image ?? []).entries()) {
            if (values.image[index]?.nodeIds?.length && isWorkflowGenerationResult(input, nodeById.get(input.nodeId ?? ""))) {
              values.image[index] = { ...values.image[index], assetIds: sourceImages(input) };
            }
          }
          const frameIds = new Set(videoFrameInputValues(draft, values, graphNodes, document.nodes).flatMap(value => value.assetIds ?? []));
          const references = compileGenerationPrompt(draft, values, document.nodes).assetIds.map(id => {
            const asset = assets.find(asset => asset.id === id);
            // These sockets submit a PNG tail frame, not the source video.
            return frameIds.has(id) && isVideoPath(asset?.store_path) ? { store_path: "__video_tail__.png" } : { store_path: asset?.store_path };
          });
          videoOptions = resolveVideoOptions(videoOptions, references);
        } catch { /* Draft references can be incomplete; execution validates them after upstream results arrive. */ }
      }
      const readCurrentPrompt = () => controller.document.nodes.find(card => card.id === node.id)?.prompt ?? node.prompt;
      const thumbnailIds = new Set(references.map(asset => asset.id));
      const thumbnailWireIds = new Set<string>();
      const labelledInputs = Object.entries(visibleInputs).map(([port, inputs]) => [port, inputs.filter(input => {
        if (localVideo && (port === "first-frame" || port === "last-frame" || port === H3_VIDEO_AUDIO_PORT)) return false;
        if (!referenceCard || (port !== "image" && port !== "text")) return true;
        const ids = inputImages(input);
        if (!ids.length || !ids.every(id => thumbnailIds.has(id))) return true;
        if (input.autoConnect) thumbnailWireIds.add(input.autoConnect);
        return false;
      })] as const).map(([port, inputs]) => [port, inputs.filter(input => !input.autoConnect || !thumbnailWireIds.has(input.autoConnect))] as const);
      const bindings = labelledInputs.some(([, inputs]) => inputs.length > 0) && <div className="workflow-bindings">
        {[...new Map(labelledInputs.flatMap(([, inputs]) => inputs).filter(input => input.autoConnect).map(input => [workflowDisconnectId(input)!, input])).entries()].map(([id, input]) =>
          <button key={id} disabled={busy && input.portId !== "signal" && node.kind !== "trigger"} title="断开连接" onClick={() => disconnectAutomatic(id)}>{sourceLabel(input).label}<X size={11} /></button>)}
        {labelledInputs.map(([port, bindings]) => [port, bindings.filter(input => !input.autoConnect)] as const).filter(([, bindings]) => bindings.length).map(([port, bindings]) =>
          <button key={port} disabled={busy && port !== "completion" && port !== "signal"} title="断开此输入" onClick={event => chooseDisconnect({ nodeId: node.id, port }, { x: event.clientX, y: event.clientY }, true)}>{node.kind === "loop" && bindings.length === 1 ? sourceLabel(bindings[0]).label : node.kind === "voice" && port === "image" ? "参考录音" : port === "completion" ? "完成触发" : port === "signal" ? "触发器" : port === "text" ? "文本" : port === "visual-profile" ? "视觉规范" : port === "first-frame" ? node.comfyVideo?.mode === "reference" ? "参考图" : "首帧" : port === "last-frame" ? "尾帧" : portMediaLabel(bindings)}{(node.kind !== "loop" || bindings.length > 1) && ` · ${bindings.length} 个来源`} <X size={11} /></button>)}
      </div>;
      const presentation = WORKFLOW_CARD_PRESENTATION[videoCard ? "comfy-video" : node.kind], CardIcon = node.kind === "trigger" ? TRIGGER_MODES.find(mode => mode.id === triggerMode)!.icon : presentation.icon;
      const optimization = step?.comfyOptimization;
      const optimizing = starting === "optimize" || run?.status === "running" && step?.status !== "done"
        && (step?.comfyAutoGeneration ? !optimization?.result : !!optimization);
      const generatingStatus = localVideo ? "正在生成视频" : "正在生成图片";
      const h3Status = (localVideo || localImage) ? (() => {
        if (step?.comfyStopping) return optimization && !optimization.result ? "正在停止提示词优化…" : "正在中断本机生成…";
        if (optimizing) return "正在优化提示词";
        if (starting === "run" && run?.status !== "running") return "准备运行";
        if (step?.comfyCancelled) return "已取消";
        if (run?.status === "stopped" && step?.status !== "done") return step?.status === "pending" ? "已停止，未执行" : "已停止";
        if (imageActivity.running || run?.status === "running"
          && (starting === "run" || step?.status === "running" || (localVideo && step?.status === "pending" && step.detail))) return generatingStatus;
        if (step?.status === "done") {
          if (optimization && !step.comfyAutoGeneration) return optimization.keptOriginal ? "已保留原提示词" : "提示词已优化";
          if (localVideo) return userErrorMessage(step.detail, "视频已生成");
          if (imageActivity.failed) return "图片生成失败";
          if (step.generationSubmission === "submitted") {
            const currentTurn = step.jobId && step.turnKey && imageActivity.session?.id === generationPromptNodeId(step.jobId, step.turnKey);
            if (!currentTurn) return "已提交生成";
            if (["cancelled", "canceled", "stopped"].includes(imageActivity.sessionStatus ?? "")) return "已取消";
            if (imageActivity.sessionStatus !== "done") return "已提交生成";
          }
          return "图片已生成";
        }
        if (step?.status === "waiting" && step.detail === "提示词已优化，等待本机生成") return step.detail;
        if (step?.status === "pending" && run?.status === "failed") return "因上游失败未执行";
        return step ? statusLabels[step.status] : node.trigger ? "工作流起点" : "未运行";
      })() : undefined;
      const h3Progress = localVideo && h3Status === generatingStatus && run?.status === "running" ? step?.comfyProgress : undefined;
      const h3VideoPhase = h3Progress?.label
        ?? (run?.status === "running" && (!step?.comfyAutoGeneration || step.jobId) ? step?.detail : undefined);
      const h3Detail = h3Status === generatingStatus
        ? localVideo
          ? h3VideoPhase ? userErrorMessage(h3VideoPhase, "等待本机进度") : ""
          : imageActivity.jobId ? generationProgressLabel(genJobs[imageActivity.jobId]) : ""
        : h3Status === "正在优化提示词" && step?.detail === "提示词优化排队中" ? "排队中" : "";
      const optimizationActions = <H3OptimizationActions nodeId={node.id} runs={workflowRuns(document)} disabled={busy || !node.prompt.trim()}
        busy={optimizing}
        retryDisabled={busy && !(run?.status === "waiting" && !!optimization && !step?.comfyAutoGeneration)}
        onOptimize={() => handle(controller.optimizeComfyPrompt(node.id, referenceIds.length))} onRetry={() => handle(controller.retryComfyPrompt(node.id))}
        restoreDisabled={busy} onRestore={async (runId, source) => {
          try {
            await controller.restoreComfyPrompt(node.id, runId, source);
            return true;
          } catch (error) {
            notifyError(error, "工作流操作未完成");
            return false;
          }
        }}
        onFocusPrompt={() => cardElements.current.get(node.id)?.querySelector<HTMLElement>('[aria-label="卡片指令"]')?.focus({ preventScroll: true })}
        onContinue={runId => handle(openOptimizationChat(node.id, runId))} />;
      const running = !!starting || imageActivity.running || chatBusy || run?.status === "running" && step?.status === "running";
      const displayed = displayPoint(node);
      const videoControls = videoCard && <VideoControls card menuClassName="canvas-tactical-model-menu" options={videoOptions} channel={node.generation?.videoChannel ?? "jimeng"}
        onChange={(options, channel) => {
          if (channel) patch(node.id, selectWorkflowVideoProvider(node, channel, options), false);
          else patch(node.id, { generation: { ...node.generation, videoOptions: options } });
        }}
        local={{ options: localVideo ? node.comfyVideo ?? DEFAULT_COMFY_VIDEO : undefined,
          onSelect: () => {
            if (localVideo) return;
            patch(node.id, selectWorkflowVideoProvider(node, "h3"), false);
          } }}
        ratio={node.generation?.ratio ?? "16:9"} onRatioChange={ratio => patch(node.id, { generation: { ...node.generation, ratio } })} />;
      return <article key={node.id} data-canvas-node data-workflow-card={node.id} ref={element => { if (element) cardElements.current.set(node.id, element); else cardElements.current.delete(node.id); }} aria-busy={running} className={`workflow-card ${running ? "canvas-card-running" : imageFailure || failure && !failure.dismissed ? "canvas-card-error" : ""} is-${node.kind} ${localVideo ? "is-generation" : ""} ${selectedIds.has(node.id) ? "is-selected" : ""} ${armed ? "is-key-target" : ""}`}
        style={{ left: displayed.x, top: displayed.y, width: workflowCardWidth(node), minHeight: height, zIndex: `var(--workflow-card-z, ${selectedIds.has(node.id) ? 11000 : 9000})` }}
        onPointerDownCapture={event => {
          const target = event.target as Element;
          if (target.closest(".workflow-agent-question-float")) { agentDetailPress.current = null; return; }
          agentDetailPress.current = node.kind === "agent" && event.button === 0 && !panReady && !armed
            && !connectionRef.current && !automaticRef.current && !event.ctrlKey && !event.metaKey && !event.shiftKey
            && event.currentTarget.contains(target) && !target.closest("button,input,select,textarea,label,summary,a,[contenteditable],.workflow-prompt-editor,.canvas-card-name")
            ? { nodeId: node.id, x: event.clientX, y: event.clientY } : null;
          if (event.button === 0 && armed && !busy && node.kind !== "planner" && !(event.target as HTMLElement).closest(".canvas-card-name")) { event.stopPropagation(); event.preventDefault(); patch(node.id, { trigger: true, inputs: { ...node.inputs, signal: [] } }, false); setArmed(false); }
        }}
        onPointerMoveCapture={event => {
          const press = agentDetailPress.current;
          if (press && exceedsCanvasDragThreshold(press, { x: event.clientX, y: event.clientY })) agentDetailPress.current = null;
        }}
        onPointerCancelCapture={() => { agentDetailPress.current = null; }}
        onPointerDown={event => { if (event.button !== 0 || panReady) return; event.stopPropagation(); if (!selectedIds.has(node.id) || event.ctrlKey || event.metaKey) onSelect(node.id, event.ctrlKey || event.metaKey); }} onDoubleClick={event => event.stopPropagation()}
        onClick={event => {
          const press = agentDetailPress.current;
          agentDetailPress.current = null;
          if (press?.nodeId === node.id && !panReady && !event.ctrlKey && !event.metaKey && !event.shiftKey
              && !exceedsCanvasDragThreshold(press, { x: event.clientX, y: event.clientY })) {
            onOpenAgent(node.id, conversationId);
          }
        }}
        onKeyDown={event => { if (!["Escape", "Delete", "Backspace"].includes(event.key) && !((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z")) event.stopPropagation(); }}
        onContextMenu={event => { if (creating) { event.preventDefault(); event.stopPropagation(); } else onNodeMenu(event, node.id); }} onWheel={event => { if ((event.target as HTMLElement).closest("textarea,.workflow-prompt-editor,.workflow-preview,.workflow-text-result")) event.stopPropagation(); }}
        onDragOver={event => { if (getDragAssets() || event.dataTransfer.types.includes("text/plain")) { event.preventDefault(); event.stopPropagation(); } }}
        onDrop={event => {
          if (event.dataTransfer.types.includes(WORKFLOW_CARD_DRAG_TYPE)) return;
          event.preventDefault(); event.stopPropagation(); if (busy) return;
          const keyText = event.dataTransfer.getData("text/plain");
          const previousKey = keyText.startsWith("bowerbird-winding-key:") ? keyText.slice(22) : "";
          if (node.kind !== "planner" && previousKey && document.nodes.some(node => node.id === previousKey && node.trigger)) {
            handle(edit(document.nodes.map(candidate => ({ ...candidate, trigger: candidate.id === node.id || (candidate.id !== previousKey && candidate.trigger),
              ...(candidate.id === node.id ? { inputs: { ...candidate.inputs, signal: [] } } : {}) })))); return;
          }
          const ids = getDragAssets(); if (!ids?.length || node.kind === "trigger" || node.kind === "agent" || node.kind === "comfy-video") return;
          if (node.kind === "voice") {
            if (node.voice?.id) return;
            if (ids.length !== 1) { notifyError(null, "请拖入一段音频"); return; }
            handle((async () => {
              const source = assets.find(asset => asset.id === ids[0]) ?? (await api.getAssetsByIds([ids[0]]))[0];
              if (!source || !isAudioPath(source.store_path)) throw new Error("请拖入一段音频");
              const current = controller.document.nodes.find(item => item.id === node.id);
              if (current && !current.voice?.id && !controller.isLocked(node.id)) patch(node.id, { inputs: { ...current.inputs, image: [{ assetId: source.id }] } });
            })()); return;
          }
          if (node.kind === "loop" && node.loopMode === "rows") { notifyError(null, "逐行模式请连接内容卡的整体文本输出"); return; }
          if (node.kind === "loop" && node.loopMode === "count") { notifyError(null, "按次数循环无需输入图片，请把图片连接到下游生成卡片"); return; }
          if (node.kind === "visual-profile" && node.profileId) { notifyError(null, "请先切换到从输入提炼"); return; }
          if (node.kind === "instruction" && node.action !== "describe" && ids.length !== 1) { notifyError(null, "此指令只接收一张图片"); return; }
          patch(node.id, { inputs: { ...node.inputs, image: ids.map(assetId => ({ assetId })) } });
        }}>
        <div className="canvas-tactical-card-shell" aria-hidden="true" />
        {nameEditor(node.id, { left: 0, top: -28, maxWidth: workflowCardWidth(node) - 60 }, busy)}
        {node.inputs.signal?.length ? gearButton(node) : node.trigger && keyButton(node)}
        <header data-local-chat-id={conversationId} data-chat-status={agentChat?.status}
          onMouseEnter={event => { if (node.kind === "trigger" && !event.buttons) showProgress(node.id, event.currentTarget, true); }}
          onMouseLeave={() => { if (node.kind === "trigger") setKeyHover(null); }}
          onPointerDown={event => {
            if (creating || (event.target as HTMLElement).closest("button")) return;
            onDragStart(event, node);
          }} onPointerMove={onDragMove} onPointerUp={event => onDragEnd(event)} onPointerCancel={event => onDragEnd(event, true)}>
          <span className="canvas-tactical-module-icon" aria-hidden="true"><CardIcon size={15} strokeWidth={1.5} /></span>
          {node.kind !== "agent" && <span className="canvas-tactical-module-code" data-module-code={presentation.code} aria-hidden="true" />}
          {node.kind === "agent" ? <strong role="button" tabIndex={0} aria-label="查看 Agent 详情" title="单击查看详情，拖动移动卡片"
            onClick={event => { if (event.detail === 0) { event.stopPropagation(); onOpenAgent(node.id, conversationId); } }}
            onKeyDown={event => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault(); event.stopPropagation();
              onOpenAgent(node.id, conversationId);
            }}>{presentation.title}</strong> : <strong title="拖动卡片">{presentation.title}</strong>}
          {agentChat && ((agentChat.provider === "dsh-local" && ["running", "failed", "interrupted"].includes(agentChat.status))
            || (agentChat.provider === "codex-local" && agentChat.status === "running"))
            && !(run?.status === "stopped" && step?.chatConversationId === agentChat.id)
            && <AgentCardQuestion key={agentChat.id} conversationId={agentChat.id} onResume={turnId => {
              const current = workflowNodeRun(controller.document, node.id);
              if (current?.status === "waiting" && current.steps[node.id]?.chatTurnId === turnId)
                handle(controller.continue(current.id));
            }} />}
          {(node.kind === "generation" || localVideo && !!node.sessionNodeIds?.length) && <WorkflowGenerationHistory node={node} graphNodes={graphNodes} onOpen={onOpenGeneration} />}
          {localImage && <ComfyEnvironmentControl key={state.cloudAuth?.user_id} node={{}} imageMode={references.length ? "edit" : "image"} disabled={busy} onChange={() => {}} />}
          {node.kind === "voice" && <VoiceEnvironmentControl projectId={projectId} onStatusChange={setVoiceIssue} />}
          {node.kind === "comfy-video" && <CardComfyEnvironment node={node} disabled={busy} onChange={changes => patch(node.id, changes, false)} onStatus={reportComfy} />}
          {expandedImageCards?.has(node.id) && <button type="button" aria-label="收起生成卡" title="收起生成卡" disabled={running} onClick={() => onCollapseImageCard?.(node.id)}><ChevronUp size={14} /></button>}
          <button aria-label="复制卡片" disabled={creating} onClick={() => {
            const current = controller.document.nodes.find(card => card.id === node.id);
            if (!current) return;
            const { workflow: [copy] } = cloneCanvasClipboard({ projectId, nodes: [], groups: [], items: [], workflow: [current], selection: [current.id] },
              projectId, current.x + 350, current.y);
            handle(edit([...controller.document.nodes, { ...copy, trigger: false }])); onSelect(copy.id);
          }}><Copy size={13} /></button>
          <button className="canvas-tactical-card-close" aria-label="删除卡片" disabled={busy && !removableWaitingVideo && !removableLocalVideo}
            title={removableWaitingVideo || removableLocalVideo ? "停止此工作流的等待并删除卡片；已生成素材保留" : "删除卡片"}
            onClick={() => {
              if (removableLocalVideo) { handle(controller.discardLocalVideo(node.id).then(() => { if (!controller.isLocked(node.id)) onRemove(node.id); })); return; }
              if (!removableWaitingVideo) { onRemove(node.id); return; }
              handle(controller.stop(run.id).then(() => { if (!controller.isLocked(node.id)) onRemove(node.id); }));
            }}><X size={15} /></button>
        </header>
        {(node.kind === "generation" || localVideo) && <div className="workflow-media-tabs" role="group" aria-label="生成类型" onPointerDown={event => event.stopPropagation()}>
          {(["image", "video"] as const).map(media => <button type="button" key={media} aria-label={media === "image" ? "图片" : "视频"} title={media === "image" ? "图片" : "视频"} aria-pressed={videoCard === (media === "video")} disabled={busy}
            onClick={() => {
              if (videoCard === (media === "video")) return;
              if (localVideo && media === "image") {
                const next = selectWorkflowVideoProvider(node, node.generation?.videoChannel ?? "jimeng");
                patch(node.id, { ...next, provider: state.activeGenProvider || state.defaultProvider, generation: { ...next.generation, media } }, false);
              } else patch(node.id, { generation: { ...node.generation, media } });
            }}>{media === "image" ? <Images size={13} aria-hidden="true" /> : <Clapperboard size={13} aria-hidden="true" />}{selectedIds.has(node.id) && <span>{media === "image" ? "图片" : "视频"}</span>}</button>)}
        </div>}
        <div className="workflow-card-body">
          {node.kind === "director3d" && <span>工作台已下架</span>}
          {node.templateInstance && <section className="workflow-template-instance" aria-label="子流程接口">
            <p>模板 v{node.templateInstance.template.revision} · {node.templateInstance.nodeIds.length - 1} 个步骤</p>
            <button disabled={busy} onClick={() => setTemplateLibrary({ instanceRoot: node.id })}>配置子流程参数</button>
            <details><summary>步骤与公开输出</summary>
              {node.templateInstance.nodeIds.slice(1).map((id, index) => <button key={id} onClick={() => locateIssue(id)}>步骤 {index + 1}</button>)}
              {node.templateInstance.template.outputs.map(output => <button key={output.id} onClick={() => {
                const index = node.templateInstance!.template.plan.nodes.findIndex(spec => spec.id === output.node); locateIssue(node.templateInstance!.nodeIds[index]);
              }}>输出 · {output.label}</button>)}
            </details>
            <button disabled={busy || node.templateInstance.nodeIds.some(id => controller.isLocked(id))} onClick={() => handle(edit(removeWorkflowNodes(controller.document.nodes, node.templateInstance!.nodeIds)))}>移除整个子流程</button>
          </section>}
          {node.kind === "planner" && <WorkflowPlannerCard node={{ ...node, inputs: { ...node.inputs, image: node.inputs.image?.map(input => input.groupId ? { ...input, assetIds: materials.find(item => item.groupId === input.groupId)?.assetIds ?? [] } : input) ?? [] } }} nodes={document.nodes} graphNodes={graphNodes} runtime={controller.planner} readCurrentPrompt={readCurrentPrompt} onChange={(prompt, promptReferences) => patch(node.id, { prompt, promptReferences })} onLocate={() => { const first = node.planning?.appliedNodes?.[0]; if (first) locateIssue(first.id); }} />}
          {node.kind === "instruction" && <TacticalSelect aria-label="指令功能" disabled={busy} value={node.action} onValueChange={value => {
            const action = value as WorkflowNode["action"];
            const nodes = invalidateWorkflow(document.nodes, node.id).map(candidate => candidate.id === node.id ? { ...candidate, action, outputPorts: [] } : { ...candidate,
              inputs: Object.fromEntries(Object.entries(candidate.inputs).map(([port, bindings]) => [port, bindings.filter(binding => binding.nodeId !== node.id)])) });
            handle(edit(nodes));
          }}><option value="describe">反推</option><option value="reuse">复用生成提示词</option><option value="layers">分层编辑</option></TacticalSelect>}
          {node.kind === "skill" && <TacticalSelect aria-label="选择技能" disabled={busy} value={node.skill} onValueChange={value => patch(node.id, { skill: value })}>
            {WORKFLOW_SKILLS.map(skill => <option key={skill.id} value={skill.id}>{skill.label}</option>)}
          </TacticalSelect>}
          {node.kind === "agent" && <AgentChatControls node={node} busy={busy} onChange={changes => patch(node.id, changes)}
            newChatAction={<button type="button" className="workflow-new-chat-action" title={NEW_AGENT_CHAT_TOOLTIP} aria-label="新建对话"
              disabled={busy} onPointerDown={event => event.stopPropagation()} onClick={() => handle(handleAgentCard(node, conversationId, "new"))}>
              <MessageCirclePlus size={15} aria-hidden="true" />
            </button>}
            onProviderChange={provider => handle(handleAgentCard(node, conversationId, provider))} />}
          {node.kind === "visual-profile" && <TacticalSelect aria-label="视觉规范来源" disabled={busy} value={node.profileId ?? ""} onValueChange={value => patch(node.id, { profileId: value || undefined, profileCache: undefined, inputs: {}, prompt: "" })}>
            <option value="">从图片 / 文字提炼</option>
            {node.profileId && !profiles.some(p => p.id === node.profileId) && <option value={node.profileId}>已选规范不可用</option>}
            {profiles.map(p => <option key={p.id} value={p.id}>{p.name} · v{p.version}</option>)}
          </TacticalSelect>}
          {node.kind === "voice" && <VoiceCard placedAssetIds={placedAudioAssets} node={node} projectId={projectId} assets={assets} referenceIds={(node.inputs.image ?? []).flatMap(inputImages)}
            step={step} busy={busy} runBlocked={!!providerIssue} patch={changes => patch(node.id, changes)} run={() => handle(controller.start(node.id, true))} />}
          {node.kind === "loop" && <WorkflowLoopCard node={node} items={loopItems} notice={loopInputNotice} busy={busy} run={run}
            runs={workflowRuns(document).filter(entry => entry.loop?.nodeId === node.id)} bindings={bindings} nodes={nodeById} assets={assets} onOpenAgent={onOpenAgent}
            graphById={graphById} onOpenGeneration={onOpenGeneration}
            onStartItem={loopStartItem => patch(node.id, { loopStartItem }, false)} onCount={loopCount => patch(node.id, { loopCount })} onMode={loopMode => {
              const outputIds = new Set(workflowOutputs({ ...node, loopMode }).map(port => port.id));
              const nodes = invalidateWorkflow(document.nodes, node.id).map(candidate => candidate.id === node.id
                ? { ...candidate, loopMode, loopCount: loopMode === "count" ? candidate.loopCount ?? 1 : undefined, loopStartItem: 1, inputs: { ...(node.inputs.signal ? { signal: node.inputs.signal } : {}) } }
                : { ...candidate, inputs: Object.fromEntries(Object.entries(candidate.inputs).map(([port, bindings]) => [port, bindings.filter(input => input.nodeId !== node.id || outputIds.has(input.portId ?? ""))])) });
              handle(edit(nodes));
            }} />}
          {node.kind === "instruction" && node.action === "describe" && <WorkflowDescribeOption node={node} assetIds={inputIds} checked={!!node.overwriteDescribe} disabled={busy} onChange={overwriteDescribe => patch(node.id, { overwriteDescribe })} />}
          {node.kind === "visual-profile" && !node.profileId && <input className="workflow-profile-name" aria-label="规范名称" disabled={busy} maxLength={80} placeholder="画板视觉规范" value={node.profileName ?? ""} onChange={event => patch(node.id, { profileName: event.target.value }, false)} />}
          {node.kind === "generation" && !localVideo && <div className="workflow-media-settings">
            {!videoCard && <div className="workflow-generation-parameters" role="toolbar" aria-label="生成参数" onPointerDown={event => event.stopPropagation()}>
              <fieldset disabled={busy}><RatioSelect value={node.ratio} onChange={ratio => patch(node.id, { ratio })} />
                <ProviderSelect environmentInHeader value={node.provider} onChange={provider => patch(node.id, { provider })} codexHealth={state.codexHealth} dreaminaHealth={state.dreaminaHealth}
                  cloudAuth={state.cloudAuth} cloudEntitlement={state.cloudEntitlement} menuClassName="canvas-tactical-model-menu" /></fieldset>
            </div>}
            {videoCard && <fieldset className="workflow-video-parameters workflow-video-controls" aria-label="视频参数" disabled={busy} onPointerDown={event => event.stopPropagation()}>
              {videoControls}
            </fieldset>}
          </div>}
          {localVideo && <ComfyVideoCard node={node} modelControl={videoControls}
                disabled={busy} readCurrentPrompt={readCurrentPrompt}
                assets={assets} inputImages={inputImages} onChange={changes => patch(node.id, changes)} optimizationActions={optimizationActions} />}
          {(node.kind === "generation" || node.kind === "agent" && !hasAgentMessages) && <WorkflowPromptEditor fitContent={videoCard} cardNames={cardNames} node={{ ...node, inputs: { ...node.inputs, image: node.inputs.image?.map(input => input.groupId ? { ...input, assetIds: inputImages(input) } : input) ?? [] } }} nodes={document.nodes} graphNodes={graphNodes} disabled={busy && !creating} readCurrentPrompt={readCurrentPrompt} onChange={(prompt, promptReferences) => patch(node.id, { prompt, promptReferences })} />}
          {localImage && optimizationActions}
          {node.kind !== "director3d" && node.kind !== "planner" && node.kind !== "trigger" && node.kind !== "loop" && node.kind !== "generation" && node.kind !== "agent" && node.kind !== "comfy-video" && node.kind !== "voice" && !(node.kind === "instruction" && node.action !== "describe") && !(node.kind === "visual-profile" && node.profileId) && <CanvasTextarea aria-label={node.kind === "instruction" ? "反推要求" : node.kind === "visual-profile" ? "视觉要求" : "卡片指令"}
            disabled={busy} maxLength={node.kind === "visual-profile" ? 4000 : undefined} placeholder={node.kind === "instruction" ? "留空使用当前反推要求" : node.kind === "visual-profile" ? "描述配色、构图、光线等要求；可只接图片或只填文字…" : "输入创作要求…"}
            value={node.prompt} readCurrentValue={readCurrentPrompt}
            onValueChange={prompt => patch(node.id, { prompt })} />}
          {references.length > 0 && <WorkflowGenerationReferences assets={references} disabled={busy || panReady} onMove={(from, to) => moveReference(node.id, from, to)} onDisconnect={assetId => disconnectReference(node.id, assetId)} />}
          {node.kind === "voice" || node.kind === "loop" || localVideo ? null : selectedImages.length > 0 ? <div className="workflow-preview">{selectedImages.map(asset => <WorkflowMediaThumbnail key={asset.id} asset={asset} />)}</div>
            : !hasAgentMessages && !references.length && node.kind !== "planner" && !(node.kind === "agent" && node.skill === "hyperframes") && <p className="workflow-hint">{node.kind === "agent" ? "输入任务要求，或连接上游内容" : node.kind === "trigger" ? <>上游成功完成后，扣 1 次并触发下游；为 0 时停止自动触发。</> : <><ImagePlus size={14} />{node.kind === "visual-profile" ? "图片可选 · 规范只影响连接的下游" : "拖入图片，或连接上游卡片"}</>}</p>}
          {node.kind === "trigger" && <div className="workflow-trigger-mode" onPointerDown={event => event.stopPropagation()}>
            <svg className="workflow-trigger-circuit" width="40" height="24" viewBox="0 0 40 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M0 15h9m21 0h10M13 13l13-9" /><circle cx="11" cy="15" r="2" /><circle cx="28" cy="15" r="2" />
              <path className="workflow-trigger-contact" d="M13 15h13" />
            </svg>
            <TacticalSelect aria-label="触发方式" value={triggerMode} disabled={busy} onValueChange={value => {
              const id = value as NonNullable<WorkflowNode["triggerMode"]>;
              if (triggerMode === id) return;
              patch(node.id, { triggerMode: id, triggerSchedule: undefined,
                ...(id === "completion" ? { completionSeen: [...new Set([...(node.completionSeen ?? []), ...completedCanvasSessions(node.inputs.completion ?? [], graphNodes, useStore.getState().genJobs)])] } : {}) }, false);
            }}>{TRIGGER_MODES.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}</TacticalSelect>
          </div>}
          {node.kind === "trigger" && (triggerMode === "daily" || triggerMode === "once") && <WorkflowTriggerSchedule key={triggerMode} mode={triggerMode} schedule={node.triggerSchedule} disabled={busy}
            onChange={triggerSchedule => patch(node.id, { triggerMode, triggerSchedule }, false)} />}
          {node.kind === "trigger" && triggerMode === "completion" && <label className="workflow-trigger-count" title="上游成功完成后扣 1 次；为 0 时停止完成触发。">剩余
            <input aria-label="剩余触发次数" type="number" min={0} max={9999} step={1} value={node.triggerCount ?? 0} disabled={busy}
              onChange={event => { const value = event.currentTarget.valueAsNumber; if (Number.isInteger(value) && value >= 0 && value <= 9999) patch(node.id, { triggerCount: value,
                ...(value > (node.triggerCount ?? 0) ? { completionSeen: [...new Set([...(node.completionSeen ?? []), ...completedCanvasSessions(node.inputs.completion ?? [], graphNodes, useStore.getState().genJobs)])] } : {}) }, false); }} />
            <span>次</span>
          </label>}
          {node.kind === "visual-profile" && <>
            {!node.profileId && <p className="workflow-hint">提炼 2 积分 · 图片分析另用账号额度 · 保存后继续</p>}
            {node.outputs["visual-profile"] && <p className="workflow-profile-summary">v{node.outputs["visual-profile"].version} · {node.outputs["visual-profile"].summary}</p>}
            {profileId && <button className="workflow-detail" onClick={() => handle((async () => {
              const profile = await api.visualProfileGet(profileId); state.openVisualProfile({ id: profile.folderId, name: profile.name, profileId });
            })())}>查看 / 确认视觉规范</button>}
            {node.profileCache && !node.profileId && <button className="workflow-detail" disabled={busy} onClick={() => patch(node.id, { profileCache: undefined })}>重新提炼</button>}
          </>}
          {node.kind === "instruction" && !outputPorts.length && <p className="workflow-hint">{node.action === "describe" ? "反推后展开各维度输出" : "保存分层工程后展开图层输出"}</p>}
          {node.kind !== "agent" && node.kind !== "loop" && outputPorts.filter(port => port.type === "text" && node.outputs[port.id]?.text).map(port => <details key={port.id} className="workflow-text-result">
            <summary>{node.outputs[port.id].table ? `表格 · ${contentTableRows(node.outputs[port.id].table!).length} 行 × ${contentTableRows(node.outputs[port.id].table!)[0].length} 列` : port.label}</summary>
            {node.outputs[port.id].table ? <div className="workflow-table-result"><table>
              {node.outputs[port.id].table!.title && <caption>{node.outputs[port.id].table!.title}</caption>}
              <tbody>{contentTableRows(node.outputs[port.id].table!).map((row, r) => <tr key={r}>{row.map((text, c) => <td key={c}>{text}</td>)}</tr>)}</tbody>
            </table></div> : <p>{node.outputs[port.id].text}</p>}
          </details>)}
          {node.kind !== "loop" && !videoCard && bindings}
          {failure && !failure.dismissed && <p className="workflow-error" role="alert">
            {userErrorMessage(failure.diagnostic?.message ?? step?.error, "这一步未完成，请查看问题并重试。")}
            {failure.diagnostic && <button onClick={() => controller.showIssue(failure.diagnostic!)}>查看问题</button>}
            <button onClick={() => controller.dismissCardFailure(failure.key)}>关闭提示</button>
          </p>}
          {imageFailure && <p className="workflow-error" role="alert">
            {userErrorMessage(imageActivity.error, "生成未完成，请查看详情并重试。")}
            <button type="button" onClick={() => onOpenGeneration(imageFailure)}>查看生成详情</button>
          </p>}
          {failure?.dismissed && (failure.diagnostic
            ? <button className="workflow-history-issue" onClick={() => controller.showIssue(failure.diagnostic!)}>查看问题</button>
            : <details className="workflow-history-issue"><summary>查看问题</summary>{userErrorMessage(step?.error, "这一步未完成。")}</details>)}
          {step?.error && step.status !== "failed" && <p className="workflow-waiting" role="status">{userErrorMessage(step.error, step.error.startsWith("尚未确认停止") ? "尚未确认停止，请稍后重试停止或查询原任务。" : step.status === "waiting" ? "任务状态尚未确认，请继续查询原任务，勿重复提交。" : "这一步未完成，请查看问题并重试。")}
            {step.diagnostic && <button onClick={() => controller.showIssue(step.diagnostic!)}>查看问题</button>}
          </p>}
          {(retryIssue || !busy && (restartIssue || providerIssue)) && <ProviderIssueNotice issue={retryIssue || restartIssue || providerIssue} />}
          {node.kind === "loop" && <WorkflowLoopActions run={run?.order.includes(node.id) ? run : undefined} busy={busy} invalid={loopStartInvalid || !!providerIssue}
            retryBlocked={!!retryIssue} restartBlocked={!!restartIssue}
            onStart={() => handle(controller.start(node.id))} onStop={() => handle(controller.stop(run?.id))}
            onContinue={() => handle(controller.continue(run?.id))} onRestart={() => run && handle(controller.restartLoop(run.id))}
            onRetry={() => run && handle(retryLoop(run.id))} />}
          {node.kind !== "loop" && node.kind !== "planner" && (node.kind !== "voice" || busy) && (node.kind !== "trigger" || triggerMode === "manual" || queuedTrigger || triggerExecuting || run?.status === "failed")
            && (!hasAgentMessages || (!busy && agentChat?.status !== "idle") || retryDelivery || continueWorkflow) && <footer className={hasAgentMessages ? "workflow-agent-run-footer" : undefined}>
            {h3Status ? <span className="workflow-h3-status" role="status">
              <span className="workflow-h3-status-copy">
                <span>{h3Status}</span>
                {h3Detail && !["生成视频", "正在生成图像", h3Status].includes(h3Detail) && <small>{h3Detail}</small>}
              </span>
              {h3Progress && <ComfyGenerationProgress progress={h3Progress} />}
            </span> : (!hasAgentMessages || agentChat?.status !== "idle") && <span role={imageActivity.running ? "status" : undefined}>{imageActivity.running ? generationProgressLabel(imageActivity.jobId ? genJobs[imageActivity.jobId] : undefined) : agentChat ? localChatStatusLabel(agentChat.status, agentChat.turnCount) : node.kind === "trigger" && (queuedTrigger || triggerExecuting) ? run?.status === "waiting" ? "等待继续" : "运行中" : step?.status === "pending" && run?.status === "failed" ? "因上游失败未执行" : step?.status === "pending" && run?.status === "stopped" ? "已停止，未执行" : step?.status === "done" && step.generationSubmission === "submitted" ? "已提交生成" : step ? statusLabels[step.status] : node.trigger ? "工作流起点" : "未运行"}</span>}
            {starting && node.kind !== "agent" ? <button title="取消启动" onClick={() => controller.cancelStarting(node.id)}><Square size={13} />停止</button> : imageActivity.running && imageActivity.jobId && !controller.isLocked(node.id) ? <button type="button" aria-label="停止生成" onClick={() => useStore.getState().cancelGeneration(imageActivity.jobId)}><Square size={13} />停止</button> : activeWorkflow ? <>
              {retryDelivery && <button onClick={() => handle(controller.continue(activeWorkflow.id))}>重试写入内容卡</button>}
              {continueWorkflow && <button aria-label="继续工作流" onClick={() => handle(controller.continue(activeWorkflow.id))}><Play size={13} />继续</button>}
              {node.kind !== "agent" && <button disabled={!!step?.comfyStopping} aria-label="停止工作流" title={node.kind === "comfy-video" ? "取消排队或中断本次生成" : "停止工作流"} onClick={() => handle(controller.stop(activeWorkflow.id))}><Square size={12} /></button>}
            </> : node.kind !== "agent" && node.kind !== "trigger" && <>
              {(localVideo || localImage) && <label className="workflow-video-auto-optimize" title="运行前通过 Cloud DSH 优化一次提示词，可能消耗 Bowerbird 积分。" onPointerDown={event => event.stopPropagation()}>
                <input type="checkbox" checked={h3AutoOptimize} disabled={busy} onChange={event => {
                  void useStore.getState().updateSettings({ h3_auto_optimize_prompt: event.target.checked })
                    .catch(error => notifyError(error, "自动优化设置未保存"));
                }} />
                自动优化提示词
              </label>}
              <button disabled={busy || !!providerIssue} aria-label={videoCard || generationAction === "重试" ? generationAction : "运行此卡片"} title={localVideo ? "本机算力·不扣额度" : undefined}
                onClick={() => runCard(node.id, true)}><Play size={13} aria-hidden="true" />{generationCard ? generationAction : "运行此卡片"}</button>
            </>}
            {node.kind === "trigger" && triggerMode === "manual" && <button disabled={creating || !!providerIssue} aria-label="触发下游" onClick={() => handle(controller.start(node.id))}><Play size={13} />触发下游</button>}
            {node.kind === "agent" && !hasAgentMessages && <button type="button" aria-label={stopAgent ? "停止回复" : "运行此卡片"}
              disabled={stopAgent ? agentChat?.status === "stopping" : busy || !!providerIssue}
              onClick={() => handle(stopAgent ? Promise.resolve(stopAgent()) : handleAgentCard(node, conversationId, "run"))}>
              {stopAgent ? <Square size={13} fill="currentColor" /> : <><Play size={13} />运行</>}
            </button>}
          </footer>}
          {agentChat && hasAgentMessages && <AgentCardConversation key={agentChat.id} summary={agentChat} busy={busy} blocked={!!providerIssue} onStop={stopAgent}
            onRerun={() => handle(handleAgentCard(node, conversationId, "run"))}
            history={agentHistory.length > 1 ? agentHistory : []} runPrompts={agentRunPrompts}
            getCardDefaults={getChatCardDefaults ?? (() => ({ provider: useStore.getState().defaultProvider, videoChannel: "jimeng", videoOptions: { ...DEFAULT_VIDEO_OPTIONS } }))}
            onOpen={(chatId, entryKey) => onOpenAgent(node.id, chatId === agentChat.id && entryKey ? undefined : chatId, entryKey)} />}
          {node.kind === "comfy-video" && run?.status === "stopped" && step?.jobId && !step.comfyCancelled && step.status !== "done" && <button disabled={busy} className="workflow-detail" onClick={() => handle(controller.recoverComfyVideo(run.id, node.id))}>取回上次视频</button>}
          {step?.agentRunId && node.kind === "skill" && <button className="workflow-detail" onClick={() => handle((async () => {
            const run = await api.cloudAgentGet(step.agentRunId!); useStore.getState().openCloudAgentRun(run, { navigate: false }); setAgentOpen(true);
          })())}>查看技能执行 / 审批</button>}
        </div>
        {node.kind === "trigger" ? inputPorts.map((port, index) => portButton(node, port, "input", index)) : inputPorts.length > 0 && automaticButton(node.id, "input", creating)}
        {node.kind === "trigger" ? outputPorts.map((port, index) => portButton(node, port, "output", index)) : outputPorts.length > 0 && automaticButton(node.id, "output", creating)}
      </article>;
    })}
    {armed && createPortal(<div ref={ghostElement} className="workflow-key-ghost" style={{ left: cursor.current.x + 16, top: cursor.current.y + 16 }}><WindingKey size={30} />卡片上吸附 · 空白处创建 · Esc 取消</div>, window.document.body)}
    {keyHover && createPortal(<div id="workflow-progress" role="tooltip" className="workflow-progress" style={{ left: Math.max(12, Math.min(keyHover.x, window.innerWidth - 340)), top: Math.max(12, Math.min(keyHover.y + 10, window.innerHeight - 320)) }}>
      {(() => {
        const run = [...workflowRuns(document)].reverse().find(item => item.startId === keyHover.id);
        if (!run) return <><strong>工作流起点</strong><p>点击运行下游流程 · 拖动更换起点 · 右键取下</p></>;
        const current = run.order.find(id => run.steps[id]?.status === "failed") ?? run.order.find(id => run.steps[id]?.status !== "done");
        const active = run.order.filter(id => run.steps[id]?.status === "running");
        return <><strong>{({running:"工作流运行中",waiting:"工作流等待继续",done:"工作流已完成",failed:"工作流已失败",stopped:"工作流已停止"})[run.status]} · {run.order.filter(id => run.steps[id]?.status === "done").length}/{run.order.length}</strong>
          {current && <p>第 {run.order.indexOf(current) + 1} 步：{userErrorMessage(run.steps[current]?.error || run.steps[current]?.detail, run.steps[current]?.error ? "这一步未完成，请查看问题。" : "准备执行")}</p>}
          {run.status === "running" && active.length > 1 && <p>{active.length} 个步骤同时执行中</p>}
          <ol>{run.order.map((id, index) => {
            const card = document.nodes.find(item => item.id === id); const item = run.steps[id];
            const label = card?.kind === "instruction" ? ({describe:"反推",layers:"分层拆分",reuse:"复用生成提示词"})[card.action] : card ? workflowTitle(card) : "已移除卡片";
            const executing = item?.status === "running" || item?.status === "waiting";
            return <li key={id} className={id === current || executing ? "is-current" : ""}><span>{index + 1}. {label} · {item?.status === "done" ? "已完成" : item?.status === "failed" ? "失败" : executing ? run.status === "stopped" || run.status === "failed" ? "已停止" : item.status === "waiting" ? "等待继续" : "执行中" : run.status === "failed" ? "因上游失败未执行" : run.status === "stopped" ? "已停止，未执行" : "等待上游"}</span>
              {(id === current || executing) && <p>{userErrorMessage(item?.error || item?.detail, item?.error ? "这一步未完成，请查看问题。" : "准备执行")}</p>}</li>;
          })}</ol></>;
      })()}
    </div>, window.document.body)}
    {issue && diagnosticTarget && createPortal(<section className="workflow-diagnostic" role="alert" aria-label="工作流问题" onPointerDown={event => event.stopPropagation()}>
      <header><strong>{deliveryRunIds.has(issue.runId ?? "") ? "内容写入未完成" : issue.phase === "validation" ? "工作流未启动" : "工作流已停止"}</strong><button aria-label="关闭工作流问题" onClick={() => controller.dismissIssue()}><X size={15} /></button></header>
      <p className="workflow-diagnostic-location">{issue.step ? `第 ${issue.step} 步 · ` : "启动检查 · "}{issue.nodeLabel}</p>
      {issue.referenceLabel && <p>输入引用：@{issue.referenceLabel}</p>}
      {issueSourceLabel && <p>来源：{issueSourceLabel}</p>}
      <p>{userErrorMessage(issue.message, "这一步未能完成。")}</p><p className="workflow-diagnostic-action">{userErrorMessage(issue.action, "请检查这张卡片的输入和设置，然后重试。")}</p>
      <div className="workflow-diagnostic-buttons"><button onClick={() => locateIssue(issue.nodeId)}>定位出错卡片</button>
        {deliveryRunIds.has(issue.runId ?? "") && <button onClick={() => handle(controller.continue(issue.runId))}>重试写入内容卡</button>}
        {issueSourceId && (document.nodes.some(node => node.id === issueSourceId) || graphNodes.some(node => node.id === issueSourceId && node.hiddenAt == null)) && <button onClick={() => locateIssue(issueSourceId)}>定位来源</button>}
        <button onClick={() => handle(navigator.clipboard.writeText(workflowDiagnosticReport(issue)).then(() => notifySuccess("诊断信息已复制")))}>复制诊断信息</button>
      </div>
      <details><summary>诊断详情</summary><pre>{workflowDiagnosticReport(issue)}</pre></details>
    </section>, diagnosticTarget)}
    {controller.error && diagnosticTarget && createPortal(<div className="workflow-save-error" role="alert" onPointerDown={event => event.stopPropagation()}>{userErrorMessage(controller.error, "工作流未能保存，请重试保存。")}<button onClick={() => handle(retryWorkflowSave(controller))}>重试保存</button></div>, diagnosticTarget)}
    {connectionHover && (() => {
      const node = nodeById.get(connectionHover.id), card = graphById.get(connectionHover.id) ?? materialById.get(connectionHover.id);
      const rect = node ? { x: node.x, y: node.y, width: workflowCardWidth(node), height: cardHeights.current.get(node.id) ?? 300 } : card;
      return rect && <div className={`canvas-connection-target${connectionHover.error ? " is-invalid" : ""}`} style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        data-connection-target={connectionHover.id} aria-label={connectionHover.error ? userErrorMessage(connectionHover.error, "此卡片暂时不能连接") : "可以连接"} />;
    })()}
    {connectionHover?.error && createPortal(<div className="canvas-connection-notice" role="status" style={{ left: cursor.current.x + 16, top: cursor.current.y + 16 }}>{userErrorMessage(connectionHover.error, "此卡片暂时不能连接")}</div>, window.document.body)}
    {cardMenu && <ContextMenu key={videoConnection ? "video-reference" : connectionMenu ? connectionMenu.gesture.scope ?? "all" : "blank"} x={cardMenu.x} y={cardMenu.y}
      label={videoConnection ? "引用视频" : connectionMenu ? connectionMenu.gesture.side === "output" ? "添加下游" : "添加上游" : "新建卡片"}
      trigger={videoConnection ? connectionMenu?.gesture.trigger : undefined}
      onClose={connectionMenu ? clearAutomatic : () => setBlankCardMenu(null)}>
      {videoConnection ? VIDEO_REFERENCE_OPTIONS.map(({ label, frame }) => {
        const { output, target, created } = videoConnection;
        const error = videoReferenceError(videoConnection, frame);
        return <button key={label} role="menuitem" className="app-context-item px-2 py-1.5" disabled={!!error} title={error ?? undefined}
          onClick={() => commitAutomatic([output], target, created ? [created] : [], frame)}>{label}</button>;
      }) : <>
      {CONNECTION_CARDS.map(option => {
        const error = connectionMenu && newConnectionError(connectionMenu.gesture, connectionCard(option, { x: 0, y: 0 }));
        const Icon = WORKFLOW_CARD_PRESENTATION[option.kind].icon;
        return <button key={option.label} role="menuitem" className="app-context-item px-2 py-1.5" disabled={!!error} title={error ? userErrorMessage(error, "此卡片暂时不能连接") : undefined} onClick={() => {
          if (connectionMenu) createConnected(option);
          else if (blankCardMenu) {
            setBlankCardMenu(null);
            addCard(connectionCard(option, blankCardMenu.point));
          }
        }}><Icon size={15} />{option.label}</button>;
      })}
      {connectionMenu && <>
      <ContextSubmenu label="连接已有卡片">
        {() => [...new Set([...controller.document.nodes.filter(node => !node.textTarget && !node.textSource).map(node => node.id),
          ...graphNodes.filter(node => node.hiddenAt == null).map(node => node.id), ...materials.map(item => item.id)])].filter(id => {
          if (id === connectionMenu.gesture.id) return false;
          if (connectionMenu.gesture.side === "input" && nodeById.get(connectionMenu.gesture.id)?.kind === "trigger" && conversationCards?.hiddenIds.has(id)) return false;
          return !receiverError(gestureOutputs(connectionMenu.gesture, id), connectionMenu.gesture.side === "output" ? automaticTarget(id) : connectionMenu.gesture.target);
        }).map(id => <button role="menuitem" className="app-context-item px-2 py-1.5" key={id} onClick={event => {
          const { gesture, x, y } = connectionMenu;
          const rect = event.currentTarget.getBoundingClientRect();
          chooseAutomaticReceiver(gesture, gestureOutputs(gesture, id), gesture.side === "output" ? automaticTarget(id) : gesture.target,
            { x: rect.right < innerWidth - 150 ? rect.right + 4 : x, y: rect.top || y });
        }}>{cardNames[id] ?? "卡片"}</button>)}
      </ContextSubmenu>
      {(() => {
        const card = graphById.get(connectionMenu.gesture.id);
        if (card?.kind !== "note") return null;
        const note = readCanvasNote(card), input = connectionMenu.gesture.side === "input";
        if (!["text", "images"].includes(note.note_type)) return null;
        return <ContextSubmenu label={input ? "指定接收位置" : "指定内容"}>
          {() => <>
            <button role="menuitem" className="app-context-item px-2 py-1.5" onClick={() => selectConnectionScope()}>{input ? "追加到卡片" : "全部内容"}</button>
            {input && ["row", "column"].flatMap(axis => (axis === "row" ? note.cells.map(row => row[0]) : note.cells[0]).map((cell, index) =>
              <button role="menuitem" className="app-context-item px-2 py-1.5" key={`${axis}:${cell.id}`} onClick={() => selectConnectionScope(`${axis}:${cell.id}`)}>第 {index + 1} {axis === "row" ? "行" : "列"}</button>))}
            {note.cells.flatMap((row, r) => row.map((cell, c) => <button role="menuitem" className="app-context-item px-2 py-1.5" key={cell.id} onClick={() => selectConnectionScope(cell.id)}>第 {r + 1} 行，第 {c + 1} 列</button>))}
          </>}
        </ContextSubmenu>;
      })()}
      {connectionMenu.gesture.side === "output" && (() => { const card = graphById.get(connectionMenu.gesture.id); return card?.kind === "note" && ["text", "images"].includes(readCanvasNote(card).note_type); })() &&
        <button role="menuitem" className="app-context-item px-2 py-1.5" onClick={() => beginAutomatic(connectionMenu.gesture.id, "output", { x: connectionMenu.x, y: connectionMenu.y }, true, !connectionMenu.gesture.latest)}>{connectionMenu.gesture.latest ? "使用全部内容" : "仅使用最新一行"}</button>}
      </>}
      </>}
    </ContextMenu>}
    {agentOpen && <ModalShell title="技能执行" width="lg" onClose={() => setAgentOpen(false)}><CloudAgentSession embedded /></ModalShell>}
    {localRunReview?.projectId === projectId && <ConfirmDialog open title="是否需要继续运行当前卡片？"
      message="目前已有运行中的本地生成卡片。同时运行当前卡片，可能会导致电脑卡顿、生成速度降低。"
      confirmLabel="确认" onCancel={() => setLocalRunReview(null)}
      onConfirm={() => { setLocalRunReview(null); runCard(localRunReview.nodeId, localRunReview.single, true); }} />}
    {retryReview?.projectId === projectId && <ConfirmDialog open title="重做失败步骤？" confirmLabel="保留卡片并重做"
      message={`这一步已创建：${retryReview.cardNames.join("、")}。重做会保留这些卡片，也可能再次创建相同的内容。`}
      onCancel={() => setRetryReview(null)} onConfirm={() => { setRetryReview(null); handle(retryReview.confirm()); }} />}
    {templateLibrary && <WorkflowTemplateLibrary controller={controller} selectedIds={selectedIds} graphNodes={graphNodes} provider={state.activeGenProvider || state.defaultProvider}
      instanceRoot={templateLibrary.instanceRoot} importPackage={templateLibrary.importPackage} ensureMaterialized={ensureMaterialized} onClose={() => setTemplateLibrary(null)} onLocate={locateIssue} />}
    {templateSelection?.projectId === projectId && <SaveWorkflowTemplateDialog nodes={templateSelection.nodes} selectedIds={templateSelection.ids} graphNodes={templateSelection.canvas} bounds={templateSelection.bounds} mode={templateSelection.mode}
      onEncapsulate={async (name, members, template) => { await ensureMaterialized(); const result = await controller.encapsulate(name, members, templateSelection.bounds, template); onPlaced(result.bounds); return result; }}
      onClose={() => setTemplateSelection(null)} onSaved={() => notifySuccess(templateSelection.mode === "package" ? "工作流数据包已导出，可发送给对方导入" : templateSelection.mode === "template" ? "已存为模板，并保留封装布局" : "已封装为容器")} />}
  </>;
}));
