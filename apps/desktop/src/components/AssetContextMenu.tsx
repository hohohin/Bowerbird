import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ClipboardCopy, MessageSquare, PenTool, ScanSearch } from "lucide-react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { loadDescribePrompt } from "../lib/describePrompt";
import { ConfirmDialog } from "./ConfirmDialog";
import { RenameDialog } from "./RenameDialog";
import { understandProvider } from "../lib/entitlement";
import { notifyError, notifySuccess } from "../lib/notify";
import type { AssetDeleteMode, AssetDeleteResult } from "../lib/types";

const MENU_WIDTH = 232;
// 高度按全量项（生成图 + 本地文件 + 项目内，含「物理删除整组」）估算，含四组标签与分隔线。
const MENU_HEIGHT = 560;

/** 可标注图片：浏览器 <img>/canvas 能解码的位图格式（tiff 浏览器不解码，排除）。 */
const ANNOTATABLE_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];

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

/**
 * 图片右键菜单：整理 / 再创作 / 文件 / 移出与删除 四组。
 * 全局只有一个实例（store.contextMenu 状态驱动），挂在 App 最外层；
 * 瀑布流缩略图 / 详情页大图各自 onContextMenu 触发。
 */
export function AssetContextMenu() {
  const menu = useStore((s) => s.contextMenu);
  const closeContextMenu = useStore((s) => s.closeContextMenu);
  const openDetail = useStore((s) => s.openDetail);
  const detailAssetId = useStore((s) => s.detailAssetId);
  const addAssetToBoardFromDetail = useStore((s) => s.addAssetToBoardFromDetail);
  const currentProjectId = useStore((s) => s.currentProjectId);
  const reloadProjects = useStore((s) => s.reloadProjects);
  const assets = useStore((s) => s.assets);
  const openDescribePicker = useStore((s) => s.openDescribePicker);
  const reusePromptToBoard = useStore((s) => s.reusePromptToBoard);
  const codexHealth = useStore((s) => s.codexHealth);
  const openAnnotator = useStore((s) => s.openAnnotator);
  const viewGenerationHistory = useStore((s) => s.viewGenerationHistory);
  const mode = useStore((s) => s.mode);
  const enterManage = useStore((s) => s.enterManage);
  const toggleSelect = useStore((s) => s.toggleSelect);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  const cloudAvailable = cloudAuth?.cloud_available ?? false;

  const [busy, setBusy] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  // 右键素材所在生成组的成员 id（菜单打开时取，>1 张才显示「物理删除整组」）。
  const [groupIds, setGroupIds] = useState<string[] | null>(null);
  const [pendingGroupDelete, setPendingGroupDelete] = useState<string[] | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 每次打开重置子状态。
  // （pendingDeleteId / pendingGroupDelete / renameTarget 不在此重置——「物理删除」/「物理删除
  //   整组」/「重命名」点击会先 closeContextMenu 再弹 dialog，menu=null 触发本 effect，重置会把
  //   尚需显示的 dialog 一起清掉；它们由自身回调清理。）
  useEffect(() => {
    setBusy(false);
  }, [menu]);

  // 菜单打开且为生成图时取同组图（与瀑布流轮播同一查询、同 project scope）；
  // 非生成图 / 查询失败按无组处理，不显示整组删除。
  useEffect(() => {
    setGroupIds(null);
    if (!menu) return;
    const target = useStore.getState().assets.find((a) => a.id === menu.assetId);
    if (!target?.generation_session_id) return;
    let alive = true;
    api
      .listGenerationGroup(menu.assetId, currentProjectId)
      .then((g) => {
        if (alive) setGroupIds(g.map((a) => a.id));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [menu, currentProjectId]);

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
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      if (buttons.length === 0) return;
      e.preventDefault();
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
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    });
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
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
        {renameTarget && (
          <RenameDialog
            open
            assetId={renameTarget.id}
            currentName={renameTarget.name}
            onClose={() => setRenameTarget(null)}
          />
        )}
      </>
    );
  }

  // 守卫后捕获，闭包里直接用（TS 不会把守卫的收窄带进嵌套函数）。
  const assetId = menu.assetId;
  const asset = assets.find((a) => a.id === assetId);
  const storePath = asset?.store_path ?? null;
  // 仅生成图显示「复用生成提示词」：generation_session_id 非 null 即任意 provider 的生成图。
  const isGenerated = !!asset?.generation_session_id;
  // 「图片标注」可用：本地有文件且为浏览器可解码位图（视频 / SVG / TIFF 不可标注）。
  const annotatable =
    !!storePath && ANNOTATABLE_EXTS.includes((asset?.ext ?? "").toLowerCase());
  // 反推项置灰：该图正在反推或已排队（runDescribe 内部已去重，置灰仅为给用户明确反馈）。
  const describing =
    useStore.getState().describingId === assetId ||
    useStore.getState().describeQueue.some((q) => q.assetId === assetId);
  const understandRoute = understandProvider(cloudEntitlement);
  const understandReady = understandRoute === "codex"
    ? !!codexHealth?.ok
    : understandRoute === "bowerbird-cloud"
      ? cloudAvailable && !!cloudAuth?.logged_in
      : false;
  const understandReason = understandRoute === "codex"
    ? codexHealth?.reason || "codex 不可用"
    : !cloudAuth?.logged_in
      ? "免费版反推需要先登录 Bowerbird Cloud（每日 10 次）"
      : "Bowerbird Cloud 不可用";

  // 菜单定位：固定到鼠标位置，超右/下边缘时收进来（近似估算尺寸即可）。
  const x = Math.max(4, Math.min(menu.x, window.innerWidth - MENU_WIDTH - 8));
  const y = Math.max(4, Math.min(menu.y, window.innerHeight - MENU_HEIGHT - 8));

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
    setBusy(true);
    try {
      const hist = await api.generationHistory(assetId, currentProjectId);
      // 优先未铺开的原始编辑框文本（维度 chip，不展开 body）；旧 meta 无 prompt_raw → 回退铺开 prompt。
      const prompt = hist.turns[0]?.prompt_raw ?? hist.turns[0]?.prompt ?? "";
      if (!prompt) {
        notifyError(null, "该生成图没有可复用的提示词记录");
        setBusy(false);
        return;
      }
      // 复用首轮 prompt + 首版参考图（与 GenerationPanel「📋 复用」语义一致）→ 打开创作板载入。
      reusePromptToBoard(prompt, hist.references);
      notifySuccess("生成提示词已载入创作板");
      closeContextMenu();
    } catch (e) {
      notifyError(e, "读取生成提示词失败");
      setBusy(false);
    }
  }

  async function runDelete(id: string, mode: AssetDeleteMode) {
    setBusy(true);
    try {
      const result = await api.deleteAssetWithMode(id, mode, currentProjectId);
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

  /** 整组物理删除：循环单条 delete（无批量 API，与 BatchBar 批量删除同模式），
   *  单条失败不中断后续；有失败 → 报失败数，全成功 → toast 总数。 */
  async function runDeleteGroup(ids: string[]) {
    setBusy(true);
    let failed = 0;
    try {
      for (const id of ids) {
        try {
          await api.deleteAssetWithMode(id, "delete", currentProjectId);
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

  const menuStyle: React.CSSProperties = {
    position: "fixed",
    left: x,
    top: y,
    width: MENU_WIDTH,
    zIndex: 60,
  };

  return createPortal(
    <div
      ref={menuRef}
      style={menuStyle}
      onContextMenu={(e) => e.preventDefault()}
      className="app-context-menu p-1.5 text-xs"
      role="menu"
      aria-label="素材操作"
    >
      <div className="app-context-label">整理</div>
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
        onClick={() => {
          openDetail(assetId);
          closeContextMenu();
        }}
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
      <button
        type="button"
        role="menuitem"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          openDescribePicker(
            { kind: "single", assetId, instruction: loadDescribePrompt() },
            { x: r.left, y: r.bottom },
          );
          closeContextMenu();
        }}
        disabled={busy || describing || !understandReady}
        title={understandReady ? "反推提示词" : understandReason}
        className="app-context-item px-2 py-1.5"
      >
        <ScanSearch size={13} className="shrink-0" />
        反推提示词
      </button>
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
      {isGenerated && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            // 先收菜单再开生成会话面板（与详情页「回看生成对话」同一入口）。
            closeContextMenu();
            void viewGenerationHistory(assetId);
          }}
          disabled={busy}
          title="回看这张图的生成会话：各轮 prompt 与产出图，可继续提修改意见"
          className="app-context-item px-2 py-1.5"
        >
          <MessageSquare size={13} className="shrink-0" />
          打开生成会话
        </button>
      )}

      <div className="app-context-divider" />
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
      <div className="app-context-label">移出与删除</div>
      <div className="space-y-0.5">
          {currentProjectId && (
            <button
              type="button"
              role="menuitem"
              onClick={() => runDelete(assetId, "keep")}
              disabled={busy}
              className="app-context-item px-2 py-1.5"
            >
              仅移出当前项目 · 素材留在全局
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => runDelete(assetId, "move_out")}
            disabled={busy}
            title="不会删除文件，文件回到原始位置"
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
    </div>,
    document.body
  );
}
