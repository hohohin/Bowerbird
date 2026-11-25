import { userErrorMessage } from "../lib/userError";
import { useProjectChatSummaries, useLocalChatStore } from "../lib/localChatStore";
import { agentChatOptions, localChat, localChatRunning, type ChatCardDefaults, type ChatProvider } from "../lib/localChat";
import { createdChatTurnCards, terminalDshTurnFailure, workflowAgentProvider } from "../lib/workflowAgentChat";
import { chatDshStatus, chatQuote } from "../lib/chatCapabilities";
import { profileExtractionIssue, profileInputKey, workflowProviderIssue } from "../lib/workflowProviderIssue";
import { useWorkflowLayerIssue } from "./useWorkflowLayerIssue";
import type { ProviderIssue } from "../lib/generationAvailability";
import { forwardRef, memo, startTransition, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore as useSnapshot } from "zustand";
import { shallow } from "zustand/shallow";
import { api } from "../lib/api";
import { comfyVideoMode } from "../lib/comfyVideo";
import { startComposerLocalVideo } from "../lib/composerLocalVideo";
import { activeCanvasNameCounts, assignCanvasCardNames, canvasCardNameError } from "../lib/canvasCardNames";
import { CanvasCardName } from "./CanvasCardName";
import { CanvasConnectionDefinitions, CanvasConnectionHandle } from "./CanvasConnectionHandle";
import { IMAGE_GENERATION_CARD, WorkflowConnectionMenu, VIDEO_REFERENCE_OPTIONS, type ConnectionCardOption, type VideoReferenceMode } from "./WorkflowConnectionMenu";
import { automaticValueMedia, canvasAutomaticOutputs, workflowSourceMediaLabel } from "../lib/workflowCanvasCapabilities";
import { hasTableWriter, resolveAssetMediaType } from "./workflowLayerBindings";
import { automaticInputMedia, planAutomaticConnection, contentCardAcceptsMedia, type AutomaticOutput } from "../lib/workflowAutoConnect";
import type { DisconnectChoice } from "./WorkflowDisconnectMenu";
import { workflowLoopItems, workflowLoopRows } from "../lib/workflowLoop";
import { WorkflowLoopFrame } from "./WorkflowLoopFrame";
import { placeCanvasCardNearSource } from "../lib/canvasReferencePlacement";
import { canvasDocumentHeight, expandCanvasSections, readCanvasNote } from "../lib/canvasNotes";
import { contentInputPort } from "../lib/canvasContentInput";
import { canvasInputAssetIds, canvasInputValue, canvasWorkflowInputState, canvasSessionImages, workflowBindingAssetIds, workflowGenerationResultAnchor, hiddenWorkflowSessionIds, workflowSessionIds, type WorkflowGenerationActivity } from "../lib/canvasSessionOutputs";
import { useStore } from "../store";
import { canvasWirePath as path, type DragOffset } from "../lib/canvasDragPreview";
import { useWorkflowPortGeometry, type WorkflowPortTarget } from "../lib/useWorkflowPortGeometry";
import { WorkflowCardItem, type WorkflowCardContext } from "./WorkflowCardItem";
import { WorkflowWiresLayer } from "./WorkflowWiresLayer";
import { WorkflowDisconnectOverlay, WorkflowOverlays } from "./WorkflowOverlays";
import { renderCanvasCards, useCanvasEntryCardContext } from "./CanvasEntryCard";
import { isWorkflowProDenied } from "../lib/workflowEntitlement";
import { singleVideoOutput, useWorkflowConnectionGesture } from "./useWorkflowConnectionGesture";
import { comfyCheckKey, disconnectKey, WindingKey } from "./WorkflowLayerPresentation";
import type { AutomaticGesture, AutomaticTarget, Connection, ConnectionMenuState, DisconnectTarget, H3RunChoice, MaterialAnchor, PendingConnectionCard, VideoReferenceTarget, WorkflowGeometry, WorkflowLayerHandle, WorkflowLayerProps } from "./WorkflowLayerTypes";
import { useLatestCallback } from "../lib/useCanvasFrame";
import { notifyError, notifySuccess } from "../lib/notify";
import { canvasWorkflowController } from "../lib/canvasWorkflowRuntime";
import { h3CardDraft, h3DraftForResult, h3DraftStale, h3OriginalPrompt, h3PromptPatch, isH3ImageCard, workflowFrameLabel, workflowProducesVideo, workflowVideoAudioLabel } from "../lib/canvasWorkflow";
import { H3_R2V_INPUT_LIMITS, H3_R2V_INPUT_PORTS, H3_VIDEO_AUDIO_PORT, workflowBindingKey, generationReferencePreviewOrder, lastGenerationRunInput, disconnectGenerationReference, reorderGenerationReferences, isWorkflowGenerationResult, workflowOrder } from "../lib/canvasWorkflow";
import {
  assertWorkflowAcyclic, invalidateWorkflow, newWorkflowNode, normalizeWorkflowInputSlots, workflowNodeRun, workflowRuns, workflowInputProducers, workflowConnectionError, workflowCompletionTarget, workflowInputs, workflowOutputs,
  workflowPortY, workflowTitle, workflowCardWidth, type WorkflowInput, type WorkflowLoopItem, type WorkflowNode, type WorkflowPort
} from "../lib/canvasWorkflow";
import type { Asset, CanvasNode, VisualProfileSummary } from "../lib/types";
import { H3_IMAGE } from "../lib/genProviders";
import { generationPromptNodeId } from "../lib/projectNodeIds";
import { DEFAULT_VIDEO_OPTIONS } from "../lib/videoGeneration";
import { materializeVideoFrameOutput, videoFrameOutputPreview } from "../lib/workflowVideoFrames";
import { materializeVideoAudioOutput, videoAudioOutputPreview } from "../lib/workflowVideoAudio";
import { isWorkspaceOperationCurrent } from "../lib/workspaceRoute";
import { isAudioPath } from "../lib/audioMedia";
import { readVoiceDraft } from "../lib/voiceStudioDraft";
import "./CanvasWorkflow.css";
export { WindingKey };

const IDLE_GENERATION: WorkflowGenerationActivity = { running: false };

export type { AutomaticGesture, AutomaticTarget, Connection, ConnectionMenuState, DisconnectTarget, H3RunChoice,
  MaterialAnchor, PendingConnectionCard, WorkflowGeometry, WorkflowLayerHandle } from "./WorkflowLayerTypes";

function videoReferenceOutput(output: AutomaticOutput, mode?: VideoReferenceMode) {
  return mode === "audio" ? videoAudioOutputPreview(output) : mode ? videoFrameOutputPreview(output, mode) : output;
}

function connectionForType(source: Connection, type?: WorkflowPort["type"]): Connection {
  return ["*latest", "*latest-image"].includes(source.cellId ?? "") && (type === "text" || type === "image")
    ? { ...source, cellId: type === "image" ? "*latest-image" : "*latest", type } : source;
}
export const CanvasWorkflowLayer = memo(forwardRef<WorkflowLayerHandle, WorkflowLayerProps>(function CanvasWorkflowLayer({ projectId, provisional = false, diagnosticTarget = window.document.body, getZoom, settledZoom, opening = false, entryCardIds, deferredCandidateIds, materials, graphNodes, knownAssets, loadAssets = api.getAssetsByIds, visibleGraphNodeIds, conversationCards, selectedConversationOutputs, imageOnlyConversationIds, sessionHeights, generationCardAnchors, generationCardOrigins, generationActivities, activeGenerationIds, pinnedCardOffsets, peekCard, onPeekInteraction, onToggleGenerationPin, onConnectCollapsedGeneration, onUndoGenerationConnection, ensureMaterialized, toBoardPoint, onPlaced, selectedIds, panReady, onSelect, onNodesChanged, onTriggerArmedChange, onEdited, onOpenGeneration, onOpenAgent, getChatCardDefaults, onNewAgentChat, onDragStart, onDragMove, onDragEnd, onNodeMenu, onRemove }, ref) {
  const controller = useMemo(() => canvasWorkflowController(projectId), [projectId]);
  const [, redraw] = useState(0);
  const [controllerRevision, setControllerRevision] = useState(0);
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
  const cardRefs = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const cardObserver = useRef<ResizeObserver>();
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
  const [loadedAssets, setLoadedAssets] = useState<{ projectId: string; loader: typeof loadAssets; assets: Asset[] }>();
  const assetById = useMemo(() => {
    const byId = new Map(knownAssets);
    if (loadedAssets?.loader === loadAssets && loadedAssets.projectId === projectId) {
      for (const asset of loadedAssets.assets) if (!byId.has(asset.id)) byId.set(asset.id, asset);
    }
    return byId;
  }, [knownAssets, loadedAssets, loadAssets, projectId]);
  const [agentOpen, setAgentOpen] = useState(false);
  const [retryReview, setRetryReview] = useState<{ projectId: string; cardNames: string[]; confirm: () => Promise<void> } | null>(null);
  const [localRunReview, setLocalRunReview] = useState<{ projectId: string; nodeId: string; single: boolean; choice?: H3RunChoice } | null>(null);
  const [staleReview, setStaleReview] = useState<string | null>(null);
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
  const chatSummaries = useProjectChatSummaries(projectId, true);
  const activeVideoJobs = useStore(state => Object.values(state.genJobs).filter(job => job.media === "video" && job.running).map(job => job.id), shallow);
  const [savingH3Preference, setSavingH3Preference] = useState(false);
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
      // Let H3 cards explain the Pro requirement when the user starts a run.
      if (issue?.settings === "account" && (node.kind === "comfy-video" || isH3ImageCard(node))) continue;
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
  const collapsedAnchor = (id: string) => activeGenerationIds.has(id) || pinnedCardOffsets?.has(id) ? undefined : generationCardAnchors?.get(id);
  const cardMounted = (id: string) => entryCardIds === null || entryCardIds.has(id) || (!!deferredCandidateIds && !deferredCandidateIds.has(id));
  const workflowNodeMounted = (node: WorkflowNode) => activeGenerationIds.has(node.id)
    || cardMounted(node.textTarget?.nodeId ?? node.textSource ?? collapsedAnchor(node.id)?.id ?? node.id);
  const collapsedAnchorOwners = useMemo(() => new Map([...(generationCardAnchors ?? [])].flatMap(([id, anchor]) =>
    activeGenerationIds.has(id) || pinnedCardOffsets?.has(id) ? [] : [[anchor.id, id] as const])), [generationCardAnchors, pinnedCardOffsets, activeGenerationIds]);
  const generationAnchorOwners = useMemo(() => new Map([...(generationCardAnchors ?? [])].map(([id, anchor]) => [anchor.id, id])), [generationCardAnchors]);
  const displayPoint = (node: WorkflowNode) => {
    const offset = pinnedCardOffsets?.get(node.id);
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
  const nameCards = useMemo(() => [
    ...document.nodes.filter(node => !node.textTarget && !node.textSource).map(node => ({ id: node.id, title: workflowTitle(node) })),
    ...graphNodes.map(node => ({ id: node.id, title: node.kind === "note" ? (readCanvasNote(node).artboard ? "画板" : { text: "内容卡片", images: "内容卡片", document: "文本卡片", bubble: "气泡", section: "分区" }[readCanvasNote(node).note_type] ?? "内容卡片") : node.kind === "asset" ? materialById.get(node.id)?.audio ? "音频卡片" : materialById.get(node.id)?.video ? "视频卡片" : "图片卡片" : "会话卡片" })),
    ...materials.filter(item => item.groupId).map(item => ({ id: item.groupId!, title: "素材组" })),
  ], [document.nodes, graphNodes, materialById, materials]);
  const cardNames = useMemo(() => assignCanvasCardNames(document.cardNames, nameCards), [document.cardNames, nameCards]);
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
    if (input.groupId) { const group = groupById.get(input.groupId); return (input.autoConnect || input.mediaFilter?.some(media => media === "audio" || media === "video") ? group?.mediaAssetIds : group?.assetIds) ?? group?.assetIds ?? []; }
    return workflowBindingAssetIds(input, nodeById.get(input.nodeId ?? ""), graphById.get(input.canvasNodeId ?? ""), graphNodes);
  }, [groupById, graphById, graphNodes, nodeById]);
  const inputImages = useCallback((input: WorkflowInput) => {
    const ids = sourceImages(input);
    return input.excludedAssetIds?.length ? ids.filter(id => !input.excludedAssetIds!.includes(id)) : ids;
  }, [sourceImages]);
  function h3ReferenceAssets(input: WorkflowInput, media?: keyof typeof H3_R2V_INPUT_PORTS) {
    const source = media ? { ...input, mediaFilter: [media] } : input;
    if (source.nodeId && source.videoFrame) {
      if (source.mediaFilter && !source.mediaFilter.includes("image")) return [];
      // The slot accepts a frame, but its preview comes from the upstream video's cover.
      return inputImages({ ...source, videoFrame: undefined });
    }
    return inputImages(source).filter(id => {
      if (!media && !source.mediaFilter) return true;
      const type = resolveAssetMediaType(id, materialByAsset, assetById);
      return !type || (media ? media === type : source.mediaFilter?.includes(type));
    });
  }
  function h3ReferencePending(input: WorkflowInput) {
    return !!input.nodeId && nodeById.has(input.nodeId) && !sourceImages({ ...input, videoFrame: undefined }).length;
  }
  function h3ReferenceCount(input: WorkflowInput, media?: keyof typeof H3_R2V_INPUT_PORTS) {
    return h3ReferenceAssets(input, media).length || Number(h3ReferencePending(input));
  }
  function inputMediaLabel(binding: WorkflowInput) {
    if (binding.videoAudio) return "音频";
    if (binding.videoFrame) return "图片";
    return workflowSourceMediaLabel(inputImages(binding), assetById, nodeById.get(binding.nodeId ?? ""));
  }
  function portMediaLabel(bindings: WorkflowInput[]) {
    const label = inputMediaLabel(bindings[0]);
    return bindings.slice(1).every(binding => inputMediaLabel(binding) === label) ? label : "素材";
  }
  function referencePreviewValues(node: WorkflowNode, includeText = false, imageIds = sourceImages) {
    return {
      image: (node.inputs.image ?? []).map(input => ({ type: "image" as const, assetIds: imageIds(input) })),
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
  const { loopPreviews, currentRows } = useMemo(() => {
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
        }
      } catch (error) { loopPreviews.set(node.id, { notice: userErrorMessage(error, "暂时无法预览循环内容，请检查输入后重试。") }); }
    }
    return { loopPreviews, currentRows };
  }, [document, graphNodes, graphById, inputImages]);
  const portTargets = useMemo(() => {
    const targets: WorkflowPortTarget[] = [];
    const addPort = (id: string | undefined, kind: WorkflowPortTarget["kind"], port: string | undefined, image = false) => {
      const node = id && graphById.get(id);
      if (node && node.kind === "note" && port !== undefined) targets.push({ node, kind, port, image });
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
    for (const { source, first, last } of currentRows.values()) {
      addPort(source.id, "cell", first);
      addPort(source.id, "cell", last);
    }
    return targets;
  }, [document.nodes, nodeById, graphById, conversationCards, connection, automatic, currentRows]);
  const portRect = useWorkflowPortGeometry(wireElement, portTargets, getZoom, settledZoom);
  const frames = new Map<string, { owner: string; x: number; y: number; width: number; height: number; index: number; total: number }>();
  for (const [id, row] of currentRows) {
    const first = portRect(row.source, "cell", row.first);
    const last = portRect(row.source, "cell", row.last);
    if (first && last) frames.set(id, { owner: row.source.id, x: first.x - 3, y: first.y, width: last.x + last.width - first.x + 6,
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
    onOpenAgent(nodeId, chat.id, undefined, async text => {
      const node = controller.document.nodes.find(item => item.id === nodeId);
      const snapshot = workflowRuns(controller.document).find(run => run.id === runId)?.steps[nodeId]?.comfyOptimization;
      if (!node || !snapshot?.result || activeController.current !== controller || !h3CardDraft(node)
        || ("mode" in snapshot.input) !== (node.kind === "comfy-video")) throw new Error("卡片或优化记录已更改，请从当前卡片重新打开续聊。");
      if (controller.isLocked(nodeId) || controller.startingAction(nodeId)) throw new Error("请在卡片任务结束后应用回复。");
      if (!text.trim() || text.length > 16000) throw new Error("优化后提示词需要 1–16000 字。");
      const update = h3PromptPatch({ ...h3DraftForResult(snapshot.input, snapshot.result, h3OriginalPrompt(node)), edited: text });
      await edit(invalidateWorkflow(controller.document.nodes.map(item => item.id === nodeId ? { ...item, ...update } : item), nodeId));
      notifySuccess("回复已应用到优化后提示词");
    });
  }
  function runCard(nodeId: string, single: boolean, confirmed = false, choice?: H3RunChoice) {
    const board = controller.document;
    const node = board.nodes.find(card => card.id === nodeId);
    if (!node || controller.startingAction(nodeId) || controller.isLocked(nodeId)) return;
    const draft = h3CardDraft(node);
    if (single && !choice && !useStore.getState().settings?.h3_auto_optimize_prompt && draft && !draft.paused && h3DraftStale(node, draft)) {
      setStaleReview(nodeId);
      return;
    }
    if (!confirmed && (node.kind === "comfy-video" || isH3ImageCard(node))) {
      const others = board.nodes.filter(card => card.id !== nodeId);
      const anotherCardRunning = controller.hasRunningGenerationCard(card =>
        card.id !== nodeId && (card.kind === "comfy-video" || isH3ImageCard(card)));
      // Image workflow steps hand off to the generation session before the GPU job finishes.
      const sessions = workflowSessionIds(others);
      const anotherImageJobRunning = Object.values(useStore.getState().genJobs).some(job =>
        job.running && job.provider === H3_IMAGE && job.turns.some(turn =>
          !!turn.turnKey && sessions.has(generationPromptNodeId(job.id, turn.turnKey))));
      if (anotherCardRunning || anotherImageJobRunning) {
        setLocalRunReview({ projectId, nodeId, single, choice });
        return;
      }
    }
    setStaleReview(null);
    if (choice === "original" && draft) patch(nodeId, h3PromptPatch({ ...draft, paused: true, expanded: false }));
    handle(controller.start(nodeId, single, false, choice ? choice === "optimize" : undefined));
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
    const refresh = () => { setControllerRevision(value => value + 1); nodesChanged.current(); };
    return controller.subscribe((urgent, promptEditor) => {
      const focused = window.document.activeElement;
      if (promptEditor && focused?.matches(".comfy-video-prompt") && focused.closest<HTMLElement>("[data-workflow-card]")?.dataset.workflowCard === promptEditor) return;
      if (urgent) { refresh(); return; }
      // A save acknowledgement arrives outside the input event's transition.
      if (focused?.closest(".workflow-card textarea, .workflow-card [contenteditable=true]")) startTransition(refresh);
      else refresh();
    });
  }, [controller]);
  useEffect(() => { handle(controller.syncCanvasReferences(graphNodes)); }, [controller, graphNodes]);
  useEffect(() => { setConnection(null); setArmed(false); clearAutomatic(); setAgentOpen(false); setKeyHover(null); setTemplateLibrary(null); setTemplateSelection(null); setDisconnectMenu(null); setLocalRunReview(null); setStaleReview(null); }, [projectId]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        const card = entry.target as HTMLElement;
        const id = card.dataset.workflowCard!;
        const box = entry.borderBoxSize[0];
        const height = box?.blockSize ?? card.offsetHeight;
        controller.measureCard(id, box ? Math.round(box.inlineSize) : card.offsetWidth, height);
        if (cardHeights.current.get(id) !== height) { cardHeights.current.set(id, height); changed = true; }
      }
      if (changed) redraw(value => value + 1);
    });
    cardObserver.current = observer;
    for (const card of cardElements.current.values()) observer.observe(card);
    return () => { observer.disconnect(); cardObserver.current = undefined; };
  }, [controller]);
  function workflowCardRef(id: string) {
    let callback = cardRefs.current.get(id);
    if (!callback) {
      callback = (element: HTMLElement | null) => {
        const previous = cardElements.current.get(id);
        if (previous) cardObserver.current?.unobserve(previous);
        if (element) {
          cardElements.current.set(id, element);
          cardObserver.current?.observe(element);
        } else {
          cardElements.current.delete(id);
          cardRefs.current.delete(id);
        }
      };
      cardRefs.current.set(id, callback);
    }
    return callback;
  }
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
  const assetKey = useMemo(() => [...new Set([...automaticAssetIds, ...[...loopPreviews.values()].flatMap(preview => preview.items?.flatMap(item => item.assetIds) ?? []), ...workflowRuns(document).flatMap(run => [...(run.loop?.items?.flatMap(item => item.assetIds) ?? []), ...(run.loop?.completed.flatMap(item => Object.values(item.outputs).flatMap(outputs => Object.values(outputs).flatMap(value => value.assetIds ?? []))) ?? [])]), ...document.nodes.flatMap(node => [
    ...Object.values(node.inputs).flat().flatMap(inputImages),
    ...Object.values(node.outputs).flatMap(output => output.assetIds ?? []),
  ]), ...graphNodes.filter(node => node.kind === "asset" && node.role === "output").flatMap(node => node.assetId ? [node.assetId] : [])])]
    .filter(id => !knownAssets?.has(id)).sort().join("|"), [automaticAssetIds, loopPreviews, document, inputImages, graphNodes, knownAssets]);
  useEffect(() => {
    let current = true;
    if (!assetKey) { setLoadedAssets(undefined); return; }
    void loadAssets(assetKey.split("|")).then(assets => { if (current) setLoadedAssets({ projectId, loader: loadAssets, assets }); }).catch(() => {});
    return () => { current = false; };
  }, [assetKey, loadAssets, projectId]);
  const assets = useMemo(() => Array.from(assetById.values()), [assetById]);

  function edit(nodes: WorkflowNode[], draftNodeId?: string, editorOnly = false) {
    const before = controller.document;
    const pending = controller.edit(nodes, undefined, draftNodeId, editorOnly);
    const after = controller.document;
    const remember = () => { if (after !== before && activeController.current === controller) onEdited(before, after); };
    return pending.then(remember, error => {
      if (!isWorkflowProDenied(error)) remember();
      throw error;
    });
  }
  function patch(id: string, update: Partial<WorkflowNode>, invalidate = true) {
    const draft = pendingCards.current.get(id);
    if (draft && !controller.document.nodes.some(node => node.id === id)) {
      Object.assign(draft.node, update);
      redraw(value => value + 1);
      return;
    }
    const previous = controller.document.nodes;
    const current = previous.find(node => node.id === id);
    if (!current) return;
    const updated = { ...current, ...update };
    if (workflowProducesVideo(current) && !workflowProducesVideo(updated)) {
      const derived = previous.flatMap(node => [
        ...Object.values(node.inputs).flat(), ...Object.values(node.savedComfyR2V ?? {}).flat(), ...(node.savedComfyAudio ?? []),
      ]).filter(input => input?.nodeId === id);
      if (derived.some(input => input?.videoAudio || input?.videoFrame)) {
        notifyError(null, derived.some(input => input?.videoAudio)
          ? "请先断开下游的视频音频引用，再切换输出类型" : "请先断开下游的首帧或尾帧画面引用，再切换输出类型");
        return;
      }
    }
    if (updated.kind !== "voice" && Object.entries(updated.inputs).some(([port, inputs]) =>
      inputs.some(input => input.videoAudio) && !(updated.kind === "comfy-video" && (port === H3_VIDEO_AUDIO_PORT || port === H3_R2V_INPUT_PORTS.audio))
        && (!workflowInputs(updated).some(input => input.id === port) || !automaticInputMedia(updated, port).includes("audio")))) {
      notifyError(null, "请先断开视频音频引用，再切换卡片模式");
      return;
    }
    if (!workflowProducesVideo(updated) && [...(updated.savedComfyAudio ?? []), ...(updated.savedComfyR2V?.[H3_R2V_INPUT_PORTS.audio] ?? [])].some(input => input.videoAudio)) {
      notifyError(null, "请回到本地 H3 断开视频音频引用，再切换输出类型");
      return;
    }
    const nodes = previous.map(node => node.id === id ? updated : node);
    const promptOnly = Object.keys(update).length === 1 && typeof update.prompt === "string";
    const h3DraftEdit = !!update.h3Prompt && typeof update.prompt === "string";
    const next = invalidate && (!promptOnly || previous.some(node => Object.keys(node.outputs).length))
      ? invalidateWorkflow(nodes, id) : nodes;
    const edited = promptOnly && previous.find(node => node.id === id);
    const lastPrompt = edited && edited.kind === "comfy-video" ? lastGenerationRunInput(controller.document, id)?.prompt : undefined;
    // Native typing paints this field. Other cards only change when an output
    // is invalidated, or the draft changes an available action.
    const editorOnly = !!edited && edited.kind === "comfy-video" && !!edited.prompt.trim() === !!update.prompt!.trim()
      && (edited.prompt === lastPrompt) === (update.prompt === lastPrompt)
      && !previous.some((node, index) => node.outputs !== next[index].outputs && Object.keys(node.outputs).length > 0);
    const saved = edit(next, promptOnly || h3DraftEdit ? id : undefined, editorOnly);
    handle(saved.then(() => {
      if (promptOnly || h3DraftEdit) {
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
    const label = (id && cardNames[id]) || assetById.get(binding.assetId ?? "")?.name || "来源已移除";
    if (binding.videoAudio) return { label, detail: workflowVideoAudioLabel() };
    if (binding.videoFrame) return { label, detail: workflowFrameLabel(binding.videoFrame) };
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
    const outputs = canvasAutomaticOutputs(selected.id, controller.document.nodes, graphNodes, materials, assetById);
    return selected.video ? outputs.map(output => ({ ...output, media: "video" as const })) : outputs;
  }
  function automaticOutputs(id: string, latest = false) {
    const selected = selectedMediaOutputs(id);
    if (selected) return selected;
    const group = conversationCards?.cards.get(id);
    const sourceId = group?.latest.kind === "prompt" ? group.latest.id : id;
    return canvasAutomaticOutputs(sourceId, controller.document.nodes, graphNodes, materials, assetById, latest).map(output => {
      const member = output.binding.assetNodeId && conversationCards?.cards.get(output.binding.assetNodeId)?.outputs
        .find(node => node.assetId === output.binding.assetId);
      return member ? { ...output, binding: { ...output.binding, assetNodeId: member.id } } : output;
    });
  }
  function automaticTarget(id: string): AutomaticTarget {
    const visibleOwner = generationAnchorOwners.get(id);
    const owner = collapsedAnchorOwners.get(id) ?? (visibleOwner && activeGenerationIds.has(visibleOwner) ? visibleOwner : undefined);
    if (owner) return { nodeId: owner, collapsedAnchorId: id };
    if (!controller.document.nodes.some(node => node.id === id)) return { canvasNodeId: id };
    const anchor = collapsedAnchor(id);
    return anchor ? { nodeId: id, collapsedAnchorId: anchor.id } : { nodeId: id };
  }
  function gestureOutputs(gesture: AutomaticGesture, otherId: string) {
    if (gesture.side === "output") return gesture.outputs;
    if (nodeById.get(gesture.id)?.kind === "trigger") {
      const anchor = conversationCards?.cards.get(otherId)?.anchor;
      if (anchor?.kind === "prompt") return [{ type: "image" as const, binding: { canvasNodeId: anchor.id, cellId: "image" } }];
    }
    return automaticOutputs(otherId);
  }
  function connectionCardId(element: Element | null) {
    const card = element?.closest<HTMLElement>("[data-workflow-card],[data-canvas-node-id],[data-workflow-material]");
    return card?.dataset.workflowCard ?? card?.dataset.canvasNodeId ?? card?.dataset.workflowMaterial;
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
  function beginCompletionDrag(event: React.PointerEvent<HTMLButtonElement>, id: string) {
    event.stopPropagation();
    if (event.button !== 0 || !event.isPrimary || panReady || !controller.ready) return;
    event.preventDefault();
    clearAutomatic();
    connectionRef.current = null; setConnection(null); setArmed(false); setDisconnectMenu(null); setBlankCardMenu(null);
    const start = { x: event.clientX, y: event.clientY };
    const rect = event.currentTarget.getBoundingClientRect();
    automaticRef.current = {
      id, side: "output", start, dragged: false, outputs: [], target: {},
      completion: { pointerId: event.pointerId, anchor: toBoardPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) },
    };
    setCursor(start);
  }
  function completionDropTarget(element: HTMLElement | null, sourceId: string) {
    const card = element?.closest<HTMLElement>("[data-workflow-card],[data-canvas-node-id]");
    const shownId = card?.dataset.workflowCard ?? card?.dataset.canvasNodeId;
    if (!shownId) return null;
    const id = collapsedAnchorOwners.get(shownId) ?? shownId;
    if (id === sourceId) return null;
    const node = nodeById.get(id);
    if (node) return { id, shownId, error: workflowCompletionTarget(node) ? null : "此卡片不能作为触发卡的下游" };
    const native = graphById.get(id);
    return native?.kind === "note" && ["text", "images"].includes(readCanvasNote(native).note_type) ? { id, shownId, error: null } : null;
  }
  function commitCompletionDrag(sourceId: string, targetId: string, anchor: { x: number; y: number }) {
    const from = cardPoint(sourceId, "output") ?? anchor;
    const to = cardPoint(targetId, "input");
    if (!to) return;
    const width = workflowCardWidth({ kind: "trigger" }), height = 112;
    const point = { x: (from.x + to.x - width) / 2, y: (from.y + to.y - height) / 2, width, height };
    const obstacles = [
      ...visibleGraphNodes.filter(node => node.hiddenAt == null).map(node => ({ ...node, height: sessionHeights?.get(node.id) ?? node.height })),
      ...renderedNodes.filter(node => !node.textSource && !node.textTarget && !collapsedAnchor(node.id)).map(node => {
        const { x, y } = displayPoint(node);
        return { x, y, width: workflowCardWidth(node), height: cardHeights.current.get(node.id) ?? 300 };
      }),
    ];
    const position = placeCanvasCardNearSource(point, obstacles);
    const owner = controller;
    const revision = useStore.getState().projectRouteRevision;
    const sameRoute = () => {
      const state = useStore.getState();
      return activeController.current === owner && isWorkspaceOperationCurrent(projectId, state.activeProjectId,
        state.projectRoutePending, revision, state.projectRouteRevision);
    };
    handle((async () => {
      if (provisional) await ensureMaterialized();
      if (!sameRoute()) return;
      const result = await owner.connectCompletionTrigger(sourceId, targetId, position, (before, after) => {
        if (sameRoute()) onEdited(before, after);
      });
      if (sameRoute() && result.createdNodeIds[0]) onSelect(result.createdNodeIds[0]);
    })());
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

  function lockedOutput(outputs: AutomaticOutput[], extractMedia = false) {
    return outputs.some(({ binding }) => [binding.nodeId, binding.canvasNodeId, binding.assetNodeId,
      ...workflowInputProducers(controller.document.nodes, binding)]
      .some(id => id && (extractMedia ? controller.isLocked(id) : controller.isWriteLocked(id))));
  }
  function automaticError(outputs: AutomaticOutput[], target: AutomaticTarget) {
    const controlWire = nodeById.get(target.nodeId ?? "")?.kind === "trigger" || outputs.length > 0 && outputs.every(output => output.type === "signal");
    if (!controlWire && lockedOutput(outputs)) return "来源卡片正在使用";
    if (target.nodeId) {
      if (target.collapsedAnchorId && generationCardAnchors?.get(target.nodeId)?.id !== target.collapsedAnchorId) return "接收卡片已不存在";
      if (!controlWire && (controller.isLocked(target.nodeId) || activeGenerationIds.has(target.nodeId)
        || controller.startingAction(target.nodeId))) return "这张卡片正在运行";
      return planAutomaticConnection(controller.document.nodes, outputs, target.nodeId, target.collapsedAnchorId ? generationCardOrigins : undefined).error;
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
  function videoReferenceError(video: VideoReferenceTarget, mode?: VideoReferenceMode) {
    if (mode && (video.created ?? nodeById.get(video.target.nodeId ?? ""))?.kind === "trigger") return "此输入只接收完成信号";
    if (mode === "audio" && video.target.canvasNodeId) return "此位置不能接收音频";
    const output = videoReferenceOutput(video.output, mode);
    if ((mode || video.created) && lockedOutput([output], !!mode && (mode !== "audio" || !output.binding.nodeId))) return "来源卡片正在使用";
    if (!video.created) return automaticError([output], video.target);
    return planAutomaticConnection([...controller.document.nodes, video.created], [output], video.created.id).error;
  }
  function receiverError(outputs: AutomaticOutput[], target: AutomaticTarget, created?: WorkflowNode) {
    const video = singleVideoOutput(outputs);
    if (!video) return created ? planAutomaticConnection([...controller.document.nodes, created], outputs, created.id).error : automaticError(outputs, target);
    const reference = { output: video, target, created };
    for (const { mode } of VIDEO_REFERENCE_OPTIONS) {
      if (!videoReferenceError(reference, mode)) return null;
    }
    return videoReferenceError(reference);
  }
  function chooseAutomaticReceiver(gesture: AutomaticGesture, outputs: AutomaticOutput[], target: AutomaticTarget,
    point: { x: number; y: number }, created?: WorkflowNode) {
    const error = receiverError(outputs, target, created);
    if (error) { clearAutomatic(); notifyError(null, error); return; }
    const video = singleVideoOutput(outputs);
    if (video) {
      setConnectionMenu({ gesture, ...point, video: { output: video, target, created } });
      connectionHoverRef.current = null; setConnectionHover(null);
    } else commitAutomatic(outputs, target, created ? [created] : []);
  }
  function commitAutomatic(outputs: AutomaticOutput[], target: AutomaticTarget, createNodes: WorkflowNode[] = [], mode?: VideoReferenceMode) {
    clearAutomatic();
    if (target.collapsedAnchorId) {
      const error = mode ? videoReferenceError({ output: outputs[0], target }, mode) : automaticError(outputs, target);
      if (error) { notifyError(null, error); return; }
    }
    if (mode && outputs[0].binding.nodeId) {
      outputs = [videoReferenceOutput(outputs[0], mode)];
      mode = undefined;
    }
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
    if (!mode) publishPending(outputs);
    handle((async () => {
      try {
        // Native endpoints may still be in the canvas journal. Workflow-only edits use their own queue.
        if (mode || provisional || !target.nodeId || target.collapsedAnchorId || outputs.some(({ binding }) =>
          !binding.nodeId || binding.canvasNodeId || binding.assetNodeId || binding.groupId)) await ensureMaterialized();
        if (!sameRoute()) return;
        if (mode) {
          const [source] = outputs;
          const sourceId = source.binding.assetNodeId;
          if (sourceId) {
            const nodes = await api.projectCanvasVisibleNodes(projectId, [sourceId]);
            if (!nodes.some(node => node.id === sourceId && node.assetId === source.binding.assetId)) throw new Error("来源卡片已不存在");
          }
          const reference = { output: source, target, created };
          const error = videoReferenceError(reference, mode);
          if (error) throw new Error(error);
          const preview = videoReferenceOutput(source, mode);
          if (target.nodeId && !created && !planAutomaticConnection(controller.document.nodes, [preview], target.nodeId,
            target.collapsedAnchorId ? generationCardOrigins : undefined).bindings.length) return;
          try {
            outputs = [mode === "audio"
              ? await materializeVideoAudioOutput(projectId, source, sameRoute)
              : await materializeVideoFrameOutput(projectId, source, mode, sameRoute)];
          } catch (error) {
            if (!sameRoute()) return;
            throw error;
          }
          if (!sameRoute()) return;
          publishPending(outputs);
        }
        const result = await owner.connectAutomatic(outputs, target, {
          createNodes, connectionId, onEdited(before, after) {
            if (created) pendingCards.current.delete(created.id);
            if (sameRoute()) onEdited(before, after, target.collapsedAnchorId ? target.nodeId : undefined);
          },
        });
        if (result.before !== result.after && target.nodeId && target.collapsedAnchorId && sameRoute()) {
          onConnectCollapsedGeneration(target.nodeId, target.collapsedAnchorId);
        }
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
  function existingConnectionCards(menu: ConnectionMenuState) {
    const { gesture, x, y } = menu;
    const ids = [...new Set([
      ...controller.document.nodes.filter(node => !node.textTarget && !node.textSource).map(node => node.id),
      ...graphNodes.filter(node => node.hiddenAt == null).map(node => node.id),
      ...materials.map(item => item.id),
    ])];
    return ids.flatMap(id => {
      if (gesture.side === "output" && generationAnchorOwners.has(id)) return [];
      if (id === gesture.id || gesture.side === "input" && nodeById.get(gesture.id)?.kind === "trigger" && conversationCards?.hiddenIds.has(id)) return [];
      const outputs = gestureOutputs(gesture, id);
      const receiver = gesture.side === "output" ? automaticTarget(id) : gesture.target;
      return receiverError(outputs, receiver) ? [] : [{
        id, label: cardNames[id] ?? "卡片",
        choose: (rect: DOMRect) => chooseAutomaticReceiver(gesture, gestureOutputs(gesture, id), receiver,
          { x: rect.right < innerWidth - 150 ? rect.right + 4 : x, y: rect.top || y }),
      }];
    });
  }
  function connectionScope(menu: ConnectionMenuState) {
    const card = graphById.get(menu.gesture.id);
    if (card?.kind !== "note") return;
    const note = readCanvasNote(card);
    if (!["text", "images"].includes(note.note_type)) return;
    return { cells: note.cells, selectScope: selectConnectionScope, latest: menu.gesture.latest,
      toggleLatest: () => beginAutomatic(menu.gesture.id, "output", { x: menu.x, y: menu.y }, true, !menu.gesture.latest) };
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
  function connectionCard(option: ConnectionCardOption, point: { x: number; y: number }) {
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
      try { await saved; }
      catch (error) {
        if (isWorkflowProDenied(error) && activeController.current === controller && currentSelection.current.has(node.id)) onSelect(node.id, true);
        throw error;
      }
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
  function createConnected(option: ConnectionCardOption) {
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
    const media = automaticValueMedia(value, assetById, hasTableWriter(controller.document.nodes, card.id, cellId));
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
  function directAutomaticOutput(draft: Connection): AutomaticOutput {
    const { type, ...binding } = draft;
    const media = binding.nodeId && type === "image"
      ? automaticOutputs(binding.nodeId).find(output => output.binding.portId === binding.portId)?.media : undefined;
    return { type, binding, media };
  }
  function connectAutomaticDraft(draft: Connection, target: AutomaticTarget, point: { x: number; y: number }) {
    connectionRef.current = null; setConnection(null);
    const id = draft.nodeId ?? draft.canvasNodeId ?? draft.assetNodeId ?? "";
    const outputs = [directAutomaticOutput(draft)];
    chooseAutomaticReceiver({ id, side: "output", start: point, dragged: true, target: {}, outputs }, outputs, target, point);
  }
  function connect(toId: string, inputId: string, point = cursor.current) {
    const draft = connectionRef.current;
    if (!draft || inputId !== "*auto" && inputId !== "completion" && draft.type !== "signal" && controller.isLocked(toId)) return;
    if (inputId === "*auto") {
      connectAutomaticDraft(draft, automaticTarget(toId), point);
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
    if (binding.videoAudio && (port?.type !== "image" || !automaticInputMedia(node, inputId).includes("audio"))) {
      notifyError(null, "此输入不能接收音频");
      return;
    }
    const r2vLimit = node.kind === "comfy-video" && comfyVideoMode(node.comfyVideo) === "r2v" ? H3_R2V_INPUT_LIMITS[inputId] : undefined;
    const r2vMedia = r2vLimit ? (Object.keys(H3_R2V_INPUT_PORTS) as (keyof typeof H3_R2V_INPUT_PORTS)[])
      .find(media => H3_R2V_INPUT_PORTS[media] === inputId) : undefined;
    if (node.kind === "comfy-video" && port?.type === "image") {
      const audioPort = inputId === H3_VIDEO_AUDIO_PORT;
      const ids = inputImages(r2vMedia || audioPort ? { ...binding, mediaFilter: [r2vMedia ?? "audio"] } : binding);
      const media = ids.map(id => resolveAssetMediaType(id, materialByAsset, assetById));
      const producerMedia = source.nodeId && automaticOutputs(source.nodeId).find(output => output.binding.portId === source.portId)?.media;
      const knownMedia = binding.videoAudio ? ["audio"] : media.length && media.every(Boolean) ? media : !media.length && producerMedia ? [producerMedia].flat() : [];
      if (r2vMedia) {
        if (binding.videoFrame && r2vMedia !== "image" || knownMedia.length && !knownMedia.includes(r2vMedia)) {
          notifyError(null, `请选择可用的${port.label}`); return;
        }
        binding.mediaFilter = [r2vMedia];
      } else if (audioPort) {
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
      if (ids.length > 1 || ids.some(id => { const asset = assetById.get(id); return asset && !isAudioPath(asset.store_path); })) {
        notifyError(null, "请选择一段音频作为参考录音"); return;
      }
    }
    const current = node.inputs[inputId] ?? [];
    if (current.some(input => binding.groupId ? input.groupId === binding.groupId : workflowBindingKey(input) === workflowBindingKey(binding))) { setConnection(null); connectionRef.current = null; return; }
    // An explicit new connection can replace a deleted source on its old pipe.
    const missing = (node.kind === "generation" || node.kind === "agent")
      ? current.filter(input => canvasWorkflowInputState(input, graphNodes, nodes) === "missing").sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))[0] : undefined;
    const connected = missing ? current.map(input => input === missing ? { ...binding, slot: missing.slot } : input) : [...current, binding];
    if (r2vLimit && (connected.length > r2vLimit || connected.reduce((n, input) => n + h3ReferenceCount(input, r2vMedia), 0) > r2vLimit)) {
      notifyError(null, `${port?.label ?? "此输入"}最多接入 ${r2vLimit} 个素材`); return;
    }
    const documentSource = source.canvasNodeId && graphNodes.find(card => card.id === source.canvasNodeId && card.kind === "note" && readCanvasNote(card).note_type === "document");
    const reference = !missing && documentSource && node.kind === "generation" && (source.type === "text" || source.type === "image")
      ? { id: crypto.randomUUID(), type: source.type, input: binding, label: source.type === "text" ? "文档文本" : "文档图片" } : null;
    if (latest) {
      try { assertWorkflowAcyclic(nodes.map(item => item.id === toId ? { ...item, inputs: { ...item.inputs, [inputId]: connected } } : item), toId); }
      catch (error) { notifyError(error, "这条连接会形成循环"); return; }
    }
    patch(toId, { ...(reference ? { prompt: `${node.prompt}${node.prompt ? "\n" : ""}@[${reference.id}]`, promptReferences: [...(node.promptReferences ?? []), reference] } : {}),
      inputs: { ...node.inputs, [inputId]: (node.kind === "voice" && inputId === "image") || (node.kind === "comfy-video" && inputId !== "text" && !r2vLimit) || (node.kind === "instruction" && node.action !== "describe") || (inputId === "visual-profile" || node.kind === "loop" && node.loopMode === "rows") ? [binding] : connected } });
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
  useWorkflowConnectionGesture({
    armed, automaticPressTimer, automaticRef, automaticTarget, chooseAutomaticReceiver,
    clearAutomatic, commitAutomatic, commitCompletionDrag, completionDropTarget, connect,
    connectionCardId, connectAutomaticDraft, directAutomaticOutput,
    connectionHoverRef, connectionMenu, connectionRef, connectSignal, controller,
    edit, ensureMaterialized, gestureOutputs, graphNodes, handle,
    hoveredHotspot, hoveredMaterialRef, inputText, onSelect, receiverError,
    setArmed, setConnection, setConnectionHover, setConnectionMenu, setCursor,
    startAutomaticDrag, swallowAutomaticClick, toBoardPoint, wireElement,
  });
  useEffect(() => {
    const plane = wireElement.current?.closest(".canvas-plane");
    if (automatic) plane?.setAttribute("data-canvas-connecting", "");
    const id = automatic && CSS.escape(automatic.id);
    const sources = id ? plane?.querySelectorAll(`[data-canvas-node-id="${id}"], [data-workflow-card="${id}"], [data-workflow-material="${id}"]`) : undefined;
    const cellSources = automatic?.scope ? Array.from(sources ?? []).flatMap(source => Array.from(source.querySelectorAll(`[data-canvas-cell="${CSS.escape(automatic.scope!)}"]`))) : [];
    const markers = cellSources.length ? cellSources : Array.from(sources ?? []);
    markers.forEach(source => source.setAttribute("data-canvas-connection-source", automatic!.side));
    if (automatic?.dragged && !automatic.completion && !connectionMenu) markers.forEach(source => source.setAttribute("data-canvas-connection-dragging", automatic.side));
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
      const node = connectionCard(IMAGE_GENERATION_CARD, point);
      commitAutomatic([{ type: "image", media: "image", binding: { assetId, assetNodeId: sourceId } }], { nodeId: node.id }, [node]);
    },
    arm(x, y) { clearAutomatic(); setArmed(value => !value); connectionRef.current = null; setConnection(null); if (x !== undefined && y !== undefined) setCursor({ x, y }); },
    cancelPlacement() { setArmed(false); setConnection(null); clearAutomatic(); },
    isConnecting: () => !!connectionRef.current || !!automaticRef.current,
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
        || activeGenerationIds.has(id)
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
    if (node?.kind === "trigger") return { x: node.x + (side === "output" ? workflowCardWidth(node) : 0),
      y: workflowPortY(node, side, side === "input" ? "completion" : "signal"), owner: id, selected: wireSelected(id) };
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
      const anchor = gesture.completion?.anchor ?? scopedPoint(gesture.id, gesture.side, gesture.scope) ?? toBoardPoint(gesture.start.x, gesture.start.y), cursorPoint = toBoardPoint(cursor.current.x, cursor.current.y);
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
  useLayoutEffect(() => { onTriggerArmedChange?.(armed); }, [onTriggerArmedChange, armed]);
  useLayoutEffect(() => updateCursor.current(), [connection, automatic, connectionMenu, armed, toBoardPoint, document.nodes, graphNodes, materials, portRect]);

  function automaticButton(id: string, side: "input" | "output", disabled = false, active = automatic?.id === id && automatic.side === side) {
    return <CanvasConnectionHandle side={side} disabled={disabled || panReady} active={active}
      aria-label={side === "input" ? "添加上游" : "添加下游"}
      data-workflow-node={id} data-workflow-input={side === "input" ? "*auto" : undefined}
      onPointerDown={event => { if (event.button !== 0) return; event.stopPropagation(); event.preventDefault(); beginAutomatic(id, side, { x: event.clientX, y: event.clientY }); }}
      onClick={event => {
        if (event.detail !== 0) return;
        if (side === "input" && connectionRef.current?.type === "signal") { connectSignal(id); return; }
        const rect = event.currentTarget.getBoundingClientRect();
        const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        if (side === "input" && connectionRef.current) { connect(id, "*auto", point); return; }
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
  function keyButton(node: WorkflowNode, showProgressTooltip = keyHover?.id === node.id) {
    const busy = controller.isLocked(node.id);
    const issue = flowIssues.get(node.id);
    return <button className={`workflow-key ${workflowRuns(document).some(item => item.startId === node.id && item.status === "running") ? "is-running" : ""}`} draggable={!busy}
          onPointerDown={event => event.stopPropagation()}
          aria-label="上发条，运行工作流" aria-disabled={!!issue} title={issue?.message} aria-describedby={showProgressTooltip ? "workflow-progress" : undefined}
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
  const cardAutomaticButton = useLatestCallback(automaticButton);
  const cardBeginCompletionDrag = useLatestCallback(beginCompletionDrag);
  const cardChooseDisconnect = useLatestCallback(chooseDisconnect);
  const cardDisconnectAutomatic = useLatestCallback(disconnectAutomatic);
  const cardDisconnectReference = useLatestCallback(disconnectReference);
  const cardEdit = useLatestCallback(edit);
  const cardGearButton = useLatestCallback(gearButton);
  const cardH3ReferencePending = useLatestCallback(h3ReferencePending);
  const cardOnUndoGenerationConnection = useLatestCallback(onUndoGenerationConnection);
  const cardH3ReferenceAssets = useLatestCallback(h3ReferenceAssets);
  const cardKeyButton = useLatestCallback(keyButton);
  const cardHandle = useLatestCallback(handle);
  const cardHandleAgentCard = useLatestCallback(handleAgentCard);
  const cardLocateIssue = useLatestCallback(locateIssue);
  const cardMoveReference = useLatestCallback(moveReference);
  const cardNameEditor = useLatestCallback(nameEditor);
  const cardOnDragEnd = useLatestCallback(onDragEnd);
  const cardOnDragMove = useLatestCallback(onDragMove);
  const cardOnDragStart = useLatestCallback(onDragStart);
  const cardOnNodeMenu = useLatestCallback(onNodeMenu);
  const cardOnOpenAgent = useLatestCallback(onOpenAgent);
  const cardOnOpenGeneration = useLatestCallback(onOpenGeneration);
  const cardOnPeekInteraction = useLatestCallback(onPeekInteraction ?? (() => {}));
  const cardOnRemove = useLatestCallback(onRemove);
  const cardOnSelect = useLatestCallback(onSelect);
  const cardOnToggleGenerationPin = useLatestCallback(onToggleGenerationPin ?? (() => {}));
  const cardOpenOptimizationChat = useLatestCallback(openOptimizationChat);
  const cardPatch = useLatestCallback(patch);
  const cardPortButton = useLatestCallback(portButton);
  const cardPortMediaLabel = useLatestCallback(portMediaLabel);
  const cardReferencePreviewValues = useLatestCallback(referencePreviewValues);
  const cardRetryLoop = useLatestCallback(retryLoop);
  const cardRunCard = useLatestCallback(runCard);
  const cardShowProgress = useLatestCallback(showProgress);
  const cardSourceLabel = useLatestCallback(sourceLabel);
  const cardWorkflowCardRef = useLatestCallback(workflowCardRef);
  const cardDefaults = useLatestCallback((): ChatCardDefaults => getChatCardDefaults?.() ??
    { provider: useStore.getState().defaultProvider, videoChannel: "jimeng", videoOptions: { ...DEFAULT_VIDEO_OPTIONS } });
  const chatsByCard = useMemo(() => {
    const result = new Map<string, (typeof chatSummaries)[string]>();
    for (const chat of Object.values(chatSummaries)) if (chat.projectId === projectId && chat.nodeId && !result.has(chat.nodeId)) result.set(chat.nodeId, chat);
    return result;
  }, [chatSummaries, projectId]);
  const cardContext = useMemo<WorkflowCardContext>(() => ({

    assetById, assets, cardElements, cardNames, controller,
    document, graphById, graphNodes, h3AutoOptimize,
    loadAssets, nodeById, placedAudioAssets, profiles,
    projectId, state, agentDetailPress, automaticRef,
    connectionRef, automaticButton: cardAutomaticButton, beginCompletionDrag: cardBeginCompletionDrag, chooseDisconnect: cardChooseDisconnect,
    disconnectAutomatic: cardDisconnectAutomatic, disconnectReference: cardDisconnectReference, edit: cardEdit, gearButton: cardGearButton,
    savingH3Preference, setSavingH3Preference, h3ReferencePending: cardH3ReferencePending, onUndoGenerationConnection: cardOnUndoGenerationConnection,
    h3ReferenceAssets: cardH3ReferenceAssets, inputImages, keyButton: cardKeyButton, handle: cardHandle,
    handleAgentCard: cardHandleAgentCard, locateIssue: cardLocateIssue, moveReference: cardMoveReference, nameEditor: cardNameEditor,
    onDragEnd: cardOnDragEnd, onDragMove: cardOnDragMove, onDragStart: cardOnDragStart, onNodeMenu: cardOnNodeMenu,
    onOpenAgent: cardOnOpenAgent, onOpenGeneration: cardOnOpenGeneration, onPeekInteraction: cardOnPeekInteraction, onRemove: cardOnRemove,
    onSelect: cardOnSelect, onToggleGenerationPin: cardOnToggleGenerationPin, openOptimizationChat: cardOpenOptimizationChat, patch: cardPatch,
    portButton: cardPortButton, portMediaLabel: cardPortMediaLabel, referencePreviewValues: cardReferencePreviewValues, reportComfy,
    retryLoop: cardRetryLoop, runCard: cardRunCard, setAgentOpen, setArmed,
    setKeyHover, setStaleReview, setTemplateLibrary, setVoiceIssue,
    showProgress: cardShowProgress, sourceImages, sourceLabel: cardSourceLabel, workflowCardRef: cardWorkflowCardRef,
  }), [

    assetById, assets, cardElements, cardNames, controller, document, graphById,
    graphNodes, h3AutoOptimize, loadAssets, nodeById, placedAudioAssets, profiles,
    projectId, state, agentDetailPress, automaticRef, connectionRef, cardAutomaticButton,
    cardBeginCompletionDrag, cardChooseDisconnect, cardDisconnectAutomatic, cardDisconnectReference, cardEdit, cardGearButton,
    savingH3Preference, cardH3ReferencePending, cardOnUndoGenerationConnection,
    cardH3ReferenceAssets, inputImages, cardKeyButton, cardHandle, cardHandleAgentCard, cardLocateIssue,
    cardMoveReference, cardNameEditor, cardOnDragEnd, cardOnDragMove, cardOnDragStart, cardOnNodeMenu,
    cardOnOpenAgent, cardOnOpenGeneration, cardOnPeekInteraction, cardOnRemove, cardOnSelect, cardOnToggleGenerationPin,
    cardOpenOptimizationChat, cardPatch, cardPortButton, cardPortMediaLabel, cardReferencePreviewValues, reportComfy,
    cardRetryLoop, cardRunCard, setAgentOpen, setArmed, setKeyHover, setStaleReview,
    setTemplateLibrary, setVoiceIssue, cardShowProgress, sourceImages, cardSourceLabel, cardWorkflowCardRef,
  ]);
  const entryCardContext = useMemo(() => ({}), [cardContext, controllerRevision, generationActivities, selectedIds,
    pinnedCardOffsets, peekCard, chatsByCard, chatSummaries, armed, panReady, automatic, keyHover, staleReview,
    pendingAgentCards, activeVideoJobs, flowIssues, providerIssues, loopPreviews]);
  const stagedCardContext = useCanvasEntryCardContext(entryCardContext, opening, entryCardContext);
  const sessionOutputsBySessionId = useMemo(() => {
    const ids = hiddenWorkflowSessionIds(document.nodes);
    return new Map(graphNodes.filter(session => ids.has(session.id)).map(session => [session.id, canvasSessionImages(session, graphNodes)]));
  }, [document.nodes, graphNodes]);
  return <>
    {visibleGraphNodes.filter(node => cardMounted(node.id) && node.hiddenAt == null && (node.kind !== "asset" || materialById.has(node.id)) && !sessionIds.has(node.id) && !conversationCards?.hiddenIds.has(node.id)).map(node => {
      if (node.kind === "prompt" && collapsedAnchorOwners.has(node.id)) return null;
      const note = node.kind === "note" ? readCanvasNote(node) : null;
      if (note?.note_type === "section" && !note.artboard && !note.workflow_container) {
        return nameEditor(node.id, { left: `calc(${node.x}px + 22px * var(--section-title-scale))`, top: node.y,
          "--section-color": note.section_color, maxWidth: `clamp(80px, calc(${node.width}px / var(--section-title-scale) - 22px), 320px)` } as React.CSSProperties, false, true);
      }
      return nameEditor(node.id, { left: node.x + (note?.note_type === "section" ? 24 : 0), top: node.y - 28, maxWidth: node.width });
    })}
    {materials.filter(item => item.groupId && cardMounted(item.id)).map(item => nameEditor(item.groupId!, { left: item.x, top: item.y - 28, maxWidth: item.width }))}
    <WorkflowDisconnectOverlay {...{ disconnectMenu, disconnectChoices, assets, setDisconnectMenu }} />
    {Array.from(frames, ([id, frame]) => <WorkflowLoopFrame key={id} {...frame} />)}
    <CanvasConnectionDefinitions />
    <WorkflowWiresLayer
      automatic={automatic} cardMounted={cardMounted} cardPoint={cardPoint} chooseDisconnect={chooseDisconnect} collapsedAnchor={collapsedAnchor}
      connection={connection} connectionMenu={connectionMenu} conversationCards={conversationCards} cursor={cursor}
      displayPoint={displayPoint} document={document} draftElement={draftElement} embeddedPoint={embeddedPoint} frames={frames}
      generationResultAnchors={generationResultAnchors} graphById={graphById} sessionOutputsBySessionId={sessionOutputsBySessionId} groupById={groupById} materialById={materialById}
      nodeDiagnostic={nodeDiagnostic} outputPath={outputPath} pending={pending} portRect={portRect} renderedNodes={renderedNodes}
      scopedPoint={scopedPoint} sourcePoint={sourcePoint} toBoardPoint={toBoardPoint} visibleGraphNodeIds={visibleGraphNodeIds} wireElement={wireElement}
      wireSelected={wireSelected} workflowNodeMounted={workflowNodeMounted} />
    {document.nodes.filter(node => node.textSource && cardMounted(node.textSource) && (node.trigger || node.inputs.signal?.length)).map(node => {
      const card = graphNodes.find(card => card.id === node.textSource && card.hiddenAt == null);
      return card && <div key={node.id} className="workflow-material-hotspot workflow-text-key" data-workflow-text-key={card.id} style={{ left: card.x, top: card.y, width: card.width, height: card.height }}>{node.inputs.signal?.length ? gearButton(node) : keyButton(node)}</div>;
    })}
    {visibleGraphNodes.filter(card => cardMounted(card.id) && card.kind === "prompt" && card.hiddenAt == null && !sessionIds.has(card.id) && !conversationCards?.hiddenIds.has(card.id)).map(card =>
      <div key={`session-${card.id}`} data-workflow-material={card.id} className={`workflow-material-hotspot ${imageOnlyConversationIds?.has(card.id) ? "is-image-session" : ""} ${hoveredMaterial === card.id ? "is-hovered" : ""} ${selectedIds.has(card.id) ? "is-selected" : ""}`} style={{ left: card.x, top: card.y, width: card.width, height: sessionHeights?.get(card.id) ?? card.height }}>
        {automaticButton(card.id, "output")}
      </div>)}
    {materials.filter(material => cardMounted(material.id)).map(material => <div key={material.id} data-workflow-material={material.id} className={`workflow-material-hotspot ${hoveredMaterial === material.id ? "is-hovered" : ""} ${selectedIds.has(material.id) ? "is-selected" : ""}`} style={{ left: material.x, top: material.y, width: material.width, height: material.height }}>
      {automaticButton(material.id, "output")}
    </div>)}
    {renderCanvasCards(renderedNodes.filter(node => node.kind !== "text" && (activeGenerationIds.has(node.id) || (peekCard?.nodeId === node.id
      ? cardMounted(peekCard.anchorId) : cardMounted(node.id) && !collapsedAnchor(node.id)))), stagedCardContext, node => {
      const run = workflowNodeRun(document, node.id);
      const failure = controller.cardFailure(node.id, run);
      const peek = peekCard?.nodeId === node.id ? peekCard : undefined;
      const { x, y } = peek ? { x: peek.point.x - workflowCardWidth(node) - 12, y: peek.point.y } : displayPoint(node);
      const agentChat = node.kind === "agent" ? (node.chatConversationId ? chatSummaries[node.chatConversationId] : chatsByCard.get(node.id)) : undefined;
      const videoJobId = run?.steps[node.id]?.jobId;
      return <WorkflowCardItem context={cardContext} node={node} run={run} creating={!nodeById.has(node.id)}
        starting={controller.startingAction(node.id)} locked={controller.isLocked(node.id)}
        removableLocalVideo={node.kind === "comfy-video" && controller.canDiscardLocalVideo(node.id)}
        imageActivity={generationActivities.get(node.id) ?? IDLE_GENERATION} agentChat={agentChat} selected={selectedIds.has(node.id)}
        pinned={!!pinnedCardOffsets?.has(node.id)} peek={peek} x={x} y={y} armed={armed} panReady={panReady}
        activeHandle={automatic?.id === node.id ? automatic.side : undefined} showKeyProgress={keyHover?.id === node.id}
        showStaleReview={staleReview === node.id} pendingAgent={pendingAgentCards.has(node.id)} deliveryPending={!!run && deliveryRunIds.has(run.id)}
        videoJobActive={!!videoJobId && activeVideoJobs.includes(videoJobId)}
        providerIssue={(node.kind === "loop" || node.kind === "trigger" ? flowIssues.get(node.id) : providerIssues.get(node.id)) ?? null}
        loopProviderIssues={node.kind === "loop" ? providerIssues : undefined} loopPreview={loopPreviews.get(node.id)}
        failureKey={failure?.key} failureDismissed={failure?.dismissed} failureDiagnostic={failure?.diagnostic} getChatCardDefaults={cardDefaults} />;
    })}
    <WorkflowOverlays {...{
      armed, ghostElement, cursor, keyHover, document, issue, diagnosticTarget, deliveryRunIds, controller,
      issueSourceLabel, locateIssue, handle, issueSourceId, graphNodes, connectionHover, nodeById,
      graphById, materialById, automatic, peekCard, displayPoint, cardHeights, sessionHeights,
      agentOpen, setAgentOpen, localRunReview, projectId, setLocalRunReview, runCard, retryReview,
      setRetryReview, templateLibrary, selectedIds, state, ensureMaterialized, setTemplateLibrary,
      templateSelection, onPlaced, setTemplateSelection,
    }} connectionMenuContent={cardMenu && <WorkflowConnectionMenu key={videoConnection ? "video-reference" : connectionMenu ? connectionMenu.gesture.scope ?? "all" : "blank"}
      x={cardMenu.x} y={cardMenu.y} direction={connectionMenu?.gesture.side} trigger={connectionMenu?.gesture.trigger}
      video={videoConnection && { error: mode => videoReferenceError(videoConnection, mode), choose: mode => {
        const { output, target, created } = videoConnection;
        commitAutomatic([output], target, created ? [created] : [], mode);
      } }}
      onClose={connectionMenu ? clearAutomatic : () => setBlankCardMenu(null)}
      newCardError={connectionMenu ? option => newConnectionError(connectionMenu.gesture, connectionCard(option, { x: 0, y: 0 })) : undefined}
      createCard={option => {
        if (connectionMenu) createConnected(option);
        else if (blankCardMenu) {
          setBlankCardMenu(null);
          addCard(connectionCard(option, blankCardMenu.point));
        }
      }}
      existingCards={connectionMenu ? () => existingConnectionCards(connectionMenu) : undefined}
      note={connectionMenu ? connectionScope(connectionMenu) : undefined} />} />
  </>;
}));
