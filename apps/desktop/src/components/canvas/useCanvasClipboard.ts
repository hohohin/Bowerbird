import { useEffect, useRef, type MutableRefObject } from "react";
import { api } from "../../lib/api";
import { captureCanvasClipboard, cloneCanvasClipboard, parseCanvasClipboard, serializeCanvasClipboard, type CanvasClipboard } from "../../lib/canvasClipboard";
import { canvasViewForNewCard, type CanvasPoint, type CanvasRect } from "../../lib/canvasLogic";
import { canvasTextMinSize, emptyCanvasCell } from "../../lib/canvasNotes";
import { canvasWorkflowController } from "../../lib/canvasWorkflowRuntime";
import { clipboardEditing, clipboardMediaFiles } from "../../lib/clipboardMedia";
import { newProjectCanvasAssetNode, projectCanvasAssetIds, projectGraphNodesWithLiveLayout } from "../../lib/creativeCanvas";
import { prepareExplorerCanvasDrop } from "../../lib/explorerCanvasDrop";
import { importDroppedMedia, prepareMediaImport, readClipboardMediaPaths } from "../../lib/mediaImport";
import { notify, notifyError } from "../../lib/notify";
import { originalDeletionEpoch } from "../../lib/pendingOriginalDeletion";
import type { Asset, CanvasGroup, CanvasNode as ProjectGraphNode, CreativeViewMode, ProjectCanvasSnapshot } from "../../lib/types";
import { isWorkspaceOperationCurrent } from "../../lib/workspaceRoute";
import { useStore } from "../../store";
import type { ActiveCanvasState, CanvasNode } from "./canvasWorkspaceHelpers";
import type { useCanvasUndo } from "./useCanvasUndo";

let canvasClipboardText = "";
let canvasClipboardCopiedAt = 0;

interface CanvasClipboardDeps {
  activeCanvasRef: { readonly current: ActiveCanvasState };
  nodesRef: { readonly current: CanvasNode[] };
  graphNodesRef: { readonly current: ProjectGraphNode[] };
  groupsRef: { readonly current: Map<string, CanvasGroup> };
  stageRef: { readonly current: HTMLDivElement | null };
  panRef: MutableRefObject<CanvasPoint>;
  zoomRef: MutableRefObject<number>;
  viewModeRef: { readonly current: CreativeViewMode };
  loadingRef: { readonly current: boolean };
  selectedCanvasNodeIdsRef: { readonly current: Set<string> };
  lastImportPointRef: { readonly current: { projectId: string; routeRevision: number; point: CanvasPoint; at: number } | null };
  pastedNodeIds: { readonly current: Set<string> };
  writeJournalRef: { readonly current: { failure: unknown } };
  exploring: boolean;
  loadFailed: boolean;
  scopedInspectorOpen: boolean;
  workflowInteractive: boolean;
  nodeRect: (node: CanvasNode) => CanvasRect;
  expandArtboardSelection: (ids: Set<string>) => Set<string>;
  applySnapshot: (
    snapshot: ProjectCanvasSnapshot,
    options: { restoreView: boolean; restoreDraft?: boolean },
    exactAssets: Asset[],
    expectedRouteRevision: number,
    readEpoch: number,
  ) => boolean;
  selectionAnchors: () => { rect: CanvasRect }[];
  enqueueWrite: (work: () => Promise<void>) => Promise<void>;
  ensureMaterialized: (draft: ActiveCanvasState) => Promise<boolean>;
  pushCanvasUndo: ReturnType<typeof useCanvasUndo>["pushCanvasUndo"];
  setSelectedCanvasNodeIds: (ids: Set<string>) => void;
  setPan: (pan: CanvasPoint) => void;
  setZoom: (zoom: number) => void;
  markViewDirty: () => void;
  toBoardPoint: (clientX: number, clientY: number) => CanvasPoint;
  pasteCardPosition: (rect: CanvasRect) => CanvasRect;
  createCanvasNote: (rect: CanvasRect, kind: "text", artboard: undefined, initialText: string) => string;
}

export function useCanvasClipboard({
  activeCanvasRef, nodesRef, graphNodesRef, groupsRef, stageRef, panRef, zoomRef, viewModeRef, loadingRef,
  selectedCanvasNodeIdsRef, lastImportPointRef, pastedNodeIds, writeJournalRef,
  exploring, loadFailed, scopedInspectorOpen, workflowInteractive,
  nodeRect, expandArtboardSelection, applySnapshot, selectionAnchors, enqueueWrite, ensureMaterialized,
  pushCanvasUndo, setSelectedCanvasNodeIds, setPan, setZoom, markViewDirty, toBoardPoint, pasteCardPosition, createCanvasNote,
}: CanvasClipboardDeps) {
  const mediaPasteQueue = useRef(Promise.resolve());
  const pastingRef = useRef(false);

  function captureSelection(ids: Iterable<string>): CanvasClipboard | null {
    const project = activeCanvasRef.current.id;
    const groups = nodesRef.current.flatMap(node => {
      const group = node.kind === "folder" && groupsRef.current.get(node.id);
      return group ? [{ ...group, ...nodeRect(node), zIndex: node.order }] : [];
    });
    const items = nodesRef.current.flatMap(node => node.kind === "folder" ? node.assets.map((asset, ordinal) => ({ projectId: project, groupId: node.id, nodeId: asset.id, ordinal })) : []);
    const graph = projectGraphNodesWithLiveLayout(graphNodesRef.current, nodesRef.current);
    for (const node of nodesRef.current) if (node.kind === "asset" && !graph.some(item => item.id === node.id)) graph.push({ ...newProjectCanvasAssetNode(project, node), hiddenAt: null, createdAt: 0, updatedAt: 0 });
    const value = captureCanvasClipboard(project, expandArtboardSelection(new Set(ids)), graph, groups, items, canvasWorkflowController(project).document.nodes);
    return value.selection.length ? value : null;
  }

  async function copyCanvasSelection(ids: Iterable<string>, clipboard?: DataTransfer) {
    const value = captureSelection(ids);
    if (!value) { notify("请选择流程卡片、内容卡片或素材", "info"); return; }
    canvasClipboardText = serializeCanvasClipboard(value);
    canvasClipboardCopiedAt = performance.now();
    if (clipboard) clipboard.setData("text/plain", canvasClipboardText);
    else await navigator.clipboard.writeText(canvasClipboardText).catch(() => {});
    notify(`已复制 ${value.selection.length} 张卡片`, "success");
  }

  async function refreshClipboardCanvas(project: string) {
    const routeRevision = useStore.getState().projectRouteRevision;
    const readEpoch = originalDeletionEpoch();
    const snapshot = await api.projectCanvasGet(project);
    const exact = await api.getAssetsByIds(projectCanvasAssetIds(snapshot.nodes));
    applySnapshot(snapshot, { restoreView: false, restoreDraft: false }, exact, routeRevision, readEpoch);
  }

  async function pasteCanvasSelection(value: CanvasClipboard, point?: CanvasPoint) {
    if (pastingRef.current || !workflowInteractive || !value.selection.length) return;
    const draft = activeCanvasRef.current, controller = canvasWorkflowController(draft.id);
    const revision = useStore.getState().projectRouteRevision;
    if (!controller.ready || controller.error || writeJournalRef.current.failure) { notify("请先完成当前画板的保存重试", "info"); return; }
    pastingRef.current = true;
    try {
      const positions = [...value.nodes, ...value.groups, ...value.workflow.filter(node => node.kind !== "text")];
      const x = point?.x ?? Math.min(...positions.map(node => node.x)) + 60;
      const y = point?.y ?? Math.min(...positions.map(node => node.y)) + 60;
      const cloned = cloneCanvasClipboard(value, draft.id, x, y);
      let shift = 0;
      const obstacles = selectionAnchors().map(item => item.rect);
      while (obstacles.some(rect => x + shift < rect.x + rect.width + 24 && x + shift + cloned.width + 24 > rect.x && y < rect.y + rect.height + 24 && y + cloned.height + 24 > rect.y)) shift += cloned.width + 60;
      for (const node of [...cloned.nodes, ...cloned.groups, ...cloned.workflow]) node.x += shift;
      const ids: string[] = cloned.workflow.map(node => node.id);
      if (controller.document.nodes.length + ids.length > 500) throw new Error("粘贴后工作流卡片超过 500 张，请缩小选区");
      let completed = false;
      await enqueueWrite(async () => {
        await ensureMaterialized(draft);
        // Retry a partial write using the same identities, never create a second copy.
        const existing = await api.projectCanvasGet(draft.id);
        const nodeIds = new Set(existing.nodes.map(item => item.id));
        const groupIds = new Set(existing.groups.map(item => item.id));
        const nodesToCreate = cloned.nodes.filter(node => !nodeIds.has(node.id));
        const groupsToCreate = cloned.groups.filter(group => !groupIds.has(group.id)).map(value => ({
          value, nodeIds: cloned.items.filter(item => item.groupId === value.id).map(item => item.nodeId),
        }));
        if (nodesToCreate.length || groupsToCreate.length) {
          await api.projectCanvasNodesBatchCreate(draft.id, nodesToCreate, groupsToCreate);
        }
        if (ids.length) {
          if (controller.document.nodes.some(node => ids.includes(node.id))) {
            if (controller.error) await controller.retrySave();
          } else await controller.edit([...controller.document.nodes, ...cloned.workflow]);
        }
        await refreshClipboardCanvas(draft.id);
        const route = useStore.getState();
        if (!completed && activeCanvasRef.current.id === draft.id
          && isWorkspaceOperationCurrent(draft.id, route.activeProjectId, route.projectRoutePending, revision, route.projectRouteRevision)) {
          completed = true;
          pushCanvasUndo({ kind: "paste", projectId: draft.id, nodeIds: cloned.nodes.map(node => node.id), groupIds: cloned.groups.map(group => group.id), workflowIds: ids });
          setSelectedCanvasNodeIds(new Set(cloned.selection));
          const bounds = stageRef.current?.getBoundingClientRect();
          if (bounds) {
            const next = canvasViewForNewCard({ x: x + shift, y, width: cloned.width, height: cloned.height }, { x: 80, y: 60, width: Math.max(200, bounds.width - 120), height: Math.max(200, bounds.height - 270) }, panRef.current, zoomRef.current, true);
            if (next) { panRef.current = next.pan; zoomRef.current = next.zoom; setPan(next.pan); setZoom(next.zoom); markViewDirty(); }
          }
          stageRef.current?.focus({ preventScroll: true });
        }
      });
    } catch (error) { notifyError(error, "粘贴卡片失败"); }
    finally { pastingRef.current = false; }
  }

  useEffect(() => {
    const allowed = (event: ClipboardEvent) => {
      const stage = stageRef.current, target = event.target, route = useStore.getState();
      return !!stage && !event.defaultPrevented && !clipboardEditing(event)
        && (target === document.body || (target instanceof Node && stage.contains(target)))
        && viewModeRef.current === "canvas" && !route.projectRoutePending && !loadingRef.current && !loadFailed && !scopedInspectorOpen
        && route.activeProjectId === activeCanvasRef.current.id && !exploring && !stage.closest("[inert]");
    };
    const copy = (event: ClipboardEvent) => {
      if (!allowed(event) || !event.clipboardData || !selectedCanvasNodeIdsRef.current.size) return;
      if (event.target === document.body && useStore.getState().canvasLibraryOpen) return;
      if (!captureSelection(selectedCanvasNodeIdsRef.current)) return;
      event.preventDefault(); event.stopPropagation(); void copyCanvasSelection(selectedCanvasNodeIdsRef.current, event.clipboardData);
    };
    const paste = (event: ClipboardEvent) => {
      const stage = stageRef.current, data = event.clipboardData;
      if (!stage || !data || !allowed(event)) return;
      const state = useStore.getState(), projectId = activeCanvasRef.current.id;
      const savedPoint = lastImportPointRef.current;
      const click = savedPoint?.projectId === projectId && savedPoint.routeRevision === state.projectRouteRevision ? savedPoint : null;
      const text = data.getData("text/plain"), value = parseCanvasClipboard(text);
      if (value) {
        event.preventDefault(); event.stopPropagation();
        const point = click && (text !== canvasClipboardText || click.at > canvasClipboardCopiedAt) ? click.point : undefined;
        void pasteCanvasSelection(value, point);
        return;
      }
      const files = clipboardMediaFiles(data);
      if (!files.length && !text.trim()) return;
      event.preventDefault(); event.stopPropagation();
      const bounds = stage.getBoundingClientRect();
      const point = click?.point ?? toBoardPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      if (!files.length) {
        const size = { width: 320, height: canvasTextMinSize([[emptyCanvasCell()]]).height };
        const rect = { x: point.x - size.width / 2, y: point.y - size.height / 2, ...size };
        pastedNodeIds.current.add(createCanvasNote(pasteCardPosition(rect), "text", undefined, text));
        return;
      }
      const place = prepareExplorerCanvasDrop(stage, projectId, bounds.left + panRef.current.x + point.x * zoomRef.current,
        bounds.top + panRef.current.y + point.y * zoomRef.current, { clipboard: true });
      if (!place) { notifyError(null, "画布尚未准备好，请稍后再粘贴"); return; }
      mediaPasteQueue.current = Promise.all([mediaPasteQueue.current, readClipboardMediaPaths(files)]).then(async ([, paths]) => {
        await prepareMediaImport(projectId, state.projectRouteRevision);
        for (const file of files) {
          try { await place(await importDroppedMedia(file, projectId, "clipboard", { paths, multiple: files.length > 1 })); }
          catch (error) { notifyError(error, "粘贴素材到画布失败"); }
        }
      }).catch(error => notifyError(error, "粘贴素材到画布失败"));
    };
    window.addEventListener("copy", copy, true); window.addEventListener("paste", paste, true);
    return () => { window.removeEventListener("copy", copy, true); window.removeEventListener("paste", paste, true); };
  }, [exploring, loadFailed, scopedInspectorOpen, workflowInteractive]);

  function pasteCanvasClipboardAt(point: CanvasPoint) {
    return navigator.clipboard.readText().catch(() => canvasClipboardText).then(text => {
      const value = parseCanvasClipboard(text);
      if (value) return pasteCanvasSelection(value, point);
      notify("剪贴板中没有可粘贴的画板卡片", "info");
    });
  }

  return { copyCanvasSelection, refreshClipboardCanvas, pasteCanvasClipboardAt };
}
