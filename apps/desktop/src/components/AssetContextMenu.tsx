import { useEffect, useRef, useState } from "react";
import { ClipboardCopy, FileText, FolderPlus, FolderTree, Layers, LayoutDashboard, MessageSquare, ScanSearch, Scan, Trash2, Ungroup } from "lucide-react";
import { understandEngineUsable, useStore } from "../store";
import { api } from "../lib/api";
import { buildAssetContextMenu, type AssetMenuAction, type AssetMenuSnapshot } from "../lib/assetContextMenu";
import {
  copyAssetFilePath, copyImageToClipboard, enqueueDescribeWithEngine, openAssetWithSystem,
  removeAssetsFromProject, reuseGenerationPrompt, revealAssetFolder, setAssetLibraryVisibility,
} from "../lib/assetMenuCommands";
import { canUseByo } from "../lib/entitlement";
import { externalFiles } from "../lib/externalFiles";
import { notifyError } from "../lib/notify";
import { canSearchPinterest } from "../lib/pinterestSearch";
import type { Asset } from "../lib/types";
import { videoSourceKey } from "../lib/videoSourceKey";
import { AssetTransferMenuItems, useAssetTransferDialogs } from "./AssetTransferMenuItems";
import { BatchAddToProjectsDialog } from "./BatchAddToProjectsDialog";
import { CanvasAssetDeleteDialog } from "./CanvasAssetDeleteDialog";
import { CanvasSelectionMenuItems } from "./CanvasSelectionMenuItems";
import { CollectionAssignDialog } from "./CollectionDialogs";
import { ContextMenu } from "./ContextMenu";
import { ContextMenuItems } from "./ContextMenuItems";
import { GenerationGroupMenuItem, MergeGenerationGroupMenuItem } from "./GenerationGroupMenuItem";
import { ImageEditIcon } from "./ImageEditIcon";
import { LibraryVideoPreview } from "./LibraryVideoPreview";
import { RenameDialog } from "./RenameDialog";
import { useAssetMenuHost, type AssetMenuContext, type AssetMenuHostSelection } from "./useAssetMenuHost";

type SelectionOperation = { ids: string[]; onComplete?: () => void };

const ICONS = {
  edit: <ImageEditIcon />,
  "folder-plus": <FolderPlus size={13} />,
  "folder-tree": <FolderTree size={13} />,
  trash: <Trash2 size={13} />,
  ungroup: <Ungroup size={13} />,
  layers: <Layers size={13} />,
  "status-unavailable": <span className="app-status-dot" aria-hidden="true" />,
  "status-ready": <span className="app-status-dot is-ready" aria-hidden="true" />,
  "scan-search": <ScanSearch size={13} />,
  scan: <Scan size={13} />,
  board: <LayoutDashboard size={13} />,
  clipboard: <ClipboardCopy size={13} />,
  message: <MessageSquare size={13} />,
  "file-text": <FileText size={13} />,
};

/** 单选双列，多选单列；全局素材库、画布和嵌入式工作区共用。 */
export function AssetContextMenu({ selection }: { selection?: AssetMenuHostSelection } = {}) {
  const host = useAssetMenuHost(selection);
  const { menu, embedded, isCurrent, close } = host;
  const activeProjectId = useStore(state => state.activeProjectId);
  const assets = useStore(state => state.assets);
  const mode = useStore(state => state.mode);
  const selectedIds = useStore(state => state.selectedIds);
  const hasProjects = useStore(state => state.projects.length > 0);
  const cloudAuth = useStore(state => state.cloudAuth);
  const cloudEntitlement = useStore(state => state.cloudEntitlement);
  const codexHealth = useStore(state => state.codexHealth);
  const describingId = useStore(state => state.describingId);
  const describeQueue = useStore(state => state.describeQueue);

  const reuseIntent = useRef(0);
  const [busy, setMenuBusy] = useState(false);
  const [canvasLibraryCheck, setCanvasLibraryCheck] = useState<{ menu: AssetMenuContext; status: AssetMenuSnapshot["canvasLibraryStatus"] } | null>(null);
  const [groupCheck, setGroupCheck] = useState<{ menu: AssetMenuContext; projectId: string | null; ids: string[] | null } | null>(null);
  const [selectionAssets, setSelectionAssets] = useState<{ menu: AssetMenuContext; assets: Asset[] } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string; external: boolean; localPath?: string } | null>(null);
  const [transcriptPreview, setTranscriptPreview] = useState<{ asset: Asset; path: string; projectId: string | null } | null>(null);
  const [assignCollectionIds, setAssignCollectionIds] = useState<SelectionOperation | null>(null);
  const [projectPickIds, setProjectPickIds] = useState<SelectionOperation | null>(null);
  const [pendingCanvasDelete, setPendingCanvasDelete] = useState<{ assetIds: string[]; projectId: string | null; localPaths?: Record<string, string>; onComplete?: () => void } | null>(null);
  const transfer = useAssetTransferDialogs();

  useEffect(() => {
    if (!embedded && menu && menu.workspaceProjectId !== undefined && menu.workspaceProjectId !== activeProjectId) close();
  }, [menu, activeProjectId, selection]);
  useEffect(() => { setTranscriptPreview(null); }, [activeProjectId]);

  useEffect(() => {
    setMenuBusy(false);
    if (!menu?.canvasSelection) return;
    const supplied = new Set(menu.canvasSelection.assets?.map(asset => asset.id));
    const cached = useStore.getState().assets;
    const missing = (menu.canvasSelection.assetIds ?? [menu.assetId]).filter(id =>
      id !== menu.asset?.id && !supplied.has(id) && !cached.some(asset => asset.id === id));
    if (!missing.length) return;
    let alive = true;
    api.getAssetsByIds(missing).then(assets => {
      if (alive) setSelectionAssets({ menu, assets });
    }).catch(() => { if (alive) setSelectionAssets({ menu, assets: [] }); });
    return () => { alive = false; };
  }, [menu]);

  useEffect(() => {
    if (!menu?.libraryProjectId) return;
    let alive = true;
    api.projectCanvasGet(menu.libraryProjectId).then(snapshot => {
      if (!alive) return;
      const available = snapshot.nodes.some(node => node.kind === "asset" && node.assetId === menu.assetId && node.hiddenAt == null);
      setCanvasLibraryCheck({ menu, status: available ? "available" : "unavailable" });
    }).catch(() => { if (alive) setCanvasLibraryCheck({ menu, status: "failed" }); });
    return () => { alive = false; };
  }, [menu]);

  // 与素材库轮播共用组图查询。结果只更新当前菜单中已有的删除行。
  useEffect(() => {
    if (!menu || menu.canvasSelection) return;
    const target = menu.asset ?? useStore.getState().assets.find(asset => asset.id === menu.assetId);
    if (!target?.generation_session_id) return;
    let alive = true;
    api.listGenerationGroup(menu.assetId, activeProjectId).then(group => {
      if (alive) setGroupCheck({ menu, projectId: activeProjectId, ids: group.map(asset => asset.id) });
    }).catch(() => { if (alive) setGroupCheck({ menu, projectId: activeProjectId, ids: null }); });
    return () => { alive = false; };
  }, [menu, activeProjectId]);

  if (!menu) return <>
    {transcriptPreview && <LibraryVideoPreview {...transcriptPreview} sourceKey={videoSourceKey(transcriptPreview.asset)}
      openTranscript onClose={() => setTranscriptPreview(null)} />}
    {assignCollectionIds && <CollectionAssignDialog assetIds={assignCollectionIds.ids} onSaved={assignCollectionIds.onComplete} onClose={() => setAssignCollectionIds(null)} />}
    {transfer.dialogs}
    {pendingCanvasDelete && <CanvasAssetDeleteDialog target={pendingCanvasDelete} onComplete={pendingCanvasDelete.onComplete} onClose={() => setPendingCanvasDelete(null)} />}
    {renameTarget && <RenameDialog open assetId={renameTarget.id} currentName={renameTarget.name} external={renameTarget.external} localPath={renameTarget.localPath} onClose={() => setRenameTarget(null)} />}
    {projectPickIds && <BatchAddToProjectsDialog ids={projectPickIds.ids} onComplete={projectPickIds.onComplete} onClose={() => setProjectPickIds(null)} />}
  </>;

  const { assetId, canvasSelection: canvas, fileSelection: file } = menu;
  const canvasMulti = !!canvas && canvas.nodeIds.length > 1;
  const entries = file?.entries;
  const entryCount = entries?.count ?? file?.assets.length;
  let multiIds: string[] | null = null;
  if (canvasMulti) multiIds = [...new Set(canvas?.assetIds ?? [])];
  else if (file && (entryCount ?? 0) > 1) multiIds = file.assets.map(asset => asset.id);
  else if (!file && !embedded && !menu.singleAsset && !canvas && mode === "manage" && selectedIds.size > 1 && selectedIds.has(assetId)) {
    multiIds = [...selectedIds];
  }
  const targetIds = multiIds ?? [assetId];
  const resolvedSelection = selectionAssets?.menu === menu ? selectionAssets.assets : undefined;
  const resolveAsset = (id: string) => resolvedSelection?.find(item => item.id === id)
    ?? canvas?.assets?.find(item => item.id === id) ?? assets.find(item => item.id === id);
  const resolveTarget = (id: string) => file ? file.assets.find(item => item.id === id) : resolveAsset(id);
  const asset = menu.asset ?? resolveTarget(assetId);
  const targets = targetIds.map(id => id === assetId ? asset ?? resolveTarget(id) : resolveTarget(id));
  const canvasImagesPending = canvasMulti && canvas.imageOnly && targets.some(target => !target)
    ? resolvedSelection ? "部分所选素材不可用" : "正在检查所选素材…" : undefined;
  const projectId = canvas?.projectId ?? (menu.workspaceProjectId !== undefined ? menu.workspaceProjectId : activeProjectId);
  const membershipProjectId = menu.libraryProjectId ?? projectId;
  const onComplete = file?.onComplete ?? (!canvas && multiIds ? host.selectionComplete : undefined);
  const deletionTargets = canvas?.deletionTargets;
  const removeFromCanvas = canvasMulti ? canvas?.removeSelectionFromCanvas : deletionTargets?.item.removeFromCanvas;
  const menuMode = menu.moveIncompleteSelection ? "incomplete" : multiIds ? "multi" : "single";
  const describeAccess = { cloudAuth, cloudEntitlement, codexHealth };
  const group = groupCheck?.menu === menu && groupCheck.projectId === activeProjectId ? groupCheck : undefined;
  const groupIds = group?.ids;
  const generationCheck = !canvas && !!asset?.generation_session_id
    ? !group ? "checking" : groupIds == null ? "failed" : groupIds.length <= 1 ? "unavailable" : undefined
    : undefined;
  const model = buildAssetContextMenu({
    mode: menuMode, asset, targets,
    selectedCount: canvasMulti ? canvas.nodeIds.length : entries?.count ?? multiIds?.length ?? 1,
    busy, manage: mode === "manage", embedded, hasDetail: host.detailAssetId !== null,
    canSearchPinterest: canSearchPinterest(asset), hasProject: !!projectId, hasMembershipProject: !!membershipProjectId,
    canAddToProject: hasProjects, libraryProject: !!menu.libraryProjectId,
    canvasLibraryStatus: canvasLibraryCheck?.menu === menu ? canvasLibraryCheck.status : "checking",
    generationCount: groupIds?.length ?? 0, generationCheck, hasGenerationGroup: !!menu.generationGroup, canvasImagesPending,
    canvas: canvas && { nodeCount: canvas.nodeIds.length, canRemove: !!removeFromCanvas, itemTarget: !!deletionTargets?.item,
      groupCount: deletionTargets?.group?.count, canUngroup: !!menu.ungroupCanvasFolder,
      generationActions: canvas.generationActions && { edit: !!canvas.generationActions.edit, revise: !!canvas.generationActions.revise,
        create: !!canvas.generationActions.create } },
    file: file && { local: !!file.localPaths, entries: entries && { available: entries.available, canRemoveReferences: !!entries.removeReferences } },
    describe: { queued: describingId === assetId || describeQueue.some(item => item.assetId === assetId),
      cloudUsable: understandEngineUsable(describeAccess, "bowerbird-cloud"), cloudAvailable: cloudAuth?.cloud_available ?? false,
      loggedIn: !!cloudAuth?.logged_in, codexUsable: understandEngineUsable(describeAccess, "codex"),
      canUseByo: canUseByo(cloudEntitlement), codexReason: codexHealth?.reason },
  });

  const feedback = { onClose: close, onComplete, isCurrent, setBusy: (value: boolean) => { if (isCurrent()) setMenuBusy(value); } };
  const storePath = asset?.store_path;
  const external = asset?.source === "external";
  const rename = () => {
    if (entries) {
      close();
      entries.rename();
      return;
    }
    const localPath = file?.localPaths?.[assetId];
    const name = localPath ? localPath.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "") : asset?.name ?? "";
    setRenameTarget({ id: assetId, name, external: !localPath && external, localPath });
    close();
  };
  const confirmDelete = (ids: string[]) => {
    setPendingCanvasDelete({ assetIds: [...new Set(ids)], projectId, localPaths: file?.localPaths, onComplete });
    close();
  };
  const removeFromProject = (ids: string[], removeCellImages?: () => void) => {
    void removeAssetsFromProject(membershipProjectId, ids, feedback, canvas && { ...canvas, removeCellImages });
  };
  const describe = (engine: "bowerbird-cloud" | "codex") => {
    enqueueDescribeWithEngine(targetIds, engine, () => {
      if (multiIds && !file && !canvas) useStore.getState().exitManage();
      file?.onComplete?.();
      close();
    });
  };
  const openTranscript = async () => {
    if (!asset || !storePath || busy || !isCurrent()) return;
    const routeRevision = useStore.getState().projectRouteRevision;
    const isCurrentPreview = () => isCurrent() && useStore.getState().projectRouteRevision === routeRevision;
    setMenuBusy(true);
    try {
      const path = await externalFiles.media(storePath);
      if (!isCurrentPreview()) return;
      setTranscriptPreview({ asset, path, projectId: membershipProjectId });
      close();
    } catch (error) {
      if (isCurrentPreview()) notifyError(error, "无法打开视频预览");
    } finally {
      if (isCurrent()) setMenuBusy(false);
    }
  };

  const onSelect = (action: AssetMenuAction) => {
    const store = useStore.getState();
    const item = deletionTargets?.item;
    const group = deletionTargets?.group;
    switch (action) {
      case "move-incomplete": menu.moveIncompleteSelection?.(); close(); break;
      case "add-to-chat": host.navigate(); store.addAssetToBoardFromDetail(assetId); close(); break;
      case "open-detail": host.openDetail(menu); break;
      case "open-transcript": void openTranscript(); break;
      case "edit": host.navigate(); store.openAnnotator(assetId); close(); break;
      case "pinterest": host.searchPinterest(assetId); break;
      case "select": host.select(menu); break;
      case "rename": rename(); break;
      case "describe-cloud": describe("bowerbird-cloud"); break;
      case "describe-codex": describe("codex"); break;
      case "dimensions": host.peek(menu); break;
      case "artboard": host.createArtboard(menu); break;
      case "reuse": {
        const request = ++reuseIntent.current;
        void reuseGenerationPrompt(assetId, { ...feedback, isLatest: () => reuseIntent.current === request,
          navigate: host.navigate, reuseEmbeddedPrompt: host.reusePrompt });
        break;
      }
      case "layers": host.navigate(); store.openLayerEditor(assetId); break;
      case "history": close(); host.navigate(); void store.viewGenerationHistory(assetId); break;
      case "assign": setAssignCollectionIds({ ids: targetIds, onComplete }); close(); break;
      case "project-picker": setProjectPickIds({ ids: targetIds, onComplete }); close(); break;
      case "reveal": void revealAssetFolder(assetId, feedback); break;
      case "open-system": if (storePath) void openAssetWithSystem(storePath, feedback); break;
      case "copy-image": if (storePath) void copyImageToClipboard(storePath, feedback); break;
      case "copy-path": if (storePath) void copyAssetFilePath(storePath, feedback); break;
      case "references": host.openReferences(menu); break;
      case "show-in-library": void setAssetLibraryVisibility(canvas?.projectId, assetId, true, external, feedback); break;
      case "hide-in-library": void setAssetLibraryVisibility(menu.libraryProjectId, assetId, false, external, feedback); break;
      case "remove-references": close(); entries?.removeReferences?.(); break;
      case "remove-from-canvas": removeFromCanvas?.(); close(); break;
      case "ungroup": close(); menu.ungroupCanvasFolder?.(); break;
      case "edit-generation-card": close(); canvas?.generationActions?.edit?.(); break;
      case "continue-image-generation": close(); canvas?.generationActions?.revise?.(); break;
      case "create-image-generation-card": close(); canvas?.generationActions?.create?.(); break;
      case "remove-from-project": removeFromProject(targetIds); break;
      case "delete-originals": confirmDelete(targetIds); break;
      case "delete-generation": if (groupIds) confirmDelete(groupIds); break;
      case "remove-canvas-item-from-project": if (item) removeFromProject(item.assetIds, item.removeFromCanvas); break;
      case "delete-canvas-item": if (item) confirmDelete(item.assetIds); break;
      case "remove-canvas-group": group?.removeFromCanvas(); close(); break;
      case "remove-canvas-group-from-project": if (group) removeFromProject(group.assetIds, group.removeFromCanvas); break;
      case "delete-canvas-group": if (group) confirmDelete(group.assetIds); break;
    }
  };

  const slots = {
    "canvas-selection": canvas && <CanvasSelectionMenuItems {...canvas} images={menu.addCanvasImagesToBoard} disabled={busy}
      className="app-context-item px-2 py-1.5" onClose={close} />,
    "generation-group": <GenerationGroupMenuItem target={menu.generationGroup} disabled={busy} onComplete={close} />,
    "merge-generation-group": <MergeGenerationGroupMenuItem assetIds={targetIds} nodeIds={canvas?.nodeIds} projectId={projectId}
      disabled={busy || !!canvasImagesPending} title={canvasImagesPending}
      onComplete={() => { close(); onComplete?.(); }} />,
    transfers: <AssetTransferMenuItems assetIds={targetIds} sourceProjectId={canvas?.projectId ?? menu.libraryProjectId ?? null}
      dialogs={transfer} onClose={close} onMoveFolder={entries?.move} onComplete={onComplete} disabled={busy} />,
  };

  const single = menuMode === "single";
  const incomplete = menuMode === "incomplete";
  const sections = (column: typeof model.columns[number]) => column.map(({ heading, items }, index) =>
    <AssetMenuSection key={index} heading={heading} divide={index > 0 && !!heading}>
      <ContextMenuItems items={items} icons={ICONS} slots={slots} onSelect={onSelect} />
    </AssetMenuSection>);
  return <ContextMenu key={incomplete ? undefined : `${assetId}:${menu.x}:${menu.y}${single ? "" : ":multi"}`}
    x={menu.x} y={menu.y} label={model.label} onClose={close}
    className={incomplete ? undefined : single ? "asset-context-menu" : "asset-context-menu is-multi"}
    contentClassName={single ? "asset-context-columns" : undefined}>
    {incomplete ? sections(model.columns[0]) : model.columns.map((column, index) =>
      <div className="asset-context-column" key={index}>{sections(column)}</div>)}
  </ContextMenu>;
}

function AssetMenuSection({ heading, divide, children }: { heading: string; divide: boolean; children: React.ReactNode }) {
  return <>
    {divide && <div className="app-context-divider" />}
    {heading && <div className="app-context-label">{heading}</div>}
    {children}
  </>;
}
