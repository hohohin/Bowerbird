import { userErrorMessage } from "../lib/userError";
import { useEffect, useRef, useState } from "react";
import { CanvasLayerMenuItem } from "./CanvasLayerMenuItem";
import { CANVAS_ARTBOARD_FROM_IMAGE } from "../lib/canvasArtboard";
import { ContextMenu, ContextSubmenu, DeleteSubmenu } from "./ContextMenu";
import { isVideoPath } from "../lib/videoGeneration";
import { Archive, ClipboardCopy, FolderPlus, FolderTree, Layers, LayoutDashboard, MessageSquare, PenTool, ScanSearch, Ungroup } from "lucide-react";
import { exportAssetArchive } from "../lib/assetArchive";
import { understandEngineUsable, useStore } from "../store";
import { api } from "../lib/api";
import { loadDescribePrompt } from "../lib/describePrompt";
import { CollectionAssignDialog } from "./CollectionDialogs";
import { CanvasAssetDeleteDialog } from "./CanvasAssetDeleteDialog";
import { ModalShell } from "./ModalShell";
import { RenameDialog } from "./RenameDialog";
import { canUseByo } from "../lib/entitlement";
import { notifyError, notifySuccess } from "../lib/notify";
import { isWorkspaceOperationCurrent } from "../lib/workspaceRoute";
import type { Asset, AssetDeleteResult } from "../lib/types";
import { externalFiles, OPEN_LOCAL_FILES } from "../lib/externalFiles";
import { canMoveAssetOut } from "../lib/assetDeletion";
import {
  CANVAS_REMOVE_NODES_EVENT,
  CANVAS_ARRANGE_NODES_EVENT,
  type CanvasArrangeNodesEventDetail,
  type CanvasRemoveNodesEventDetail,
} from "../lib/creativeCanvas";

/** 可标注图片：浏览器 <img>/canvas 能解码的位图格式（tiff 浏览器不解码，排除）。 */
const ANNOTATABLE_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];
const CANVAS_IMAGE_EXTS = [...ANNOTATABLE_EXTS, "avif", "svg", "ico", "tif", "tiff"];

type SelectionOperation = { ids: string[]; onComplete?: () => void };

function resultMessage(mode: "keep" | "move_out", result: AssetDeleteResult): string {
  if (mode === "keep") {
    return result.removed_members > 0 ? "已移出当前项目，素材留在全局" : "素材已在全局";
  }
  return result.deleted_assets > 0
    ? "文件已回到原始位置，并从素材库移除"
    : "文件已在原始位置，素材仍保留在全局";
}

/** 右键「反推」二级菜单的引擎选项；reason 为空表示该引擎当前可用。 */
interface DescribeEngineOption {
  key: "bowerbird-cloud" | "codex";
  label: string;
  reason: string | null;
}

/**
 * 素材菜单：单项按常用 / 再创作与文件分列，多选只显示选区操作。
 * 全局只有一个实例（store.contextMenu 状态驱动），挂在 App 最外层；
 * 瀑布流缩略图 / 详情页大图各自 onContextMenu 触发。
 */
export function AssetContextMenu() {
  const menu = useStore((s) => s.contextMenu);
  const closeContextMenu = () => {
    if (useStore.getState().contextMenu === menu) useStore.getState().closeContextMenu();
  };
  const openDetail = useStore((s) => s.openDetail);
  const detailAssetId = useStore((s) => s.detailAssetId);
  const addAssetToBoardFromDetail = useStore((s) => s.addAssetToBoardFromDetail);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const reloadProjects = useStore((s) => s.reloadProjects);
  const assets = useStore((s) => s.assets);
  const reusePromptToBoard = useStore((s) => s.reusePromptToBoard);
  const codexHealth = useStore((s) => s.codexHealth);
  const openAnnotator = useStore((s) => s.openAnnotator);
  const viewGenerationHistory = useStore((s) => s.viewGenerationHistory);
  const mode = useStore((s) => s.mode);
  const enterManage = useStore((s) => s.enterManage);
  const toggleSelect = useStore((s) => s.toggleSelect);
  const selectedIds = useStore((s) => s.selectedIds);
  const projects = useStore((s) => s.projects);
  const exitManage = useStore((s) => s.exitManage);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  const cloudAvailable = cloudAuth?.cloud_available ?? false;
  const reuseIntentRef = useRef(0);

  const [busy, setMenuBusy] = useState(false);
  function setBusy(value: boolean) { if (useStore.getState().contextMenu === menu) setMenuBusy(value); }
  const [canvasLibraryCheck, setCanvasLibraryCheck] = useState<{ menu: typeof menu; available: boolean } | null>(null);
  const [groupIds, setGroupIds] = useState<string[] | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string; external: boolean; localPath?: string } | null>(null);
  const [assignCollectionIds, setAssignCollectionIds] = useState<SelectionOperation | null>(null);
  const [projectPickIds, setProjectPickIds] = useState<SelectionOperation | null>(null);
  const [pendingCanvasDelete, setPendingCanvasDelete] = useState<{ assetIds: string[]; projectId: string | null; localPaths?: Record<string, string>; onComplete?: () => void } | null>(null);
  const [selectionAssets, setSelectionAssets] = useState<{ menu: typeof menu; assets: Asset[] } | null>(null);
  const describingId = useStore(s => s.describingId);
  const describeQueue = useStore(s => s.describeQueue);
  useEffect(() => {
    if (menu && menu.workspaceProjectId !== undefined && menu.workspaceProjectId !== activeProjectId) closeContextMenu();
  }, [menu, activeProjectId]);
  useEffect(() => {
    setMenuBusy(false);
    if (!menu?.canvasSelection) return;
    let alive = true;
    api.getAssetsByIds(menu.canvasSelection.assetIds ?? [menu.assetId]).then(assets => {
      if (alive) setSelectionAssets({ menu, assets });
    }).catch(() => {});
    return () => { alive = false; };
  }, [menu]);

  useEffect(() => {
    if (!menu?.libraryProjectId) return;
    let alive = true;
    api.projectCanvasGet(menu.libraryProjectId).then(snapshot => {
      if (alive) setCanvasLibraryCheck({ menu, available: snapshot.nodes.some(node =>
        node.kind === "asset" && node.assetId === menu.assetId && node.hiddenAt == null) });
    }).catch(() => { if (alive) setCanvasLibraryCheck({ menu, available: false }); });
    return () => { alive = false; };
  }, [menu]);

  // 菜单打开且为生成图时取同组图（与瀑布流轮播同一查询、同 project scope）；
  // 非生成图 / 查询失败按无组处理，不显示整组删除。
  useEffect(() => {
    setGroupIds(null);
    if (!menu) return;
    const target = menu.asset ?? useStore.getState().assets.find((a) => a.id === menu.assetId);
    if (!target?.generation_session_id) return;
    let alive = true;
    api
      .listGenerationGroup(menu.assetId, activeProjectId)
      .then((g) => {
        if (alive) setGroupIds(g.map((a) => a.id));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [menu, activeProjectId]);

  if (!menu) return <>
    {assignCollectionIds && <CollectionAssignDialog assetIds={assignCollectionIds.ids} onSaved={assignCollectionIds.onComplete} onClose={() => setAssignCollectionIds(null)} />}
    {pendingCanvasDelete && <CanvasAssetDeleteDialog target={pendingCanvasDelete} onComplete={pendingCanvasDelete.onComplete} onClose={() => setPendingCanvasDelete(null)} />}
    {renameTarget && <RenameDialog open assetId={renameTarget.id} currentName={renameTarget.name} external={renameTarget.external} localPath={renameTarget.localPath} onClose={() => setRenameTarget(null)} />}
    {projectPickIds && <BatchAddToProjectsDialog ids={projectPickIds.ids} onComplete={projectPickIds.onComplete} onClose={() => setProjectPickIds(null)} />}
  </>;

  // 守卫后捕获，闭包里直接用（TS 不会把守卫的收窄带进嵌套函数）。
  const assetId = menu.assetId;
  const asset = menu.asset ?? (selectionAssets?.menu === menu ? selectionAssets.assets : assets).find((a) => a.id === assetId);
  const canvasMulti = !!menu.canvasSelection && menu.canvasSelection.nodeIds.length > 1;
  const multiIds = canvasMulti ? [...new Set(menu.canvasSelection!.assetIds ?? [])]
    : menu.fileSelection ? menu.fileSelection.assets.length > 1 ? menu.fileSelection.assets.map(asset => asset.id) : null
    : !menu.singleAsset && !menu.canvasSelection && mode === "manage" && selectedIds.size > 1 && selectedIds.has(assetId) ? [...selectedIds] : null;
  const targetIds = multiIds ?? [assetId];
  const knownAssets = menu.fileSelection?.assets ?? (selectionAssets?.menu === menu ? selectionAssets.assets : assets);
  const targets = targetIds.map(id => id === assetId ? asset ?? knownAssets.find(a => a.id === id) : knownAssets.find(a => a.id === id));
  const targetsReady = targets.every((item): item is Asset => !!item);
  const batchMovable = targetsReady && targets.every(canMoveAssetOut);
  const allImages = targetIds.length > 0 && targetsReady && targets.every(item => !!item.store_path && !isVideoPath(item.store_path));
  const projectId = menu.canvasSelection?.projectId ?? (menu.workspaceProjectId !== undefined ? menu.workspaceProjectId : activeProjectId);
  const onComplete = menu.fileSelection?.onComplete ?? (!menu.canvasSelection && multiIds ? exitManage : undefined);
  const storePath = asset?.store_path ?? null;
  const moveOutAvailable = canMoveAssetOut(asset);
  const canvasLibraryAvailable = canvasLibraryCheck?.menu === menu && canvasLibraryCheck.available;
  const canChangeLibraryVisibility = !!asset?.store_path && CANVAS_IMAGE_EXTS.includes((asset.ext ?? "").toLowerCase());
  // 仅生成图显示「复用生成提示词」：generation_session_id 非 null 即任意 provider 的生成图。
  const isGenerated = !!asset?.generation_session_id;
  // 「图片标注」可用：本地有文件且为浏览器可解码位图（视频 / SVG / TIFF 不可标注）。
  const annotatable =
    !!storePath && ANNOTATABLE_EXTS.includes((asset?.ext ?? "").toLowerCase());
  // 反推项置灰：该图正在反推或已排队（runDescribe 内部已去重，置灰仅为给用户明确反馈）。
  const describing =
    describingId === assetId ||
    describeQueue.some((q) => q.assetId === assetId);
  // 反推引擎选项（右键二级菜单）：门控与 DescribeProviderPicker 一致，但不按账号档位自动路由——
  // Pro 未就绪 codex 仍可显式选 Cloud；reason 为空即该引擎当前可用。
  const describeEngines: DescribeEngineOption[] = [
    {
      key: "bowerbird-cloud",
      label: "Bowerbird Cloud",
      reason: understandEngineUsable({ cloudAuth, cloudEntitlement, codexHealth }, "bowerbird-cloud")
        ? null
        : !cloudAvailable
          ? "当前版本未配置 Bowerbird Cloud"
          : !cloudAuth?.logged_in
            ? "请先登录 Bowerbird 账号"
            : "积分不足",
    },
    {
      key: "codex",
      label: "本机 codex",
      reason: understandEngineUsable({ cloudAuth, cloudEntitlement, codexHealth }, "codex")
        ? null
        : !canUseByo(cloudEntitlement)
          ? "升级 Pro 解锁本机 codex"
          : codexHealth?.reason || "codex 不可用",
    },
  ];

  async function reveal() {
    setBusy(true);
    try {
      await api.revealAssetFolder(assetId);
      notifySuccess("已打开素材所在文件夹");
      closeContextMenu();
    } catch (e) {
      notifyError(e, "无法打开所在文件夹");
      setBusy(false);
    }
  }

  /** 图片位图复制到系统剪贴板（可粘贴到聊天 / 编辑等应用）。data URL 同源不污染画布，
   *  canvas 统一转 PNG——ClipboardItem 仅稳定支持 image/png（动图取首帧）。 */
  async function copyImage() {
    if (!storePath) return;
    setBusy(true);
    try {
      const url = await api.readImageDataUrl(storePath);
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("图片解码失败"));
        el.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d")?.drawImage(img, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("图片转换 PNG 失败");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      notifySuccess("图片已复制到剪贴板");
      closeContextMenu();
    } catch (e) {
      notifyError(e, "复制图片失败");
      setBusy(false);
    }
  }

  async function reuseGeneration() {
    const intentId = ++reuseIntentRef.current;
    const expectedMenu = menu;
    const route = useStore.getState();
    const expectedProjectId = route.activeProjectId;
    const expectedRouteRevision = route.projectRouteRevision;
    const isCurrentIntent = () => {
      const current = useStore.getState();
      return intentId === reuseIntentRef.current
        && current.contextMenu === expectedMenu
        && isWorkspaceOperationCurrent(
          expectedProjectId,
          current.activeProjectId,
          current.projectRoutePending,
          expectedRouteRevision,
          current.projectRouteRevision,
        );
    };
    if (!isCurrentIntent()) return;
    setBusy(true);
    try {
      // 生成来源属于中心素材，而不是素材当前出现的项目。画板节点可以引用尚未写入
      // project_assets 的恢复/迁移结果；按当前项目过滤会把真实 generation_meta 筛空。
      const hist = await api.generationHistory(assetId, null);
      if (!isCurrentIntent()) {
        if (useStore.getState().contextMenu === expectedMenu) setBusy(false);
        return;
      }
      // 优先未铺开的原始编辑框文本（维度 chip，不展开 body）；旧 meta 无 prompt_raw → 回退铺开 prompt。
      const prompt = hist.turns[0]?.prompt_raw ?? hist.turns[0]?.prompt ?? "";
      if (!prompt) {
        notifyError(null, "该生成图没有可复用的提示词记录");
        setBusy(false);
        return;
      }
      // 复用首轮 prompt + 首版参考图 + 借用维度源图（车牌 sidecar，与 GenerationPanel 一致）
      // → 打开创作板载入。
      reusePromptToBoard(prompt, hist.references, hist.dimension_assets, undefined, { media: hist.media, videoOptions: hist.video_options, ratio: hist.ratio, videoChannel: hist.provider?.startsWith("bowerbird-cloud") ? "cloud" : "jimeng" }, expectedProjectId && hist.turns[0]?.project_id === expectedProjectId ? hist.references.map(asset => hist.turns[0]?.reference_node_ids?.[hist.turns[0]?.references?.indexOf(asset.store_path ?? "") ?? -1] ?? null) : undefined);
      notifySuccess("生成提示词已载入创作板");
      closeContextMenu();
    } catch (e) {
      if (!isCurrentIntent()) {
        if (useStore.getState().contextMenu === expectedMenu) setBusy(false);
        return;
      }
      notifyError(e, "读取生成提示词失败");
      setBusy(false);
    }
  }

  async function runDelete(id: string, mode: "keep" | "move_out") {
    setBusy(true);
    try {
      const result = await api.deleteAssetWithMode(id, mode, projectId);
      await reloadProjects();
      if (result.failed_moves.length > 0) {
        notifyError(null, `移出失败：${result.failed_moves.join("、")}，素材保留在全局`);
        setBusy(false);
        return;
      }
      if (useStore.getState().contextMenu === menu) onComplete?.();
      notifySuccess(resultMessage(mode, result));
      closeContextMenu();
    } catch (e) {
      notifyError(e, "删除失败");
      setBusy(false);
    }
  }

  async function setLibraryVisibility(visible: boolean) {
    const projectId = visible ? menu?.canvasSelection?.projectId : menu?.libraryProjectId;
    if (!projectId) return;
    const expectedMenu = menu;
    setBusy(true);
    try {
      if (visible && asset?.source === "external") await externalFiles.copy(assetId);
      else await api.setCanvasAssetLibraryVisibility(projectId, assetId, visible);
      if (useStore.getState().contextMenu === menu) onComplete?.();
      notifySuccess(visible ? "已加入素材库" : "已从素材库移除，画布图片已保留");
      if (useStore.getState().contextMenu === expectedMenu) closeContextMenu();
      void reloadProjects();
    } catch (error) {
      notifyError(error, "调整素材库归属失败");
      if (useStore.getState().contextMenu === expectedMenu) setBusy(false);
    }
  }

  /** 反推二级菜单选定引擎后直接入队（单图 / 多选批量同链路，批量与选择浮层一致退出管理态）。 */
  function runDescribeWith(engine: DescribeEngineOption["key"]) {
    const instruction = loadDescribePrompt();
    const st = useStore.getState();
    if (multiIds) {
      for (const id of multiIds) st.runDescribe(id, instruction, engine);
      if (!menu?.fileSelection && !menu?.canvasSelection) st.exitManage();
    } else {
      st.runDescribe(assetId, instruction, engine);
    }
    menu?.fileSelection?.onComplete?.();
    closeContextMenu();
  }

  /** 多选移除：keep 数组一次，move_out 循环单条。
   *  move_out 的文件恢复失败是结构化结果而非 rejected promise；有失败留在原地反馈，全成功退出管理。 */
  async function runBatchDelete(ids: string[], deleteMode: "keep" | "move_out") {
    setBusy(true);
    let failedCount = 0;
    try {
      if (deleteMode === "keep") {
        if (projectId) await api.removeAssetsFromProject(projectId, ids);
      } else {
        for (const id of ids) {
          try {
            const result = await api.deleteAssetWithMode(id, deleteMode, projectId);
            if (
              result.failed_moves.length > 0
              || (!projectId && result.deleted_assets === 0)
            ) {
              failedCount += 1;
            }
          } catch (e) {
            failedCount += 1;
            console.error("delete one failed", e);
          }
        }
      }
      await reloadProjects();
      if (failedCount > 0) {
        notifyError(null, `${failedCount} 张删除失败，已保留在全局`);
        setBusy(false);
        return;
      }
      notifySuccess(
        deleteMode === "keep"
          ? "素材已移出当前项目"
          : "素材已移出园丁鸟"
      );
      if (useStore.getState().contextMenu === menu) onComplete?.();
      closeContextMenu();
    } catch (e) {
      notifyError(e, "删除失败");
      setBusy(false);
    }
  }

  const itemClass = "app-context-item px-2 py-1.5";
  function confirmDelete(ids: string[]) {
    setPendingCanvasDelete({ assetIds: [...new Set(ids)], projectId, localPaths: menu!.fileSelection?.localPaths, onComplete });
    closeContextMenu();
  }
  const describeMenu = <ContextSubmenu label={multiIds ? "批量反推" : "反推提示词"} menuLabel="选择反推引擎" icon={<ScanSearch size={13} />}
    disabled={busy || (!multiIds && describing)} title={describing && !multiIds ? "这张图片正在反推或已排队" : undefined}>
    {describeEngines.map(engine => <button key={engine.key} type="button" role="menuitem" className={itemClass}
      disabled={busy || engine.reason !== null} title={engine.reason ? userErrorMessage(engine.reason, "此方式暂不可用，请在设置中重新登录。") : `用 ${engine.label} 反推`} onClick={() => runDescribeWith(engine.key)}>
      <span className={`app-status-dot ${engine.reason === null ? "is-ready" : ""}`} aria-hidden="true" />
      <span>{engine.label}{engine.reason && <small className="context-menu-reason">{userErrorMessage(engine.reason, "此方式暂不可用，请在设置中重新登录。")}</small>}</span>
    </button>)}
  </ContextSubmenu>;
  const canvasActions = menu.canvasSelection && <>
    <CanvasLayerMenuItem {...menu.canvasSelection} disabled={busy} className={itemClass} />
    {menu.canvasSelection.nodeIds.length > 1 && <button role="menuitem" className={itemClass} disabled={busy} onClick={() => {
      window.dispatchEvent(new CustomEvent<CanvasArrangeNodesEventDetail>(CANVAS_ARRANGE_NODES_EVENT, { detail: menu.canvasSelection })); closeContextMenu();
    }}><LayoutDashboard size={13} />整理</button>}
    {menu.addCanvasImagesToBoard && menu.addCanvasImagesToBoard.count > 0 && <button role="menuitem" className={itemClass} disabled={busy}
      onClick={() => { closeContextMenu(); menu.addCanvasImagesToBoard!.run(); }}>
      {menu.addCanvasImagesToBoard.count > 1 ? `添加所选 ${menu.addCanvasImagesToBoard.count} 张图片到对话框` : "添加到对话框"}
    </button>}
  </>;
  const deleteMenu = <DeleteSubmenu disabled={busy}>
    {menu.ungroupCanvasFolder && !canvasMulti && <button role="menuitem" className={itemClass} onClick={() => { closeContextMenu(); menu.ungroupCanvasFolder!(); }}><Ungroup size={13} />解散素材组</button>}
    {!multiIds && menu.libraryProjectId && canChangeLibraryVisibility && !asset?.library_hidden && <button role="menuitem" className={itemClass}
      disabled={!canvasLibraryAvailable} title={canvasLibraryAvailable ? "从中央和各项目素材库列表移除，保留所有画布中的图片及原文件" : "请先将图片拖到当前画布"}
      onClick={() => void setLibraryVisibility(false)}>从库中删除 · 在画布保留</button>}
    {menu.canvasSelection && <button role="menuitem" className={itemClass} onClick={() => {
      window.dispatchEvent(new CustomEvent<CanvasRemoveNodesEventDetail>(CANVAS_REMOVE_NODES_EVENT, { detail: menu.canvasSelection })); closeContextMenu();
    }}>{canvasMulti ? `从画布移出所选 ${menu.canvasSelection.nodeIds.length} 项` : "从画布移出"}</button>}
    {projectId && targetIds.length > 0 && <button role="menuitem" className={itemClass} title="仅移出当前项目 · 素材留在全局" onClick={() => multiIds ? void runBatchDelete(multiIds, "keep") : void runDelete(assetId, "keep")}>移出当前项目</button>}
    {(multiIds ? batchMovable : moveOutAvailable) && <button role="menuitem" className={itemClass} title="不会删除文件，文件回到原始位置"
      onClick={() => multiIds ? void runBatchDelete(multiIds, "move_out") : void runDelete(assetId, "move_out")}>移出园丁鸟</button>}
    {targetIds.length > 0 && <button role="menuitem" className={itemClass + " is-danger"} onClick={() => confirmDelete(targetIds)}>
      {menu.fileSelection?.localPaths ? "删除本机文件" : targetsReady && targets.every(item => item.source === "external") ? multiIds ? "移除引用 · 原文件保留" : "移除外部引用记录" : "物理删除"}
    </button>}
    {!multiIds && groupIds && groupIds.length > 1 && <button role="menuitem" className={itemClass + " is-danger"}
      title="删除这组同流程生成图的全部成员（含当前显示的这张）" onClick={() => confirmDelete(groupIds)}>物理删除整组 · {groupIds.length} 张</button>}
  </DeleteSubmenu>;
  function assign() { setAssignCollectionIds({ ids: targetIds, onComplete }); closeContextMenu(); }
  if (multiIds) return <ContextMenu key={`${assetId}:${menu.x}:${menu.y}:multi`} x={menu.x} y={menu.y} label={`已选 ${canvasMulti ? menu.canvasSelection!.nodeIds.length : multiIds.length} 项素材的操作`}
    onClose={closeContextMenu} className="asset-context-menu is-multi">
    <div className="asset-context-column">
      <div className="app-context-label">已选 {canvasMulti ? menu.canvasSelection!.nodeIds.length : multiIds.length} 项</div>
      {canvasActions}
      {targetIds.length > 0 && <button role="menuitem" className={itemClass} disabled={busy} onClick={assign}><FolderPlus size={13} />添加到集合</button>}
      {menu.canvasSelection && targetIds.length > 0 && <button role="menuitem" className={itemClass} disabled={busy} onClick={() => { closeContextMenu(); void exportAssetArchive(targetIds); }}><Archive size={13} />将所选内容打包</button>}
      {!projectId && projects.length > 0 && <button role="menuitem" className={itemClass} disabled={busy} onClick={() => { setProjectPickIds({ ids: targetIds, onComplete }); closeContextMenu(); }}><FolderTree size={13} />加入项目</button>}
      {allImages && <><div className="app-context-divider" />{describeMenu}</>}
      <div className="app-context-divider" />{deleteMenu}
    </div>
  </ContextMenu>;

  return <ContextMenu key={`${assetId}:${menu.x}:${menu.y}`} x={menu.x} y={menu.y} label="素材操作" onClose={closeContextMenu} className="asset-context-menu" contentClassName="asset-context-columns">
    <div className="asset-context-column">
      <div className="app-context-label">常用</div>
      {canvasActions}
      {mode === "browse" && detailAssetId !== null && <button role="menuitem" className={itemClass} disabled={busy}
        onClick={() => { addAssetToBoardFromDetail(assetId); closeContextMenu(); }}>添加到对话框</button>}
      <button role="menuitem" className={itemClass} disabled={busy} onClick={() => { closeContextMenu(); if (menu.fileSelection) useStore.setState({ mode: "browse" }); openDetail(assetId); }}>{isVideoPath(storePath) ? "打开视频详情" : "打开图片详情"}</button>
      {!menu.canvasSelection && <button role="menuitem" className={itemClass} disabled={busy} onClick={() => {
        if (menu.fileSelection) menu.fileSelection.select(); else { if (mode !== "manage") enterManage(); toggleSelect(assetId); } closeContextMenu();
      }}>{menu.fileSelection ? "选择" : mode === "manage" ? "选择/取消选择" : "选择"}</button>}
      {storePath && <button role="menuitem" className={itemClass} disabled={busy} title={menu.fileSelection?.localPaths ? "重命名本机文件" : asset?.source === "external" ? "修改引用名称，原文件名保留" : "重命名（同步改磁盘文件名）"}
        onClick={() => { const localPath = menu.fileSelection?.localPaths?.[assetId]; setRenameTarget({ id: assetId, name: localPath ? localPath.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "") : asset?.name ?? "", external: !localPath && asset?.source === "external", localPath }); closeContextMenu(); }}>重命名</button>}
      {(allImages || isGenerated) && <><div className="app-context-divider" /><div className="app-context-label">再创作</div></>}
      {allImages && describeMenu}
      {menu.canvasSelection && canChangeLibraryVisibility && <button role="menuitem" className={itemClass} disabled={busy} onClick={() => {
        window.dispatchEvent(new CustomEvent(CANVAS_ARTBOARD_FROM_IMAGE, { detail: { ...menu.canvasSelection, assetId } })); closeContextMenu();
      }}><LayoutDashboard size={13} />以此图新建画板</button>}
      {isGenerated && <button role="menuitem" data-tour="ctx-reuse-gen" className={itemClass} disabled={busy} onClick={reuseGeneration}><ClipboardCopy size={13} />复用生成提示词</button>}
      {annotatable && <>
        <button role="menuitem" className={itemClass} disabled={busy} onClick={() => { openAnnotator(assetId); closeContextMenu(); }}><PenTool size={13} />图片标注</button>
        <button role="menuitem" className={itemClass} disabled={busy} onClick={() => useStore.getState().openLayerEditor(assetId)}><Layers size={13} />分层编辑</button>
      </>}
      {isGenerated && <button role="menuitem" className={itemClass} disabled={busy} onClick={() => { closeContextMenu(); void viewGenerationHistory(assetId); }}><MessageSquare size={13} />回看所属创作</button>}
    </div>
    <div className="asset-context-column">
      <div className="app-context-label">文件</div>
      <button role="menuitem" className={itemClass} disabled={busy} onClick={assign}><FolderPlus size={13} />添加到集合</button>
      {menu.canvasSelection && <button role="menuitem" className={itemClass} disabled={busy} onClick={() => { closeContextMenu(); void exportAssetArchive(targetIds); }}><Archive size={13} />将所选内容打包</button>}
      {storePath && <>
        <button role="menuitem" className={itemClass} disabled={busy} onClick={reveal}>打开所在文件夹</button>
        <button role="menuitem" className={itemClass} disabled={busy} onClick={async () => { setBusy(true); try { await api.openWithSystem(storePath); notifySuccess("已用系统程序打开素材"); closeContextMenu(); } catch (e) { notifyError(e, "无法用系统程序打开素材"); setBusy(false); } }}>用系统程序打开</button>
        {annotatable && <button role="menuitem" className={itemClass} disabled={busy} onClick={copyImage}>复制图片</button>}
        <button role="menuitem" className={itemClass} disabled={busy} onClick={async () => { setBusy(true); try { await navigator.clipboard.writeText(storePath); notifySuccess("文件路径已复制"); closeContextMenu(); } catch (e) { notifyError(e, "复制文件路径失败"); setBusy(false); } }}>复制文件路径</button>
      </>}
      {asset?.source === "external" && <button role="menuitem" className={itemClass} disabled={busy} onClick={() => { closeContextMenu(); if (menu.fileSelection) menu.fileSelection.openReferences(); else window.dispatchEvent(new Event(OPEN_LOCAL_FILES)); }}>管理外部引用 · 原图保留</button>}
      {menu.canvasSelection && asset?.library_hidden && <button role="menuitem" className={itemClass} disabled={busy} onClick={() => void setLibraryVisibility(true)}>加入素材库</button>}
      <div className="app-context-divider" />{deleteMenu}
    </div>
  </ContextMenu>;
}

/** 多选右键「加入项目」小面板：勾选（可多选）目标项目后批量加入；
 *  全部失败留在面板反馈，至少一个成功才退出管理。 */
function BatchAddToProjectsDialog({ ids, onClose, onComplete }: SelectionOperation & { onClose: () => void }) {
  const projects = useStore((s) => s.projects);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (checked.size === 0 || busy) return;
    setBusy(true);
    let failed = 0;
    for (const projectId of checked) {
      try {
        await api.addAssetsToProject(projectId, ids);
      } catch (e) {
        failed += 1;
        console.error("add to project failed", e);
      }
    }
    await useStore.getState().reloadProjects();
    if (failed === checked.size) {
      notifyError(null, "加入项目失败");
      setBusy(false);
      return;
    }
    if (failed === 0) onComplete?.();
    if (failed > 0) notifyError(null, `${failed} 个项目加入失败`);
    notifySuccess(`素材已加入 ${checked.size - failed} 个项目`);
    useStore.getState().exitManage();
    onClose();
  }

  return (
    <ModalShell
      title="加入项目"
      eyebrow="Add to projects"
      description={`勾选要放入所选 ${ids.length} 张素材的项目（可多选）。`}
      onClose={onClose}
      preventClose={busy}
      footer={
        <>
          <button onClick={onClose} disabled={busy} className="app-modal-button">
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={checked.size === 0 || busy}
            className="app-modal-button is-primary"
          >
            {busy && <span className="app-spinner" aria-hidden />}
            {busy ? "加入中…" : checked.size > 0 ? `加入所选 ${checked.size} 个项目` : "加入项目"}
          </button>
        </>
      }
    >
      <div className="max-h-64 space-y-1 overflow-y-auto">
        {projects.map((p) => (
          <label
            key={p.id}
            className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm ${busy ? "" : "cursor-pointer hover:bg-edge"}`}
          >
            <input
              type="checkbox"
              checked={checked.has(p.id)}
              disabled={busy}
              onChange={() => toggle(p.id)}
              className="size-4"
            />
            <span className="min-w-0 flex-1 truncate" title={p.name}>{p.name}</span>
          </label>
        ))}
        {projects.length === 0 && (
          <p className="px-2.5 py-4 text-center text-xs text-muted">还没有项目</p>
        )}
      </div>
    </ModalShell>
  );
}
