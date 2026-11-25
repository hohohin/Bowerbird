import { useEffect, useRef } from "react";
import { readCanvasNote } from "../lib/canvasNotes";
import { newWorkflowNode, type WorkflowNode } from "../lib/canvasWorkflow";
import type { CanvasWorkflowController } from "../lib/canvasWorkflowRuntime";
import { notifyError } from "../lib/notify";
import type { CanvasNode } from "../lib/types";
import type { AutomaticOutput } from "../lib/workflowAutoConnect";
import type { AutomaticGesture, AutomaticTarget, Connection, ConnectionMenuState } from "./WorkflowLayerTypes";
import type { VideoReferenceMode } from "./WorkflowConnectionMenu";

export function singleVideoOutput(outputs: AutomaticOutput[]) {
  const [output] = outputs;
  return outputs.length === 1 && !output.selectionWireId && (output.binding.assetId || output.binding.nodeId && output.binding.portId)
    && (output.media === "video" || Array.isArray(output.media) && output.media.length === 1 && output.media[0] === "video")
    ? output : undefined;
}

interface WorkflowConnectionGestureBindings {
  armed: boolean;
  automaticPressTimer: React.MutableRefObject<number>;
  automaticRef: React.MutableRefObject<AutomaticGesture | null>;
  automaticTarget: (id: string) => AutomaticTarget;
  chooseAutomaticReceiver: (gesture: AutomaticGesture, outputs: AutomaticOutput[], target: AutomaticTarget, point: { x: number; y: number; }, created?: WorkflowNode) => void;
  clearAutomatic: () => void;
  commitAutomatic: (outputs: AutomaticOutput[], target: AutomaticTarget, createNodes?: WorkflowNode[], mode?: VideoReferenceMode) => void;
  commitCompletionDrag: (sourceId: string, targetId: string, anchor: { x: number; y: number; }) => void;
  completionDropTarget: (element: HTMLElement | null, sourceId: string) => { id: string; shownId: string; error: string | null; } | null;
  connect: (toId: string, inputId: string, point?: { x: number; y: number }) => void;
  connectionCardId: (element: Element | null) => string | undefined;
  connectAutomaticDraft: (draft: Connection, target: AutomaticTarget, point: { x: number; y: number }) => void;
  directAutomaticOutput: (draft: Connection) => AutomaticOutput;
  connectionHoverRef: React.MutableRefObject<{ id: string; error: string | null; } | null>;
  connectionMenu: ConnectionMenuState | null;
  connectionRef: React.MutableRefObject<Connection | null>;
  connectSignal: (targetId: string, native?: boolean) => void;
  controller: CanvasWorkflowController;
  edit: (nodes: WorkflowNode[], draftNodeId?: string, editorOnly?: boolean) => Promise<void>;
  ensureMaterialized: () => Promise<unknown>;
  gestureOutputs: (gesture: AutomaticGesture, otherId: string) => AutomaticOutput[];
  graphNodes: CanvasNode[];
  handle: (promise: Promise<unknown>) => void;
  hoveredHotspot: React.MutableRefObject<Element | null>;
  hoveredMaterialRef: React.MutableRefObject<string | null>;
  inputText: (nodeId: string, cellId?: string, disconnect?: boolean, inputType?: "text" | "image" | "auto", point?: { x: number; y: number; }, keyboard?: boolean) => void;
  onSelect: (id: string, additive?: boolean) => void;
  receiverError: (outputs: AutomaticOutput[], target: AutomaticTarget, created?: WorkflowNode) => string | null;
  setArmed: React.Dispatch<React.SetStateAction<boolean>>;
  setConnection: React.Dispatch<React.SetStateAction<Connection | null>>;
  setConnectionHover: React.Dispatch<React.SetStateAction<{ id: string; error: string | null; } | null>>;
  setConnectionMenu: React.Dispatch<React.SetStateAction<ConnectionMenuState | null>>;
  setCursor: (point: { x: number; y: number; }) => void;
  startAutomaticDrag: (gesture: AutomaticGesture) => void;
  swallowAutomaticClick: React.MutableRefObject<boolean>;
  toBoardPoint: (clientX: number, clientY: number) => { x: number; y: number; };
  wireElement: React.RefObject<SVGSVGElement>;
}

function gestureHandlers({
  armed, automaticPressTimer, automaticRef, automaticTarget, chooseAutomaticReceiver, clearAutomatic, commitAutomatic,
  commitCompletionDrag, completionDropTarget, connect, connectionHoverRef, connectionMenu, connectionRef, connectSignal,
  connectionCardId, connectAutomaticDraft, directAutomaticOutput, controller, edit, ensureMaterialized, gestureOutputs, graphNodes, handle, hoveredHotspot,
  hoveredMaterialRef, inputText, onSelect, receiverError, setArmed, setConnection, setConnectionHover,
  setConnectionMenu, setCursor, startAutomaticDrag, swallowAutomaticClick, toBoardPoint, wireElement,
}: WorkflowConnectionGestureBindings) {
  const finishAutomatic = (event: globalThis.PointerEvent, gesture: AutomaticGesture) => {
    const element = window.document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const id = connectionCardId(element);
    if (id === gesture.id && element?.closest(".canvas-connection-handle,[data-workflow-input='completion']")) {
      setConnectionMenu({ gesture, x: event.clientX, y: event.clientY });
    } else if (id) {
      const outputs = gestureOutputs(gesture, id);
      const receiver = gesture.side === "output" ? automaticTarget(id) : gesture.target;
      const error = id === gesture.id ? "不能连接卡片自身" : receiverError(outputs, receiver);
      if (error && (id === gesture.id || !singleVideoOutput(outputs))) { clearAutomatic(); notifyError(null, error); }
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
    }
    const draft = connectionRef.current;
    if (!gesture && draft && draft.type !== "signal") {
      const id = connectionCardId(window.document.elementFromPoint(event.clientX, event.clientY));
      const receiver = id ? automaticTarget(id) : undefined;
      const next = id && receiver?.collapsedAnchorId ? { id, error: receiverError([directAutomaticOutput(draft)], receiver) } : null;
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
    const input = element?.closest<HTMLElement>("[data-workflow-input]");
    const id = connectionCardId(element);
    const receiver = id ? automaticTarget(id) : undefined;
    const point = { x: event.clientX, y: event.clientY };
    if (receiver?.collapsedAnchorId) connectAutomaticDraft(connectionRef.current, receiver, point);
    else if (input) connect(input.dataset.workflowNode!, input.dataset.workflowInput!, point);
    connectionHoverRef.current = null; setConnectionHover(null);
  };
  const cancel = () => {
    swallowAutomaticClick.current = false;
    connectionRef.current = null;
    setConnection(null);
    setArmed(false);
    clearAutomatic();
  };
  const key = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
  const wheel = (event: WheelEvent) => { if (!(event.target instanceof Element && event.target.closest("[data-context-owner]"))) clearAutomatic(); };
  return { move, end, key, down, click, cancel, wheel };
}

export function useWorkflowConnectionGesture(bindings: WorkflowConnectionGestureBindings) {
  const current = gestureHandlers(bindings);
  const handlers = useRef(current);
  handlers.current = current;
  useEffect(() => {
    const move = (event: PointerEvent) => handlers.current.move(event);
    const end = (event: PointerEvent) => handlers.current.end(event);
    const key = (event: KeyboardEvent) => handlers.current.key(event);
    const down = () => handlers.current.down();
    const click = (event: MouseEvent) => handlers.current.click(event);
    const cancel = () => handlers.current.cancel();
    const wheel = (event: WheelEvent) => handlers.current.wheel(event);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("click", click, true);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("wheel", wheel, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("keydown", key);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("click", click, true);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("wheel", wheel, true);
    };
  }, []);
}
