import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CanvasLayerMenuItem } from "./CanvasLayerMenuItem";
import { createPortal } from "react-dom";
import { ChevronRight, ClipboardCopy, FolderInput, FolderPlus, FolderTree, Layers, LayoutDashboard, MessageSquare, PenTool, ScanSearch, Trash2, Ungroup } from "lucide-react";
import { understandEngineUsable, useStore } from "../store";
import { api } from "../lib/api";
import { loadDescribePrompt } from "../lib/describePrompt";
import { ConfirmDialog } from "./ConfirmDialog";
import { ModalShell } from "./ModalShell";
import { RenameDialog } from "./RenameDialog";
import { canUseByo } from "../lib/entitlement";
import { notifyError, notifySuccess } from "../lib/notify";
import { isWorkspaceOperationCurrent } from "../lib/workspaceRoute";
import type { AssetDeleteMode, AssetDeleteResult } from "../lib/types";
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

function resultMessage(mode: AssetDeleteMode, result: AssetDeleteResult): string {
  if (mode === "keep") {
    return result.removed_members > 0 ? "已移出当前项目，素材留在全局" : "素材已在全局";
  }
  if (mode === "move_out") {
    return result.deleted_assets > 0
      ? "文件已回到原始位置，并从素材库移除"
      : "文件已在原始位置，素材仍保留在全局";
  }
  return `已物理删除 ${result.deleted_assets} 张素材`;
}

/** 右键「反推」二级菜单的引擎选项；reason 为空表示该引擎当前可用。 */
interface DescribeEngineOption {
  key: "bowerbird-cloud" | "codex";
  label: string;
  reason: string | null;
}

/** 反推引擎二级子菜单：不可用引擎置灰 + 原因在 tooltip，选定后直接执行（onPick）。 */
function DescribeEngineSubmenu({ engines, busy, onLeft, pickTitle, onPick }: {
  engines: DescribeEngineOption[];
  busy: boolean;
  onLeft: boolean;
  pickTitle: (engine: DescribeEngineOption) => string;
  onPick: (key: DescribeEngineOption["key"]) => void;
}) {
  return (
    <div
      className={`app-context-menu asset-context-submenu p-1.5 text-xs ${onLeft ? "right-full mr-0.5" : "left-full ml-0.5"}`}
      role="menu"
      aria-label="选择反推引擎"
    >
      {engines.map((engine) => {
        const usable = engine.reason === null;
        return (
          <button
            key={engine.key}
            type="button"
            role="menuitem"
            disabled={busy || !usable}
            title={usable ? pickTitle(engine) : engine.reason ?? undefined}
            className="app-context-item px-2 py-1.5"
            onClick={() => onPick(engine.key)}
          >
            <span className={`app-status-dot ${usable ? "is-ready" : ""}`} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{engine.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * 图片右键菜单：常用 / 再创作、文件 / 移出与删除 两列。
 * 全局只有一个实例（store.contextMenu 状态驱动），挂在 App 最外层；
 * 瀑布流缩略图 / 详情页大图各自 onContextMenu 触发。
 */
export function AssetContextMenu() {
  const menu = useStore((s) => s.contextMenu);
  const closeContextMenu = useStore((s) => s.closeContextMenu);
  const openDetail = useStore((s) => s.openDetail);
  const exitProject = useStore((s) => s.exitProject);
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
  const folders = useStore((s) => s.folders);
  const projects = useStore((s) => s.projects);
  const reloadFolders = useStore((s) => s.reloadFolders);
  const clearSelect = useStore((s) => s.clearSelect);
  const exitManage = useStore((s) => s.exitManage);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  const cloudAvailable = cloudAuth?.cloud_available ?? false;
  const reuseIntentRef = useRef(0);

  const [busy, setBusy] = useState(false);
  const [canvasLibraryCheck, setCanvasLibraryCheck] = useState<{ menu: typeof menu; available: boolean } | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  // 右键素材所在生成组的成员 id（菜单打开时取，>1 张才显示「物理删除整组」）。
  const [groupIds, setGroupIds] = useState<string[] | null>(null);
  const [pendingGroupDelete, setPendingGroupDelete] = useState<string[] | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  // 多选菜单的「移入已有集合」二级子菜单开关。
  const [folderSubOpen, setFolderSubOpen] = useState(false);
  // 「反推」二级子菜单开关（单图 / 多选菜单共用一个状态，两种菜单不会同时出现）。
  const [describeSubOpen, setDescribeSubOpen] = useState(false);
  // 多选菜单点击后弹出的批量面板（菜单先收，再由 !menu 分支挂载）。
  const [newCollectionIds, setNewCollectionIds] = useState<string[] | null>(null);
  const [projectPickIds, setProjectPickIds] = useState<string[] | null>(null);
  const [pendingBatchDelete, setPendingBatchDelete] = useState<string[] | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu?.libraryProjectId) return;
    let alive = true;
    api.projectCanvasGet(menu.libraryProjectId).then(snapshot => {
      if (alive) setCanvasLibraryCheck({ menu, available: snapshot.nodes.some(node =>
        node.kind === "asset" && node.assetId === menu.assetId && node.hiddenAt == null) });
    }).catch(() => { if (alive) setCanvasLibraryCheck({ menu, available: false }); });
    return () => { alive = false; };
  }, [menu]);

  // 按实际尺寸避让窗口边缘；异步出现的整组删除和窗口缩放也重新定位。
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!menu || !element) return;
    const position = () => {
      const rect = element.getBoundingClientRect();
      element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))}px`;
      element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(element);
    window.addEventListener("resize", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
    };
  }, [menu]);

  // 每次打开重置子状态。
  // （pendingDeleteId / pendingGroupDelete / pendingBatchDelete / renameTarget /
  //   newCollectionIds / projectPickIds 不在此重置——对应按钮点击会先 closeContextMenu 再弹
  //   dialog，menu=null 触发本 effect，重置会把尚需显示的 dialog 一起清掉；它们由自身回调清理。）
  useEffect(() => {
    setBusy(false);
    setFolderSubOpen(false);
    setDescribeSubOpen(false);
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

  // 菜单打开时：点击菜单外关闭、Esc 关闭。
  useEffect(() => {
    if (!menu) return;
    function onMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeContextMenu();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        closeContextMenu();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      if (buttons.length === 0) return;
      e.preventDefault();
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const columns = menuRef.current?.querySelectorAll<HTMLElement>(".asset-context-column");
        const target = columns?.[e.key === "ArrowRight" ? 1 : 0];
        const currentColumn = document.activeElement?.closest(".asset-context-column");
        const currentButtons = Array.from(currentColumn?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const targetButtons = Array.from(target?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const index = Math.max(0, currentButtons.indexOf(document.activeElement as HTMLButtonElement));
        targetButtons[Math.min(index, targetButtons.length - 1)]?.focus();
        return;
      }
      if (e.key === "Home") {
        buttons[0].focus();
        return;
      }
      if (e.key === "End") {
        buttons[buttons.length - 1].focus();
        return;
      }
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const offset = e.key === "ArrowDown" ? 1 : -1;
      buttons[(current + offset + buttons.length) % buttons.length].focus();
    }
    // 画板节点会在 pointerdown 中阻止冒泡以启动拖动；用捕获阶段确保
    // 左键点击画板时仍能先关闭已经打开的右键菜单。
    window.addEventListener("pointerdown", onMouseDown, true);
    window.addEventListener("keydown", onKey);
    window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    });
    return () => {
      window.removeEventListener("pointerdown", onMouseDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, closeContextMenu]);

  // 物理删除确认 / 重命名 dialog：独立于菜单渲染。点「物理删除」/「物理删除整组」/「重命名」
  // 会先 closeContextMenu 收菜单，menu=null 走此分支单独挂载。
  if (!menu) {
    return (
      <>
        <ConfirmDialog
          open={pendingDeleteId !== null}
          danger
          title="物理删除素材"
          message={<>素材将从全局及所有项目物理删除，<strong>不可恢复</strong>。</>}
          confirmLabel="物理删除"
          onConfirm={() => {
            const id = pendingDeleteId;
            setPendingDeleteId(null);
            if (id) void runDelete(id, "delete");
          }}
          onCancel={() => setPendingDeleteId(null)}
        />
        <ConfirmDialog
          open={pendingGroupDelete !== null}
          danger
          title="物理删除整组素材"
          message={
            <>这组 {pendingGroupDelete?.length ?? 0} 张素材将从全局及所有项目物理删除，<strong>不可恢复</strong>。</>
          }
          confirmLabel="物理删除整组"
          onConfirm={() => {
            const ids = pendingGroupDelete;
            setPendingGroupDelete(null);
            if (ids && ids.length > 0) void runDeleteGroup(ids);
          }}
          onCancel={() => setPendingGroupDelete(null)}
        />
        <ConfirmDialog
          open={pendingBatchDelete !== null}
          danger
          title={`物理删除 ${pendingBatchDelete?.length ?? 0} 张素材`}
          message={<>这些素材将从全局及所有项目物理删除，<strong>不可恢复</strong>。</>}
          confirmLabel="物理删除"
          onConfirm={() => {
            const ids = pendingBatchDelete;
            setPendingBatchDelete(null);
            if (ids && ids.length > 0) void runBatchDelete(ids, "delete");
          }}
          onCancel={() => setPendingBatchDelete(null)}
        />
        {renameTarget && (
          <RenameDialog
            open
            assetId={renameTarget.id}
            currentName={renameTarget.name}
            onClose={() => setRenameTarget(null)}
          />
        )}
        {newCollectionIds && (
          <BatchNewCollectionDialog ids={newCollectionIds} onClose={() => setNewCollectionIds(null)} />
        )}
        {projectPickIds && (
          <BatchAddToProjectsDialog ids={projectPickIds} onClose={() => setProjectPickIds(null)} />
        )}
      </>
    );
  }

  // 守卫后捕获，闭包里直接用（TS 不会把守卫的收窄带进嵌套函数）。
  const assetId = menu.assetId;
  const asset = menu.asset ?? assets.find((a) => a.id === assetId);
  // 多选右键（manage 模式、选区 >1 且右键图在选区内）→ 专属批量菜单：
  // 单图操作（详情 / 重命名 / 标注 / 分层 / 文件类）不适用，换成集合 / 项目 / 批量反推 / 批量删除。
  const multiIds = mode === "manage" && selectedIds.size > 1 && selectedIds.has(assetId)
    ? Array.from(selectedIds)
    : null;
  // 移入已有只列普通集合（排除 root、智能夹与收藏夹），与 BatchBar 一致。
  const existingFolders = folders.filter((f) => f.id !== "root" && (f.kind ?? "folder") === "folder");
  const batchHasNonMovable = multiIds?.some((id) => !canMoveAssetOut(assets.find((a) => a.id === id))) ?? false;
  // 二级集合子菜单默认向右飞出，靠右时翻到左侧。
  const subOnLeft = menu.x > window.innerWidth - 340;
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
    useStore.getState().describingId === assetId ||
    useStore.getState().describeQueue.some((q) => q.assetId === assetId);
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
  const anyDescribeEngine = describeEngines.some((engine) => engine.reason === null);

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

  async function runDelete(id: string, mode: AssetDeleteMode) {
    setBusy(true);
    try {
      const result = await api.deleteAssetWithMode(id, mode, activeProjectId);
      await reloadProjects();
      if (result.failed_moves.length > 0) {
        notifyError(null, `移出失败：${result.failed_moves.join("、")}，素材保留在全局`);
        setBusy(false);
        return;
      }
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
      await api.setCanvasAssetLibraryVisibility(projectId, assetId, visible);
      notifySuccess(visible ? "已加入素材库" : "已从素材库移除，画布图片已保留");
      if (useStore.getState().contextMenu === expectedMenu) closeContextMenu();
      void reloadProjects();
    } catch (error) {
      notifyError(error, "调整素材库归属失败");
      if (useStore.getState().contextMenu === expectedMenu) setBusy(false);
    }
  }

  /** 整组物理删除：循环单条 delete（无批量 API，与 BatchBar 批量删除同模式），
   *  单条失败不中断后续；有失败 → 报失败数，全成功 → toast 总数。 */
  async function runDeleteGroup(ids: string[]) {
    setBusy(true);
    let failed = 0;
    try {
      for (const id of ids) {
        try {
          await api.deleteAssetWithMode(id, "delete", activeProjectId);
        } catch (e) {
          failed += 1;
          console.error("delete one failed", e);
        }
      }
      await reloadProjects();
      if (failed > 0) {
        notifyError(null, `${failed} 张删除失败，已保留在全局`);
        setBusy(false);
        return;
      }
      notifySuccess(`已物理删除 ${ids.length} 张素材`);
      closeContextMenu();
    } catch (e) {
      notifyError(e, "删除失败");
      setBusy(false);
    }
  }

  /** 多选右键「移入已有集合」：与 BatchBar 移入已有同链路，成功后跳转到该集合。 */
  async function runBatchMoveToExisting(ids: string[], folderId: string) {
    setBusy(true);
    try {
      await api.moveAssetsToFolder(ids, folderId);
      clearSelect();
      exitManage();
      useStore.getState().setCurrentFolder(folderId);
      await reloadFolders();
      notifySuccess("素材已移入集合");
      closeContextMenu();
    } catch (e) {
      notifyError(e, "移入失败");
      setBusy(false);
    }
  }

  /** 反推二级菜单选定引擎后直接入队（单图 / 多选批量同链路，批量与选择浮层一致退出管理态）。 */
  function runDescribeWith(engine: DescribeEngineOption["key"]) {
    const instruction = loadDescribePrompt();
    const st = useStore.getState();
    if (multiIds) {
      for (const id of multiIds) st.runDescribe(id, instruction, engine);
      st.exitManage();
    } else {
      st.runDescribe(assetId, instruction, engine);
    }
    closeContextMenu();
  }

  /** 多选右键批量删除：与 BatchBar 同模式——keep 数组一次；move_out/delete 循环单条，
   *  move_out 的文件恢复失败是结构化结果而非 rejected promise；有失败留在原地反馈，全成功退出管理。 */
  async function runBatchDelete(ids: string[], deleteMode: AssetDeleteMode) {
    setBusy(true);
    let failedCount = 0;
    try {
      if (deleteMode === "keep") {
        if (activeProjectId) await api.removeAssetsFromProject(activeProjectId, ids);
      } else {
        for (const id of ids) {
          try {
            const result = await api.deleteAssetWithMode(id, deleteMode, activeProjectId);
            if (
              result.failed_moves.length > 0
              || (deleteMode === "move_out" && !activeProjectId && result.deleted_assets === 0)
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
          : deleteMode === "move_out"
            ? "素材已移出园丁鸟"
            : `已物理删除 ${ids.length} 张素材`
      );
      exitManage();
      closeContextMenu();
    } catch (e) {
      notifyError(e, "删除失败");
      setBusy(false);
    } finally {
      setPendingBatchDelete(null);
    }
  }

  const menuStyle: React.CSSProperties = {
    position: "fixed",
    left: menu.x,
    top: menu.y,
    zIndex: 60,
  };

  async function showAssetDetail() {
    closeContextMenu();
    if (!activeProjectId) {
      openDetail(assetId);
      return;
    }
    try {
      await exitProject();
      const state = useStore.getState();
      // 路由期间若用户已进入另一项目，不用迟到的详情请求覆盖新意图。
      if (state.activeProjectId === null) state.openDetail(assetId);
    } catch (error) {
      notifyError(error, "无法打开图片详情，当前画板保持不变");
    }
  }

  // 多选专属菜单：单列窄卡，只保留对整批有意义的操作（集合 / 项目 / 批量反推 / 批量删除）。
  if (multiIds) {
    return createPortal(
      <div
        ref={menuRef}
        style={menuStyle}
        onContextMenu={(e) => e.preventDefault()}
        className="app-context-menu asset-context-menu is-multi p-1.5 text-xs"
        role="menu"
        aria-label={`已选 ${multiIds.length} 张素材的操作`}
      >
        <div className="asset-context-column">
          <div className="app-context-label">已选 {multiIds.length} 张素材</div>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            title="创建新集合，并把选中的素材移入"
            className="app-context-item px-2 py-1.5"
            onClick={() => {
              // 先收菜单再弹命名弹窗，避免两个浮层同时存在。
              setNewCollectionIds(multiIds);
              closeContextMenu();
            }}
          >
            <FolderPlus size={13} className="shrink-0" /> 用选中的内容新建集合
          </button>
          <div
            className="relative"
            onMouseEnter={() => setFolderSubOpen(true)}
            onMouseLeave={() => setFolderSubOpen(false)}
          >
            <button
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={folderSubOpen}
              disabled={busy || existingFolders.length === 0}
              title={existingFolders.length === 0 ? "还没有集合，可先「用选中的内容新建集合」" : "移入已有集合"}
              className="app-context-item px-2 py-1.5"
              onClick={() => setFolderSubOpen((open) => !open)}
            >
              <FolderInput size={13} className="shrink-0" />
              <span className="flex-1 text-left">移入已有集合</span>
              <ChevronRight size={13} className="shrink-0" aria-hidden="true" />
            </button>
            {folderSubOpen && existingFolders.length > 0 && (
              <div
                className={`app-context-menu asset-context-submenu p-1.5 text-xs ${subOnLeft ? "right-full mr-0.5" : "left-full ml-0.5"}`}
                role="menu"
                aria-label="选择要移入的集合"
              >
                {existingFolders.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    role="menuitem"
                    disabled={busy}
                    title={`移入「${f.name}」`}
                    className="app-context-item px-2 py-1.5"
                    onClick={() => void runBatchMoveToExisting(multiIds, f.id)}
                  >
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {!activeProjectId && projects.length > 0 && (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              title="勾选一个或多个项目，把选中的素材加进去"
              className="app-context-item px-2 py-1.5"
              onClick={() => {
                // 先收菜单再弹项目勾选面板，避免两个浮层同时存在。
                setProjectPickIds(multiIds);
                closeContextMenu();
              }}
            >
              <FolderTree size={13} className="shrink-0" /> 加入项目
            </button>
          )}

          <div className="app-context-divider" />
          <div className="app-context-label">再创作</div>
          <div
            className="relative"
            onMouseEnter={() => setDescribeSubOpen(true)}
            onMouseLeave={() => setDescribeSubOpen(false)}
          >
            <button
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={describeSubOpen}
              disabled={busy}
              title="展开选择反推引擎（Bowerbird Cloud / 本机 codex）"
              className="app-context-item px-2 py-1.5"
              onClick={() => setDescribeSubOpen((open) => !open)}
            >
              <ScanSearch size={13} className="shrink-0" />
              <span className="flex-1 text-left">批量反推</span>
              <ChevronRight size={13} className="shrink-0" aria-hidden="true" />
            </button>
            {describeSubOpen && (
              <DescribeEngineSubmenu
                engines={describeEngines}
                busy={busy}
                onLeft={subOnLeft}
                pickTitle={(engine) => `用 ${engine.label} 反推 ${multiIds.length} 张`}
                onPick={runDescribeWith}
              />
            )}
          </div>

          <div className="app-context-divider" />
          <div className="app-context-label asset-context-label-with-icon">
            <Trash2 size={12} aria-hidden="true" />
            移出与删除
          </div>
          {activeProjectId && (
            <button
              type="button"
              role="menuitem"
              onClick={() => void runBatchDelete(multiIds, "keep")}
              disabled={busy}
              title="仅移出当前项目 · 素材留在全局"
              className="app-context-item px-2 py-1.5"
            >
              移出当前项目
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => void runBatchDelete(multiIds, "move_out")}
            disabled={busy || batchHasNonMovable}
            title={batchHasNonMovable
              ? "所选内容包含没有可恢复原始位置的素材，只能物理删除"
              : "不会删除文件，文件回到原始位置"}
            className="app-context-item px-2 py-1.5"
          >
            移出园丁鸟
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              // 先收菜单再弹批量删除确认，避免两个浮层同时存在。
              setPendingBatchDelete(multiIds);
              closeContextMenu();
            }}
            disabled={busy}
            className="app-context-item is-danger px-2 py-1.5"
          >
            物理删除
          </button>
        </div>
      </div>,
      document.body
    );
  }

  return createPortal(
    <div
      ref={menuRef}
      style={menuStyle}
      onContextMenu={(e) => e.preventDefault()}
      // 子菜单展开时放开滚动裁剪，让二级菜单能飞出菜单外（收起后恢复可滚动）。
      className={`app-context-menu asset-context-menu p-1.5 text-xs${describeSubOpen ? " submenu-open" : ""}`}
      role="menu"
      aria-label="素材操作"
    >
      <div className="asset-context-column">
        <div className="app-context-label">常用</div>
        {menu.canvasSelection && <CanvasLayerMenuItem {...menu.canvasSelection} disabled={busy} className="app-context-item px-2 py-1.5" />}
        {menu.ungroupCanvasFolder && (
          <button type="button" role="menuitem" disabled={busy} className="app-context-item px-2 py-1.5"
            onClick={() => {
              closeContextMenu();
              menu.ungroupCanvasFolder!();
            }}>
            <Ungroup size={13} className="shrink-0" /> 解散素材组
          </button>
        )}
        {menu.canvasSelection && menu.canvasSelection.nodeIds.length > 1 && (
          <button type="button" role="menuitem" disabled={busy} className="app-context-item px-2 py-1.5"
            onClick={() => {
              window.dispatchEvent(new CustomEvent<CanvasArrangeNodesEventDetail>(CANVAS_ARRANGE_NODES_EVENT, {
                detail: menu.canvasSelection,
              }));
              closeContextMenu();
            }}>
            <LayoutDashboard size={13} className="shrink-0" /> 整理
          </button>
        )}
        {menu.addCanvasImagesToBoard && menu.addCanvasImagesToBoard.count > 0 && (
          <button type="button" role="menuitem" disabled={busy} className="app-context-item px-2 py-1.5"
            onClick={() => {
              closeContextMenu();
              menu.addCanvasImagesToBoard!.run();
            }}>
            {menu.addCanvasImagesToBoard.count > 1
              ? `添加所选 ${menu.addCanvasImagesToBoard.count} 张图片到对话框`
              : "添加到对话框"}
          </button>
        )}
        {/* 详情页右键（编辑器对话框与详情页互斥，从此处带回主界面插 chip）：菜单第一项。 */}
        {mode === "browse" && detailAssetId !== null && (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              addAssetToBoardFromDetail(assetId);
              closeContextMenu();
            }}
            disabled={busy}
            className="app-context-item px-2 py-1.5"
          >
            添加到对话框
          </button>
        )}
        {/* 浏览（未激活创作）模式下右键开详情；激活态左键是插 chip，详情也走这里。 */}
        <button
          type="button"
          role="menuitem"
          onClick={() => void showAssetDetail()}
          disabled={busy}
          className="app-context-item px-2 py-1.5"
        >
          打开图片详情
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            // browse 模式：右键直接进 manage 并选中此图；manage 模式：仅切换选中。继续点其它图加选。
            if (mode !== "manage") enterManage();
            toggleSelect(assetId);
            closeContextMenu();
          }}
          disabled={busy}
          className="app-context-item px-2 py-1.5"
        >
          {mode === "manage" ? "选择/取消选择" : "选择"}
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            // 先收菜单再开 dialog，避免两个浮层同时存在。
            setRenameTarget({ id: assetId, name: asset?.name ?? "" });
            closeContextMenu();
          }}
          disabled={busy || !storePath}
          title={storePath ? "重命名（同步改磁盘文件名）" : "该素材没有本地文件，无法重命名"}
          className="app-context-item px-2 py-1.5"
        >
          重命名
        </button>
        <div className="app-context-divider" />
        <div className="app-context-label">再创作</div>
        <div
          className="relative"
          onMouseEnter={() => setDescribeSubOpen(true)}
          onMouseLeave={() => setDescribeSubOpen(false)}
        >
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={describeSubOpen}
            onClick={() => setDescribeSubOpen((open) => !open)}
            disabled={busy || describing}
            title={
              describing
                ? "这张图片正在反推或已排队"
                : anyDescribeEngine
                  ? "展开选择反推引擎（Bowerbird Cloud / 本机 codex）"
                  : "反推引擎均不可用：Bowerbird Cloud 需登录且有积分；本机 codex 需 Pro 且本机就绪"
            }
            className="app-context-item px-2 py-1.5"
          >
            <ScanSearch size={13} className="shrink-0" />
            <span className="flex-1 text-left">反推提示词</span>
            <ChevronRight size={13} className="shrink-0" aria-hidden="true" />
          </button>
          {describeSubOpen && !describing && (
            <DescribeEngineSubmenu
              engines={describeEngines}
              busy={busy}
              onLeft={subOnLeft}
              pickTitle={(engine) => `用 ${engine.label} 反推`}
              onPick={runDescribeWith}
            />
          )}
        </div>
        {isGenerated && (
          <button
            type="button"
            role="menuitem"
            data-tour="ctx-reuse-gen"
            onClick={reuseGeneration}
            disabled={busy}
            title="打开创作板，填入该图生成时的提示词与参考素材"
            className="app-context-item px-2 py-1.5"
          >
            <ClipboardCopy size={13} className="shrink-0" />
            复用生成提示词
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            openAnnotator(assetId);
            closeContextMenu();
          }}
          disabled={busy || !annotatable}
          title={
            annotatable
              ? "截图软件式画框 / 箭头标注；输出可保存到素材库或插入创作板（不入库）"
              : "该素材不是可标注的图片"
          }
          className="app-context-item px-2 py-1.5"
        >
          <PenTool size={13} className="shrink-0" />
          图片标注
        </button>
        <button type="button" role="menuitem" disabled={busy || !annotatable}
          title={annotatable ? "拆分并独立调整图层" : "该素材不是可编辑的图片"}
          className="app-context-item px-2 py-1.5"
          onClick={() => useStore.getState().openLayerEditor(assetId)}>
          <Layers size={13} className="shrink-0" />分层编辑
        </button>
        {isGenerated && (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              // 先收菜单再打开所属创作；未迁移的旧图回退到历史生成面板。
              closeContextMenu();
              void viewGenerationHistory(assetId);
            }}
            disabled={busy}
            title="打开这张图所属的创作；旧记录回退到生成历史"
            className="app-context-item px-2 py-1.5"
          >
            <MessageSquare size={13} className="shrink-0" />
            回看所属创作
          </button>
        )}

      </div>
      <div className="asset-context-column">
        <div className="app-context-label">文件</div>
        <button
          type="button"
          role="menuitem"
          onClick={reveal}
          disabled={busy}
          className="app-context-item px-2 py-1.5"
        >
          打开所在文件夹
        </button>
        {storePath && (
          <>
            <button
              type="button"
              role="menuitem"
              onClick={async () => {
                try {
                  await api.openWithSystem(storePath);
                  notifySuccess("已用系统程序打开素材");
                  closeContextMenu();
                } catch (e) {
                  notifyError(e, "无法用系统程序打开素材");
                }
              }}
              disabled={busy}
              className="app-context-item px-2 py-1.5"
            >
              用系统程序打开
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={copyImage}
              disabled={busy || !annotatable}
              title={annotatable ? "复制图片位图，可粘贴到聊天 / 编辑等应用" : "该素材不是可复制的图片（支持 PNG/JPG/WebP/GIF/BMP）"}
              className="app-context-item px-2 py-1.5"
            >
              复制图片
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(storePath);
                  notifySuccess("文件路径已复制");
                  closeContextMenu();
                } catch (e) {
                  notifyError(e, "复制文件路径失败");
                }
              }}
              disabled={busy}
              className="app-context-item px-2 py-1.5"
            >
              复制文件路径
            </button>
          </>
        )}

        <div className="app-context-divider" />
        <div className="app-context-label asset-context-label-with-icon">
          <Trash2 size={12} aria-hidden="true" />
          移出与删除
        </div>
        <div className="space-y-0.5">
            {menu.libraryProjectId && canChangeLibraryVisibility && !asset?.library_hidden && (
              <button type="button" role="menuitem" disabled={busy || !canvasLibraryAvailable}
                className="app-context-item px-2 py-1.5"
                title={canvasLibraryAvailable ? "从中央和各项目素材库列表移除，保留所有画布中的图片及原文件" : "请先将图片拖到当前画布"}
                onClick={() => void setLibraryVisibility(false)}>
                从库中删除 · 在画布保留
              </button>
            )}
            {menu.canvasSelection && asset?.library_hidden && (
              <button type="button" role="menuitem" disabled={busy}
                className="app-context-item px-2 py-1.5" onClick={() => void setLibraryVisibility(true)}>
                加入素材库
              </button>
            )}
            {menu.canvasSelection && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent<CanvasRemoveNodesEventDetail>(CANVAS_REMOVE_NODES_EVENT, {
                    detail: menu.canvasSelection,
                  }));
                  closeContextMenu();
                }}
                disabled={busy}
                className="app-context-item px-2 py-1.5"
              >
                {menu.canvasSelection.nodeIds.length > 1
                  ? `从画布移出所选 ${menu.canvasSelection.nodeIds.length} 项`
                  : "从画布移出"}
              </button>
            )}
            {activeProjectId && (
              <button
                type="button"
                role="menuitem"
                onClick={() => runDelete(assetId, "keep")}
                disabled={busy}
                title="仅移出当前项目 · 素材留在全局"
                className="app-context-item px-2 py-1.5"
              >
                移出当前项目
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => runDelete(assetId, "move_out")}
              disabled={busy || !moveOutAvailable}
              title={!moveOutAvailable
                ? "该素材没有可恢复的原始文件位置，请使用物理删除"
                : "不会删除文件，文件回到原始位置"}
              className="app-context-item px-2 py-1.5"
            >
              移出园丁鸟
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                // 先收菜单再弹确认，避免两个浮层同时存在。
                setPendingDeleteId(assetId);
                closeContextMenu();
              }}
              disabled={busy}
              className="app-context-item is-danger px-2 py-1.5"
            >
              物理删除
            </button>
            {groupIds && groupIds.length > 1 && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setPendingGroupDelete(groupIds);
                  closeContextMenu();
                }}
                disabled={busy}
                title="删除这组同流程生成图的全部成员（含当前显示的这张）"
                className="app-context-item is-danger px-2 py-1.5"
              >
                物理删除整组 · {groupIds.length} 张
              </button>
            )}
        </div>
      </div>
    </div>,
    document.body
  );
}

/** 多选右键「用选中的内容新建集合」弹窗：命名 → 建集合 + 移入 + 跳转，
 *  与 BatchBar「移入新文件夹」同链路（照 RenameDialog 的单 input Modal 范式）。 */
function BatchNewCollectionDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();

  async function submit() {
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const folderId = await api.createFolder(trimmed);
      await api.moveAssetsToFolder(ids, folderId);
      const st = useStore.getState();
      st.clearSelect();
      st.exitManage();
      st.setCurrentFolder(folderId);
      await st.reloadFolders();
      notifySuccess("已新建集合并移入选中素材");
      onClose();
    } catch (e) {
      console.error("create collection failed", e);
      notifyError(e, "新建集合失败");
      setBusy(false);
    }
  }

  return (
    <ModalShell
      title="用选中的内容新建集合"
      eyebrow="New collection"
      description={`将创建新集合，并把选中的 ${ids.length} 张素材移入。`}
      onClose={onClose}
      preventClose={busy}
      footer={
        <>
          <button onClick={onClose} disabled={busy} className="app-modal-button">
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={!trimmed || busy}
            className="app-modal-button is-primary"
          >
            {busy && <span className="app-spinner" aria-hidden />}
            {busy ? "创建中…" : "创建集合并移入"}
          </button>
        </>
      }
    >
      <label className="block text-[11px] font-medium text-muted" htmlFor="batch-new-collection-input">
        集合名称
      </label>
      <input
        id="batch-new-collection-input"
        data-modal-autofocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape" && !busy) onClose();
        }}
        maxLength={64}
        placeholder="输入新集合名称"
        className="app-form-input mt-2 px-3 text-sm"
      />
      <div className="mt-2 flex items-center justify-between gap-3 text-[10px] text-faint">
        <span>最多 64 个字符</span>
        <span>{name.length}/64</span>
      </div>
    </ModalShell>
  );
}

/** 多选右键「加入项目」小面板：勾选（可多选）目标项目后批量加入；
 *  全部失败留在面板反馈，至少一个成功才退出管理。 */
function BatchAddToProjectsDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
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
