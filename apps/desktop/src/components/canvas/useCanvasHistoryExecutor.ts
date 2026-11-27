import { api } from "../../lib/api";
import { readCanvasNote, type CanvasNotePayload } from "../../lib/canvasNotes";
import { restoreCanvasNoteEdit } from "../../lib/canvasNoteUndo";
import type { CanvasRect } from "../../lib/canvasLogic";
import { canvasWorkflowController } from "../../lib/canvasWorkflowRuntime";
import { newProjectCanvasAssetNode, newProjectCanvasGroup, projectCanvasGroupUpdate, projectCanvasNodeLayoutUpdate } from "../../lib/creativeCanvas";
import { notify, notifyError } from "../../lib/notify";
import type { CanvasGroup, CanvasNode as ProjectGraphNode, CreativeViewMode } from "../../lib/types";
import { useLatestCallback } from "../../lib/useCanvasFrame";
import { isWorkspaceOperationCurrent } from "../../lib/workspaceRoute";
import { invertWorkflowEditUndo, restoreWorkflowEdit, workflowEditUndo, type WorkflowEditUndo } from "../../lib/workflowUndo";
import { useStore } from "../../store";
import type { WorkflowGeometry, WorkflowLayerHandle } from "../CanvasWorkflowLayer";
import {
  canvasGeometryDiffers, containedNodeIds, groupedAssetNode, workflowReferencesTo,
  type ActiveCanvasState, type CanvasAssetNode, type CanvasFolderNode, type CanvasNode,
} from "./canvasWorkspaceHelpers";
import type { CanvasDrag } from "./useCanvasDrag";
import type { CanvasHistoryMode, CanvasUndoEntry, ConsumeCanvasHistory, useCanvasUndo } from "./useCanvasUndo";

interface CanvasHistoryExecutorDeps {
  activeCanvasRef: { readonly current: ActiveCanvasState };
  nodesRef: { readonly current: CanvasNode[] };
  graphNodesRef: { readonly current: ProjectGraphNode[] };
  groupsRef: { readonly current: Map<string, CanvasGroup> };
  workflowRef: { readonly current: WorkflowLayerHandle | null };
  writeQueueRef: { readonly current: Promise<void> };
  workspaceRef: { readonly current: HTMLDivElement | null };
  viewModeRef: { readonly current: CreativeViewMode };
  activeDragRef: { readonly current: CanvasDrag | null };
  scopedInspectorOpen: boolean;
  undoHistoryRef: ReturnType<typeof useCanvasUndo>["undoHistoryRef"];
  pushCanvasUndo: ReturnType<typeof useCanvasUndo>["pushCanvasUndo"];
  clearCanvasRedo: ReturnType<typeof useCanvasUndo>["clearCanvasRedo"];
  undoCanvasAction: ReturnType<typeof useCanvasUndo>["undoCanvasAction"];
  setGraphNodes: (nodes: ProjectGraphNode[]) => void;
  commitNodes: (nodes: CanvasNode[]) => void;
  enqueueWrite: (work: () => Promise<void>) => Promise<void>;
  ensureMaterialized: (draft: ActiveCanvasState) => Promise<boolean>;
  persistGeometries: (materials: readonly CanvasNode[], graph: readonly ProjectGraphNode[]) => void;
  refreshClipboardCanvas: (project: string) => Promise<void>;
  removeNodes: (ids: Iterable<string>, expandConversations: boolean, replay: (inverse: CanvasUndoEntry) => void) => Promise<void> | undefined;
  claimSectionMembers: (rect: CanvasRect, sectionId: string) => string[];
  updateCanvasNote: (nodeId: string, value: CanvasNotePayload, size: undefined, history: "layout") => void;
}

export function useCanvasHistoryExecutor({
  activeCanvasRef, nodesRef, graphNodesRef, groupsRef, workflowRef, writeQueueRef,
  workspaceRef, viewModeRef, activeDragRef, scopedInspectorOpen,
  undoHistoryRef, pushCanvasUndo, clearCanvasRedo, undoCanvasAction,
  setGraphNodes, commitNodes, enqueueWrite, ensureMaterialized, persistGeometries,
  refreshClipboardCanvas, removeNodes, claimSectionMembers, updateCanvasNote,
}: CanvasHistoryExecutorDeps) {
  /** 记录一次移动/层级/缩放前的快照；连续层级微调合并为一条撤销记录。 */
  function pushGeometryUndo(materials: readonly CanvasNode[], graph: readonly ProjectGraphNode[], workflow: WorkflowGeometry[] = []) {
    const draft = activeCanvasRef.current;
    const materialBefore = materials.filter((before) => {
      const after = nodesRef.current.find((node) => node.id === before.id);
      return !!after && (canvasGeometryDiffers(before, after) || before.order !== after.order);
    });
    const graphBefore = graph.filter((before) => {
      if (before.hiddenAt != null) return false;
      const after = graphNodesRef.current.find((node) => node.id === before.id);
      return !!after && (canvasGeometryDiffers(before, after) || before.zIndex !== after.zIndex);
    });
    const workflowBefore = workflow.filter(before => { const after = workflowRef.current?.bounds(true).find(node => node.id === before.id); return after && (before.x !== after.x || before.y !== after.y); });
    if (materialBefore.length === 0 && graphBefore.length === 0 && workflowBefore.length === 0) return;
    const ids = new Set([...materialBefore, ...graphBefore].map((node) => node.id));
    const top = undoHistoryRef.current[undoHistoryRef.current.length - 1];
    if (top?.kind === "geometry" && !workflowBefore.length && !top.workflow.length && top.projectId === draft.id
      && top.materials.length === materialBefore.length && top.graph.length === graphBefore.length
      && top.materials.every((node) => ids.has(node.id)) && top.graph.every((node) => ids.has(node.id))
      && top.materials.every((node) => !canvasGeometryDiffers(node, nodesRef.current.find((live) => live.id === node.id)))
      && top.graph.every((node) => !canvasGeometryDiffers(node, graphNodesRef.current.find((live) => live.id === node.id)))) {
      clearCanvasRedo();
      return;
    }
    pushCanvasUndo({ kind: "geometry", projectId: draft.id, materials: materialBefore, graph: graphBefore, workflow: workflowBefore });
  }

  async function applyCanvasUndo(entry: CanvasUndoEntry, mode: CanvasHistoryMode, consume: ConsumeCanvasHistory) {
    const undo = mode === "undo";
    const action = undo ? "撤销" : "重做";
    if (entry.kind === "gallery") {
      await api.undoGenerationGalleryMerge(entry.edit).then(() => { consume(); })
        .catch(error => notifyError(error, "合组撤销未完成"));
      return;
    }
    if (entry.kind === "names") {
      const controller = canvasWorkflowController(entry.projectId);
      const cardNames = { ...controller.document.cardNames };
      const changes = Object.entries(entry.before);
      const before = Object.fromEntries(changes.map(([id]) => [id, cardNames[id]]));
      for (const [id, name] of changes) {
        if (name === undefined) delete cardNames[id]; else cardNames[id] = name;
      }
      consume()({ ...entry, before });
      await controller.save({ ...controller.document, cardNames }).catch(error => notifyError(error, `名称${action}未完成`));
      return;
    }
    if (entry.kind === "content") {
      const controller = canvasWorkflowController(entry.projectId);
      if (controller.isLocked(entry.before.id)) return;
      const live = graphNodesRef.current.find(node => node.id === entry.before.id && node.hiddenAt == null);
      if (!live) return;
      const restored = { ...live, payloadJson: restoreCanvasNoteEdit(live.payloadJson, entry.before.payloadJson, entry.after.payloadJson),
        width: live.width === entry.after.width ? entry.before.width : live.width,
        height: live.height === entry.after.height ? entry.before.height : live.height };
      consume()({ ...entry, before: live, after: restored, typedAt: undefined });
      setGraphNodes(graphNodesRef.current.map(node => node.id === live.id ? restored : node));
      await enqueueWrite(async () => {
        await api.projectCanvasNoteUpdate(restored.id, restored.payloadJson);
        await api.projectCanvasNodeUpdate(restored.id, { x: restored.x, y: restored.y, width: restored.width, height: restored.height, zIndex: restored.zIndex, positionLocked: restored.positionLocked });
        for (const node of entry.restoredMaterials ?? []) {
          if (!undo) await api.projectCanvasNodeRemove(node.id);
          else if (!await api.projectCanvasNodeRestore(entry.projectId, node.id) && node.kind === "asset") {
            await api.projectCanvasNodeCreate(newProjectCanvasAssetNode(entry.projectId, node));
          }
        }
        if (entry.restoredMaterials?.length) await refreshClipboardCanvas(entry.projectId);
      });
      return;
    }
    if (entry.kind === "materials") {
      const affected = new Set([...entry.before, ...entry.after].map(node => node.id));
      consume()({ ...entry, before: nodesRef.current.filter(node => affected.has(node.id)), after: entry.before, groups: new Map(groupsRef.current) });
      commitNodes([...nodesRef.current.filter(node => !affected.has(node.id)), ...entry.before]);
      const restoredGroups = new Set<string>();
      await enqueueWrite(async () => {
        for (const node of entry.after) if (node.kind === "folder" && !restoredGroups.has(node.id)) {
          await api.projectCanvasGroupDelete(node.id); groupsRef.current.delete(node.id);
        }
        const assetNodes = entry.before.flatMap(node => node.kind === "asset" ? [node] : node.assets.map((asset, i) => groupedAssetNode(asset, node, i)));
        const retained = new Set(assetNodes.map(node => node.id));
        for (const node of entry.after) for (const id of node.kind === "asset" ? [node.id] : node.assets.map(asset => asset.id)) {
          if (!retained.has(id)) await api.projectCanvasNodeRemove(id);
        }
        if (assetNodes.length) {
          if (!undo) {
            const currentIds = containedNodeIds(entry.after);
            for (const node of assetNodes) if (!currentIds.has(node.id) && !await api.projectCanvasNodeRestore(entry.projectId, node.id)) {
              await api.projectCanvasNodeCreate(newProjectCanvasAssetNode(entry.projectId, node));
            }
          }
          await api.projectCanvasNodesBatchUpdate(entry.projectId, assetNodes.map(node => ({ nodeId: node.id, value: projectCanvasNodeLayoutUpdate(node) })));
        }
        for (const node of entry.before) if (node.kind === "folder" && !restoredGroups.has(node.id)) {
          const original = entry.groups.get(node.id);
          const group = await api.projectCanvasGroupCreate(original ? projectCanvasGroupUpdate(original, node) : newProjectCanvasGroup(entry.projectId, node), node.assets.map(asset => asset.id));
          groupsRef.current.set(node.id, group);
          restoredGroups.add(node.id);
        }
      });
      return;
    }
    if (entry.kind === "workflow") {
      const controller = canvasWorkflowController(entry.projectId);
      if (controller.error) { notify(`请先重试保存工作流，再${action}卡片操作`, "info"); return; }
      const before = controller.document;
      const restored = restoreWorkflowEdit(before.nodes, entry.edit);
      const pending = controller.edit(restored, entry.edit);
      if (controller.document !== before) {
        const inverse = invertWorkflowEditUndo(entry.edit);
        consume()({ ...entry, edit: undo ? inverse : workflowEditUndo(before, controller.document) ?? inverse });
      }
      await pending.catch(error => notifyError(error, `工作流${action}未完成`));
      return;
    }
    if (entry.kind === "paste") {
      const controller = canvasWorkflowController(entry.projectId);
      const label = entry.removal !== undefined ? "重做删除" : "撤销粘贴";
      if (entry.workflowIds.some(id => controller.isLocked(id))) { notify(`请先停止这组卡片的工作流再${label}`, "info"); return; }
      const workflowIds = new Set(entry.workflowIds);
      const references = new Set([...workflowIds, ...entry.nodeIds, ...entry.groupIds]);
      // A replay may remove wiring restored by the preceding undo.
      const restoredNodes = new Map(entry.removal?.nodes.map(change => [change.id, change.before]));
      if (controller.document.nodes.some(node => {
        if (workflowIds.has(node.id)) return false;
        const restored = restoredNodes.get(node.id);
        const previous = restored && workflowReferencesTo(restored, references);
        return [...workflowReferencesTo(node, references)].some(reference => !previous?.has(reference));
      })) {
        notify(`这组卡片已有新的外部连线，请先断开后再${label}`, "info"); return;
      }
      if (entry.removal !== undefined) {
        await removeNodes(references, false, inverse => consume()(inverse));
        return;
      }
      const materials = nodesRef.current.filter(node => references.has(node.id));
      const geometry = new Map(materials.filter((node): node is CanvasAssetNode => node.kind === "asset").map(node => [node.id, node]));
      const graph = graphNodesRef.current.filter(node => references.has(node.id) && node.hiddenAt == null).map(node => {
        const live = geometry.get(node.id);
        return live ? { ...node, ...projectCanvasNodeLayoutUpdate(live), positionLocked: node.positionLocked } : node;
      });
      const changedFolders = nodesRef.current.filter((node): node is CanvasFolderNode =>
        node.kind === "folder" && !references.has(node.id) && node.assets.some(asset => references.has(asset.id)));
      const recordInverse = consume();
      let workflow: WorkflowEditUndo | null = null;
      await enqueueWrite(async () => {
        if (controller.error) await controller.retrySave();
        if (controller.document.nodes.some(node => workflowIds.has(node.id))) {
          const before = controller.document;
          const pending = controller.edit(before.nodes.filter(node => !workflowIds.has(node.id)));
          const removed = workflowEditUndo(before, controller.document);
          if (removed) workflow = { ...removed, removedRuns: [], runOrder: [] };
          await pending;
        }
        const groups = new Map(groupsRef.current);
        for (const id of entry.groupIds) await api.projectCanvasGroupDelete(id);
        for (const id of entry.nodeIds) await api.projectCanvasNodeRemove(id);
        await refreshClipboardCanvas(entry.projectId);
        recordInverse({ kind: "removal", projectId: entry.projectId, materials, graph, changedFolders, groups, workflow, fromPaste: true });
      });
      return;
    }
    let workflowUndo: Promise<void> | undefined;
    if (entry.kind === "removal" && entry.workflow) {
      const controller = canvasWorkflowController(entry.projectId);
      if (controller.error) { notify(`请先重试保存工作流，再${action}卡片操作`, "info"); return; }
      const before = controller.document;
      const pending = controller.edit(restoreWorkflowEdit(before.nodes, entry.workflow), entry.workflow);
      workflowUndo = pending.then(() => {}, error => { notifyError(error, `工作流${action}未完成`); });
      if (controller.document === before) return workflowUndo;
    }
    if (entry.kind === "geometry") {
      const materialBefore = new Map(entry.materials.map((node) => [node.id, node]));
      const graphBefore = new Map(entry.graph.map((node) => [node.id, node]));
      const workflowBefore = new Map(entry.workflow.map(node => [node.id, node]));
      consume()({ ...entry,
        materials: nodesRef.current.filter(node => materialBefore.has(node.id)),
        graph: graphNodesRef.current.filter(node => graphBefore.has(node.id)),
        workflow: workflowRef.current?.bounds(true).filter(node => workflowBefore.has(node.id)) ?? [],
      });
      workflowRef.current?.position(workflowBefore, true);
      commitNodes(nodesRef.current.map((node) => {
        const before = materialBefore.get(node.id);
        return before ? { ...node, x: before.x, y: before.y, width: before.width, height: before.height, order: before.order } : node;
      }));
      const next = graphNodesRef.current.map((node) => {
        const before = graphBefore.get(node.id);
        return before ? { ...node, x: before.x, y: before.y, width: before.width, height: before.height, zIndex: before.zIndex } : node;
      });
      setGraphNodes(next);
      persistGeometries(nodesRef.current.filter(node => materialBefore.has(node.id)),
        next.filter(node => node.kind !== "asset" && graphBefore.has(node.id)));
      // 分区几何恢复后按还原范围重新圈定成员；等 DOM 提交后再取实际显示尺寸。
      window.requestAnimationFrame(() => {
        if (activeCanvasRef.current.id !== entry.projectId) return;
        for (const node of graphNodesRef.current) {
          if (node.kind !== "note" || node.hiddenAt != null || !graphBefore.has(node.id)) continue;
          const value = readCanvasNote(node);
          if (value.note_type === "section" && !value.workflow_container && !value.artboard) updateCanvasNote(node.id, { ...value, member_ids: claimSectionMembers(node, node.id) }, undefined, "layout");
        }
      });
      await writeQueueRef.current;
      if (entry.workflow.length) await canvasWorkflowController(entry.projectId).flush();
      return;
    }
    const ids = new Set(entry.graph.map((node) => node.id));
    const groupIds = entry.materials.filter(node => node.kind === "folder").map(node => node.id);
    const nodeIds = [...new Set([...ids, ...containedNodeIds(entry.materials)])];
    const workflowIds = entry.workflow?.nodes.flatMap(change => change.before && !change.after ? [change.id] : []) ?? [];
    consume()({ kind: "paste", projectId: entry.projectId, nodeIds, groupIds, workflowIds,
      removal: entry.fromPaste ? undefined : entry.workflow ?? null });
    const currentIds = new Set(nodesRef.current.map((node) => node.id));
    const folders = new Map(entry.changedFolders?.map(folder => [folder.id, folder]));
    commitNodes([...nodesRef.current.map(node => folders.get(node.id) ?? node), ...entry.materials.filter((node) => !currentIds.has(node.id))]);
    const graphIds = new Set(graphNodesRef.current.map((node) => node.id));
    const next = [...graphNodesRef.current.map((node) => ids.has(node.id) ? { ...node, hiddenAt: null } : node),
      ...entry.graph.filter((node) => !graphIds.has(node.id))];
    setGraphNodes(next);
    const draft = activeCanvasRef.current;
    const restoredGroups = new Set<string>();
    await enqueueWrite(async () => {
      await ensureMaterialized(draft);
      const restored = new Set<string>();
      for (const original of entry.graph) {
        if (!await api.projectCanvasNodeRestore(entry.projectId, original.id)) {
          const { hiddenAt: _hidden, createdAt: _created, updatedAt: _updated, ...input } = original;
          await api.projectCanvasNodeCreate(input);
        }
        restored.add(original.id);
      }
      for (const folder of folders.values()) await api.projectCanvasGroupSetItems(folder.id, folder.assets.map(asset => asset.id));
      for (const node of entry.materials) {
        const assets = node.kind === "asset" ? [node] : node.assets.map((asset, index) => groupedAssetNode(asset, node, index));
        for (const asset of assets) {
          if (!restored.has(asset.id) && !await api.projectCanvasNodeRestore(entry.projectId, asset.id)) {
            await api.projectCanvasNodeCreate(newProjectCanvasAssetNode(entry.projectId, asset));
          }
        }
        if (node.kind === "folder" && !restoredGroups.has(node.id)) {
          const original = entry.groups.get(node.id);
          const group = await api.projectCanvasGroupCreate(original ? projectCanvasGroupUpdate(original, node) : newProjectCanvasGroup(entry.projectId, node), node.assets.map((asset) => asset.id));
          groupsRef.current.set(node.id, group);
          restoredGroups.add(node.id);
        }
      }
    });
    await workflowUndo;
  }

  const undoGenerationConnection = useLatestCallback((nodeId: string) => {
    const entry = undoHistoryRef.current[undoHistoryRef.current.length - 1];
    const route = useStore.getState();
    if (!entry || entry.kind !== "workflow" || entry.connectedGenerationId !== nodeId
      || entry.projectId !== activeCanvasRef.current.id || !isWorkspaceOperationCurrent(entry.projectId, route.activeProjectId, route.projectRoutePending)
      || workspaceRef.current?.closest("[inert]")
      || scopedInspectorOpen || viewModeRef.current !== "canvas" || activeDragRef.current
      || document.querySelector('[data-context-owner], [role="dialog"][aria-modal="true"]')) return false;
    return undoCanvasAction();
  });

  function pushMaterialsUndo(before: CanvasNode[], after: CanvasNode[]) {
    const previous = new Map(before.map(node => [node.id, node])), next = new Map(after.map(node => [node.id, node]));
    const changed = new Set([...previous.keys(), ...next.keys()].filter(id => previous.get(id) !== next.get(id)
      && JSON.stringify(previous.get(id)) !== JSON.stringify(next.get(id))));
    if (changed.size) pushCanvasUndo({ kind: "materials", projectId: activeCanvasRef.current.id,
      before: before.filter(node => changed.has(node.id)), after: after.filter(node => changed.has(node.id)), groups: new Map(groupsRef.current) });
  }

  return { pushGeometryUndo, applyCanvasUndo, undoGenerationConnection, pushMaterialsUndo };
}
