import { copyComfyDiagnostic } from "../lib/comfyVideo";
import { memo, useMemo } from "react";
import { Clapperboard, Images, MessageCirclePlus, Play, Square, X, Copy, CopyPlus, ImagePlus, Pin, PinOff } from "lucide-react";
import { AgentCardConversation } from "./AgentCardConversation";
import { AgentCardQuestion } from "./AgentCardQuestion";
import { AgentChatControls } from "./AgentChatControls";
import { CanvasTextarea } from "./CanvasTextarea";
import { ComfyEnvironmentControl, ComfyGenerationProgress, ComfyVideoCard } from "./ComfyVideoCard";
import { H3OptimizationActions } from "./creation/H3OptimizationActions";
import { ProviderIssueNotice } from "./creation/ProviderIssueNotice";
import { ProviderSelect } from "./creation/ProviderSelect";
import { RatioSelect } from "./creation/RatioSelect";
import { VideoControls } from "./creation/VideoControls";
import { GenerationJobProgress } from "./GenerationJobFeedback";
import { TacticalSelect } from "./TacticalSelect";
import { VoiceCard } from "./VoiceCard";
import { VoiceEnvironmentControl } from "./VoiceEnvironmentControl";
import { WorkflowDescribeOption } from "./WorkflowDescribeOption";
import { WorkflowGenerationHistory } from "./WorkflowGenerationHistory";
import { WorkflowGenerationReferences, WorkflowMediaThumbnail } from "./WorkflowGenerationReferences";
import { WorkflowLoopActions, WorkflowLoopCard } from "./WorkflowLoopCard";
import { WorkflowPlannerCard } from "./WorkflowPlannerCard";
import { WorkflowPromptEditor } from "./WorkflowPromptEditor";
import { WorkflowTriggerSchedule } from "./WorkflowTriggerSchedule";
import { CardComfyEnvironment, TRIGGER_MODES, WindingKey, WORKFLOW_CARD_PRESENTATION } from "./WorkflowLayerPresentation";
import { api } from "../lib/api";
import { isAudioPath } from "../lib/audioMedia";
import { cloneCanvasClipboard } from "../lib/canvasClipboard";
import { exceedsCanvasDragThreshold } from "../lib/canvasLogic";
import { canvasInputValue, completedCanvasSessions, type WorkflowGenerationActivity } from "../lib/canvasSessionOutputs";
import {
  H3_R2V_INPUT_LIMITS, H3_R2V_INPUT_PORTS, H3_VIDEO_AUDIO_PORT, WORKFLOW_CARD_DRAG_TYPE, WORKFLOW_SKILLS, compileGenerationPrompt,
  generationInputNode, generationReferencePreviewOrder, h3CardDraft, h3DraftStale, h3OriginalPrompt, h3PromptPatch,
  h3RunReferences, invalidateWorkflow, isH3ImageCard, isWorkflowGenerationResult, lastGenerationRunInput, selectWorkflowVideoProvider,
  workflowCardWidth, workflowCompletionOutput, workflowDisconnectId, workflowFrameLabel, workflowInputs, workflowInputValues, workflowNodeRun,
  workflowOutputs, workflowRuns, workflowVideoAudioLabel, type CanvasWorkflow, type WorkflowInput, type WorkflowLoopItem,
  type WorkflowNode, type WorkflowPort, type WorkflowRun, type WorkflowValue,
} from "../lib/canvasWorkflow";
import type { CanvasWorkflowController } from "../lib/canvasWorkflowRuntime";
import { DEFAULT_COMFY_VIDEO, comfyVideoMode } from "../lib/comfyVideo";
import { contentTableRows } from "../lib/contentTable";
import { getDragAssets } from "../lib/dragPayload";
import type { ProviderIssue } from "../lib/generationAvailability";
import { localChatRunning, localChatStatusLabel, type ChatCardDefaults, type ChatProvider, type ChatSummary } from "../lib/localChat";
import { useLocalChatStore } from "../lib/localChatStore";
import { notifyError, notifySuccess } from "../lib/notify";
import { generationPromptNodeId } from "../lib/projectNodeIds";
import type { Asset, CanvasNode, VisualProfileSummary } from "../lib/types";
import { userErrorMessage } from "../lib/userError";
import { DEFAULT_VIDEO_OPTIONS, isVideoPath, resolveVideoOptions } from "../lib/videoGeneration";
import { workflowDiagnosticReport } from "../lib/workflowDiagnostics";
import { removeWorkflowNodes } from "../lib/workflowRemoval";
import { workflowTriggerMode } from "../lib/workflowTriggerSchedule";
import { videoFrameInputValues } from "../lib/workflowVideoFrames";
import { useStore } from "../store";
import type { AutomaticGesture, Connection, DisconnectTarget, H3RunChoice } from "./CanvasWorkflowLayer";

const NEW_AGENT_CHAT_TOOLTIP = "在新建对话中运行指令，消除上下文影响";
const statusLabels = { pending: "等待上游", running: "执行中", waiting: "等待继续", done: "已完成", failed: "失败" };

export interface WorkflowCardContext {
  assetById: Map<string, Asset>;
  assets: Asset[];
  cardElements: React.MutableRefObject<Map<string, HTMLElement>>;
  cardNames: Record<string, string>;
  controller: CanvasWorkflowController;
  document: CanvasWorkflow;
  graphById: Map<string, CanvasNode>;
  graphNodes: CanvasNode[];
  h3AutoOptimize: boolean;
  savingH3Preference: boolean;
  setSavingH3Preference: React.Dispatch<React.SetStateAction<boolean>>;
  h3ReferencePending: (input: WorkflowInput) => boolean;
  onUndoGenerationConnection: (nodeId: string) => boolean;
  loadAssets: (ids: string[]) => Promise<Asset[]>;
  nodeById: Map<string, WorkflowNode>;
  placedAudioAssets: Set<string>;
  profiles: VisualProfileSummary[];
  projectId: string;
  state: Pick<ReturnType<typeof useStore.getState>, "activeGenProvider" | "defaultProvider" | "codexHealth" | "dreaminaHealth" | "cloudAuth" | "cloudEntitlement" | "openVisualProfile">;
  agentDetailPress: React.MutableRefObject<{ nodeId: string; x: number; y: number; } | null>;
  automaticRef: React.MutableRefObject<AutomaticGesture | null>;
  connectionRef: React.MutableRefObject<Connection | null>;
  automaticButton: (id: string, side: "input" | "output", disabled?: boolean, active?: boolean) => React.JSX.Element;
  beginCompletionDrag: (event: React.PointerEvent<HTMLButtonElement>, id: string) => void;
  chooseDisconnect: (target: DisconnectTarget, point: { x: number; y: number; }, quick?: boolean) => void;
  disconnectAutomatic: (id: string) => void;
  disconnectReference: (nodeId: string, assetId: string) => void;
  edit: (nodes: WorkflowNode[], draftNodeId?: string, editorOnly?: boolean) => Promise<void>;
  gearButton: (node: WorkflowNode) => React.JSX.Element;
  h3ReferenceAssets: (input: WorkflowInput, media?: keyof typeof H3_R2V_INPUT_PORTS) => string[];
  inputImages: (input: WorkflowInput) => string[];
  keyButton: (node: WorkflowNode, showProgressTooltip: boolean) => React.JSX.Element;
  handle: (promise: Promise<unknown>) => void;
  handleAgentCard: (node: WorkflowNode, conversationId: string | undefined, action: "run" | "new" | ChatProvider, confirmedRequestId?: string) => Promise<void>;
  locateIssue: (id: string) => void;
  moveReference: (nodeId: string, fromId: string, toId: string) => void;
  nameEditor: (id: string, style?: React.CSSProperties, busy?: boolean, section?: boolean) => React.JSX.Element;
  onDragEnd: (event: React.PointerEvent<HTMLElement>, cancelled?: boolean) => void;
  onDragMove: (event: React.PointerEvent<HTMLElement>) => void;
  onDragStart: (event: React.PointerEvent<HTMLElement>, node: WorkflowNode) => void;
  onNodeMenu: (event: React.MouseEvent<HTMLElement>, id: string) => void;
  onOpenAgent: (nodeId: string, conversationId?: string, entryKey?: string, applyPrompt?: (text: string) => Promise<void>) => void;
  onOpenGeneration: (node: CanvasNode) => void;
  onPeekInteraction: (kind: "enter" | "leave" | "blur" | "compose" | "commit") => void;
  onRemove: (id: string) => void;
  onSelect: (id: string, additive?: boolean) => void;
  onToggleGenerationPin: (nodeId: string) => void;
  openOptimizationChat: (nodeId: string, runId: string) => Promise<void>;
  patch: (id: string, update: Partial<WorkflowNode>, invalidate?: boolean) => void;
  portButton: (node: WorkflowNode, port: WorkflowPort, side: "input" | "output", _index: number) => React.JSX.Element;
  portMediaLabel: (bindings: WorkflowInput[]) => "音频" | "图片" | "素材" | "视频";
  referencePreviewValues: (node: WorkflowNode, includeText?: boolean, imageIds?: (input: WorkflowInput) => string[]) => Record<"text" | "image", WorkflowValue[]>;
  reportComfy: (key: string, message: string | null) => void;
  retryLoop: (runId: string, confirmedRequestIds?: string[]) => Promise<void>;
  runCard: (nodeId: string, single: boolean, confirmed?: boolean, choice?: H3RunChoice) => void;
  setAgentOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setArmed: React.Dispatch<React.SetStateAction<boolean>>;
  setKeyHover: (value: null) => void;
  setStaleReview: React.Dispatch<React.SetStateAction<string | null>>;
  setTemplateLibrary: (value: { instanceRoot?: string; importPackage?: boolean } | null) => void;
  setVoiceIssue: React.Dispatch<React.SetStateAction<string | null>>;
  showProgress: (id: string, anchor: HTMLElement, beside?: boolean, focus?: boolean) => void;
  sourceImages: (input: WorkflowInput) => string[];
  sourceLabel: (binding: WorkflowInput) => { label: string; detail: string; };
  workflowCardRef: (id: string) => (element: HTMLElement | null) => void;
}

interface WorkflowCardItemProps {
  context: WorkflowCardContext;
  node: WorkflowNode;
  run?: WorkflowRun;
  creating: boolean;
  locked: boolean;
  starting: ReturnType<CanvasWorkflowController["startingAction"]>;
  stopping: boolean;
  removableLocalVideo: boolean;
  imageActivity: WorkflowGenerationActivity;
  agentChat?: ChatSummary;
  selected: boolean;
  pinned: boolean;
  peek?: { anchorId: string; point: { x: number; y: number } };
  x: number;
  y: number;
  armed: boolean;
  panReady: boolean;
  activeHandle?: "input" | "output";
  showKeyProgress: boolean;
  showStaleReview: boolean;
  pendingAgent: boolean;
  deliveryPending: boolean;
  videoJobActive: boolean;
  providerIssue: ProviderIssue | null;
  loopProviderIssues?: Map<string, ProviderIssue>;
  loopPreview?: { items?: WorkflowLoopItem[]; notice: string };
  failureKey?: string;
  failureDismissed?: boolean;
  failureDiagnostic?: NonNullable<ReturnType<CanvasWorkflowController["cardFailure"]>>["diagnostic"];
  getChatCardDefaults: () => ChatCardDefaults;
}

export const WorkflowCardItem = memo(function WorkflowCardItem({
  context, node, run, creating, locked, starting, stopping, removableLocalVideo, imageActivity, agentChat,
  selected, pinned, peek, x, y, armed, panReady, activeHandle, showKeyProgress, showStaleReview, pendingAgent, deliveryPending,
  videoJobActive, providerIssue, loopProviderIssues, loopPreview, failureKey, failureDismissed, failureDiagnostic, getChatCardDefaults,
}: WorkflowCardItemProps) {
  const {
    assetById, assets, cardElements, cardNames, controller, document, graphById, graphNodes, h3AutoOptimize, savingH3Preference, setSavingH3Preference, h3ReferencePending, onUndoGenerationConnection, loadAssets, nodeById, placedAudioAssets,
    profiles, projectId, state, agentDetailPress, automaticRef, connectionRef,
    automaticButton, beginCompletionDrag, chooseDisconnect, disconnectAutomatic, disconnectReference, edit, gearButton, h3ReferenceAssets,
    inputImages, keyButton, handle, handleAgentCard, locateIssue, moveReference, nameEditor, onDragEnd, onDragMove, onDragStart, onNodeMenu,
    onOpenAgent, onOpenGeneration, onPeekInteraction, onRemove, onSelect, onToggleGenerationPin, openOptimizationChat, patch,
    portButton, portMediaLabel, referencePreviewValues, reportComfy, retryLoop, runCard, setAgentOpen, setArmed, setKeyHover, setStaleReview,
    setTemplateLibrary, setVoiceIssue, showProgress, sourceImages, sourceLabel, workflowCardRef,
  } = context;
  const displayed = { x, y };
  const failure = failureKey ? { key: failureKey, dismissed: failureDismissed, diagnostic: failureDiagnostic } : null;
  const step = run?.steps[node.id];
  const voiceReferenceIds = node.kind === "voice" ? (node.inputs.image ?? []).flatMap(input => {
    const reference = step?.voiceRequest?.videoAudio;
    if (!input.nodeId || !input.videoAudio || !reference) return inputImages(input);
    const videos = inputImages({ ...input, videoAudio: undefined });
    return videos.length === 1 && videos[0] === reference.sourceAssetId ? [reference.assetId] : [];
  }) : [];
  const imageFailure = !failure && imageActivity.failed && imageActivity.session;
  const hasAgentMessages = !!agentChat?.turnCount;
  const { agentHistory, agentRunPrompts } = useMemo(() => {
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
    return { agentHistory, agentRunPrompts };
  }, [node.kind, node.id, document]);
  const chatBusy = localChatRunning(agentChat);
  const conversationId = agentChat?.id ?? node.chatConversationId;
  const workflowExecuting = controller.isNodeExecuting(node.id, run?.id);
  const imageRunning = imageActivity.running;
  const statusText = stopping ? "正在停止" : starting ? "准备运行"
    : step?.detail === "连线已断开，本次未执行" ? step.detail
      : node.kind === "voice" && step?.status === "running" && step.detail ? step.detail
        : node.kind === "agent" && run?.status === "stopped" && !chatBusy && step?.status !== "done" ? "已停止" : undefined;
  const queuedTrigger = node.kind === "trigger" && run?.status === "waiting" && !run.order.length && run.triggerQueue?.[0] === node.id;
  const triggerExecuting = node.kind === "trigger" && (run?.status === "running" || run?.status === "waiting") && run.order.includes(node.id);
  const activeWorkflow = run && (queuedTrigger || triggerExecuting || workflowExecuting
    || run.status === "waiting" && ((run.order.includes(node.id) && step?.status !== "done") || deliveryPending && node.id === run.startId))
    ? run : undefined;
  const retryDelivery = !!activeWorkflow && deliveryPending && node.id === activeWorkflow.startId;
  const continueWorkflow = activeWorkflow?.status === "waiting" && !Object.values(activeWorkflow.steps).some(step => step.status === "failed")
    && (activeWorkflow.order.find(id => activeWorkflow.steps[id].status !== "done")
      ?? (activeWorkflow.triggerQueue?.length ? activeWorkflow.startId : null)) === node.id;
  const stopAgent = node.kind !== "agent" ? undefined : starting ? () => controller.cancelStarting(node.id)
    : chatBusy && agentChat && !workflowExecuting ? () => useLocalChatStore.getState().stop(agentChat.id)
      : activeWorkflow ? () => controller.stop(activeWorkflow.id) : undefined;
  const busy = creating || node.kind !== "trigger" && (!!starting || imageRunning || locked || chatBusy || pendingAgent || node.planning?.status === "waiting");
  const loop = node.kind === "loop" && run?.loop?.nodeId === node.id ? run.loop : undefined;
  const restartIssue = loop && run?.status === "stopped" ? loop.bodyIds.map(id => loopProviderIssues?.get(id)).find(Boolean) : null;
  // A saved request may only need a status query. Block retries known to submit again.
  const retryIssue = loop && run?.status === "waiting" ? Object.entries(run.steps).flatMap(([id, step]) => {
    if (step.status !== "failed") return [];
    const job = step.jobId && useStore.getState().genJobs[step.jobId];
    const last = job ? job.turns[job.turns.length - 1] : undefined;
    const confirmed = step.confirmedFailedChatTurnId || (job && !job.running && last && last.turnKey === step.turnKey && last.error)
      || (step.retrySafe && !step.jobId && !step.chatInput && !step.localDsRequestId && !step.agentRunId);
    const issue = confirmed && loopProviderIssues?.get(id);
    return issue ? [issue] : [];
  })[0] : null;
  const removableWaitingVideo = node.kind === "generation" && node.generation?.media === "video"
    && run?.status === "waiting" && step?.status === "waiting" && !!step.jobId && !step.videoJobActive && !videoJobActive;
  const loopItems = loopPreview?.items, loopInputNotice = loopPreview?.notice ?? "";
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
  const localMode = localVideo ? comfyVideoMode(node.comfyVideo) : undefined;
  const r2vCounts = localMode === "r2v" ? {
    referenceImageCount: (node.inputs[H3_R2V_INPUT_PORTS.image] ?? []).reduce((n, input) =>
      n + (input.nodeId && input.videoFrame ? 1 : h3ReferenceAssets(input, "image").length), 0),
    referenceVideoCount: (node.inputs[H3_R2V_INPUT_PORTS.video] ?? []).flatMap(input => h3ReferenceAssets(input, "video")).length,
    referenceAudioCount: (node.inputs[H3_R2V_INPUT_PORTS.audio] ?? []).reduce((count, input) =>
      count + (input.nodeId && input.videoAudio ? 1 : h3ReferenceAssets(input, "audio").length), 0),
  } : undefined;
  let generationAction = "运行";
  if (lastGenerationInput?.prompt === node.prompt) {
    const current = generationInputNode(node, document.nodes);
    const runReferenceIds = (input: WorkflowInput) => input.nodeId && (input.videoFrame || input.videoAudio)
      ? inputImages({ ...input, videoFrame: undefined, videoAudio: undefined })
      : localMode === "r2v" ? h3ReferenceAssets(input) : inputImages(input);
    const currentReferences = localVideo
      ? h3RunReferences(Object.fromEntries(Object.entries(current.inputs).map(([port, inputs]) =>
        [port, inputs.map(input => ({ type: "image" as const, assetIds: runReferenceIds(input) }))])), localMode)
      : [generationReferencePreviewOrder(current, referencePreviewValues(current, false, runReferenceIds), document.nodes)];
    if (JSON.stringify(lastGenerationInput.references) === JSON.stringify(currentReferences)) generationAction = "重试";
  }
  const references = referenceIds.map(id => assetById.get(id)).filter((asset): asset is Asset => !!asset);
  const selectedImages = [...new Set(outputImageIds.length ? outputImageIds : inputIds)].map(id => assetById.get(id)).filter((asset): asset is Asset => !!asset);
  const videoOptions = useMemo(() => {
    let videoOptions = resolveVideoOptions(node.generation?.videoOptions ?? DEFAULT_VIDEO_OPTIONS, []);
    if (node.kind === "generation" && node.generation?.media === "video") {
      try {
        const draft = { ...node, inputs: { text: node.inputs.text ?? [],
          image: (node.inputs.image ?? []).map(input => input.groupId ? { ...input, assetIds: sourceImages(input) } : input) } };
        const inputNode = generationInputNode(draft, document.nodes);
        // Model capability preview needs only the media type of a deferred reference.
        const pendingMedia = new Map<string, string>();
        const image = (inputNode.inputs.image ?? []).map((input, i) => {
          if (!input.nodeId || !input.videoFrame && !input.videoAudio) return input;
          const assetId = `preview-media:${i}`;
          pendingMedia.set(assetId, input.videoAudio ? "__video_audio__.wav" : "__video_frame__.png");
          return { ...input, nodeId: undefined, portId: undefined, assetId };
        });
        const values = workflowInputValues(document.nodes, { ...inputNode, inputs: { ...inputNode.inputs, image } }, (id, cell) => {
          const source = graphById.get(id); return source ? canvasInputValue(source, cell, graphNodes) : undefined;
        });
        for (const [index, input] of (inputNode.inputs.image ?? []).entries()) {
          if (values.image[index]?.nodeIds?.length && isWorkflowGenerationResult(input, nodeById.get(input.nodeId ?? ""))) {
            values.image[index] = { ...values.image[index], assetIds: sourceImages(input) };
          }
        }
        const frameIds = new Set(videoFrameInputValues(draft, values, graphNodes, document.nodes).flatMap(value => value.assetIds ?? []));
        const references = compileGenerationPrompt(draft, values, document.nodes).assetIds.map(id => {
          if (pendingMedia.has(id)) return { store_path: pendingMedia.get(id) };
          const asset = assetById.get(id);
          // These sockets submit a PNG tail frame, not the source video.
          return frameIds.has(id) && isVideoPath(asset?.store_path) ? { store_path: "__video_tail__.png" } : { store_path: asset?.store_path };
        });
        videoOptions = resolveVideoOptions(videoOptions, references);
      } catch { /* Draft references can be incomplete; execution validates them after upstream results arrive. */ }
    }
    return videoOptions;
  }, [node, document.nodes, sourceImages, graphById, graphNodes, nodeById, assetById]);
  const currentNode = () => controller.document.nodes.find(card => card.id === node.id) ?? node;
  const h3 = localVideo || localImage;
  const draft = h3 && h3CardDraft(node) || undefined;
  const original = draft?.original ?? draft?.source ?? node.prompt;
  const readCurrentPrompt = () => h3 ? h3OriginalPrompt(currentNode()) : currentNode().prompt;
  const updateOriginal = (prompt: string, promptReferences?: WorkflowNode["promptReferences"]) => {
    const current = h3 && h3CardDraft(currentNode());
    const changes = current ? h3PromptPatch({ ...current, original: prompt }) : { prompt };
    patch(node.id, promptReferences ? { ...changes, promptReferences } : changes,
      !current || changes.prompt !== currentNode().prompt || !!promptReferences && promptReferences !== currentNode().promptReferences);
  };
  const thumbnailIds = new Set(references.map(asset => asset.id));
  const thumbnailWireIds = new Set<string>();
  const labelledInputs = Object.entries(visibleInputs).map(([port, inputs]) => [port, inputs.filter(input => {
    if (localVideo && (port === "first-frame" || port === "last-frame" || port === H3_VIDEO_AUDIO_PORT || H3_R2V_INPUT_LIMITS[port])) return false;
    if (!referenceCard || (port !== "image" && port !== "text")) return true;
    const ids = inputImages(input);
    if (!ids.length || !ids.every(id => thumbnailIds.has(id))) return true;
    if (input.autoConnect) thumbnailWireIds.add(input.autoConnect);
    return false;
  })] as const).map(([port, inputs]) => [port, inputs.filter(input => !input.autoConnect || !thumbnailWireIds.has(input.autoConnect))] as const);
  const bindings = labelledInputs.some(([, inputs]) => inputs.length > 0) && <div className="workflow-bindings">
    {[...new Map(labelledInputs.flatMap(([, inputs]) => inputs).filter(input => input.autoConnect).map(input => [workflowDisconnectId(input)!, input])).entries()].map(([id, input]) =>
      <button key={id} disabled={busy && input.portId !== "signal" && node.kind !== "trigger"} title="断开连接" onClick={() => disconnectAutomatic(id)}>{sourceLabel(input).label}{input.videoFrame && ` · ${workflowFrameLabel(input.videoFrame)}`}{input.videoAudio && ` · ${workflowVideoAudioLabel()}`}<X size={11} /></button>)}
    {labelledInputs.map(([port, bindings]) => [port, bindings.filter(input => !input.autoConnect)] as const).filter(([, bindings]) => bindings.length).map(([port, bindings]) =>
      <button key={port} disabled={busy && port !== "completion" && port !== "signal"} title="断开此输入" onClick={event => chooseDisconnect({ nodeId: node.id, port }, { x: event.clientX, y: event.clientY }, true)}>{node.kind === "loop" && bindings.length === 1 ? sourceLabel(bindings[0]).label : node.kind === "voice" && port === "image" ? "参考录音" : port === "completion" ? "完成触发" : port === "signal" ? "触发器" : port === "text" ? "文本" : port === "visual-profile" ? "视觉规范" : port === "first-frame" ? node.comfyVideo?.mode === "reference" ? "参考图" : "首帧" : port === "last-frame" ? "尾帧" : portMediaLabel(bindings)}{(node.kind !== "loop" || bindings.length > 1) && ` · ${bindings.length} 个来源`} <X size={11} /></button>)}
  </div>;
  const presentation = WORKFLOW_CARD_PRESENTATION[videoCard ? "comfy-video" : node.kind], CardIcon = node.kind === "trigger" ? TRIGGER_MODES.find(mode => mode.id === triggerMode)!.icon : presentation.icon;
  const optimization = step?.comfyOptimization;
  const optimizing = starting === "optimize" || workflowExecuting && step?.status !== "done"
    && (step?.comfyAutoGeneration ? !optimization?.result : !!optimization);
  const generatingStatus = localVideo ? "正在生成视频" : "正在生成图片";
  const h3Status = (localVideo || localImage) ? (() => {
    if (step?.comfyStopping) return optimization && !optimization.result ? "正在停止提示词优化…" : "正在中断本机生成…";
    if (optimizing) return "正在优化提示词";
    if (statusText) return statusText;
    if (step?.comfyCancelled) return "已取消";
    if (run?.status === "stopped" && step?.status !== "done") return step?.status === "pending" ? "已停止，未执行" : "已停止";
    if (imageRunning || workflowExecuting) return generatingStatus;
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
    if (step) return statusLabels[step.status];
    if (providerIssue) return "暂不可运行";
    if (node.trigger) return "工作流起点";
    return h3AutoOptimize ? "就绪 · 运行前自动优化" : draft && !draft.paused ? "就绪 · 使用优化后提示词" : "就绪 · 使用原文";
  })() : undefined;
  const h3Progress = localVideo && h3Status === generatingStatus && run?.status === "running" ? step?.comfyProgress : undefined;
  const h3VideoPhase = h3Progress?.label
    ?? (run?.status === "running" && (!step?.comfyAutoGeneration || step.jobId) ? step?.detail : undefined);
  const h3Detail = h3Status === generatingStatus
    ? localVideo && h3VideoPhase ? userErrorMessage(h3VideoPhase, "等待本机进度") : ""
    : h3Status === "正在优化提示词" && step?.detail === "提示词优化排队中" ? "排队中" : "";
  const optimizationActions = h3 && <H3OptimizationActions nodeId={node.id} runs={workflowRuns(document)} disabled={busy || !original.trim()}
    draft={draft} stale={!!draft && h3DraftStale(node, draft)} seconds={localVideo ? draft?.seconds ?? (node.comfyVideo ?? DEFAULT_COMFY_VIDEO).seconds : undefined}
    readText={() => { const d = h3CardDraft(currentNode()); return d?.edited ?? d?.result ?? ""; }}
    onUpdate={changes => {
      const current = h3CardDraft(currentNode());
      if (current) {
        const update = h3PromptPatch({ ...current, ...changes });
        patch(node.id, update, update.prompt !== currentNode().prompt);
      }
    }}
    busy={optimizing}
    retryDisabled={busy && !(run?.status === "waiting" && !!optimization && !step?.comfyAutoGeneration)}
    onOptimize={() => handle(controller.optimizeComfyPrompt(node.id, r2vCounts ?? referenceIds.length))} onRetry={() => handle(controller.retryComfyPrompt(node.id))}
    restoreDisabled={busy} onRestore={async (runId, source) => {
      try {
        await controller.restoreComfyPrompt(node.id, runId, source);
        return true;
      } catch (error) {
        notifyError(error, "工作流操作未完成");
        return false;
      }
    }}
    onFocusPrompt={source => {
      const card = cardElements.current.get(node.id);
      const field = source === "result" && card?.querySelector<HTMLElement>(".h3-prompt-editor textarea");
      (field || card?.querySelector<HTMLElement>('[aria-label="卡片指令"]'))?.focus({ preventScroll: true });
    }}
    onContinue={runId => handle(openOptimizationChat(node.id, runId))} />;
  const running = !!starting || imageRunning || chatBusy || workflowExecuting;
  const footerStatus = statusText ?? (imageRunning ? <GenerationJobProgress jobId={imageActivity.jobId} />
    : workflowExecuting && (!step || step.status === "pending") ? "准备运行"
      : agentChat ? localChatStatusLabel(agentChat.status, agentChat.turnCount)
        : queuedTrigger || triggerExecuting ? run?.status === "waiting" ? "等待继续" : "运行中"
          : step?.status === "pending" && run?.status === "failed" ? "因上游失败未执行"
            : step?.status === "pending" && run?.status === "stopped" ? "已停止，未执行"
              : step?.status === "done" && step.generationSubmission === "submitted" ? "已提交生成"
                : step ? statusLabels[step.status] : node.trigger ? "工作流起点" : "未运行");
  const pinLabel = pinned ? "取消固定并收起" : "固定在画板上";
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
  return <article key={node.id} data-canvas-node={peek ? undefined : ""} data-workflow-card={node.id} data-workflow-peek={peek ? "" : undefined}
    data-workflow-peek-anchor={peek?.anchorId} data-workflow-pinned={pinned ? "" : undefined}
    data-h3-card={h3 || undefined} ref={peek ? undefined : workflowCardRef(node.id)} aria-busy={running} className={`workflow-card ${running ? "canvas-card-running" : imageFailure || failure && !failure.dismissed ? "canvas-card-error" : ""} is-${node.kind} ${localVideo ? "is-generation" : ""} ${selected ? "is-selected" : ""} ${armed ? "is-key-target" : ""}`}
    style={{ left: displayed.x, top: displayed.y, width: workflowCardWidth(node), minHeight: height }}
    onPointerEnter={peek ? () => onPeekInteraction?.("enter") : undefined}
    onPointerLeave={peek ? () => onPeekInteraction?.("leave") : undefined}
    onBlurCapture={peek ? () => onPeekInteraction?.("blur") : undefined}
    onCompositionStartCapture={peek ? () => onPeekInteraction?.("compose") : undefined}
    onCompositionEndCapture={peek ? () => onPeekInteraction?.("commit") : undefined}
    onPointerDownCapture={event => {
      const target = event.target as Element;
      if (target.closest(".workflow-agent-question-float")) { agentDetailPress.current = null; return; }
      agentDetailPress.current = node.kind === "agent" && event.button === 0 && !panReady && !armed
        && !connectionRef.current && !automaticRef.current && !event.ctrlKey && !event.metaKey && !event.shiftKey
        && event.currentTarget.contains(target) && !target.closest("button,input,select,textarea,label,summary,a,[contenteditable],.workflow-prompt-editor,.canvas-card-name")
        ? { nodeId: node.id, x: event.clientX, y: event.clientY } : null;
      if (event.button === 0 && armed && !busy && node.kind !== "planner" && !target.closest(".canvas-card-name,[data-workflow-completion-drag]")) { event.stopPropagation(); event.preventDefault(); patch(node.id, { trigger: true, inputs: { ...node.inputs, signal: [] } }, false); setArmed(false); }
    }}
    onPointerMoveCapture={event => {
      const press = agentDetailPress.current;
      if (press && exceedsCanvasDragThreshold(press, { x: event.clientX, y: event.clientY })) agentDetailPress.current = null;
    }}
    onPointerCancelCapture={() => { agentDetailPress.current = null; }}
    onPointerDown={event => { if (event.button !== 0 || panReady) return; event.stopPropagation(); if (!peek && (!selected || event.ctrlKey || event.metaKey)) onSelect(node.id, event.ctrlKey || event.metaKey); }} onDoubleClick={event => event.stopPropagation()}
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
          const source = assetById.get(ids[0]) ?? (await loadAssets([ids[0]]))[0];
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
    {peek && <span className="workflow-peek-bridge" aria-hidden="true" />}
    {nameEditor(node.id, { left: 0, top: -28, maxWidth: workflowCardWidth(node) - 60 }, busy)}
    {node.inputs.signal?.length ? gearButton(node) : node.trigger && keyButton(node, showKeyProgress)}
    <header data-local-chat-id={conversationId} data-chat-status={agentChat?.status}
      onMouseEnter={event => { if (node.kind === "trigger" && !event.buttons) showProgress(node.id, event.currentTarget, true); }}
      onMouseLeave={() => { if (node.kind === "trigger") setKeyHover(null); }}
      onPointerDown={event => {
        if (creating || peek || (event.target as HTMLElement).closest("button")) return;
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
      {workflowCompletionOutput(node) && <button type="button" className="workflow-completion-drag" data-workflow-completion-drag
        aria-label="拖出上游完成触发卡" title="拖到下游卡片，添加上游完成触发卡" disabled={creating}
        onPointerDown={event => beginCompletionDrag(event, node.id)} onClick={event => event.stopPropagation()}>
        <WindingKey size={15} />
      </button>}
      {(node.kind === "generation" || localVideo) && <WorkflowGenerationHistory node={node} graphNodes={graphNodes} onOpen={onOpenGeneration}
        h3Runs={h3 ? workflowRuns(document) : undefined} />}
      {localImage && <ComfyEnvironmentControl key={state.cloudAuth?.user_id} node={{}} imageMode={references.length ? "edit" : "image"} disabled={busy} onChange={() => {}} />}
      {node.kind === "voice" && <VoiceEnvironmentControl projectId={projectId} onStatusChange={setVoiceIssue} />}
      {node.kind === "comfy-video" && <CardComfyEnvironment node={node} disabled={busy} onChange={changes => patch(node.id, changes, false)} onStatus={reportComfy} />}
      {(peek || pinned) && <button className="workflow-generation-pin" type="button" aria-label={pinLabel} title={pinLabel}
        aria-pressed={pinned} disabled={running} onClick={() => onToggleGenerationPin?.(node.id)}>{pinned ? <PinOff size={14} /> : <Pin size={14} />}</button>}
      <button aria-label="复制卡片" title="复制卡片" disabled={creating} onClick={() => {
        const current = controller.document.nodes.find(card => card.id === node.id);
        if (!current) return;
        const { workflow: [copy] } = cloneCanvasClipboard({ projectId, nodes: [], groups: [], items: [], workflow: [current], selection: [current.id] },
          projectId, current.x + (h3 ? workflowCardWidth(current) + 30 : 350), current.y);
        handle(edit([...controller.document.nodes, { ...copy, trigger: false }])); onSelect(copy.id);
      }}>{h3 ? <CopyPlus size={13} /> : <Copy size={13} />}</button>
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
        }}>{media === "image" ? <Images size={13} aria-hidden="true" /> : <Clapperboard size={13} aria-hidden="true" />}{selected && <span>{media === "image" ? "图片" : "视频"}</span>}</button>)}
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
      {node.kind === "planner" && <WorkflowPlannerCard node={{ ...node, inputs: { ...node.inputs, image: node.inputs.image?.map(input => input.groupId ? { ...input, assetIds: sourceImages(input) ?? [] } : input) ?? [] } }} nodes={document.nodes} graphNodes={graphNodes} runtime={controller.planner} readCurrentPrompt={readCurrentPrompt} onChange={(prompt, promptReferences) => patch(node.id, { prompt, promptReferences })} onLocate={() => { const first = node.planning?.appliedNodes?.[0]; if (first) locateIssue(first.id); }} />}
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
      {node.kind === "voice" && <VoiceCard placedAssetIds={placedAudioAssets} node={node} readCurrentNode={currentNode} projectId={projectId} assets={assets} referenceIds={voiceReferenceIds}
        step={step} busy={busy} runBlocked={!!providerIssue || !!activeWorkflow} patch={changes => patch(node.id, changes)} run={() => handle(controller.start(node.id, true))} />}
      {node.kind === "loop" && <WorkflowLoopCard node={node} items={loopItems} notice={loopInputNotice} busy={busy} run={run}
        runs={workflowRuns(document).filter(entry => entry.loop?.nodeId === node.id)} bindings={bindings} nodes={nodeById} assetById={assetById} onOpenAgent={onOpenAgent}
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
      {localVideo && <ComfyVideoCard node={node} prompt={original} onPromptChange={updateOriginal} modelControl={videoControls}
            disabled={busy} readCurrentPrompt={readCurrentPrompt}
            assetById={assetById} inputImages={h3ReferenceAssets} referencePending={h3ReferencePending}
            videoAudioSourceName={input => {
              const [videoId] = inputImages({ ...input, videoAudio: undefined });
              if (!videoId) return "等待上游素材";
              return assetById.get(videoId)?.name ?? sourceLabel(input).label;
            }}
            onChange={changes => patch(node.id, changes)} optimizationActions={optimizationActions} />}
      {(node.kind === "generation" || node.kind === "agent" && !hasAgentMessages) && <WorkflowPromptEditor fitContent={videoCard || localImage} cardNames={cardNames} node={{ ...node, prompt: original, inputs: { ...node.inputs, image: node.inputs.image?.map(input => input.groupId ? { ...input, assetIds: inputImages(input) } : input) ?? [] } }} nodes={document.nodes} graphNodes={graphNodes} knownAssets={assetById} loadAssets={loadAssets} disabled={busy && !creating} readCurrentPrompt={readCurrentPrompt} onChange={updateOriginal} onUndoConnection={node.kind === "generation" ? () => onUndoGenerationConnection(node.id) : undefined} />}
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
        {h3 && <button onClick={() => handle(copyComfyDiagnostic(failure.diagnostic ? workflowDiagnosticReport(failure.diagnostic) : step?.error ?? "生成失败").then(() => notifySuccess("错误信息已复制")))}>复制错误信息</button>}
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
      {showStaleReview && draft && !draft.paused && h3DraftStale(node, draft) && !h3AutoOptimize && !busy &&
        <div className="h3-run-guard" role="alert"><strong>原文或生成设置已更改，需重新优化提示词</strong>
          <button aria-label="关闭运行确认" onClick={() => setStaleReview(null)}><X size={13} /></button>
          <div><button onClick={() => runCard(node.id, true, false, "optimize")}>先优化再运行</button>
            <button onClick={() => runCard(node.id, true, false, "previous")}>沿用旧优化结果</button>
            <button onClick={() => runCard(node.id, true, false, "original")}>用新原文直出</button></div>
        </div>}
      {node.kind === "loop" && <WorkflowLoopActions run={run?.order.includes(node.id) ? run : undefined} busy={busy} invalid={loopStartInvalid || !!providerIssue}
        retryBlocked={!!retryIssue} restartBlocked={!!restartIssue}
        onStart={() => handle(controller.start(node.id))} onStop={() => handle(controller.stop(run?.id))}
        onContinue={() => handle(controller.continue(run?.id))} onRestart={() => run && handle(controller.restartLoop(run.id))}
        onRetry={() => run && handle(retryLoop(run.id))} />}
      {node.kind !== "loop" && node.kind !== "planner" && (node.kind !== "voice" || busy || activeWorkflow) && (node.kind !== "trigger" || triggerMode === "manual" || queuedTrigger || triggerExecuting || run?.status === "failed")
        && (!hasAgentMessages || (!busy && agentChat?.status !== "idle") || retryDelivery || continueWorkflow) && <footer className={hasAgentMessages ? "workflow-agent-run-footer" : undefined}>
        {h3Status ? <span className="workflow-h3-status" role="status">
          <span className="workflow-h3-status-copy">
            <span>{h3Status}</span>
            {h3Detail && !["生成视频", "正在生成图像", h3Status].includes(h3Detail) && <small>{h3Detail}</small>}
            {!localVideo && h3Status === generatingStatus && imageActivity.jobId && <GenerationJobProgress jobId={imageActivity.jobId} detailFor={h3Status} />}
          </span>
          {h3Progress && <ComfyGenerationProgress progress={h3Progress} />}
        </span> : (running || statusText || !hasAgentMessages || agentChat?.status !== "idle") && <span role={running || statusText ? "status" : undefined}>{footerStatus}</span>}
        {starting && node.kind !== "agent" ? <button title="取消启动" onClick={() => controller.cancelStarting(node.id)}><Square size={13} />停止</button> : imageRunning && imageActivity.jobId && !workflowExecuting ? <button type="button" aria-label="停止生成" onClick={() => useStore.getState().cancelGeneration(imageActivity.jobId)}><Square size={13} />停止</button> : activeWorkflow ? <>
          {retryDelivery && <button onClick={() => handle(controller.continue(activeWorkflow.id))}>重试写入内容卡</button>}
          {continueWorkflow && <button aria-label="继续工作流" onClick={() => handle(controller.continue(activeWorkflow.id))}><Play size={13} />继续</button>}
          {node.kind !== "agent" && <button disabled={stopping || !!step?.comfyStopping} aria-label="停止工作流" title={node.kind === "comfy-video" ? "取消排队或中断本次生成" : "停止工作流"} onClick={() => handle(controller.stop(activeWorkflow.id))}><Square size={12} /></button>}
        </> : node.kind !== "agent" && node.kind !== "trigger" && <>
          {(localVideo || localImage) && <label className="workflow-video-auto-optimize" title="运行前通过 Cloud DSH 优化一次提示词，可能消耗 Bowerbird 积分。" onPointerDown={event => event.stopPropagation()}>
            <input type="checkbox" aria-label="自动优化提示词" checked={h3AutoOptimize} disabled={busy || savingH3Preference} onChange={event => {
              setSavingH3Preference(true);
              void useStore.getState().updateSettings({ h3_auto_optimize_prompt: event.target.checked })
                .catch(error => { console.error("h3.auto_optimize.save_failed", { error }); notifyError(error, "自动优化设置未保存"); })
                .finally(() => setSavingH3Preference(false));
            }} />
            {h3AutoOptimize ? "AUTO" : "自动优化提示词"}
          </label>}
          <button className={h3 ? "h3-run-action" : undefined} disabled={busy || !!providerIssue} aria-label={videoCard || generationAction === "重试" ? generationAction : "运行此卡片"} title={localVideo ? "本机算力·不扣额度" : undefined}
            onClick={() => runCard(node.id, true)}><Play size={13} aria-hidden="true" />{generationCard ? generationAction : "运行此卡片"}</button>
        </>}
        {node.kind === "trigger" && triggerMode === "manual" && <button disabled={creating || !!providerIssue} aria-label="触发下游" onClick={() => handle(controller.start(node.id))}><Play size={13} />触发下游</button>}
        {node.kind === "agent" && !hasAgentMessages && <button type="button" aria-label={stopAgent ? "停止回复" : "运行此卡片"}
          disabled={stopAgent ? stopping || agentChat?.status === "stopping" : busy || !!providerIssue}
          onClick={() => handle(stopAgent ? Promise.resolve(stopAgent()) : handleAgentCard(node, conversationId, "run"))}>
          {stopAgent ? <Square size={13} fill="currentColor" /> : <><Play size={13} />运行</>}
        </button>}
      </footer>}
      {agentChat && hasAgentMessages && <AgentCardConversation key={agentChat.id} summary={agentChat} busy={busy} blocked={!!providerIssue} onStop={stopAgent}
        onRerun={() => handle(handleAgentCard(node, conversationId, "run"))}
        history={agentHistory.length > 1 ? agentHistory : []} runPrompts={agentRunPrompts}
        getCardDefaults={getChatCardDefaults}
        onOpen={(chatId, entryKey) => onOpenAgent(node.id, chatId === agentChat.id && entryKey ? undefined : chatId, entryKey)} />}
      {node.kind === "comfy-video" && run?.status === "stopped" && step?.jobId && !step.comfyCancelled && step.status !== "done" && <button disabled={busy} className="workflow-detail" onClick={() => handle(controller.recoverComfyVideo(run.id, node.id))}>取回上次视频</button>}
      {step?.agentRunId && node.kind === "skill" && <button className="workflow-detail" onClick={() => handle((async () => {
        const run = await api.cloudAgentGet(step.agentRunId!); useStore.getState().openCloudAgentRun(run, { navigate: false }); setAgentOpen(true);
      })())}>查看技能执行 / 审批</button>}
    </div>
    {!peek && (node.kind === "trigger" ? inputPorts.map((port, index) => portButton(node, port, "input", index)) : inputPorts.length > 0 && automaticButton(node.id, "input", busy, activeHandle === "input"))}
    {!peek && (node.kind === "trigger" ? outputPorts.map((port, index) => portButton(node, port, "output", index)) : outputPorts.length > 0 && automaticButton(node.id, "output", creating, activeHandle === "output"))}
  </article>;
});
