import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { readCanvasNote } from "../lib/canvasNotes";
import { workflowCardWidth, workflowRuns, workflowTitle, type CanvasWorkflow, type WorkflowKind, type WorkflowNode } from "../lib/canvasWorkflow";
import { notifySuccess } from "../lib/notify";
import type { Asset, CanvasNode } from "../lib/types";
import { userErrorMessage } from "../lib/userError";
import type { AutomaticOutput } from "../lib/workflowAutoConnect";
import { workflowDiagnosticReport } from "../lib/workflowDiagnostics";
import { retryWorkflowSave } from "../lib/workflowRemoval";
import { CloudAgentSession } from "./CloudAgentPanel";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContextMenu, ContextSubmenu } from "./ContextMenu";
import { ModalShell } from "./ModalShell";
import { SaveWorkflowTemplateDialog } from "./SaveWorkflowTemplateDialog";
import { WorkflowDisconnectMenu, type DisconnectChoice } from "./WorkflowDisconnectMenu";
import { WorkflowTemplateLibrary } from "./WorkflowTemplateLibrary";

import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import type { CanvasWorkflowController } from "../lib/canvasWorkflowRuntime";
import type { WorkflowDiagnostic } from "../lib/workflowDiagnostics";
import type { AutomaticGesture, AutomaticTarget, ConnectionMenuState, VideoReferenceTarget } from "./useWorkflowConnectionGesture";
import { CONNECTION_CARDS, VIDEO_REFERENCE_OPTIONS } from "./useWorkflowConnectionGesture";
import { WindingKey, WORKFLOW_CARD_PRESENTATION } from "./WorkflowLayerPresentation";
import type { DisconnectTarget, H3RunChoice, MaterialAnchor, WorkflowGeometry, WorkflowLayerProps, WorkflowLayerStore } from "./WorkflowLayerTypes";
interface WorkflowOverlaysProps {
  armed: boolean;
  ghostElement: RefObject<HTMLDivElement>;
  cursor: MutableRefObject<{ x: number; y: number; }>;
  keyHover: { id: string; x: number; y: number; anchor: HTMLElement; rect: DOMRect; focus: boolean; } | null;
  document: CanvasWorkflow;
  issue: WorkflowDiagnostic | null;
  diagnosticTarget: HTMLElement | null;
  deliveryRunIds: Set<string>;
  controller: CanvasWorkflowController;
  issueSourceLabel: string;
  locateIssue: (id: string) => void;
  handle: (promise: Promise<unknown>) => void;
  issueSourceId: string | undefined;
  graphNodes: CanvasNode[];
  connectionHover: { id: string; error: string | null; } | null;
  nodeById: Map<string, WorkflowNode>;
  graphById: Map<string, CanvasNode>;
  materialById: Map<string, MaterialAnchor>;
  automatic: AutomaticGesture | null;
  peekCard: { nodeId: string; anchorId: string; point: { x: number; y: number; }; } | undefined;
  displayPoint: (node: WorkflowNode) => WorkflowNode | { x: number; y: number; };
  cardHeights: MutableRefObject<Map<string, number>>;
  sessionHeights: ReadonlyMap<string, number> | undefined;
  cardMenu: ConnectionMenuState | { x: number; y: number; point: { x: number; y: number; }; } | null;
  videoConnection: VideoReferenceTarget | undefined;
  connectionMenu: ConnectionMenuState | null;
  clearAutomatic: () => void;
  setBlankCardMenu: Dispatch<SetStateAction<{ x: number; y: number; point: { x: number; y: number; }; } | null>>;
  videoReferenceError: (video: VideoReferenceTarget, frame?: "first" | "last" | undefined) => string | null;
  commitAutomatic: (outputs: AutomaticOutput[], target: AutomaticTarget, createNodes?: WorkflowNode[], frame?: "first" | "last" | undefined) => void;
  newConnectionError: (gesture: AutomaticGesture, node: WorkflowNode) => string | null;
  connectionCard: (option: { label: string; kind: WorkflowKind; media?: "image" | "video" | undefined; action?: WorkflowNode["action"]; }, point: { x: number; y: number; }) => WorkflowNode;
  createConnected: (option: { label: string; kind: WorkflowKind; media?: "image" | "video" | undefined; action?: WorkflowNode["action"]; }) => void;
  blankCardMenu: { x: number; y: number; point: { x: number; y: number; }; } | null;
  addCard: (node: WorkflowNode) => void;
  materials: MaterialAnchor[];
  generationAnchorOwners: Map<string, string>;
  conversationCards: WorkflowLayerProps["conversationCards"];
  receiverError: (outputs: AutomaticOutput[], target: AutomaticTarget, created?: WorkflowNode | undefined) => string | null;
  gestureOutputs: (gesture: AutomaticGesture, otherId: string) => AutomaticOutput[];
  automaticTarget: (id: string) => AutomaticTarget;
  chooseAutomaticReceiver: (gesture: AutomaticGesture, outputs: AutomaticOutput[], target: AutomaticTarget, point: { x: number; y: number; }, created?: WorkflowNode | undefined) => void;
  cardNames: Record<string, string>;
  selectConnectionScope: (cellId?: string | undefined) => void;
  beginAutomatic: (id: string, side: "output" | "input", point: { x: number; y: number; }, keyboard?: boolean, latest?: boolean, scope?: string | undefined, selectionOutputs?: AutomaticOutput[] | undefined) => void;
  agentOpen: boolean;
  setAgentOpen: Dispatch<SetStateAction<boolean>>;
  localRunReview: { projectId: string; nodeId: string; single: boolean; choice?: H3RunChoice | undefined; } | null;
  projectId: string;
  setLocalRunReview: Dispatch<SetStateAction<{ projectId: string; nodeId: string; single: boolean; choice?: H3RunChoice | undefined; } | null>>;
  runCard: (nodeId: string, single: boolean, confirmed?: boolean, choice?: H3RunChoice | undefined) => void;
  retryReview: { projectId: string; cardNames: string[]; confirm: () => Promise<void>; } | null;
  setRetryReview: Dispatch<SetStateAction<{ projectId: string; cardNames: string[]; confirm: () => Promise<void>; } | null>>;
  templateLibrary: { instanceRoot?: string | undefined; importPackage?: boolean | undefined; } | null;
  selectedIds: Set<string>;
  state: WorkflowLayerStore;
  ensureMaterialized: () => Promise<unknown>;
  setTemplateLibrary: Dispatch<SetStateAction<{ instanceRoot?: string | undefined; importPackage?: boolean | undefined; } | null>>;
  templateSelection: { projectId: string; ids: string[]; nodes: WorkflowNode[]; canvas: CanvasNode[]; bounds: WorkflowGeometry[]; mode: "template" | "container" | "package"; } | null;
  onPlaced: (rect: { x: number; y: number; width: number; height: number; }) => void;
  setTemplateSelection: Dispatch<SetStateAction<{ projectId: string; ids: string[]; nodes: WorkflowNode[]; canvas: CanvasNode[]; bounds: WorkflowGeometry[]; mode: "template" | "container" | "package"; } | null>>;
}

export function WorkflowOverlays({
  armed, ghostElement, cursor, keyHover, document, issue, diagnosticTarget, deliveryRunIds, controller,
  issueSourceLabel, locateIssue, handle, issueSourceId, graphNodes, connectionHover, nodeById, graphById,
  materialById, automatic, peekCard, displayPoint, cardHeights, sessionHeights, cardMenu, videoConnection,
  connectionMenu, clearAutomatic, setBlankCardMenu, videoReferenceError, commitAutomatic,
  newConnectionError, connectionCard, createConnected, blankCardMenu, addCard, materials,
  generationAnchorOwners, conversationCards, receiverError, gestureOutputs, automaticTarget,
  chooseAutomaticReceiver, cardNames, selectConnectionScope, beginAutomatic, agentOpen, setAgentOpen,
  localRunReview, projectId, setLocalRunReview, runCard, retryReview, setRetryReview, templateLibrary,
  selectedIds, state, ensureMaterialized, setTemplateLibrary, templateSelection, onPlaced,
  setTemplateSelection,
}: WorkflowOverlaysProps) {
  return <>
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
      const point = node && (!automatic?.completion ? node : peekCard?.nodeId === node.id
        ? { x: peekCard.point.x - workflowCardWidth(node) - 12, y: peekCard.point.y } : displayPoint(node));
      const rect = node && point ? { x: point.x, y: point.y, width: workflowCardWidth(node), height: cardHeights.current.get(node.id) ?? 300 }
        : card && automatic?.completion ? { ...card, height: sessionHeights?.get(card.id) ?? card.height } : card;
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
          if (connectionMenu.gesture.side === "output" && generationAnchorOwners.has(id)) return false;
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
      onConfirm={() => { setLocalRunReview(null); runCard(localRunReview.nodeId, localRunReview.single, true, localRunReview.choice); }} />}
    {retryReview?.projectId === projectId && <ConfirmDialog open title="重做失败步骤？" confirmLabel="保留卡片并重做"
      message={`这一步已创建：${retryReview.cardNames.join("、")}。重做会保留这些卡片，也可能再次创建相同的内容。`}
      onCancel={() => setRetryReview(null)} onConfirm={() => { setRetryReview(null); handle(retryReview.confirm()); }} />}
    {templateLibrary && <WorkflowTemplateLibrary controller={controller} selectedIds={selectedIds} graphNodes={graphNodes} provider={state.activeGenProvider || state.defaultProvider}
      instanceRoot={templateLibrary.instanceRoot} importPackage={templateLibrary.importPackage} ensureMaterialized={ensureMaterialized} onClose={() => setTemplateLibrary(null)} onLocate={locateIssue} />}
    {templateSelection?.projectId === projectId && <SaveWorkflowTemplateDialog nodes={templateSelection.nodes} selectedIds={templateSelection.ids} graphNodes={templateSelection.canvas} bounds={templateSelection.bounds} mode={templateSelection.mode}
      onEncapsulate={async (name, members, template) => { await ensureMaterialized(); const result = await controller.encapsulate(name, members, templateSelection.bounds, template); onPlaced(result.bounds); return result; }}
      onClose={() => setTemplateSelection(null)} onSaved={() => notifySuccess(templateSelection.mode === "package" ? "工作流数据包已导出，可发送给对方导入" : templateSelection.mode === "template" ? "已存为模板，并保留封装布局" : "已封装为容器")} />}
  </>;
}
interface WorkflowDisconnectOverlayProps {
  disconnectMenu: ({ x: number; y: number; } & DisconnectTarget) | null;
  disconnectChoices: (target: DisconnectTarget) => DisconnectChoice[];
  assets: Asset[];
  setDisconnectMenu: Dispatch<SetStateAction<({ x: number; y: number; } & DisconnectTarget) | null>>;
}

export function WorkflowDisconnectOverlay({
  disconnectMenu, disconnectChoices, assets, setDisconnectMenu,
}: WorkflowDisconnectOverlayProps) {
  return <>
    {disconnectMenu && <WorkflowDisconnectMenu {...disconnectMenu} choices={disconnectChoices(disconnectMenu)} assets={assets} onClose={() => setDisconnectMenu(null)} />}
  </>;
}
