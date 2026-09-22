import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { GripHorizontal, Play, Square, X, Copy, ImagePlus } from "lucide-react";
import { api } from "../lib/api";
import { canvasAssetMediaPath } from "../lib/creativeCanvas";
import { useStore } from "../store";
import { getDragAssets } from "../lib/dragPayload";
import { notifyError } from "../lib/notify";
import { canvasWorkflowController } from "../lib/canvasWorkflowRuntime";
import { invalidateWorkflow, newWorkflowNode, workflowNodeRun, workflowRuns, workflowInputProducer, workflowConnectionError, workflowInputs, workflowOutputs,
  workflowPortY, workflowTitle, WORKFLOW_CARD_WIDTH, WORKFLOW_SKILLS, type WorkflowInput, type WorkflowKind, type WorkflowNode, type WorkflowPort } from "../lib/canvasWorkflow";
import type { Asset, CanvasNode, VisualProfileSummary } from "../lib/types";
import { ProviderSelect } from "./creation/ProviderSelect";
import { RatioSelect } from "./creation/RatioSelect";
import { CloudAgentSession } from "./CloudAgentPanel";
import { ModalShell } from "./ModalShell";
import "./CanvasWorkflow.css";

export function WindingKey({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 10C9 2 2 4 3 8s6 5 9 2Zm0 0c3-8 10-6 9-2s-6 5-9 2ZM12 10v10m-3 0h6m-3-4h3" />
  </svg>;
}
export interface WorkflowGeometry { id: string; x: number; y: number; width: number; height: number }
export interface WorkflowLayerHandle {
  connectCell: (nodeId: string, cellId: string, clientX: number, clientY: number) => void;
  add: (kind: WorkflowKind, x: number, y: number) => void; arm: () => void;
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
export const CanvasWorkflowLayer = forwardRef<WorkflowLayerHandle, Props>(function CanvasWorkflowLayer({ projectId, zoom, materials, graphNodes, ensureMaterialized, toBoardPoint, onPlaced, selectedIds, panReady, onSelect, onNodesChanged, onDragStart, onDragMove, onDragEnd, onNodeMenu }, ref) {
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

  const handle = (promise: Promise<unknown>) => { void promise.catch(error => notifyError(error, "工作流操作未完成")); };
  useEffect(() => { const unsubscribe = controller.subscribe(() => { redraw(value => value + 1); nodesChanged.current(); }); void controller.load(); return unsubscribe; }, [controller]);
  useEffect(() => { setConnection(null); setArmed(false); setAgentOpen(false); }, [projectId]);
  useEffect(() => {
    let alive = true;
    void api.visualProfileList(null).then(list => { if (alive) setProfiles(list.filter(p => p.status === "confirmed")); }).catch(() => {});
    return () => { alive = false; };
  }, [state.visualProfiles, projectId]);
  const assetKey = [...new Set(document.nodes.flatMap(node => [
    ...Object.values(node.inputs).flat().flatMap(input => input.groupId ? materials.find(item => item.groupId === input.groupId)?.assetIds ?? [] : input.assetId ? [input.assetId] : []),
    ...Object.values(node.outputs).flatMap(output => output.assetIds ?? []),
  ]))].sort().join("|");
  useEffect(() => {
    let current = true;
    void api.getAssetsByIds(assetKey ? assetKey.split("|") : []).then(value => { if (current) setAssets(value); }).catch(() => {});
    return () => { current = false; };
  }, [assetKey]);

  function patch(id: string, update: Partial<WorkflowNode>, invalidate = true) {
    const nodes = controller.document.nodes.map(node => node.id === id ? { ...node, ...update } : node);
    handle(controller.edit(invalidate ? invalidateWorkflow(nodes, id) : nodes));
  }
  function connect(toId: string, inputId: string) {
    const source = connectionRef.current;
    if (!source || controller.isLocked(toId) || (source.nodeId && controller.isLocked(source.nodeId))) return;
    const nodes = controller.document.nodes;
    const node = nodes.find(node => node.id === toId)!;
    const port = workflowInputs(node).find(port => port.id === inputId);
    const producer = workflowInputProducer(nodes, source);
    if (producer && controller.isLocked(producer)) return;
    const error = producer ? workflowConnectionError(nodes, producer, source.portId ?? "text", toId, inputId)
      : port?.type !== source.type ? "只能连接相同类型的端口" : null;
    if (error) { notifyError(null, error); return; }
    const { type: _type, ...binding } = source;
    const current = node.inputs[inputId] ?? [];
    if (current.some(input => binding.groupId ? input.groupId === binding.groupId : JSON.stringify(input) === JSON.stringify(binding))) { setConnection(null); connectionRef.current = null; return; }
    if (node.kind === "visual-profile" && node.profileId) { notifyError(null, "请先切换到从输入提炼"); return; }
    patch(toId, { inputs: { ...node.inputs, [inputId]: (node.kind === "instruction" && node.action !== "describe") || inputId === "visual-profile" ? [binding] : [...current, binding] } });
    setConnection(null); connectionRef.current = null;
  }
  function disconnectResult(producerId: string, resultId: string) {
    if (controller.isLocked(producerId)) return;
    const nodes = invalidateWorkflow(controller.document.nodes, producerId).map(node => node.id === producerId
      ? { ...node, resultNodeIds: node.resultNodeIds?.filter(id => id !== resultId) } : node);
    handle(controller.edit(nodes));
  }
  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      if (armed || connectionRef.current) setCursor({ x: event.clientX, y: event.clientY });
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-workflow-material],[data-canvas-node-id]");
      setHoveredMaterial(target?.dataset.workflowMaterial ?? target?.dataset.canvasNodeId ?? null);
    };
    const end = (event: globalThis.PointerEvent) => {
      const input = window.document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-workflow-input]");
      if (input && connectionRef.current) connect(input.dataset.workflowNode!, input.dataset.workflowInput!);
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setConnection(null); setArmed(false); } };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("keydown", key);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("keydown", key); };
  }, [armed, controller, document]);
  useImperativeHandle(ref, () => ({
    connectCell(nodeId, cellId, clientX, clientY) {
      const value: Connection = { canvasNodeId: nodeId, cellId, type: "text" };
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
    arm() { setArmed(value => !value); setConnection(null); },
    bounds() { return controller.document.nodes.map(node => ({ id: node.id, x: node.x, y: node.y, width: WORKFLOW_CARD_WIDTH, height: cardElements.current.get(node.id)?.offsetHeight ?? 330 })); },
    isLocked(id) { return controller.isLocked(id); },
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
      const card = Array.from(window.document.querySelectorAll<HTMLElement>("[data-canvas-node-id]")).find(element => element.dataset.canvasNodeId === binding.canvasNodeId);
      const port = Array.from(card?.querySelectorAll<HTMLElement>("[data-workflow-cell]") ?? []).find(element => element.dataset.workflowCell === binding.cellId);
      if (!port) return null;
      const rect = port.getBoundingClientRect(); return toBoardPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }
    const node = document.nodes.find(node => node.id === binding.nodeId);
    if (node) return { x: node.x + WORKFLOW_CARD_WIDTH, y: workflowPortY(node, "output", binding.portId!) };
    const material = materials.find(material => binding.groupId ? material.groupId === binding.groupId : !!binding.assetId && material.assetId === binding.assetId);
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
        event.stopPropagation(); event.preventDefault(); if (busy || port.type === "session") return;
        if (side === "output") { const value = { nodeId: node.id, portId: port.id, type: port.type }; connectionRef.current = value; setConnection(value); setCursor({ x: event.clientX, y: event.clientY }); }
      }}
      onClick={event => {
        if (event.detail !== 0 || busy || port.type === "session") return;
        if (side === "input") connect(node.id, port.id);
        else { const value = { nodeId: node.id, portId: port.id, type: port.type }; connectionRef.current = value; setConnection(value); }
      }}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); if (!busy && side === "input") patch(node.id, { inputs: { ...node.inputs, [port.id]: [] } }); }}>
      <i /><span>{port.label}</span>
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
        return result && <path key={id} className="is-text" data-workflow-result-link={id} d={path({ x: node.x + WORKFLOW_CARD_WIDTH, y: workflowPortY(node, "output", "text") }, { x: result.x, y: result.y + 50 })} />;
      }))}
      {document.nodes.flatMap(node => (node.sessionNodeIds ?? []).map(id => {
        const session = graphNodes.find(candidate => candidate.id === id && candidate.hiddenAt == null);
        return session && <path key={id} className="is-session" data-workflow-session-link={id} d={path({ x: node.x + WORKFLOW_CARD_WIDTH, y: workflowPortY(node, "output", "session") }, { x: session.x, y: session.y + 50 })} />;
      }))}
      {document.nodes.flatMap(node => Object.entries(node.inputs).flatMap(([port, inputs]) => inputs.map((binding, index) => {
        const from = sourcePoint(binding); if (!from) return null;
        return <path key={`${node.id}-${port}-${index}`} className={`is-${port}`} d={path(from, { x: node.x, y: workflowPortY(node, "input", port) })} />;
      })))}
      {connection && (() => { const from = sourcePoint(connection); return from && <path className="is-draft" d={path(from, toBoardPoint(cursor.x, cursor.y))} />; })()}
    </svg>
    {document.nodes.flatMap(node => (node.resultNodeIds ?? []).map(id => {
      const result = graphNodes.find(item => item.id === id && item.hiddenAt == null);
      return result && <div key={`input-${id}`} className={`workflow-material-hotspot ${hoveredMaterial === id ? "is-hovered" : ""}`} style={{ left: result.x, top: result.y, width: result.width, height: result.height }}>
        <button className="workflow-asset-port workflow-result-input" data-workflow-material={id} aria-label="断开文本卡片输入" title="点击或右键断开输入，保留文本内容" disabled={controller.isLocked(node.id)} style={{ left: -6, top: 44 }}
          onPointerDown={event => { event.stopPropagation(); event.preventDefault(); }}
          onClick={event => { event.stopPropagation(); disconnectResult(node.id, id); }}
          onContextMenu={event => { event.stopPropagation(); event.preventDefault(); disconnectResult(node.id, id); }} />
      </div>;
    }))}
    {materials.map(material => <div key={material.id} className={`workflow-material-hotspot ${hoveredMaterial === material.id ? "is-hovered" : ""}`} style={{ left: material.x, top: material.y, width: material.width, height: material.height }}><button data-workflow-material={material.id} className="workflow-asset-port" style={{ left: material.width - 6, top: material.height / 2 - 6 }}
      aria-label={material.groupId ? "连接文件夹图片到工作流" : "连接图片到工作流"} title={material.groupId ? `输出文件夹内 ${material.assetIds?.length ?? 0} 张图片` : "拖动连接到工作流图片输入"} onPointerDown={event => {
        event.stopPropagation(); event.preventDefault();
        const value: Connection = material.groupId ? { groupId: material.groupId, assetIds: material.assetIds, type: "image" } : { assetId: material.assetId, type: "image" };
        connectionRef.current = value; setConnection(value); setCursor({ x: event.clientX, y: event.clientY });
      }} /></div>)}
    {document.nodes.map(node => {
      const run = workflowNodeRun(document, node.id);
      const step = run?.steps[node.id];
      const busy = controller.isLocked(node.id);
      const inputPorts = workflowInputs(node), outputPorts = workflowOutputs(node);
      const height = Math.max(330, 130 + Math.max(inputPorts.length, outputPorts.length) * 30);
      const images = Object.values(node.outputs).flatMap(value => value.assetIds ?? []);
      const profileId = node.profileId || node.profileCache?.profileId || step?.profileId;
      const inputIds = Object.values(node.inputs).flat().flatMap(input => input.groupId ? materials.find(item => item.groupId === input.groupId)?.assetIds ?? [] : input.assetId ? [input.assetId]
        : document.nodes.find(source => source.id === input.nodeId)?.outputs[input.portId ?? ""]?.assetIds ?? []);
      const selectedImages = [...new Set(images.length ? images : inputIds)].map(id => assets.find(asset => asset.id === id)).filter((asset): asset is Asset => !!asset);
      return <article key={node.id} data-canvas-node data-workflow-card={node.id} ref={element => { if (element) cardElements.current.set(node.id, element); else cardElements.current.delete(node.id); }} className={`workflow-card is-${node.kind} ${selectedIds.has(node.id) ? "is-selected" : ""} ${armed ? "is-key-target" : ""}`}
        style={{ left: node.x, top: node.y, width: WORKFLOW_CARD_WIDTH, minHeight: height, zIndex: selectedIds.has(node.id) ? 11000 : 9000 }}
        onPointerDownCapture={event => {
          if (armed && !busy) { event.stopPropagation(); event.preventDefault(); patch(node.id, { trigger: true }, false); setArmed(false); }
        }}
        onPointerDown={event => { if (event.button === 1 || (event.button === 0 && panReady)) return; event.stopPropagation(); if (!selectedIds.has(node.id) || event.ctrlKey || event.metaKey) onSelect(node.id, event.ctrlKey || event.metaKey); }} onDoubleClick={event => event.stopPropagation()}
        onKeyDown={event => { if (event.key !== "Escape") event.stopPropagation(); }}
        onContextMenu={event => onNodeMenu(event, node.id)} onWheel={event => { if ((event.target as HTMLElement).closest("textarea,.workflow-preview,.workflow-text-result")) event.stopPropagation(); }}
        onDragOver={event => { if (getDragAssets() || event.dataTransfer.types.includes("text/plain")) { event.preventDefault(); event.stopPropagation(); } }}
        onDrop={event => {
          event.preventDefault(); event.stopPropagation(); if (busy) return;
          const keyText = event.dataTransfer.getData("text/plain");
          const previousKey = keyText.startsWith("bowerbird-winding-key:") ? keyText.slice(22) : "";
          if (previousKey && document.nodes.some(node => node.id === previousKey && node.trigger)) {
            handle(controller.edit(document.nodes.map(candidate => ({ ...candidate, trigger: candidate.id === node.id || (candidate.id !== previousKey && candidate.trigger) })))); return;
          }
          const ids = getDragAssets(); if (!ids?.length) return;
          if (node.kind === "visual-profile" && node.profileId) { notifyError(null, "请先切换到从输入提炼"); return; }
          if (node.kind === "instruction" && node.action !== "describe" && ids.length !== 1) { notifyError(null, "此指令只接收一张图片"); return; }
          patch(node.id, { inputs: { ...node.inputs, image: ids.map(assetId => ({ assetId })) } });
        }}>
        {node.trigger && <button className={`workflow-key ${workflowRuns(document).some(item => item.startId === node.id && item.status === "running") ? "is-running" : ""}`} draggable={!busy}
          aria-label="上发条，运行工作流" aria-describedby={keyHover?.id === node.id ? "workflow-progress" : undefined}
          onMouseEnter={event => { const rect = event.currentTarget.getBoundingClientRect(); setKeyHover({ id: node.id, x: rect.left, y: rect.bottom }); }}
          onMouseLeave={() => setKeyHover(null)}
          onFocus={event => { const rect = event.currentTarget.getBoundingClientRect(); setKeyHover({ id: node.id, x: rect.left, y: rect.bottom }); }} onBlur={() => setKeyHover(null)}
          onDragStart={event => { event.stopPropagation(); event.dataTransfer.setData("text/plain", `bowerbird-winding-key:${node.id}`); }}
          onClick={() => { if (!busy) handle(controller.start(node.id)); }}
          onContextMenu={event => { event.preventDefault(); event.stopPropagation(); if (!busy) patch(node.id, { trigger: false }, false); }}><WindingKey size={32} /></button>}
        <header onPointerDown={event => {
          if ((event.target as HTMLElement).closest("button") || busy) return;
          onDragStart(event, node);
        }} onPointerMove={onDragMove} onPointerUp={event => onDragEnd(event)} onPointerCancel={event => onDragEnd(event, true)}>
          <GripHorizontal size={15} /><strong>{workflowTitle(node)}</strong>
          <button aria-label="复制卡片" disabled={busy} onClick={() => {
            const copy = { ...structuredClone(node), id: crypto.randomUUID(), x: node.x + 350, outputs: {}, sessionNodeIds: [], resultNodeIds: [], resultGroupId: undefined, trigger: false };
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
          {node.kind === "visual-profile" && <select aria-label="视觉规范来源" disabled={busy} value={node.profileId ?? ""} onChange={event => patch(node.id, { profileId: event.target.value || undefined, profileCache: undefined, inputs: {}, prompt: "" })}>
            <option value="">从图片 / 文字提炼</option>
            {node.profileId && !profiles.some(p => p.id === node.profileId) && <option value={node.profileId}>已选规范不可用</option>}
            {profiles.map(p => <option key={p.id} value={p.id}>{p.name} · v{p.version}</option>)}
          </select>}
          <div className="workflow-port-space" style={{ height: Math.max(inputPorts.length, outputPorts.length, 2) * 30 + (node.kind === "generation" ? 32 : 0) }} />
          {node.kind === "visual-profile" && !node.profileId && <input className="workflow-profile-name" aria-label="规范名称" disabled={busy} maxLength={80} placeholder="画板视觉规范" value={node.profileName ?? ""} onChange={event => patch(node.id, { profileName: event.target.value }, false)} />}
          {!(node.kind === "instruction" && node.action !== "describe") && !(node.kind === "visual-profile" && node.profileId) && <textarea aria-label={node.kind === "instruction" ? "反推要求" : node.kind === "visual-profile" ? "视觉要求" : "卡片指令"}
            disabled={busy} maxLength={node.kind === "visual-profile" ? 4000 : undefined} placeholder={node.kind === "instruction" ? "留空使用当前反推要求" : node.kind === "visual-profile" ? "描述配色、构图、光线等要求；可只接图片或只填文字…" : "输入创作要求，也可从文本端口接入…"}
            value={node.prompt} onChange={event => patch(node.id, { prompt: event.target.value })} />}
          {selectedImages.length > 0 ? <div className="workflow-preview">{selectedImages.map(asset => {
            const path = canvasAssetMediaPath({ thumbPath: asset.thumb_path ?? null, storePath: asset.store_path ?? null }) ?? "";
            return <img key={asset.id} title={asset.name} alt={asset.name} src={path.startsWith("data:") ? path : convertFileSrc(path)} />;
          })}</div>
            : <p className="workflow-hint"><ImagePlus size={14} />{node.kind === "visual-profile" ? "图片可选 · 规范只影响连接的下游" : "拖入图片，或连接左侧端口"}</p>}
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
            <button key={port} disabled={busy} title="断开此输入" onClick={() => patch(node.id, { inputs: { ...node.inputs, [port]: [] } })}>{port === "text" ? "文本" : port === "visual-profile" ? "视觉规范" : "图片"} · {bindings.length} 个来源 <X size={11} /></button>)}</div>}
          {step?.error && <p className="workflow-error" role="alert">{step.error}</p>}
          <footer>
            <span>{step ? statusLabels[step.status] : node.trigger ? "工作流起点" : "未运行"}</span>
            {busy && run?.order.includes(node.id) ? <>
              {run?.status === "waiting" && step?.status !== "done" && run.order.find(id => run!.steps[id].status !== "done") === node.id
                && <button aria-label="继续工作流" onClick={() => handle(controller.continue(run?.id))}><Play size={13} />继续</button>}
              <button aria-label="停止工作流" onClick={() => handle(controller.stop(run?.id))}><Square size={12} /></button>
            </> : <button disabled={busy} aria-label="运行此卡片" onClick={() => handle(controller.start(node.id, true))}><Play size={13} />运行此卡片</button>}
          </footer>
          {step?.agentRunId && <button className="workflow-detail" onClick={() => handle((async () => {
            const run = await api.cloudAgentGet(step.agentRunId!); useStore.getState().openCloudAgentRun(run, { navigate: false }); setAgentOpen(true);
          })())}>查看技能执行 / 审批</button>}
        </div>
        {inputPorts.map((port, index) => portButton(node, port, "input", index))}
        {outputPorts.map((port, index) => portButton(node, port, "output", index))}
      </article>;
    })}
    {armed && createPortal(<div className="workflow-key-ghost" style={{ left: cursor.x + 16, top: cursor.y + 16 }}><WindingKey size={30} />点击卡片吸附 · Esc 取消</div>, window.document.body)}
    {keyHover && createPortal(<div id="workflow-progress" role="tooltip" className="workflow-progress" style={{ left: Math.max(12, Math.min(keyHover.x, window.innerWidth - 340)), top: Math.max(12, Math.min(keyHover.y + 10, window.innerHeight - 320)) }}>
      {(() => {
        const run = [...workflowRuns(document)].reverse().find(item => item.startId === keyHover.id);
        if (!run) return <><strong>工作流起点</strong><p>点击运行下游流程 · 拖动更换起点 · 右键取下</p></>;
        const current = run.order.find(id => run.steps[id]?.status !== "done");
        return <><strong>{({running:"工作流运行中",waiting:"工作流等待继续",done:"工作流已完成",failed:"工作流已失败",stopped:"工作流已停止"})[run.status]} · {run.order.filter(id => run.steps[id]?.status === "done").length}/{run.order.length}</strong>
          {current && <p>第 {run.order.indexOf(current) + 1} 步：{run.steps[current]?.error || run.steps[current]?.detail || "准备执行"}</p>}
          <ol>{run.order.map((id, index) => {
            const card = document.nodes.find(item => item.id === id); const item = run.steps[id];
            const label = card?.kind === "instruction" ? ({describe:"反推",layers:"分层拆分",reuse:"复用生成提示词"})[card.action] : card ? workflowTitle(card) : "已移除卡片";
            return <li key={id} className={id === current ? "is-current" : ""}><span>{index + 1}. {label} · {item?.status === "done" ? "已完成" : id === current ? run.status === "running" ? "执行中" : run.status === "failed" ? "失败" : run.status === "stopped" ? "已停止" : "等待继续" : "等待上游"}</span>
              {id === current && <p>{item?.error || item?.detail || "准备执行"}</p>}</li>;
          })}</ol></>;
      })()}
    </div>, window.document.body)}
    {controller.error && createPortal(<div className="workflow-save-error" role="alert" onPointerDown={event => event.stopPropagation()}>{controller.error}<button onClick={() => handle(controller.retrySave())}>重试保存</button></div>, window.document.body)}
    {agentOpen && <ModalShell title="技能执行" width="lg" onClose={() => setAgentOpen(false)}><CloudAgentSession embedded /></ModalShell>}
  </>;
});
