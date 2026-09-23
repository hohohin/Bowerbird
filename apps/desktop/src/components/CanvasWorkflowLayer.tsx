import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { GripHorizontal, Play, Square, X, Copy, ImagePlus } from "lucide-react";
import { api } from "../lib/api";
import { canvasAssetMediaPath } from "../lib/creativeCanvas";
import { readCanvasNote } from "../lib/canvasNotes";
import { canvasInputValue, workflowSessionIds } from "../lib/canvasSessionOutputs";
import { useStore } from "../store";
import { getDragAssets } from "../lib/dragPayload";
import { notifyError, notifySuccess } from "../lib/notify";
import { canvasWorkflowController } from "../lib/canvasWorkflowRuntime";
import { workflowDiagnosticReport } from "../lib/workflowDiagnostics";
import { workflowBindingKey } from "../lib/canvasWorkflow";
import { invalidateWorkflow, newWorkflowNode, workflowNodeRun, workflowRuns, workflowInputProducers, workflowConnectionError, workflowInputs, workflowOutputs,
  workflowPortY, workflowTitle, WORKFLOW_CARD_WIDTH, WORKFLOW_SKILLS, type WorkflowInput, type WorkflowKind, type WorkflowNode, type WorkflowPort } from "../lib/canvasWorkflow";
import type { Asset, CanvasNode, VisualProfileSummary } from "../lib/types";
import { ProviderSelect } from "./creation/ProviderSelect";
import { RatioSelect } from "./creation/RatioSelect";
import { CloudAgentSession } from "./CloudAgentPanel";
import { ModalShell } from "./ModalShell";
import { WorkflowPromptEditor } from "./WorkflowPromptEditor";
import { WorkflowDescribeOption } from "./WorkflowDescribeOption";
import { WorkflowGenerationHistory } from "./WorkflowGenerationHistory";
import "./CanvasWorkflow.css";

export function WindingKey({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 10C9 2 2 4 3 8s6 5 9 2Zm0 0c3-8 10-6 9-2s-6 5-9 2ZM12 10v10m-3 0h6m-3-4h3" />
  </svg>;
}
export interface WorkflowGeometry { id: string; x: number; y: number; width: number; height: number }
export interface WorkflowLayerHandle {
  inputText: (nodeId: string, cellId?: string, disconnect?: boolean, type?: "text" | "image") => void;
  connectCell: (nodeId: string, cellId: string, clientX: number, clientY: number) => void;
  add: (kind: WorkflowKind, x: number, y: number) => void; arm: (x?: number, y?: number) => void;
  bounds: () => WorkflowGeometry[];
  position: (positions: ReadonlyMap<string, { x: number; y: number }>, persist?: boolean) => void;
  isLocked: (id: string) => boolean;
}
export interface MaterialAnchor { id: string; assetId?: string; groupId?: string; assetIds?: string[]; x: number; y: number; width: number; height: number }
interface Props {
  graphNodes: CanvasNode[];
  selectedIds: Set<string>;
  panReady: boolean;
  onSelect: (id: string, additive?: boolean) => void;
  onNodesChanged: () => void;
  onOpenGeneration: (node: CanvasNode) => void;
  onDragStart: (event: React.PointerEvent<HTMLElement>, node: WorkflowNode) => void;
  onDragMove: (event: React.PointerEvent<HTMLElement>) => void;
  onDragEnd: (event: React.PointerEvent<HTMLElement>, cancelled?: boolean) => void;
  onNodeMenu: (event: React.MouseEvent<HTMLElement>, id: string) => void;
  projectId: string; zoom: number; materials: MaterialAnchor[];
  ensureMaterialized: () => Promise<unknown>;
  toBoardPoint: (clientX: number, clientY: number) => { x: number; y: number };
  onPlaced: (rect: { x: number; y: number; width: number; height: number }) => void;
}
type Connection = WorkflowInput & { type: WorkflowPort["type"] };
export const CanvasWorkflowLayer = forwardRef<WorkflowLayerHandle, Props>(function CanvasWorkflowLayer({ projectId, zoom, materials, graphNodes, ensureMaterialized, toBoardPoint, onPlaced, selectedIds, panReady, onSelect, onNodesChanged, onOpenGeneration, onDragStart, onDragMove, onDragEnd, onNodeMenu }, ref) {
  const controller = useMemo(() => canvasWorkflowController(projectId), [projectId]);
  const [, redraw] = useState(0);
  // Cell sockets are measured from the committed table layout, including row/column resizing.
  useLayoutEffect(() => { redraw(value => value + 1); }, [graphNodes, zoom]);
  const cardElements = useRef(new Map<string, HTMLElement>());
  const nodesChanged = useRef(onNodesChanged); nodesChanged.current = onNodesChanged;
  const [armed, setArmed] = useState(false);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [connection, setConnection] = useState<Connection | null>(null);
  const connectionRef = useRef(connection); connectionRef.current = connection;
  const [assets, setAssets] = useState<Asset[]>([]);
  const [agentOpen, setAgentOpen] = useState(false);
  const [keyHover, setKeyHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [profiles, setProfiles] = useState<VisualProfileSummary[]>([]);
  const [hoveredMaterial, setHoveredMaterial] = useState<string | null>(null);
  const state = useStore();
  const document = controller.document;
  const sessionIds = workflowSessionIds(document.nodes);
  const issue = controller.issue;
  const nodeDiagnostic = (nodeId: string) => {
    if (issue?.nodeId === nodeId) return issue;
    const run = workflowNodeRun(document, nodeId), step = run?.steps[nodeId];
    return step?.status === "failed" ? step.diagnostic : undefined;
  };
  const issueSourceId = issue?.source?.nodeId ?? issue?.source?.canvasNodeId ?? issue?.source?.assetNodeId;
  const issueSourceLabel = (() => {
    if (!issue?.source) return "";
    const sourceNode = document.nodes.find(node => node.id === issueSourceId);
    if (sourceNode) return workflowTitle(sourceNode);
    const source = graphNodes.find(node => node.id === issueSourceId && node.hiddenAt == null);
    if (source?.kind === "note") {
      const note = readCanvasNote(source), cellId = issue.source.cellId;
      const row = note.cells.findIndex(row => row.some(cell => cell.id === cellId));
      const column = row >= 0 ? note.cells[row].findIndex(cell => cell.id === cellId) : -1;
      return `${note.title || "内容卡片"} · ${row >= 0 ? `第 ${row + 1} 行，第 ${column + 1} 列` : cellId === "*" ? "全部图片" : cellId === "*text" ? "全部文本" : "目标单元格已删除"}`;
    }
    return issue.source.canvasNodeId ? "来源内容卡片当前不可定位" : "";
  })();
  const locateIssue = (id: string) => {
    const workflow = document.nodes.find(node => node.id === id);
    const tableId = workflow?.textTarget?.nodeId ?? workflow?.textSource;
    const table = graphNodes.find(node => node.id === (tableId ?? id) && node.hiddenAt == null);
    if (table) { onSelect(table.id); onPlaced(table); }
    else if (workflow) { onSelect(workflow.id); onPlaced({ ...workflow, width: WORKFLOW_CARD_WIDTH, height: cardElements.current.get(id)?.offsetHeight ?? 400 }); }
  };
  const inputImages = (input: WorkflowInput): string[] => {
    if (input.groupId) return materials.find(item => item.groupId === input.groupId)?.assetIds ?? [];
    if (input.assetId) return [input.assetId];
    if (input.canvasNodeId) {
      const card = graphNodes.find(node => node.id === input.canvasNodeId && node.hiddenAt == null);
      return card ? canvasInputValue(card, input.cellId ?? "", graphNodes)?.assetIds ?? [] : [];
    }
    return document.nodes.find(node => node.id === input.nodeId)?.outputs[input.portId ?? ""]?.assetIds ?? [];
  };

  const handle = (promise: Promise<unknown>) => { void promise.catch(error => notifyError(error, "工作流操作未完成")); };
  useEffect(() => { const unsubscribe = controller.subscribe(() => { redraw(value => value + 1); nodesChanged.current(); }); void controller.load(); return unsubscribe; }, [controller]);
  useEffect(() => { handle(controller.load().then(() => controller.syncCanvasReferences(graphNodes))); }, [controller, graphNodes]);
  useEffect(() => { setConnection(null); setArmed(false); setAgentOpen(false); }, [projectId]);
  useEffect(() => {
    let alive = true;
    void api.visualProfileList(null).then(list => { if (alive) setProfiles(list.filter(p => p.status === "confirmed")); }).catch(() => {});
    return () => { alive = false; };
  }, [state.visualProfiles, projectId]);
  const assetKey = [...new Set(document.nodes.flatMap(node => [
    ...Object.values(node.inputs).flat().flatMap(inputImages),
    ...Object.values(node.outputs).flatMap(output => output.assetIds ?? []),
  ]))].sort().join("|");
  useEffect(() => {
    let current = true;
    void api.getAssetsByIds(assetKey ? assetKey.split("|") : []).then(value => { if (current) setAssets(value); }).catch(() => {});
    return () => { current = false; };
  }, [assetKey]);

  function patch(id: string, update: Partial<WorkflowNode>, invalidate = true) {
    const nodes = controller.document.nodes.map(node => node.id === id ? { ...node, ...update } : node);
    handle(controller.edit(invalidate ? invalidateWorkflow(nodes, id) : nodes).then(() => controller.syncCanvasReferences(graphNodes)));
  }
  function connect(toId: string, inputId: string) {
    const source = connectionRef.current;
    if (!source || controller.isLocked(toId)) return;
    const nodes = controller.document.nodes;
    const node = nodes.find(node => node.id === toId)!;
    const port = workflowInputs(node).find(port => port.id === inputId);
    const producers = workflowInputProducers(nodes, source);
    const error = producers.map(producer => workflowConnectionError(nodes, producer, source.portId ?? source.type, toId, inputId)).find(Boolean)
      ?? (port?.type !== source.type ? "只能连接相同类型的端口" : null);
    if (error) { notifyError(null, error); return; }
    const { type: _type, ...binding } = source;
    const current = node.inputs[inputId] ?? [];
    if (current.some(input => binding.groupId ? input.groupId === binding.groupId : JSON.stringify(input) === JSON.stringify(binding))) { setConnection(null); connectionRef.current = null; return; }
    if (node.kind === "visual-profile" && node.profileId) { notifyError(null, "请先切换到从输入提炼"); return; }
    patch(toId, { inputs: { ...node.inputs, [inputId]: (node.kind === "instruction" && node.action !== "describe") || inputId === "visual-profile" ? [binding] : [...current, binding] } });
    setConnection(null); connectionRef.current = null;
  }
  function connectSignal(targetId: string, native = false) {
    const source = connectionRef.current;
    if (source?.type !== "signal" || !source.nodeId || controller.isLocked(source.nodeId)) return;
    const nodes = controller.document.nodes;
    const card = native && graphNodes.find(node => node.id === targetId && node.kind === "note" && node.hiddenAt == null && ["text", "images"].includes(readCanvasNote(node).note_type));
    const target = native ? nodes.find(node => node.textSource === targetId) ?? (card ? { ...newWorkflowNode("text", card.x, card.y, ""), textSource: targetId } : null) : nodes.find(node => node.id === targetId);
    if (!target || controller.isLocked(target.id)) return;
    const candidates = nodes.some(node => node.id === target.id) ? nodes : [...nodes, target];
    const error = workflowConnectionError(candidates, source.nodeId, "signal", target.id, "signal");
    if (error) { notifyError(null, error); return; }
    const inputs = target.inputs.signal ?? [];
    if (!inputs.some(input => input.nodeId === source.nodeId)) handle(controller.edit(candidates.map(node => node.id === target.id ? { ...node, trigger: false, inputs: { ...node.inputs, signal: [...inputs, { nodeId: source.nodeId, portId: "signal" }] } } : node)));
    setConnection(null); connectionRef.current = null;
  }
  function inputText(nodeId: string, cellId?: string, disconnect = false, inputType?: "text" | "image") {
    const source = connectionRef.current;
    if (!disconnect && source) {
      if (inputType && source.type !== inputType) { notifyError(null, "此端口接收图片"); return; }
      if (source.type !== "image" && source.type !== "text") { notifyError(null, "文本卡片只接收文本或图片"); return; }
      const { type, ...binding } = source;
      setConnection(null); connectionRef.current = null;
      handle(controller.bindTextInput(nodeId, cellId, binding, type));
      return;
    }
    if (!disconnect) return;
    const writers = document.nodes.filter(node => node.textTarget?.nodeId === nodeId && (cellId ? node.textTarget.cellId === cellId || node.textTarget.cellIds?.includes(cellId) : node.textTarget.append) && (!inputType || !!node.inputs[inputType]?.length));
    const producer = !cellId && document.nodes.find(node => node.resultNodeIds?.includes(nodeId));
    if (writers.some(node => controller.isLocked(node.id)) || (producer && controller.isLocked(producer.id))) return;
    let nodes = document.nodes;
    for (const writer of writers) nodes = invalidateWorkflow(nodes, writer.id);
    if (producer) nodes = invalidateWorkflow(nodes, producer.id).map(node => node.id === producer.id ? { ...node, resultNodeIds: node.resultNodeIds?.filter(id => id !== nodeId) } : node);
    if (writers.length || producer) handle(controller.edit(nodes.filter(node => !writers.some(writer => writer.id === node.id))));
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
      handle(controller.edit([...nodes.filter(item => item.id !== node.id).map(item => item.id === previousKey ? { ...item, trigger: false } : item), { ...node, trigger: true, inputs: { ...node.inputs, signal: [] } }]));
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
    const move = (event: globalThis.PointerEvent) => {
      if (armed || connectionRef.current) setCursor({ x: event.clientX, y: event.clientY });
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-workflow-material],[data-canvas-node-id]");
      setHoveredMaterial(target?.dataset.workflowMaterial ?? target?.dataset.canvasNodeId ?? null);
    };
    const end = (event: globalThis.PointerEvent) => {
      if (armed && event.button === 0) {
        const element = window.document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
        const workflowId = element?.closest<HTMLElement>("[data-workflow-card]")?.dataset.workflowCard;
        const nativeId = element?.closest<HTMLElement>("[data-canvas-node-id]")?.dataset.canvasNodeId;
        const native = graphNodes.find(node => node.id === nativeId && node.kind === "note" && node.hiddenAt == null && ["text", "images"].includes(readCanvasNote(node).note_type));
        if (workflowId || native) {
          const node = controller.document.nodes.find(node => workflowId ? node.id === workflowId : node.textSource === native!.id)
            ?? (native ? { ...newWorkflowNode("text", native.x, native.y, ""), textSource: native.id } : null);
          if (node && !controller.isLocked(node.id)) {
            setArmed(false);
            handle(controller.edit([...controller.document.nodes.filter(item => item.id !== node.id), { ...node, trigger: true, inputs: { ...node.inputs, signal: [] } }]));
          }
        } else if (element?.closest(".canvas-stage") && !element.closest("button,input,textarea,[data-canvas-node],.canvas-toolbar,.canvas-creation-dock")) {
          setArmed(false);
          const point = toBoardPoint(event.clientX, event.clientY);
          handle((async () => { await ensureMaterialized(); const node = newWorkflowNode("trigger", point.x, point.y, ""); await controller.edit([...controller.document.nodes, node]); onSelect(node.id); })());
        }
        return;
      }
      if (connectionRef.current?.type === "signal") {
        const target = window.document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-workflow-card],[data-canvas-node-id]");
        if (target && target.dataset.workflowCard !== connectionRef.current.nodeId) connectSignal(target.dataset.workflowCard ?? target.dataset.canvasNodeId!, !target.dataset.workflowCard);
        return;
      }
      const textInput = window.document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-workflow-text-input]");
      const textNode = textInput?.closest<HTMLElement>("[data-canvas-node-id]")?.dataset.canvasNodeId;
      if (textNode && connectionRef.current) { inputText(textNode, textInput!.dataset.workflowTextInput || undefined, false, textInput!.dataset.contentInputType as "image" | undefined); return; }
      const input = window.document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-workflow-input]");
      if (input && connectionRef.current) connect(input.dataset.workflowNode!, input.dataset.workflowInput!);
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setConnection(null); setArmed(false); } };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("keydown", key);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("keydown", key); };
  }, [armed, controller, document, graphNodes]);
  useImperativeHandle(ref, () => ({
    inputText,
    connectCell(nodeId, cellId, clientX, clientY) {
      const card = graphNodes.find(node => node.id === nodeId);
      const value: Connection = { canvasNodeId: nodeId, cellId, type: card && canvasInputValue(card, cellId, graphNodes)?.type === "image" ? "image" : "text" };
      connectionRef.current = value; setConnection(value); setCursor({ x: clientX, y: clientY });
    },
    add(kind, x, y) {
      if (!controller.ready) { notifyError(null, "工作流正在载入"); return; }
      handle((async () => {
        await ensureMaterialized();
        const nodes = controller.document.nodes;
        let nextY = y;
        while (nodes.some(node => Math.abs(node.x - x) < WORKFLOW_CARD_WIDTH + 24 && Math.abs(node.y - nextY) < 350)
          || materials.some(node => x < node.x + node.width + 20 && x + WORKFLOW_CARD_WIDTH + 20 > node.x && nextY < node.y + node.height + 20 && nextY + 350 > node.y)) nextY += 370;
        const node = newWorkflowNode(kind, x, nextY, state.activeGenProvider || state.defaultProvider);
        await controller.edit([...nodes, node]); onSelect(node.id);
        onPlaced({ x: node.x, y: node.y, width: WORKFLOW_CARD_WIDTH, height: 370 });
      })());
    },
    arm(x, y) { setArmed(value => !value); setConnection(null); if (x !== undefined && y !== undefined) setCursor({ x, y }); },
    bounds() { return controller.document.nodes.filter(node => node.kind !== "text").map(node => ({ id: node.id, x: node.x, y: node.y, width: WORKFLOW_CARD_WIDTH, height: cardElements.current.get(node.id)?.offsetHeight ?? 330 })); },
    isLocked(id) { return controller.isLocked(id) || document.nodes.some(node => (node.textSource === id || node.textTarget?.nodeId === id || node.resultNodeIds?.includes(id)) && controller.isLocked(node.id)); },
    position(positions, persist = false) {
      let changed = false;
      const nodes = controller.document.nodes.map(node => {
        const point = positions.get(node.id);
        if (!point || controller.isLocked(node.id) || (node.x === point.x && node.y === point.y)) return node;
        changed = true; return { ...node, x: point.x, y: point.y };
      });
      if (changed) { controller.document = { ...controller.document, nodes }; redraw(value => value + 1); }
      if (persist && nodes.some(node => positions.has(node.id) && !controller.isLocked(node.id))) handle(controller.save());
    },
  }));

  function sourcePoint(binding: WorkflowInput) {
    if (binding.canvasNodeId) {
      const owner = document.nodes.find(node => workflowSessionIds([node]).has(binding.canvasNodeId!));
      if (owner) return { x: owner.x + WORKFLOW_CARD_WIDTH, y: workflowPortY(owner, "output", "image") };
      const session = graphNodes.find(node => node.id === binding.canvasNodeId && node.kind === "prompt" && node.hiddenAt == null);
      if (session) return { x: session.x + session.width, y: session.y + 50 };
      const card = Array.from(window.document.querySelectorAll<HTMLElement>("[data-canvas-node-id]")).find(element => element.dataset.canvasNodeId === binding.canvasNodeId);
      const port = Array.from(card?.querySelectorAll<HTMLElement>("[data-workflow-cell]") ?? []).find(element => element.dataset.workflowCell === binding.cellId);
      if (!port) return null;
      const rect = port.getBoundingClientRect(); return toBoardPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }
    const node = document.nodes.find(node => node.id === binding.nodeId);
    if (node) return { x: node.x + WORKFLOW_CARD_WIDTH, y: workflowPortY(node, "output", binding.portId!) };
    const material = materials.find(material => binding.groupId ? material.groupId === binding.groupId
      : !!binding.assetId && material.assetId === binding.assetId && (!binding.assetNodeId || material.id === binding.assetNodeId));
    return material ? { x: material.x + material.width, y: material.y + material.height / 2 } : null;
  }
  function path(from: { x: number; y: number }, to: { x: number; y: number }) {
    const bend = Math.max(50, Math.abs(to.x - from.x) * .45);
    return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
  }
  function portButton(node: WorkflowNode, port: WorkflowPort, side: "input" | "output", index: number) {
    const busy = controller.isLocked(node.id);
    return <button key={port.id} className={`workflow-port is-${side} is-${port.type}`} style={{ top: 84 + index * 30 }}
      aria-label={`${side === "input" ? "输入" : "输出"}：${port.label}`} title={port.type === "session" ? "运行后自动连接生成会话卡片" : side === "input" ? "连接输入；右键断开此端口" : "拖到输入端口，或点击后选择输入端口"}
      data-workflow-node={node.id} data-workflow-input={side === "input" ? port.id : undefined}
      onPointerDown={event => {
        event.stopPropagation(); event.preventDefault(); if ((busy && side === "input") || port.type === "session") return;
        if (side === "output") { const value = { nodeId: node.id, portId: port.id, type: port.type }; connectionRef.current = value; setConnection(value); setCursor({ x: event.clientX, y: event.clientY }); }
      }}
      onClick={event => {
        if (event.detail !== 0 || (busy && side === "input") || port.type === "session") return;
        if (side === "input") connect(node.id, port.id);
        else { const value = { nodeId: node.id, portId: port.id, type: port.type }; connectionRef.current = value; setConnection(value); }
      }}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); if (!busy && side === "input") patch(node.id, { inputs: { ...node.inputs, [port.id]: [] } }); }}>
      <i /><span>{port.label}</span>
    </button>;
  }
  function keyButton(node: WorkflowNode) {
    const busy = controller.isLocked(node.id);
    return <button className={`workflow-key ${workflowRuns(document).some(item => item.startId === node.id && item.status === "running") ? "is-running" : ""}`} draggable={!busy}
          onPointerDown={event => event.stopPropagation()}
          aria-label="上发条，运行工作流" aria-describedby={keyHover?.id === node.id ? "workflow-progress" : undefined}
          onMouseEnter={event => { const rect = event.currentTarget.getBoundingClientRect(); setKeyHover({ id: node.id, x: rect.left, y: rect.bottom }); }}
          onMouseLeave={() => setKeyHover(null)}
          onFocus={event => { const rect = event.currentTarget.getBoundingClientRect(); setKeyHover({ id: node.id, x: rect.left, y: rect.bottom }); }} onBlur={() => setKeyHover(null)}
          onDragStart={event => { event.stopPropagation(); event.dataTransfer.setData("text/plain", `bowerbird-winding-key:${node.id}`); }}
          onClick={() => { if (!busy) handle(controller.start(node.id)); }}
          onContextMenu={event => { event.preventDefault(); event.stopPropagation(); if (!busy) patch(node.id, { trigger: false }, false); }}><WindingKey size={32} /></button>;
  }
  function gearButton(node: WorkflowNode) {
    const points = Array.from({ length: 25 }, (_, i) => {
      const angle = Math.PI + i * Math.PI / 24, radius = i % 4 === 1 || i % 4 === 2 ? 20 : 16;
      return `${20 + Math.cos(angle) * radius},${24 + Math.sin(angle) * radius}`;
    });
    return <button className="workflow-key workflow-gear" aria-label="断开触发器连接" title="触发器已连接 · 右键齿轮断开" disabled={controller.isLocked(node.id)}
      onPointerDown={event => event.stopPropagation()}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); if (!controller.isLocked(node.id)) patch(node.id, { inputs: { ...node.inputs, signal: [] } }, false); }}>
      <svg width="36" height="32" viewBox="0 0 40 32" aria-hidden="true"><path d={`M${points.join(" L")} L29,24 A9,9 0 0 0 11,24 Z`} fill="currentColor" /></svg>
    </button>;
  }
  const statusLabels = { pending: "等待上游", running: "执行中", waiting: "等待继续", done: "已完成", failed: "失败" };
  return <>
    <svg className="workflow-wires">
      {document.nodes.map(node => {
        const group = materials.find(item => item.groupId === node.resultGroupId && !!node.resultGroupId);
        return group && <path key={`group-${node.id}`} className="is-image" data-workflow-product-link={group.id} d={path({ x: node.x + WORKFLOW_CARD_WIDTH, y: workflowPortY(node, "output", "image") }, { x: group.x, y: group.y + group.height / 2 })} />;
      })}
      {document.nodes.flatMap(node => (node.resultNodeIds ?? []).map(id => {
        const result = graphNodes.find(item => item.id === id && item.hiddenAt == null);
        const type = node.action === "layers" ? "image" : "text";
        return result && <path key={id} className={`is-${type}`} data-workflow-result-link={id} d={path({ x: node.x + WORKFLOW_CARD_WIDTH, y: workflowPortY(node, "output", type) }, { x: result.x, y: result.y + 24 })} />;
      }))}
      {document.nodes.flatMap(node => Object.entries(node.inputs).flatMap(([port, inputs]) => inputs.map((binding, index) => {
        const from = sourcePoint(binding); if (!from) return null;
        let to = { x: node.x, y: workflowPortY(node, "input", port) };
        if (port === "signal") {
          const card = node.textSource && graphNodes.find(card => card.id === node.textSource && card.hiddenAt == null);
          if (node.textSource && !card) return null;
          to = { x: (card ? card.x + card.width : node.x + WORKFLOW_CARD_WIDTH) - 34, y: (card ? card.y : node.y) - 18 };
        }
        if (node.textTarget) {
          const target = node.textTarget;
          const card = Array.from(window.document.querySelectorAll<HTMLElement>("[data-canvas-node-id]")).find(item => item.dataset.canvasNodeId === target.nodeId);
          const socket = Array.from(card?.querySelectorAll<HTMLElement>("[data-workflow-text-input]") ?? []).find(item => item.dataset.workflowTextInput === (target.append ? "" : target.cellId) && (item.dataset.contentInputType === "image") === (port === "image"));
          if (!socket) return null;
          const rect = socket.getBoundingClientRect(); to = toBoardPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        }
        const diagnostic = nodeDiagnostic(node.id);
        const failedWire = diagnostic?.source && (workflowBindingKey(diagnostic.source) === workflowBindingKey(binding)
          || inputs.length === 1 && node.promptReferences?.some(ref => ref.type === port && ref.label === diagnostic.referenceLabel));
        return <path key={`${node.id}-${port}-${index}`} data-workflow-target={node.id} data-workflow-signal-link={port === "signal" ? node.id : undefined} data-workflow-text-link={node.textTarget?.cellId} className={`is-${port}${failedWire ? " is-error" : ""}`} d={path(from, to)}
          onContextMenu={event => { if (port !== "signal") return; event.preventDefault(); event.stopPropagation(); if (!controller.isLocked(node.id) && !controller.isLocked(binding.nodeId!)) patch(node.id, { inputs: { ...node.inputs, signal: inputs.filter((_, i) => i !== index) } }, false); }} />;
      })))}
      {connection && (() => { const from = sourcePoint(connection); return from && <path className="is-draft" d={path(from, toBoardPoint(cursor.x, cursor.y))} />; })()}
    </svg>
    {document.nodes.filter(node => node.textSource && (node.trigger || node.inputs.signal?.length)).map(node => {
      const card = graphNodes.find(card => card.id === node.textSource && card.hiddenAt == null);
      return card && <div key={node.id} className="workflow-material-hotspot workflow-text-key" data-workflow-text-key={card.id} style={{ left: card.x, top: card.y, width: card.width, height: card.height }}>{node.inputs.signal?.length ? gearButton(node) : keyButton(node)}</div>;
    })}
    {graphNodes.filter(card => card.kind === "prompt" && card.hiddenAt == null && !sessionIds.has(card.id)).map(card => <div key={`session-${card.id}`} className={`workflow-material-hotspot ${hoveredMaterial === card.id ? "is-hovered" : ""}`} style={{ left: card.x, top: card.y, width: card.width, height: card.height }}>
      <button data-workflow-session-output={card.id} data-workflow-material={card.id} className="workflow-asset-port" style={{ left: card.width - 6, top: 44 }}
        aria-label="连接会话图片到工作流" title="输出本轮会话图片，拖动连接到图片输入" onPointerDown={event => {
          event.stopPropagation(); event.preventDefault();
          const value: Connection = { canvasNodeId: card.id, cellId: "image", type: "image" };
          connectionRef.current = value; setConnection(value); setCursor({ x: event.clientX, y: event.clientY });
        }} />
    </div>)}
    {materials.map(material => <div key={material.id} className={`workflow-material-hotspot ${hoveredMaterial === material.id ? "is-hovered" : ""}`} style={{ left: material.x, top: material.y, width: material.width, height: material.height }}><button data-workflow-material={material.id} className="workflow-asset-port" style={{ left: material.width - 6, top: material.height / 2 - 6 }}
      aria-label={material.groupId ? "连接文件夹图片到工作流" : "连接图片到工作流"} title={material.groupId ? `输出文件夹内 ${material.assetIds?.length ?? 0} 张图片` : "拖动连接到工作流图片输入"} onPointerDown={event => {
        event.stopPropagation(); event.preventDefault();
        const value: Connection = material.groupId ? { groupId: material.groupId, assetIds: material.assetIds, type: "image" } : { assetId: material.assetId, assetNodeId: material.id, type: "image" };
        connectionRef.current = value; setConnection(value); setCursor({ x: event.clientX, y: event.clientY });
      }} /></div>)}
    {document.nodes.filter(node => node.kind !== "text").map(node => {
      const run = workflowNodeRun(document, node.id);
      const step = run?.steps[node.id];
      const busy = controller.isLocked(node.id);
      const inputPorts = workflowInputs(node), outputPorts = workflowOutputs(node);
      const height = node.kind === "trigger" ? 220 : Math.max(330, 130 + Math.max(inputPorts.length, outputPorts.length) * 30);
      const images = Object.values(node.outputs).flatMap(value => value.assetIds ?? []);
      const profileId = node.profileId || node.profileCache?.profileId || step?.profileId;
      const inputIds = Object.values(node.inputs).flat().flatMap(inputImages);
      const selectedImages = [...new Set(images.length ? images : inputIds)].map(id => assets.find(asset => asset.id === id)).filter((asset): asset is Asset => !!asset);
      return <article key={node.id} data-canvas-node data-workflow-card={node.id} ref={element => { if (element) cardElements.current.set(node.id, element); else cardElements.current.delete(node.id); }} aria-busy={run?.status === "running" && step?.status === "running"} className={`workflow-card ${run?.status === "running" && step?.status === "running" ? "canvas-card-running" : step?.status === "failed" || nodeDiagnostic(node.id) ? "canvas-card-error" : ""} is-${node.kind} ${selectedIds.has(node.id) ? "is-selected" : ""} ${armed ? "is-key-target" : ""}`}
        onMouseEnter={event => { if (node.kind === "trigger") { const rect = event.currentTarget.getBoundingClientRect(); setKeyHover({ id: node.id, x: rect.right, y: rect.top }); } }}
        onMouseLeave={() => { if (node.kind === "trigger") setKeyHover(null); }}
        style={{ left: node.x, top: node.y, width: WORKFLOW_CARD_WIDTH, minHeight: height, zIndex: selectedIds.has(node.id) ? 11000 : 9000 }}
        onPointerDownCapture={event => {
          if (armed && !busy) { event.stopPropagation(); event.preventDefault(); patch(node.id, { trigger: true, inputs: { ...node.inputs, signal: [] } }, false); setArmed(false); }
        }}
        onPointerDown={event => { if (event.button === 1 || (event.button === 0 && panReady)) return; event.stopPropagation(); if (!selectedIds.has(node.id) || event.ctrlKey || event.metaKey) onSelect(node.id, event.ctrlKey || event.metaKey); }} onDoubleClick={event => event.stopPropagation()}
        onKeyDown={event => { if (event.key !== "Escape") event.stopPropagation(); }}
        onContextMenu={event => onNodeMenu(event, node.id)} onWheel={event => { if ((event.target as HTMLElement).closest("textarea,.workflow-prompt-editor,.workflow-preview,.workflow-text-result")) event.stopPropagation(); }}
        onDragOver={event => { if (getDragAssets() || event.dataTransfer.types.includes("text/plain")) { event.preventDefault(); event.stopPropagation(); } }}
        onDrop={event => {
          event.preventDefault(); event.stopPropagation(); if (busy) return;
          const keyText = event.dataTransfer.getData("text/plain");
          const previousKey = keyText.startsWith("bowerbird-winding-key:") ? keyText.slice(22) : "";
          if (previousKey && document.nodes.some(node => node.id === previousKey && node.trigger)) {
            handle(controller.edit(document.nodes.map(candidate => ({ ...candidate, trigger: candidate.id === node.id || (candidate.id !== previousKey && candidate.trigger),
              ...(candidate.id === node.id ? { inputs: { ...candidate.inputs, signal: [] } } : {}) })))); return;
          }
          const ids = getDragAssets(); if (!ids?.length || node.kind === "trigger" || node.kind === "agent") return;
          if (node.kind === "visual-profile" && node.profileId) { notifyError(null, "请先切换到从输入提炼"); return; }
          if (node.kind === "instruction" && node.action !== "describe" && ids.length !== 1) { notifyError(null, "此指令只接收一张图片"); return; }
          patch(node.id, { inputs: { ...node.inputs, image: ids.map(assetId => ({ assetId })) } });
        }}>
        {node.inputs.signal?.length ? gearButton(node) : node.trigger && keyButton(node)}
        <header onPointerDown={event => {
          if ((event.target as HTMLElement).closest("button") || busy) return;
          onDragStart(event, node);
        }} onPointerMove={onDragMove} onPointerUp={event => onDragEnd(event)} onPointerCancel={event => onDragEnd(event, true)}>
          <GripHorizontal size={15} /><strong>{workflowTitle(node)}</strong>
          <button aria-label="复制卡片" disabled={busy} onClick={() => {
            const copy = { ...structuredClone(node), id: crypto.randomUUID(), x: node.x + 350, outputs: {}, activeSessionNodeId: null, sessionNodeIds: [], resultNodeIds: [], resultGroupId: undefined, trigger: false };
            handle(controller.edit([...document.nodes, copy])); onSelect(copy.id);
          }}><Copy size={13} /></button>
          <button aria-label="删除卡片" disabled={busy} onClick={() => {
            const remaining = invalidateWorkflow(document.nodes, node.id).filter(candidate => candidate.id !== node.id).map(candidate => ({ ...candidate,
              inputs: Object.fromEntries(Object.entries(candidate.inputs).map(([port, bindings]) => [port, bindings.filter(binding => binding.nodeId !== node.id)])) }));
            handle(controller.edit(remaining));
          }}><X size={15} /></button>
        </header>
        {node.kind === "generation" && <div className="workflow-floating-tools" role="toolbar" aria-label="生成参数" onPointerDown={event => event.stopPropagation()}>
          <fieldset disabled={busy}><RatioSelect value={node.ratio} onChange={ratio => patch(node.id, { ratio })} />
            <ProviderSelect value={node.provider} onChange={provider => patch(node.id, { provider })} codexHealth={state.codexHealth} dreaminaHealth={state.dreaminaHealth}
              cloudAvailable={!!state.cloudAuth?.cloud_available} cloudAuth={state.cloudAuth} cloudEntitlement={state.cloudEntitlement} /></fieldset>
        </div>}
        <div className="workflow-card-body">
          {node.kind === "instruction" && <select aria-label="指令功能" disabled={busy} value={node.action} onChange={event => {
            const action = event.target.value as WorkflowNode["action"];
            const nodes = invalidateWorkflow(document.nodes, node.id).map(candidate => candidate.id === node.id ? { ...candidate, action, outputPorts: [] } : { ...candidate,
              inputs: Object.fromEntries(Object.entries(candidate.inputs).map(([port, bindings]) => [port, bindings.filter(binding => binding.nodeId !== node.id)])) });
            handle(controller.edit(nodes));
          }}><option value="describe">反推</option><option value="reuse">复用生成提示词</option><option value="layers">分层编辑</option></select>}
          {node.kind === "skill" && <select aria-label="选择技能" disabled={busy} value={node.skill} onChange={event => patch(node.id, { skill: event.target.value })}>
            {WORKFLOW_SKILLS.map(skill => <option key={skill.id} value={skill.id}>{skill.label}</option>)}
          </select>}
          {node.kind === "agent" && import.meta.env.DEV && <select aria-label="Agent 测试通道" disabled={busy} value={node.agentTransport ?? "local-ds"} onChange={event => patch(node.id, { agentTransport: event.target.value as "local-ds" | "cloud" })}>
            <option value="local-ds">本机 Agent DS · 自动送达测试</option><option value="cloud">Cloud DSH</option>
          </select>}
          {node.kind === "visual-profile" && <select aria-label="视觉规范来源" disabled={busy} value={node.profileId ?? ""} onChange={event => patch(node.id, { profileId: event.target.value || undefined, profileCache: undefined, inputs: {}, prompt: "" })}>
            <option value="">从图片 / 文字提炼</option>
            {node.profileId && !profiles.some(p => p.id === node.profileId) && <option value={node.profileId}>已选规范不可用</option>}
            {profiles.map(p => <option key={p.id} value={p.id}>{p.name} · v{p.version}</option>)}
          </select>}
          <div className="workflow-port-space" style={{ height: Math.max(inputPorts.length, outputPorts.length, 2) * 30 + (node.kind === "generation" ? 32 : 0) }} />
          {node.kind === "instruction" && node.action === "describe" && <WorkflowDescribeOption assetIds={inputIds} checked={!!node.overwriteDescribe} disabled={busy} onChange={overwriteDescribe => patch(node.id, { overwriteDescribe })} />}
          {node.kind === "visual-profile" && !node.profileId && <input className="workflow-profile-name" aria-label="规范名称" disabled={busy} maxLength={80} placeholder="画板视觉规范" value={node.profileName ?? ""} onChange={event => patch(node.id, { profileName: event.target.value }, false)} />}
          {(node.kind === "generation" || node.kind === "agent") && <WorkflowPromptEditor node={{ ...node, inputs: { ...node.inputs, image: node.inputs.image?.map(input => input.groupId ? { ...input, assetIds: materials.find(item => item.groupId === input.groupId)?.assetIds ?? [] } : input) ?? [] } }} nodes={document.nodes} graphNodes={graphNodes} disabled={busy} onChange={(prompt, promptReferences) => patch(node.id, { prompt, promptReferences })} />}
          {node.kind !== "trigger" && node.kind !== "generation" && node.kind !== "agent" && !(node.kind === "instruction" && node.action !== "describe") && !(node.kind === "visual-profile" && node.profileId) && <textarea aria-label={node.kind === "instruction" ? "反推要求" : node.kind === "visual-profile" ? "视觉要求" : "卡片指令"}
            disabled={busy} maxLength={node.kind === "visual-profile" ? 4000 : undefined} placeholder={node.kind === "instruction" ? "留空使用当前反推要求" : node.kind === "visual-profile" ? "描述配色、构图、光线等要求；可只接图片或只填文字…" : "输入创作要求，也可从文本端口接入…"}
            value={node.prompt} onChange={event => patch(node.id, { prompt: event.target.value })} />}
          {selectedImages.length > 0 ? <div className="workflow-preview">{selectedImages.map(asset => {
            const path = canvasAssetMediaPath({ thumbPath: asset.thumb_path ?? null, storePath: asset.store_path ?? null }) ?? "";
            return <img key={asset.id} title={asset.name} alt={asset.name} src={path.startsWith("data:") ? path : convertFileSrc(path)} />;
          })}</div>
            : <p className="workflow-hint">{node.kind === "agent" ? `${import.meta.env.DEV && node.agentTransport !== "cloud" ? "本机 Agent DS" : "Cloud DSH"} · 按 @ 引用原文，再描述修改要求` : node.kind === "trigger" ? <><WindingKey size={28} />将触发连线拖到下游卡片上</> : <><ImagePlus size={14} />{node.kind === "visual-profile" ? "图片可选 · 规范只影响连接的下游" : "拖入图片，或连接左侧端口"}</>}</p>}
          {node.kind === "visual-profile" && <>
            {!node.profileId && <p className="workflow-hint">提炼 2 积分 · 图片分析另用账号额度 · 保存后继续</p>}
            {node.outputs["visual-profile"] && <p className="workflow-profile-summary">v{node.outputs["visual-profile"].version} · {node.outputs["visual-profile"].summary}</p>}
            {profileId && <button className="workflow-detail" onClick={() => handle((async () => {
              const profile = await api.visualProfileGet(profileId); state.openVisualProfile({ id: profile.folderId, name: profile.name, profileId });
            })())}>查看 / 确认视觉规范</button>}
            {node.profileCache && !node.profileId && <button className="workflow-detail" disabled={busy} onClick={() => patch(node.id, { profileCache: undefined })}>重新提炼</button>}
          </>}
          {node.kind === "instruction" && !outputPorts.length && <p className="workflow-hint">{node.action === "describe" ? "反推后展开各维度输出" : "保存分层工程后展开图层输出"}</p>}
          {outputPorts.filter(port => port.type === "text" && node.outputs[port.id]?.text).map(port => <details key={port.id} className="workflow-text-result">
            <summary>{port.label}</summary><p>{node.outputs[port.id].text}</p>
          </details>)}
          {Object.entries(node.inputs).some(([, bindings]) => bindings.length > 0) && <div className="workflow-bindings">{Object.entries(node.inputs).filter(([, bindings]) => bindings.length).map(([port, bindings]) =>
            <button key={port} disabled={busy} title="断开此输入" onClick={() => patch(node.id, { inputs: { ...node.inputs, [port]: [] } })}>{port === "signal" ? "触发器" : port === "text" ? "文本" : port === "visual-profile" ? "视觉规范" : "图片"} · {bindings.length} 个来源 <X size={11} /></button>)}</div>}
          {step?.error && <p className={step.status === "failed" ? "workflow-error" : "workflow-waiting"} role={step.status === "failed" ? "alert" : "status"}>{step.error}
            {step.diagnostic && <button onClick={() => controller.showIssue(step.diagnostic!)}>查看问题</button>}
          </p>}
          <footer>
            <span>{node.kind === "trigger" && busy ? run?.status === "waiting" ? "等待继续" : "运行中" : step?.status === "pending" && run?.status === "failed" ? "因上游失败未执行" : step?.status === "pending" && run?.status === "stopped" ? "已停止，未执行" : step ? statusLabels[step.status] : node.trigger ? "工作流起点" : "未运行"}</span>
            {busy && run?.order.includes(node.id) ? <>
              {run?.status === "waiting" && step?.status !== "done" && run.order.find(id => run!.steps[id].status !== "done") === node.id
                && <button aria-label="继续工作流" onClick={() => handle(controller.continue(run?.id))}><Play size={13} />继续</button>}
              <button aria-label="停止工作流" onClick={() => handle(controller.stop(run?.id))}><Square size={12} /></button>
            </> : <button disabled={busy} aria-label={node.kind === "trigger" ? "触发下游" : "运行此卡片"} onClick={() => handle(controller.start(node.id, node.kind !== "trigger"))}><Play size={13} />{node.kind === "trigger" ? "触发下游" : "运行此卡片"}</button>}
          </footer>
          {step?.agentRunId && node.kind !== "agent" && <button className="workflow-detail" onClick={() => handle((async () => {
            const run = await api.cloudAgentGet(step.agentRunId!); useStore.getState().openCloudAgentRun(run, { navigate: false }); setAgentOpen(true);
          })())}>查看技能执行 / 审批</button>}
        </div>
        {inputPorts.map((port, index) => portButton(node, port, "input", index))}
        {outputPorts.map((port, index) => portButton(node, port, "output", index))}
        {node.kind === "generation" && <WorkflowGenerationHistory node={node} graphNodes={graphNodes} onOpen={onOpenGeneration} />}
      </article>;
    })}
    {armed && createPortal(<div className="workflow-key-ghost" style={{ left: cursor.x + 16, top: cursor.y + 16 }}><WindingKey size={30} />卡片上吸附 · 空白处创建 · Esc 取消</div>, window.document.body)}
    {keyHover && createPortal(<div id="workflow-progress" role="tooltip" className="workflow-progress" style={{ left: Math.max(12, Math.min(keyHover.x, window.innerWidth - 340)), top: Math.max(12, Math.min(keyHover.y + 10, window.innerHeight - 320)) }}>
      {(() => {
        const run = [...workflowRuns(document)].reverse().find(item => item.startId === keyHover.id);
        if (!run) return <><strong>工作流起点</strong><p>点击运行下游流程 · 拖动更换起点 · 右键取下</p></>;
        const current = run.order.find(id => run.steps[id]?.status === "failed") ?? run.order.find(id => run.steps[id]?.status !== "done");
        const active = run.order.filter(id => run.steps[id]?.status === "running");
        return <><strong>{({running:"工作流运行中",waiting:"工作流等待继续",done:"工作流已完成",failed:"工作流已失败",stopped:"工作流已停止"})[run.status]} · {run.order.filter(id => run.steps[id]?.status === "done").length}/{run.order.length}</strong>
          {current && <p>第 {run.order.indexOf(current) + 1} 步：{run.steps[current]?.error || run.steps[current]?.detail || "准备执行"}</p>}
          {run.status === "running" && active.length > 1 && <p>{active.length} 个步骤同时执行中</p>}
          <ol>{run.order.map((id, index) => {
            const card = document.nodes.find(item => item.id === id); const item = run.steps[id];
            const label = card?.kind === "instruction" ? ({describe:"反推",layers:"分层拆分",reuse:"复用生成提示词"})[card.action] : card ? workflowTitle(card) : "已移除卡片";
            const executing = item?.status === "running" || item?.status === "waiting";
            return <li key={id} className={id === current || executing ? "is-current" : ""}><span>{index + 1}. {label} · {item?.status === "done" ? "已完成" : item?.status === "failed" ? "失败" : executing ? run.status === "stopped" || run.status === "failed" ? "已停止" : item.status === "waiting" ? "等待继续" : "执行中" : run.status === "failed" ? "因上游失败未执行" : run.status === "stopped" ? "已停止，未执行" : "等待上游"}</span>
              {(id === current || executing) && <p>{item?.error || item?.detail || "准备执行"}</p>}</li>;
          })}</ol></>;
      })()}
    </div>, window.document.body)}
    {issue && createPortal(<section className="workflow-diagnostic" role="alert" aria-label="工作流问题" onPointerDown={event => event.stopPropagation()}>
      <header><strong>{issue.phase === "validation" ? "工作流未启动" : "工作流已停止"}</strong><button aria-label="关闭工作流问题" onClick={() => controller.dismissIssue()}><X size={15} /></button></header>
      <p className="workflow-diagnostic-location">{issue.step ? `第 ${issue.step} 步 · ` : "启动检查 · "}{issue.nodeLabel} · {issue.nodeId.slice(0, 8)}</p>
      {issue.referenceLabel && <p>输入引用：@{issue.referenceLabel}</p>}
      {issueSourceLabel && <p>来源：{issueSourceLabel}</p>}
      <p>{issue.message}</p><p className="workflow-diagnostic-action">{issue.action}</p>
      <div className="workflow-diagnostic-buttons"><button onClick={() => locateIssue(issue.nodeId)}>定位出错卡片</button>
        {issueSourceId && (document.nodes.some(node => node.id === issueSourceId) || graphNodes.some(node => node.id === issueSourceId && node.hiddenAt == null)) && <button onClick={() => locateIssue(issueSourceId)}>定位来源</button>}
        <button onClick={() => handle(navigator.clipboard.writeText(workflowDiagnosticReport(issue)).then(() => notifySuccess("诊断信息已复制")))}>复制诊断信息</button>
      </div>
      <details><summary>诊断详情</summary><pre>{workflowDiagnosticReport(issue)}</pre></details>
    </section>, window.document.body)}
    {controller.error && createPortal(<div className="workflow-save-error" role="alert" onPointerDown={event => event.stopPropagation()}>{controller.error}<button onClick={() => handle(controller.retrySave())}>重试保存</button></div>, window.document.body)}
    {agentOpen && <ModalShell title="技能执行" width="lg" onClose={() => setAgentOpen(false)}><CloudAgentSession embedded /></ModalShell>}
  </>;
});
