import { userErrorMessage } from "../lib/userError";
import { localChatRunning } from "../lib/localChat";
import { ConfirmDialog } from "./ConfirmDialog";
import { forwardRef, memo, useImperativeHandle } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { startComposerLocalVideo } from "../lib/composerLocalVideo";
import { WorkflowDisconnectMenu } from "./WorkflowDisconnectMenu";
import { WorkflowLoopFrame } from "./WorkflowLoopFrame";
import { expandCanvasSections, readCanvasNote } from "../lib/canvasNotes";
import { canvasInputValue } from "../lib/canvasSessionOutputs";
import { notifyError, notifySuccess } from "../lib/notify";
import { workflowDiagnosticReport } from "../lib/workflowDiagnostics";
import { retryWorkflowSave } from "../lib/workflowRemoval";
import { newWorkflowNode, workflowRuns, workflowTitle, workflowCardWidth } from "../lib/canvasWorkflow";
import { CloudAgentSession } from "./CloudAgentPanel";
import { ModalShell } from "./ModalShell";
import { WorkflowTemplateLibrary } from "./WorkflowTemplateLibrary";
import { SaveWorkflowTemplateDialog } from "./SaveWorkflowTemplateDialog";
import { WindingKey, WorkflowLayerHandle, WorkflowLayerProps, Connection, CONNECTION_CARDS } from "./workflowLayerShared";
import { useWorkflowLayerState } from "./useWorkflowLayerState";
import { useWorkflowConnections } from "./useWorkflowConnections";
import { WorkflowCardList } from "./WorkflowCardList";
import { WorkflowWires } from "./WorkflowWires";
import { WorkflowCardMenu } from "./WorkflowCardMenu";

export { WindingKey } from "./workflowLayerShared";
export type { WorkflowLayerHandle, WorkflowGeometry, MaterialAnchor } from "./workflowLayerShared";
import "./CanvasWorkflow.css";

export const CanvasWorkflowLayer = memo(forwardRef<WorkflowLayerHandle, WorkflowLayerProps>(function CanvasWorkflowLayer(props, ref) {
  const layer = useWorkflowLayerState(props);
  const connections = useWorkflowConnections(props, layer);
  const {
    ensureMaterialized, onSelect, projectId, graphNodes, materials, activeGenerationIds, selectedIds,
    conversationCards, imageOnlyConversationIds,
    sessionHeights, diagnosticTarget = window.document.body, onPlaced
  } = props;
  const {
    controller, edit, setTemplateLibrary, setTemplateSelection, cardElements, connectionRef,
    setConnection, setCursor, patch, state, armed, automaticRef, setBlankCardMenu, graphById,
    materialById, setArmed, collapsedAnchor, displayPoint, cardHeights, chatSummaries,
    agentActionLocks, redraw, handle, document, assets, visibleGraphNodes,
    cardMounted, sessionIds, collapsedAnchorOwners, nameEditor, disconnectMenu, setDisconnectMenu,
    frames, hoveredMaterial, ghostElement, cursor, keyHover, issue, deliveryRunIds,
    issueSourceLabel, locateIssue, issueSourceId, connectionHover, agentOpen,
    setAgentOpen, localRunReview, setLocalRunReview, runCard, retryReview, setRetryReview,
    templateLibrary, templateSelection
  } = layer;
  const {
    inputText, automaticOutputs, beginAutomatic, addCard, connectionCard, commitAutomatic,
    clearAutomatic, disconnectChoices, gearButton, keyButton, automaticButton
  } = connections;
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
    {disconnectMenu && <WorkflowDisconnectMenu {...disconnectMenu} choices={disconnectChoices(disconnectMenu)} assets={assets} onClose={() => setDisconnectMenu(null)} />}
    {Array.from(frames, ([id, frame]) => <WorkflowLoopFrame key={id} {...frame} />)}
    <WorkflowWires props={props} layer={layer} connections={connections} />
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
    <WorkflowCardList props={props} layer={layer} connections={connections} />
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
    {connectionHover?.error && createPortal(<div className="canvas-connection-notice" role="status" style={{ left: cursor.current.x + 16, top: cursor.current.y + 16 }}>{userErrorMessage(connectionHover.error, "此卡片暂时不能连接")}</div>, window.document.body)}
    <WorkflowCardMenu props={props} layer={layer} connections={connections} />
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
}));
