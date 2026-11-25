import { forwardRef, memo, startTransition, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore as useSnapshot } from "zustand";
import { shallow } from "zustand/shallow";
import { api } from "../lib/api";
import { activeCanvasNameCounts, assignCanvasCardNames, canvasCardNameError } from "../lib/canvasCardNames";
import { contentInputPort } from "../lib/canvasContentInput";
import { canvasWirePath as path, type DragOffset } from "../lib/canvasDragPreview";
import { canvasDocumentHeight, expandCanvasSections, readCanvasNote } from "../lib/canvasNotes";
import {
  canvasInputAssetIds, canvasInputValue, canvasSessionImages, hiddenWorkflowSessionIds,
  workflowBindingAssetIds, workflowGenerationResultAnchor, workflowSessionIds,
} from "../lib/canvasSessionOutputs";
import {
  disconnectGenerationReference, generationReferencePreviewOrder, H3_R2V_INPUT_PORTS, h3CardDraft,
  h3DraftForResult, h3DraftStale, h3OriginalPrompt, h3PromptPatch,
  invalidateWorkflow, isH3ImageCard, isWorkflowGenerationResult, lastGenerationRunInput,
  newWorkflowNode, reorderGenerationReferences, workflowCardWidth, workflowFrameLabel,
  workflowNodeRun, workflowOrder, workflowOutputs, workflowPortY,
  workflowProducesVideo, workflowRuns, workflowTitle, type WorkflowInput,
  type WorkflowLoopItem, type WorkflowNode, type WorkflowPort,
} from "../lib/canvasWorkflow";
import { canvasWorkflowController } from "../lib/canvasWorkflowRuntime";
import { chatDshStatus, chatQuote } from "../lib/chatCapabilities";
import { startComposerLocalVideo } from "../lib/composerLocalVideo";
import type { ProviderIssue } from "../lib/generationAvailability";
import { H3_IMAGE } from "../lib/genProviders";
import { agentChatOptions, localChat, localChatRunning, type ChatProvider } from "../lib/localChat";
import { useLocalChatStore, useProjectChatSummaries } from "../lib/localChatStore";
import { notifyError, notifySuccess } from "../lib/notify";
import { generationPromptNodeId } from "../lib/projectNodeIds";
import type { Asset, CanvasNode, VisualProfileSummary } from "../lib/types";
import { userErrorMessage } from "../lib/userError";
import { useWorkflowPortGeometry, type WorkflowPortTarget } from "../lib/useWorkflowPortGeometry";
import { createdChatTurnCards, terminalDshTurnFailure, workflowAgentProvider } from "../lib/workflowAgentChat";
import { workflowSourceMediaLabel } from "../lib/workflowCanvasCapabilities";
import { workflowLoopItems, workflowLoopRows } from "../lib/workflowLoop";
import { profileExtractionIssue, profileInputKey, workflowProviderIssue } from "../lib/workflowProviderIssue";
import { isWorkspaceOperationCurrent } from "../lib/workspaceRoute";
import { useStore } from "../store";
import { CanvasCardName } from "./CanvasCardName";
import { CanvasConnectionDefinitions, CanvasConnectionHandle } from "./CanvasConnectionHandle";
import { renderCanvasCards, useCanvasEntryCardContext } from "./CanvasEntryCard";
import "./CanvasWorkflow.css";
import { CONNECTION_CARDS, useWorkflowConnectionGesture, type Connection, type PendingConnectionCard } from "./useWorkflowConnectionGesture";
import { useWorkflowLayerIssue } from "./useWorkflowLayerIssue";
import { WorkflowCardItem, type WorkflowCardContext } from "./WorkflowCardItem";
import { findAgentChatSummary, resolveAssetMediaType } from "./workflowLayerBindings";
import { comfyCheckKey, WindingKey } from "./WorkflowLayerPresentation";
import type { H3RunChoice, MaterialAnchor, WorkflowGeometry, WorkflowLayerHandle, WorkflowLayerProps } from "./WorkflowLayerTypes";
import { WorkflowLoopFrame } from "./WorkflowLoopFrame";
import { WorkflowDisconnectOverlay, WorkflowOverlays } from "./WorkflowOverlays";
import { WorkflowWiresLayer } from "./WorkflowWiresLayer";

export { WindingKey };
export type { MaterialAnchor,WorkflowGeometry,WorkflowLayerHandle };

export const CanvasWorkflowLayer = memo(forwardRef<WorkflowLayerHandle, WorkflowLayerProps>(function CanvasWorkflowLayer({ projectId, provisional = false, diagnosticTarget = window.document.body, getZoom, settledZoom, opening, entryCardIds, deferredCandidateIds, materials, graphNodes, visibleGraphNodeIds, conversationCards, selectedConversationOutputs, imageOnlyConversationIds, sessionHeights, generationCardAnchors, generationCardOrigins, generationActivities, activeGenerationIds, pinnedCardOffsets, peekCard, onPeekInteraction, onToggleGenerationPin, onConnectCollapsedGeneration, onUndoGenerationConnection, ensureMaterialized, toBoardPoint, onPlaced, selectedIds, panReady, onSelect, onNodesChanged, onEdited, onOpenGeneration, onOpenAgent, getChatCardDefaults, onNewAgentChat, onDragStart, onDragMove, onDragEnd, onNodeMenu, onRemove }, ref) {
  const controller = useMemo(() => canvasWorkflowController(projectId), [projectId]);
  const [, redraw] = useState(0);
  const [runtimeRevision, updateRuntimeRevision] = useState(0);
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
  const [assets, setAssets] = useState<Asset[]>([]);
  const [agentOpen, setAgentOpen] = useState(false);
  const [retryReview, setRetryReview] = useState<{ projectId: string; cardNames: string[]; confirm: () => Promise<void> } | null>(null);
  const [localRunReview, setLocalRunReview] = useState<{ projectId: string; nodeId: string; single: boolean; choice?: H3RunChoice } | null>(null);
  const [staleReview, setStaleReview] = useState<string | null>(null);
  const agentActionLocks = useRef(new Set<string>());
  const [pendingAgentCards, setPendingAgentCards] = useState<ReadonlySet<string>>(() => new Set());
  const [templateLibrary, setTemplateLibrary] = useState<{ instanceRoot?: string; importPackage?: boolean } | null>(null);
  const [templateSelection, setTemplateSelection] = useState<{ projectId: string; ids: string[]; nodes: WorkflowNode[]; canvas: CanvasNode[]; bounds: WorkflowGeometry[]; mode: "template" | "container" | "package" } | null>(null);
  const [keyHover, setKeyHover] = useState<{ id: string; x: number; y: number; anchor: HTMLElement; rect: DOMRect; focus: boolean } | null>(null);
  const [profiles, setProfiles] = useState<VisualProfileSummary[]>([]);
  const state = useStore(state => ({ visualProfiles: state.visualProfiles, activeGenProvider: state.activeGenProvider,
    defaultProvider: state.defaultProvider, codexHealth: state.codexHealth, dreaminaHealth: state.dreaminaHealth,
    cloudAuth: state.cloudAuth, cloudEntitlement: state.cloudEntitlement, openVisualProfile: state.openVisualProfile }), shallow);
  const document = controller.document;
  const chatSummaries = useProjectChatSummaries(projectId, true);
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
      const chat = findAgentChatSummary(node, chatSummaries, projectId);
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
      const type = resolveAssetMediaType(id, materialByAsset, assets);
      return !type || (media ? media === type : source.mediaFilter?.includes(type));
    });
  }
  function inputMediaLabel(binding: WorkflowInput) {
    if (binding.videoFrame) return "图片";
    return workflowSourceMediaLabel(inputImages(binding), assets, nodeById.get(binding.nodeId ?? ""));
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
    const refresh = () => { updateRuntimeRevision(value => value + 1); nodesChanged.current(); };
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
  useEffect(() => {
    setAgentOpen(false);
    setKeyHover(null);
    setTemplateLibrary(null);
    setTemplateSelection(null);
    setRetryReview(null);
    setLocalRunReview(null);
    setStaleReview(null);
    agentDetailPress.current = null;
  }, [projectId]);
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
    return () => {
      observer.disconnect();
      cardObserver.current = undefined;
      cardHeights.current.clear();
    };
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
  const assetKey = [...new Set([...automaticAssetIds, ...[...loopPreviews.values()].flatMap(preview => preview.items?.flatMap(item => item.assetIds) ?? []), ...workflowRuns(document).flatMap(run => [...(run.loop?.items?.flatMap(item => item.assetIds) ?? []), ...(run.loop?.completed.flatMap(item => Object.values(item.outputs).flatMap(outputs => Object.values(outputs).flatMap(value => value.assetIds ?? []))) ?? [])]), ...document.nodes.flatMap(node => [
    ...Object.values(node.inputs).flat().flatMap(inputImages),
    ...Object.values(node.outputs).flatMap(output => output.assetIds ?? []),
  ]), ...graphNodes.filter(node => node.kind === "asset" && node.role === "output").flatMap(node => node.assetId ? [node.assetId] : [])])].sort().join("|");
  useEffect(() => {
    if (!assetKey) { setAssets(previous => previous.length ? [] : previous); return; }
    let current = true;
    void api.getAssetsByIds(assetKey.split("|")).then(value => { if (current) setAssets(value); }).catch(() => {});
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
    const current = previous.find(node => node.id === id);
    if (!current) return;
    const updated = { ...current, ...update };
    if (workflowProducesVideo(current) && !workflowProducesVideo(updated)
      && previous.some(node => [...Object.values(node.inputs), ...Object.values(node.savedComfyR2V ?? {})]
        .some(inputs => inputs?.some(input => input.nodeId === id && input.videoFrame)))) {
      notifyError(null, "请先断开下游的首帧或尾帧画面引用，再切换输出类型"); return;
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
    const label = (id && cardNames[id]) || assets.find(asset => asset.id === binding.assetId)?.name || "来源已移除";
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
  const {
    addCard, armed, automatic, automaticOutputs, automaticRef, automaticTarget, beginAutomatic,
    beginCompletionDrag, blankCardMenu, cardMenu, chooseAutomaticReceiver, chooseDisconnect,
    clearAutomatic, commitAutomatic, connect, connectSignal, connection, connectionCard, connectionHover,
    connectionMenu, connectionRef, createConnected, cursor, disconnectAutomatic, disconnectChoices,
    disconnectMenu, gestureOutputs, hoveredMaterial, inputText, newConnectionError, receiverError,
    selectConnectionScope, setArmed, setBlankCardMenu, setConnection, setCursor, setDisconnectMenu,
    updateCursor, videoConnection, videoReferenceError,
  } = useWorkflowConnectionGesture({
    selectedConversationOutputs, controller, graphNodes, materials, assets, conversationCards,
    generationAnchorOwners, collapsedAnchorOwners, activeGenerationIds, collapsedAnchor, nodeById,
    panReady, toBoardPoint, graphById, cardPoint, visibleGraphNodes, sessionHeights, renderedNodes,
    displayPoint, cardHeights, activeController, projectId, handle, provisional, ensureMaterialized,
    onEdited, onSelect, materialById, materialByAsset, generationCardAnchors, generationCardOrigins,
    pendingCards, redraw, onConnectCollapsedGeneration, currentSelection, inputImages, sourceLabel,
    inputMediaLabel, edit, patch, state, h3ReferenceAssets, document, wireElement,
  });
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
  }, [document.nodes, graphById, nodeById, conversationCards, connection, automatic, currentRows]);
  const portRect = useWorkflowPortGeometry(wireElement, portTargets, getZoom, settledZoom);
  const frames = new Map<string, { owner: string; x: number; y: number; width: number; height: number; index: number; total: number }>();
  for (const [id, row] of currentRows) {
    const first = portRect(row.source, "cell", row.first);
    const last = portRect(row.source, "cell", row.last);
    if (first && last) frames.set(id, { owner: row.source.id, x: first.x - 3, y: first.y, width: last.x + last.width - first.x + 6,
      height: first.height, index: row.index, total: row.total });
  }

  const currentHandle = useRef<WorkflowLayerHandle>(null!);
  currentHandle.current = {
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
    isConnecting: () => !!connectionRef.current || !!automaticRef.current,
    bounds(includeHidden = false) {
      return controller.document.nodes.filter(node => node.kind !== "text" && (includeHidden || !collapsedAnchor(node.id))).map(node => {
        const { x, y } = includeHidden ? node : displayPoint(node);
        return { id: node.id, x, y, width: workflowCardWidth(node), height: cardHeights.current.get(node.id) ?? cardElements.current.get(node.id)?.offsetHeight ?? 330 };
      });
    },
    isLocked(id) {
      const node = controller.document.nodes.find(node => node.id === id);
      const chat = findAgentChatSummary(node, chatSummaries, projectId);
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
  };
  useImperativeHandle(ref, () => ({
    get startLocalVideo() { return currentHandle.current.startLocalVideo; },
    get templates() { return currentHandle.current.templates; },
    get saveTemplate() { return currentHandle.current.saveTemplate; },
    get inputText() { return currentHandle.current.inputText; },
    get connectSelection() { return currentHandle.current.connectSelection; },
    get connectCell() { return currentHandle.current.connectCell; },
    get bindRecording() { return currentHandle.current.bindRecording; },
    get add() { return currentHandle.current.add; },
    get openCardMenu() { return currentHandle.current.openCardMenu; },
    get createImageCard() { return currentHandle.current.createImageCard; },
    get arm() { return currentHandle.current.arm; },
    get cancelPlacement() { return currentHandle.current.cancelPlacement; },
    get isConnecting() { return currentHandle.current.isConnecting; },
    get bounds() { return currentHandle.current.bounds; },
    get isLocked() { return currentHandle.current.isLocked; },
    get position() { return currentHandle.current.position; },
  }), []);

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
  useLayoutEffect(() => updateCursor.current(), [connection, automatic, connectionMenu, armed, toBoardPoint, document.nodes, graphNodes, materials]);

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
  const entryContext = useMemo(() => ({}), [document, graphNodes, materials, assets, selectedIds, providerIssues, generationActivities, activeGenerationIds, peekCard]);
  const editingContext = useMemo(() => ({}), [
    entryContext, activeVideoJobs, armed, automatic, cardNames, chatSummaries, collapsedAnchorOwners, connection, connectionHover,
    conversationCards, generationCardOrigins, h3AutoOptimize, panReady, pendingAgentCards, pinnedCardOffsets, provisional,
    renderedNames, runtimeRevision, serviceIssues, state, voiceIssue,
  ]);
  const stagedCardContext = useCanvasEntryCardContext(entryContext, opening, editingContext);
  const sessionOutputsBySessionId = useMemo(() => {
    const ids = hiddenWorkflowSessionIds(document.nodes);
    return new Map(graphNodes.filter(session => ids.has(session.id)).map(session => [session.id, canvasSessionImages(session, graphNodes)]));
  }, [document.nodes, graphNodes]);
  const cardContext: WorkflowCardContext = {
    nodeById, document, generationActivities, controller, chatSummaries, projectId, deliveryRunIds,
    pendingAgentCards, flowIssues, providerIssues, activeVideoJobs, loopPreviews, inputImages,
    referencePreviewValues, h3ReferenceAssets, assets, sourceImages, graphById, graphNodes, patch,
    disconnectAutomatic, sourceLabel, chooseDisconnect, portMediaLabel, h3AutoOptimize, handle,
    cardElements, openOptimizationChat, peekCard, pinnedCardOffsets, displayPoint, workflowCardRef,
    selectedIds, armed, onPeekInteraction, agentDetailPress, panReady, connectionRef, automaticRef,
    setArmed, onSelect, onOpenAgent, onNodeMenu, edit, nameEditor, gearButton, keyButton, showProgress,
    setKeyHover, onDragStart, onDragMove, onDragEnd, beginCompletionDrag, onOpenGeneration, state,
    setVoiceIssue, reportComfy, onToggleGenerationPin, onRemove, setTemplateLibrary, locateIssue,
    materials, handleAgentCard, profiles, placedAudioAssets, cardNames, onUndoGenerationConnection,
    moveReference, disconnectReference, staleReview, setStaleReview, runCard, retryLoop,
    getChatCardDefaults, setAgentOpen, portButton, automaticButton,
  };
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
    <WorkflowDisconnectOverlay {...{
      disconnectMenu, disconnectChoices, assets, setDisconnectMenu,
    }} />
    {Array.from(frames, ([id, frame]) => <WorkflowLoopFrame key={id} {...frame} />)}
    <CanvasConnectionDefinitions />
    <WorkflowWiresLayer {...{
      wireElement, document, workflowNodeMounted, collapsedAnchor, generationResultAnchors,
      conversationCards, graphById, embeddedPoint, visibleGraphNodeIds, materialById, cardPoint,
      cardMounted, wireSelected, sessionOutputsBySessionId, outputPath, groupById, renderedNodes, frames,
      sourcePoint, displayPoint, portRect, scopedPoint, nodeDiagnostic, chooseDisconnect, pending,
      connection, draftElement, toBoardPoint, cursor, automatic, connectionMenu,
    }} />
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
      ? cardMounted(peekCard.anchorId) : cardMounted(node.id) && !collapsedAnchor(node.id)))), stagedCardContext, node => (
      <WorkflowCardItem node={node} context={cardContext} />
    ))}
    <WorkflowOverlays {...{
      armed, ghostElement, cursor, keyHover, document, issue, diagnosticTarget, deliveryRunIds,
      controller, issueSourceLabel, locateIssue, handle, issueSourceId, graphNodes, connectionHover,
      nodeById, graphById, materialById, automatic, peekCard, displayPoint, cardHeights, sessionHeights,
      cardMenu, videoConnection, connectionMenu, clearAutomatic, setBlankCardMenu, videoReferenceError,
      commitAutomatic, newConnectionError, connectionCard, createConnected, blankCardMenu, addCard,
      materials, generationAnchorOwners, conversationCards, receiverError, gestureOutputs,
      automaticTarget, chooseAutomaticReceiver, cardNames, selectConnectionScope, beginAutomatic,
      agentOpen, setAgentOpen, localRunReview, projectId, setLocalRunReview, runCard, retryReview,
      setRetryReview, templateLibrary, selectedIds, state, ensureMaterialized, setTemplateLibrary,
      templateSelection, onPlaced, setTemplateSelection,
    }} />
  </>;
}));
