import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { isAudioPath } from "../lib/audioMedia";
import { contentInputPort } from "../lib/canvasContentInput";
import { readCanvasNote } from "../lib/canvasNotes";
import { placeCanvasCardNearSource } from "../lib/canvasReferencePlacement";
import { canvasInputValue, canvasWorkflowInputState } from "../lib/canvasSessionOutputs";
import {
  assertWorkflowAcyclic, H3_R2V_INPUT_LIMITS, H3_R2V_INPUT_PORTS, H3_VIDEO_AUDIO_PORT,
  invalidateWorkflow, newWorkflowNode, normalizeWorkflowInputSlots, workflowBindingKey,
  workflowCardWidth, workflowCompletionTarget, workflowConnectionError, workflowInputProducers,
  workflowInputs, workflowOutputs, type CanvasWorkflow, type WorkflowInput,
  type WorkflowKind, type WorkflowNode, type WorkflowPort,
} from "../lib/canvasWorkflow";
import { comfyVideoMode } from "../lib/comfyVideo";
import { notifyError } from "../lib/notify";
import type { Asset, CanvasNode } from "../lib/types";
import { useLatestCallback } from "../lib/useCanvasFrame";
import { readVoiceDraft } from "../lib/voiceStudioDraft";
import { contentCardAcceptsMedia, planAutomaticConnection, type AutomaticOutput } from "../lib/workflowAutoConnect";
import { automaticValueMedia, canvasAutomaticOutputs } from "../lib/workflowCanvasCapabilities";
import { materializeVideoFrameOutput, videoFrameOutputPreview } from "../lib/workflowVideoFrames";
import { isWorkspaceOperationCurrent } from "../lib/workspaceRoute";
import { useStore } from "../store";
import type { DisconnectChoice } from "./WorkflowDisconnectMenu";
import { hasTableWriter, resolveAssetMediaType } from "./workflowLayerBindings";

import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import type { CanvasWorkflowController } from "../lib/canvasWorkflowRuntime";
import { disconnectKey } from "./WorkflowLayerPresentation";
import type { DisconnectTarget, MaterialAnchor, WorkflowLayerProps, WorkflowLayerStore } from "./WorkflowLayerTypes";
export type Connection = WorkflowInput & { type: WorkflowPort["type"] };
export type AutomaticTarget = { nodeId?: string; canvasNodeId?: string; cellId?: string; collapsedAnchorId?: string };
export type PendingConnectionCard = {
  projectId: string; node: WorkflowNode; inputs: WorkflowNode["inputs"]; target: AutomaticTarget; connectionId: string;
};
export type AutomaticGesture = { id: string; side: "input" | "output"; outputs: AutomaticOutput[]; target: AutomaticTarget;
  start: { x: number; y: number }; dragged: boolean; latest?: boolean; scope?: string; trigger?: HTMLElement | null;
  completion?: { pointerId: number; anchor: { x: number; y: number } } };
export type VideoReferencePosition = NonNullable<WorkflowInput["videoFrame"]>["position"];
export const VIDEO_REFERENCE_OPTIONS = [
  { label: "引用完整视频", frame: undefined },
  { label: "引用首帧画面", frame: "first" },
  { label: "引用尾帧画面", frame: "last" },
] as const;
export type VideoReferenceTarget = { output: AutomaticOutput; target: AutomaticTarget; created?: WorkflowNode };
export type ConnectionMenuState = { gesture: AutomaticGesture; x: number; y: number; video?: VideoReferenceTarget };

function singleVideoOutput(outputs: AutomaticOutput[]) {
  const [output] = outputs;
  return outputs.length === 1 && !output.selectionWireId && (output.binding.assetId || output.binding.nodeId && output.binding.portId)
    && (output.media === "video" || Array.isArray(output.media) && output.media.length === 1 && output.media[0] === "video")
    ? output : undefined;
}
export const CONNECTION_CARDS: { label: string; kind: WorkflowKind; media?: "image" | "video"; action?: WorkflowNode["action"] }[] = [
  { label: "图片生成", kind: "generation", media: "image" }, { label: "视频生成", kind: "generation", media: "video" },
  { label: "图片反推", kind: "instruction", action: "describe" }, { label: "复用提示词", kind: "instruction", action: "reuse" },
  { label: "分层拆分", kind: "instruction", action: "layers" }, { label: "Agent", kind: "agent" },
  { label: "视觉规范", kind: "visual-profile" }, { label: "角色声音", kind: "voice" },
];
function connectionForType(source: Connection, type?: WorkflowPort["type"]): Connection {
  return ["*latest", "*latest-image"].includes(source.cellId ?? "") && (type === "text" || type === "image")
    ? { ...source, cellId: type === "image" ? "*latest-image" : "*latest", type } : source;
}
interface GestureOptions {
  selectedConversationOutputs: ReadonlyMap<string, { id: string; video: boolean; }> | undefined;
  controller: CanvasWorkflowController;
  graphNodes: CanvasNode[];
  materials: MaterialAnchor[];
  assets: Asset[];
  conversationCards: WorkflowLayerProps["conversationCards"];
  generationAnchorOwners: Map<string, string>;
  collapsedAnchorOwners: Map<string, string>;
  activeGenerationIds: ReadonlySet<string>;
  collapsedAnchor: (id: string) => CanvasNode | undefined;
  nodeById: Map<string, WorkflowNode>;
  panReady: boolean;
  toBoardPoint: (clientX: number, clientY: number) => { x: number; y: number; };
  graphById: Map<string, CanvasNode>;
  cardPoint: (id: string, side: "output" | "input") => { x: number; y: number; owner: string; selected: boolean; } | null;
  visibleGraphNodes: CanvasNode[];
  sessionHeights: ReadonlyMap<string, number> | undefined;
  renderedNodes: WorkflowNode[];
  displayPoint: (node: WorkflowNode) => WorkflowNode | { x: number; y: number; };
  cardHeights: MutableRefObject<Map<string, number>>;
  activeController: MutableRefObject<CanvasWorkflowController | null>;
  projectId: string;
  handle: (promise: Promise<unknown>) => void;
  provisional: boolean;
  ensureMaterialized: () => Promise<unknown>;
  onEdited: (before: CanvasWorkflow, after: CanvasWorkflow, connectedGenerationId?: string | undefined) => void;
  onSelect: (id: string, additive?: boolean | undefined) => void;
  materialById: Map<string, MaterialAnchor>;
  materialByAsset: Map<string, MaterialAnchor>;
  generationCardAnchors: ReadonlyMap<string, CanvasNode> | undefined;
  generationCardOrigins: ReadonlyMap<string, WorkflowNode>;
  pendingCards: MutableRefObject<Map<string, PendingConnectionCard>>;
  redraw: Dispatch<SetStateAction<number>>;
  onConnectCollapsedGeneration: (nodeId: string, anchorId: string) => void;
  currentSelection: MutableRefObject<Set<string>>;
  inputImages: (input: WorkflowInput) => string[];
  sourceLabel: (binding: WorkflowInput) => { label: string; detail: string; };
  inputMediaLabel: (binding: WorkflowInput) => "图片" | "素材" | "音频" | "视频";
  edit: (nodes: WorkflowNode[], draftNodeId?: string | undefined, editorOnly?: boolean) => Promise<void>;
  patch: (id: string, update: Partial<WorkflowNode>, invalidate?: boolean) => void;
  state: WorkflowLayerStore;
  h3ReferenceAssets: (input: WorkflowInput, media?: "image" | "video" | "audio" | undefined) => string[];
  document: CanvasWorkflow;
  wireElement: RefObject<SVGSVGElement>;
}

export function useWorkflowConnectionGesture({
  selectedConversationOutputs, controller, graphNodes, materials, assets, conversationCards,
  generationAnchorOwners, collapsedAnchorOwners, activeGenerationIds, collapsedAnchor, nodeById, panReady,
  toBoardPoint, graphById, cardPoint, visibleGraphNodes, sessionHeights, renderedNodes, displayPoint,
  cardHeights, activeController, projectId, handle, provisional, ensureMaterialized, onEdited, onSelect,
  materialById, materialByAsset, generationCardAnchors, generationCardOrigins, pendingCards, redraw,
  onConnectCollapsedGeneration, currentSelection, inputImages, sourceLabel, inputMediaLabel, edit, patch,
  state, h3ReferenceAssets, document, wireElement,
}: GestureOptions) {
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
  const [disconnectMenu, setDisconnectMenu] = useState<({ x: number; y: number } & DisconnectTarget) | null>(null);
  const hoveredMaterialRef = useRef<string | null>(null);
  const hoveredHotspot = useRef<Element | null>(null);
  const hoveredMaterial = hoveredMaterialRef.current;
  const resetConnection = useLatestCallback(() => {
    connectionRef.current = null;
    setConnection(null);
    clearAutomatic();
  });
  useEffect(() => {
    resetConnection();
    setArmed(false);
    setBlankCardMenu(null);
    setDisconnectMenu(null);
    swallowAutomaticClick.current = false;
    hoveredHotspot.current?.classList.remove("is-hovered");
    hoveredMaterialRef.current = null;
    hoveredHotspot.current = null;
  }, [projectId, resetConnection]);
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

  function lockedOutput(outputs: AutomaticOutput[], extractFrame = false) {
    return outputs.some(({ binding }) => [binding.nodeId, binding.canvasNodeId, binding.assetNodeId,
      ...workflowInputProducers(controller.document.nodes, binding)]
      .some(id => id && (extractFrame ? controller.isLocked(id) : controller.isWriteLocked(id))));
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
    if (cell && hasTableWriter(controller.document.nodes, card.id, cell.id, node => !compatible.some(output => Object.values(node.inputs).flat().some(input => workflowBindingKey(input) === workflowBindingKey(output.binding))))) return "此位置已有输入，请先断开原连接";
    return null;
  }
  function videoReferenceError(video: VideoReferenceTarget, frame?: VideoReferencePosition) {
    if (frame && (video.created ?? nodeById.get(video.target.nodeId ?? ""))?.kind === "trigger") return "此输入只接收完成信号";
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
    const error = receiverError(outputs, target, created);
    if (error) { clearAutomatic(); notifyError(null, error); return; }
    const video = singleVideoOutput(outputs);
    if (video) {
      setConnectionMenu({ gesture, ...point, video: { output: video, target, created } });
      connectionHoverRef.current = null; setConnectionHover(null);
    } else commitAutomatic(outputs, target, created ? [created] : []);
  }
  function commitAutomatic(outputs: AutomaticOutput[], target: AutomaticTarget, createNodes: WorkflowNode[] = [], frame?: VideoReferencePosition) {
    clearAutomatic();
    if (target.collapsedAnchorId) {
      const error = frame ? videoReferenceError({ output: outputs[0], target }, frame) : automaticError(outputs, target);
      if (error) { notifyError(null, error); return; }
    }
    if (frame && outputs[0].binding.nodeId) {
      outputs = [videoFrameOutputPreview(outputs[0], frame)];
      frame = undefined;
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
    if (!frame) publishPending(outputs);
    handle((async () => {
      try {
        // Native endpoints may still be in the canvas journal. Workflow-only edits use their own queue.
        if (frame || provisional || !target.nodeId || target.collapsedAnchorId || outputs.some(({ binding }) =>
          !binding.nodeId || binding.canvasNodeId || binding.assetNodeId || binding.groupId)) await ensureMaterialized();
        if (!sameRoute()) return;
        if (frame) {
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
          if (target.nodeId && !created && !planAutomaticConnection(controller.document.nodes, [preview], target.nodeId,
            target.collapsedAnchorId ? generationCardOrigins : undefined).bindings.length) return;
          try {
            outputs = [await materializeVideoFrameOutput(projectId, source, frame, sameRoute)];
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
    const media = automaticValueMedia(value, assets, hasTableWriter(controller.document.nodes, card.id, cellId));
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
    const r2vLimit = node.kind === "comfy-video" && comfyVideoMode(node.comfyVideo) === "r2v" ? H3_R2V_INPUT_LIMITS[inputId] : undefined;
    const r2vMedia = r2vLimit ? (Object.keys(H3_R2V_INPUT_PORTS) as (keyof typeof H3_R2V_INPUT_PORTS)[])
      .find(media => H3_R2V_INPUT_PORTS[media] === inputId) : undefined;
    if (node.kind === "comfy-video" && port?.type === "image") {
      const audioPort = inputId === H3_VIDEO_AUDIO_PORT;
      const ids = inputImages(r2vMedia || audioPort ? { ...binding, mediaFilter: [r2vMedia ?? "audio"] } : binding);
      const media = ids.map(id => resolveAssetMediaType(id, materialByAsset, assets));
      const producerMedia = source.nodeId && automaticOutputs(source.nodeId).find(output => output.binding.portId === source.portId)?.media;
      const knownMedia = media.length && media.every(Boolean) ? media : !media.length && producerMedia ? [producerMedia].flat() : [];
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
    if (r2vLimit && (connected.length > r2vLimit || connected.flatMap(input => h3ReferenceAssets(input, r2vMedia)).length > r2vLimit)) {
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
  const finishAutomatic = (event: globalThis.PointerEvent, gesture: AutomaticGesture) => {
    const element = window.document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const id = connectionCardId(element);
    if (id === gesture.id && element?.closest(".canvas-connection-handle,[data-workflow-input='completion']")) {
      setConnectionMenu({ gesture, x: event.clientX, y: event.clientY });
    } else if (id === gesture.id) {
      clearAutomatic(); notifyError(null, "不能连接卡片自身");
    } else if (id) {
      chooseAutomaticReceiver(gesture, gestureOutputs(gesture, id), gesture.side === "output" ? automaticTarget(id) : gesture.target,
        { x: event.clientX, y: event.clientY });
    } else if (element?.closest(".canvas-stage") && !element.closest(".canvas-toolbar,.canvas-creation-dock,[role=menu]")) {
      setCursor({ x: event.clientX, y: event.clientY });
      setConnectionMenu({ gesture, x: event.clientX, y: event.clientY });
    } else clearAutomatic();
  };
  const move = useLatestCallback((event: globalThis.PointerEvent) => {
    const gesture = automaticRef.current;
    if (gesture?.completion && gesture.completion.pointerId !== event.pointerId) return;
    if (armed || connectionRef.current || gesture && !connectionMenu) setCursor({ x: event.clientX, y: event.clientY });
    if (gesture && !connectionMenu) {
      if (event.buttons === 0) { clearAutomatic(); return; }
      const dragging = gesture.dragged || Math.hypot(event.clientX - gesture.start.x, event.clientY - gesture.start.y) > 5;
      if (!gesture.dragged && dragging) startAutomaticDrag(gesture);
      const element = window.document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const id = connectionCardId(element);
      const completion = dragging && gesture.completion ? completionDropTarget(element, gesture.id) : null;
      const next = gesture.completion ? completion && { id: completion.shownId, error: completion.error }
        : dragging && id && id !== gesture.id ? { id, error: receiverError(gestureOutputs(gesture, id),
          gesture.side === "output" ? automaticTarget(id) : gesture.target) } : null;
      if (next?.id !== connectionHoverRef.current?.id || next?.error !== connectionHoverRef.current?.error) {
        connectionHoverRef.current = next; setConnectionHover(next);
      }
    } else if (connectionRef.current && connectionRef.current.type !== "signal") {
      const id = connectionCardId(window.document.elementFromPoint(event.clientX, event.clientY));
      const target = id ? automaticTarget(id) : undefined;
      const next = id && target?.collapsedAnchorId ? { id, error: receiverError([directAutomaticOutput(connectionRef.current)], target) } : null;
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
  });
  const end = useLatestCallback((event: globalThis.PointerEvent) => {
    if (event.button !== 0) return;
    const gesture = automaticRef.current;
    if (gesture && !connectionMenu) {
      if (gesture.completion && gesture.completion.pointerId !== event.pointerId) return;
      window.clearTimeout(automaticPressTimer.current);
      swallowAutomaticClick.current = true;
      if (gesture.completion) {
        clearAutomatic();
        if (!gesture.dragged) return;
        const target = completionDropTarget(window.document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null, gesture.id);
        if (target?.error) notifyError(null, target.error);
        else if (target) commitCompletionDrag(gesture.id, target.id, gesture.completion.anchor);
      } else if (!gesture.dragged) setConnectionMenu({ gesture, x: event.clientX, y: event.clientY });
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
    const element = window.document.elementFromPoint(event.clientX, event.clientY);
    const id = connectionCardId(element);
    const target = id ? automaticTarget(id) : undefined;
    const point = { x: event.clientX, y: event.clientY };
    if (target?.collapsedAnchorId) connectAutomaticDraft(connectionRef.current, target, point);
    else {
      const input = element?.closest<HTMLElement>("[data-workflow-input]");
      if (input) connect(input.dataset.workflowNode!, input.dataset.workflowInput!, point);
      connectionHoverRef.current = null; setConnectionHover(null);
    }
  });
  const cancelAutomatic = useLatestCallback(clearAutomatic);
  useEffect(() => {
    const down = () => { swallowAutomaticClick.current = false; };
    const click = (event: MouseEvent) => {
      if (!swallowAutomaticClick.current) return;
      swallowAutomaticClick.current = false;
      if (event.detail === 0) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { resetConnection(); setArmed(false); } };
    const cancel = () => { swallowAutomaticClick.current = false; resetConnection(); };
    const wheel = (event: WheelEvent) => { if (!(event.target instanceof Element && event.target.closest("[data-context-owner]"))) cancelAutomatic(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", down, true); window.addEventListener("click", click, true);
    window.addEventListener("pointercancel", cancel); window.addEventListener("blur", cancel); window.addEventListener("wheel", wheel, true);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("keydown", key);
      window.removeEventListener("pointerdown", down, true); window.removeEventListener("click", click, true);
      window.removeEventListener("pointercancel", cancel); window.removeEventListener("blur", cancel); window.removeEventListener("wheel", wheel, true); };
  }, [move, end, resetConnection, cancelAutomatic]);
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
    let releaseTimer: number | undefined;
    const reset = () => { window.clearTimeout(releaseTimer); cancelledByRightClick = false; };
    const cancelRightClick = (event: MouseEvent) => {
      if (!connectionRef.current && !automaticRef.current && !cancelledByRightClick) return;
      cancelledByRightClick = true;
      event.preventDefault(); event.stopPropagation();
      resetConnection();
    };
    const down = (event: MouseEvent) => {
      if (event.button !== 2) { reset(); return; }
      cancelRightClick(event);
    };
    // Cancelling the first pointerdown can suppress compatibility mousedown;
    // a second button then arrives as pointermove with the right-button bit set.
    const chord = (event: globalThis.PointerEvent) => { if (event.buttons & 2) cancelRightClick(event); };
    const context = (event: MouseEvent) => {
      if (!connectionRef.current && !cancelledByRightClick) return;
      event.preventDefault(); event.stopPropagation();
      reset();
      resetConnection();
    };
    const up = (event: globalThis.PointerEvent) => {
      if (!cancelledByRightClick || event.buttons & 2) return;
      // Some native WebViews dispatch contextmenu after releasing the button.
      window.clearTimeout(releaseTimer);
      releaseTimer = window.setTimeout(reset, 0);
    };
    // A second mouse button during a left-button drag emits mousedown, not pointerdown.
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", chord, true);
    window.addEventListener("mousedown", down, true);
    window.addEventListener("contextmenu", context, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", reset, true);
    window.addEventListener("blur", reset);
    return () => {
      reset();
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", chord, true);
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("contextmenu", context, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", reset, true);
      window.removeEventListener("blur", reset);
    };
  }, [projectId, resetConnection]);

  return {
    addCard, armed, automatic, automaticOutputs, automaticRef, automaticTarget, beginAutomatic,
    beginCompletionDrag, blankCardMenu, cardMenu, chooseAutomaticReceiver, chooseDisconnect,
    clearAutomatic, commitAutomatic, connect, connectSignal, connection, connectionCard, connectionHover,
    connectionMenu, connectionRef, createConnected, cursor, disconnectAutomatic, disconnectChoices,
    disconnectMenu, gestureOutputs, hoveredMaterial, inputText, newConnectionError, receiverError,
    selectConnectionScope, setArmed, setBlankCardMenu, setConnection, setCursor, setDisconnectMenu,
    updateCursor, videoConnection, videoReferenceError,
  };
}
