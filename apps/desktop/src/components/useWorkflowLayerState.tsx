import { useLatestCallback } from "../lib/useCanvasFrame";
import { userErrorMessage } from "../lib/userError";
import { useProjectChatSummaries, useLocalChatStore } from "../lib/localChatStore";
import { agentChatOptions, localChat, localChatRunning, type ChatProvider } from "../lib/localChat";
import { createdChatTurnCards, terminalDshTurnFailure, workflowAgentProvider } from "../lib/workflowAgentChat";
import { chatDshStatus, chatQuote } from "../lib/chatCapabilities";
import { profileExtractionIssue, profileInputKey, workflowProviderIssue } from "../lib/workflowProviderIssue";
import { useWorkflowLayerIssue } from "./useWorkflowLayerIssue";
import type { ProviderIssue } from "../lib/generationAvailability";
import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore as useSnapshot } from "zustand";
import { shallow } from "zustand/shallow";
import { api } from "../lib/api";
import { activeCanvasNameCounts, assignCanvasCardNames, canvasCardNameError } from "../lib/canvasCardNames";
import { CanvasCardName } from "./CanvasCardName";
import { workflowAssetMedia, workflowSourceMediaLabel } from "../lib/workflowCanvasCapabilities";
import { workflowLoopItems, workflowLoopRows } from "../lib/workflowLoop";
import { readCanvasNote } from "../lib/canvasNotes";
import { contentInputPort } from "../lib/canvasContentInput";
import { canvasInputAssetIds, canvasInputValue, workflowBindingAssetIds, workflowGenerationResultAnchor, hiddenWorkflowSessionIds, workflowSessionIds } from "../lib/canvasSessionOutputs";
import { useStore } from "../store";
import { useWorkflowPortGeometry, type WorkflowPortTarget } from "../lib/useWorkflowPortGeometry";
import { notifyError, notifySuccess } from "../lib/notify";
import { canvasWorkflowController } from "../lib/canvasWorkflowRuntime";
import { h3CardDraft, h3DraftForResult, h3DraftStale, h3OriginalPrompt, h3PromptPatch, isH3ImageCard, workflowFrameLabel, workflowProducesVideo } from "../lib/canvasWorkflow";
import { H3_R2V_INPUT_PORTS, generationReferencePreviewOrder, lastGenerationRunInput, disconnectGenerationReference, reorderGenerationReferences, workflowOrder } from "../lib/canvasWorkflow";
import { invalidateWorkflow, workflowNodeRun, workflowRuns, workflowOutputs, workflowTitle, workflowCardWidth, type WorkflowInput, type WorkflowLoopItem, type WorkflowNode } from "../lib/canvasWorkflow";
import type { Asset, CanvasNode, VisualProfileSummary } from "../lib/types";
import { H3_IMAGE } from "../lib/genProviders";
import { generationPromptNodeId } from "../lib/projectNodeIds";
import { isWorkspaceOperationCurrent } from "../lib/workspaceRoute";
import { DisconnectTarget, comfyCheckKey, H3RunChoice, WorkflowGeometry, MaterialAnchor, WorkflowLayerProps, Connection, PendingConnectionCard, AutomaticGesture, ConnectionMenuState } from "./workflowLayerShared";

export function useWorkflowLayerState(props: WorkflowLayerProps) {
  const {
    projectId, selectedIds, onNodesChanged, activeGenerationIds, pinnedCardOffsets,
    generationCardAnchors, entryCardIds, deferredCandidateIds, graphNodes, conversationCards,
    visibleGraphNodeIds, materials, onNodeMenu, onEdited, provisional, onSelect, onPlaced, getZoom,
    onOpenAgent, onNewAgentChat
  } = props;
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
  const cardRefs = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const cardObserver = useRef<ResizeObserver>();
  const agentDetailPress = useRef<{ nodeId: string; x: number; y: number } | null>(null);
  const invalidateWireGeometry = useRef<(() => void) | null>(null);
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
  const chatSummaries = useProjectChatSummaries(projectId);
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
      const material = materialByAsset.get(id);
      const type = material?.audio ? "audio" : material?.video ? "video" : workflowAssetMedia(assets.find(asset => asset.id === id));
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
  const disconnectReference = useLatestCallback((nodeId: string, assetId: string) => {
    const current = controller.document.nodes.find(node => node.id === nodeId);
    if (!current || (current.kind !== "generation" && current.kind !== "agent") || controller.isLocked(nodeId)) return;
    patch(nodeId, disconnectGenerationReference(current, referencePreviewValues(current, true), assetId));
  });
  const moveReference = useLatestCallback((nodeId: string, fromId: string, toId: string) => {
    const current = controller.document.nodes.find(node => node.id === nodeId);
    if (!current || (current.kind !== "generation" && current.kind !== "agent") || controller.isLocked(nodeId)) return;
    const values = referencePreviewValues(current);
    const order = generationReferencePreviewOrder(current, values, controller.document.nodes);
    const from = order.indexOf(fromId), to = order.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return;
    order.splice(from, 1);
    order.splice(to, 0, fromId);
    patch(nodeId, { inputs: reorderGenerationReferences(current, values, order) });
  });
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
  for (const { source, first, last } of currentRows.values()) {
    addPort(source.id, "cell", first);
    addPort(source.id, "cell", last);
  }
  const portRect = useWorkflowPortGeometry(wireElement, portTargets, getZoom);
  const frames = new Map<string, { x: number; y: number; width: number; height: number; index: number; total: number }>();
  for (const [id, row] of currentRows) {
    const first = portRect(row.source, "cell", row.first);
    const last = portRect(row.source, "cell", row.last);
    if (first && last) frames.set(id, { x: first.x - 3, y: first.y, width: last.x + last.width - first.x + 6,
      height: first.height, index: row.index, total: row.total });
  }

  const handle = (promise: Promise<unknown>) => { void promise.catch(error => notifyError(error, "工作流操作未完成")); };
  const openOptimizationChat = useLatestCallback(async (nodeId: string, runId: string) => {
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
  });
  const runCard = useLatestCallback((nodeId: string, single: boolean, confirmed: boolean = false, choice?: H3RunChoice) => {
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
  });
  const retryLoop = async (runId: string, confirmedRequestIds?: string[]) => {
    const review = await controller.retryLoop(runId, confirmedRequestIds);
    if (review) setRetryReview({ projectId, cardNames: review.cardNames, confirm: () => retryLoop(runId, review.requestIds) });
  };
  const handleAgentCard = useLatestCallback(async (node: WorkflowNode, conversationId: string | undefined, action: "run" | "new" | ChatProvider, confirmedRequestId?: string) => {
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
  });
  useEffect(() => {
    const refresh = () => { redraw(value => value + 1); nodesChanged.current(); };
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
  useLayoutEffect(() => {
    let frame = 0;
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
      if (changed && !frame) frame = requestAnimationFrame(() => {
        frame = 0;
        invalidateWireGeometry.current?.();
      });
    });
    cardObserver.current = observer;
    for (const card of cardElements.current.values()) observer.observe(card);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); cardObserver.current = undefined; };
  }, [controller]);
  useLayoutEffect(() => {
    for (const id of cardHeights.current.keys()) {
      if (!nodeById.has(id) && !pendingCards.current.has(id)) cardHeights.current.delete(id);
    }
  }, [nodeById]);
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
          if (!activeController.current?.document.nodes.some(node => node.id === id)) cardHeights.current.delete(id);
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
    const checkAnchor = () => {
      if (!anchor.isConnected || !anchor.matches(focus ? ":focus-visible" : ":hover")) { close(); return; }
      const current = anchor.getBoundingClientRect();
      if (current.x !== rect.x || current.y !== rect.y || current.width !== rect.width || current.height !== rect.height) close();
    };
    const size = new ResizeObserver(checkAnchor);
    size.observe(anchor);
    // Ancestor style changes include camera transforms and imperative drag previews.
    const position = new MutationObserver(checkAnchor);
    for (let element: HTMLElement | null = anchor; element; element = element.parentElement) {
      position.observe(element, { attributes: true, attributeFilter: ["style", "class"], childList: true });
    }
    const dismissEvents = ["pointerdown", "pointercancel", "dragstart", "wheel", "scroll", "resize", "blur"] as const;
    dismissEvents.forEach(type => window.addEventListener(type, close, true));
    window.addEventListener("keydown", escape, true);
    window.document.addEventListener("pointerleave", close);
    return () => {
      position.disconnect();
      size.disconnect();
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
  ]), ...graphNodes.filter(node => node.kind === "asset" && node.role === "output").flatMap(node => node.assetId ? [node.assetId] : [])])].sort().join("|"), [automaticAssetIds, loopPreviews, document, graphNodes, inputImages]);
  useEffect(() => {
    let current = true;
    void api.getAssetsByIds(assetKey ? assetKey.split("|") : []).then(value => { if (current) setAssets(value); }).catch(() => {});
    return () => { current = false; };
  }, [assetKey]);

  const edit = useLatestCallback((nodes: WorkflowNode[], draftNodeId?: string, editorOnly: boolean = false) => {
    const before = controller.document;
    const pending = controller.edit(nodes, undefined, draftNodeId, editorOnly);
    // edit validates locks before synchronously applying its optimistic snapshot.
    if (controller.document !== before) onEdited(before, controller.document);
    return pending;
  });
  const patch = useLatestCallback((id: string, update: Partial<WorkflowNode>, invalidate: boolean = true) => {
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
  });
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
  return {
    setConnection, setArmed, setAgentOpen, setKeyHover, setTemplateLibrary, setTemplateSelection,
    setDisconnectMenu, setLocalRunReview, setStaleReview, controller, assets, generationAnchorOwners,
    collapsedAnchorOwners, collapsedAnchor, nodeById, automaticPressTimer, automaticRef,
    setAutomatic, setConnectionMenu, connectionHoverRef, setConnectionHover, connectionRef,
    setBlankCardMenu, setCursor, graphById, visibleGraphNodes, renderedNodes, displayPoint,
    invalidateWireGeometry, cardHeights, activeController, handle, materialById, materialByAsset, pendingCards, redraw,
    currentSelection, inputImages, sourceLabel, inputMediaLabel, edit, patch, state, connectionMenu,
    cursor, h3ReferenceAssets, armed, document, swallowAutomaticClick, hoveredMaterialRef,
    hoveredHotspot, wireElement, automatic, cardElements, chatSummaries, agentActionLocks,
    sessionOwners, groupById, portRect, generationResultAnchors, updateCursor, draftElement,
    ghostElement, flowIssues, keyHover, runCard, providerIssues, cardMounted, sessionIds, nameEditor,
    disconnectMenu, frames, workflowNodeMounted, nodeDiagnostic, pending, connection,
    hoveredMaterial, deliveryRunIds, pendingAgentCards, loopPreviews,
    referencePreviewValues, sourceImages, portMediaLabel, h3AutoOptimize,
    openOptimizationChat, workflowCardRef, agentDetailPress, setVoiceIssue, reportComfy, locateIssue,
    handleAgentCard, profiles, placedAudioAssets, renderedNames, cardNames, moveReference, disconnectReference,
    staleReview, retryLoop, issue, issueSourceLabel, issueSourceId, connectionHover, cardMenu,
    videoConnection, blankCardMenu, agentOpen, localRunReview, retryReview, setRetryReview,
    templateLibrary, templateSelection
  };
}
export type WorkflowLayerState = ReturnType<typeof useWorkflowLayerState>;
