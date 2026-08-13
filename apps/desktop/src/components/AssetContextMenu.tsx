import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";
import { api } from "../lib/api";
import { loadDescribePrompt } from "../lib/describePrompt";
import { ConfirmDialog } from "./ConfirmDialog";
import { RenameDialog } from "./RenameDialog";
import { understandProvider } from "../lib/entitlement";
import type { AssetDeleteMode, AssetDeleteResult } from "../lib/types";

const MENU_WIDTH = 232;
const MENU_HEIGHT = 312;

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
 * 图片右键菜单：打开所在文件夹 + 删除三选项（与「删除项目」语义对齐）。
 * 全局只有一个实例（store.contextMenu 状态驱动），挂在 App 最外层；
 * 瀑布流缩略图 / 详情页大图各自 onContextMenu 触发。
 */
export function AssetContextMenu() {
  const menu = useStore((s) => s.contextMenu);
  const closeContextMenu = useStore((s) => s.closeContextMenu);
  const currentProjectId = useStore((s) => s.currentProjectId);
  const reloadProjects = useStore((s) => s.reloadProjects);
  const assets = useStore((s) => s.assets);
  const runDescribe = useStore((s) => s.runDescribe);
  const reusePromptToBoard = useStore((s) => s.reusePromptToBoard);
  const codexHealth = useStore((s) => s.codexHealth);
  const mode = useStore((s) => s.mode);
  const enterManage = useStore((s) => s.enterManage);
  const toggleSelect = useStore((s) => s.toggleSelect);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  const cloudAvailable = cloudAuth?.cloud_available ?? false;

  const [busy, setBusy] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 每次打开重置子状态；关闭时清掉自动关闭定时器。
  // （pendingDeleteId / renameTarget 不在此重置——「物理删除」/「重命名」点击会先 closeContextMenu
  //   再弹 dialog，menu=null 触发本 effect，重置会把尚需显示的 dialog 一起清掉；它们由自身回调清理。）
  useEffect(() => {
    setBusy(false);
    setMessage(null);
    setDone(null);
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, [menu]);

  // 菜单打开时：点击菜单外关闭、Esc 关闭。
  useEffect(() => {
    if (!menu) return;
    function onMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeContextMenu();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeContextMenu();
    }
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, closeContextMenu]);

  // 卸载时清掉自动关闭定时器。
  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  // 物理删除确认 / 重命名 dialog：独立于菜单渲染。点「物理删除」/「重命名」会先 closeContextMenu
  // 收菜单（菜单 z-60 高于 dialog z-50，不收会被盖住、点不到确认），menu=null 走此分支单独挂载。
  if (!menu) {
    return (
      <>
        <ConfirmDialog
          open={pendingDeleteId !== null}
          danger
          title="物理删除素材"
          message="素材将从全局及所有项目物理删除，不可恢复。"
          confirmLabel="物理删除"
          onConfirm={() => {
            const id = pendingDeleteId;
            setPendingDeleteId(null);
            if (id) void runDelete(id, "delete");
          }}
          onCancel={() => setPendingDeleteId(null)}
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
    setMessage(null);
    try {
      await api.revealAssetFolder(assetId);
      closeContextMenu();
    } catch (e) {
      setMessage(typeof e === "string" ? e : "无法打开所在文件夹");
      setBusy(false);
    }
  }

  async function reuseGeneration() {
    setBusy(true);
    setMessage(null);
    try {
      const hist = await api.generationHistory(assetId, currentProjectId);
      // 优先未铺开的原始编辑框文本（维度 chip，不展开 body）；旧 meta 无 prompt_raw → 回退铺开 prompt。
      const prompt = hist.turns[0]?.prompt_raw ?? hist.turns[0]?.prompt ?? "";
      if (!prompt) {
        setMessage("该生成图没有可复用的提示词记录");
        setBusy(false);
        return;
      }
      // 复用首轮 prompt + 首版参考图（与 GenerationPanel「📋 复用」语义一致）→ 打开创作板载入。
      reusePromptToBoard(prompt, hist.references);
      closeContextMenu();
    } catch (e) {
      setMessage(typeof e === "string" ? e : "读取生成提示词失败");
      setBusy(false);
    }
  }

  async function runDelete(id: string, mode: AssetDeleteMode) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.deleteAssetWithMode(id, mode, currentProjectId);
      await reloadProjects();
      if (result.failed_moves.length > 0) {
        setMessage(`移出失败：${result.failed_moves.join("、")}，素材保留在全局`);
        setBusy(false);
        return;
      }
      setDone(resultMessage(mode, result));
      // 短暂展示结果后自动关闭。
      closeTimer.current = setTimeout(closeContextMenu, 1400);
    } catch (e) {
      setMessage(typeof e === "string" ? e : "删除失败");
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
      className="rounded-lg border border-edge bg-panel p-1 text-xs shadow-lg"
    >
      <button
        onClick={() => {
          // browse 模式：右键直接进 manage 并选中此图；manage 模式：仅切换选中。继续点其它图加选。
          if (mode !== "manage") enterManage();
          toggleSelect(assetId);
          closeContextMenu();
        }}
        disabled={busy || done !== null}
        className="block w-full rounded px-2 py-1.5 text-left text-ink hover:bg-panel2 disabled:opacity-50"
      >
        {mode === "manage" ? "选择/取消选择" : "选择"}
      </button>
      <button
        onClick={reveal}
        disabled={busy || done !== null}
        className="block w-full rounded px-2 py-1.5 text-left text-ink hover:bg-panel2 disabled:opacity-50"
      >
        打开所在文件夹
      </button>
      <button
        onClick={() => {
          // 先收菜单再开 dialog（菜单 z-60 高于 dialog z-50，不收会被盖住）。
          setRenameTarget({ id: assetId, name: asset?.name ?? "" });
          closeContextMenu();
        }}
        disabled={busy || done !== null || !storePath}
        title={storePath ? "重命名（同步改磁盘文件名）" : "该素材没有本地文件，无法重命名"}
        className="block w-full rounded px-2 py-1.5 text-left text-ink hover:bg-panel2 disabled:opacity-50"
      >
        重命名
      </button>
      {storePath && (
        <>
          <button
            onClick={() => {
              void api.openWithSystem(storePath);
              closeContextMenu();
            }}
            disabled={busy || done !== null}
            className="block w-full rounded px-2 py-1.5 text-left text-ink hover:bg-panel2 disabled:opacity-50"
          >
            用系统程序打开
          </button>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(storePath);
              closeContextMenu();
            }}
            disabled={busy || done !== null}
            className="block w-full rounded px-2 py-1.5 text-left text-ink hover:bg-panel2 disabled:opacity-50"
          >
            复制文件路径
          </button>
        </>
      )}
      <button
        onClick={() => {
          runDescribe(assetId, loadDescribePrompt());
          closeContextMenu();
        }}
        disabled={busy || done !== null || describing || !understandReady}
        title={understandReady ? "反推提示词" : understandReason}
        className="block w-full rounded px-2 py-1.5 text-left text-ink hover:bg-panel2 disabled:opacity-50"
      >
        反推提示词
      </button>
      {isGenerated && (
        <button
          data-tour="ctx-reuse-gen"
          onClick={reuseGeneration}
          disabled={busy || done !== null}
          title="打开创作板，填入该图生成时的提示词与参考素材"
          className="block w-full rounded px-2 py-1.5 text-left text-ink hover:bg-panel2 disabled:opacity-50"
        >
          复用生成提示词
        </button>
      )}

      <div className="my-1 border-t border-edge" />

      {done !== null ? (
        <div className="px-2 py-1.5 text-emerald-400">{done}</div>
      ) : message ? (
        <div className="px-2 py-1.5 text-red-400">{message}</div>
      ) : (
        <div className="space-y-0.5">
          {currentProjectId && (
            <button
              onClick={() => runDelete(assetId, "keep")}
              disabled={busy}
              className="block w-full rounded px-2 py-1.5 text-left text-ink hover:bg-panel2 disabled:opacity-50"
            >
              仅移出当前项目 · 素材留在全局
            </button>
          )}
          <button
            onClick={() => runDelete(assetId, "move_out")}
            disabled={busy}
            title="把图片文件交回原始文件夹，并从素材库移除（共享素材仍保留在全局）"
            className="block w-full rounded px-2 py-1.5 text-left text-ink hover:bg-panel2 disabled:opacity-50"
          >
            移出园丁鸟 · 文件回到原始位置
          </button>
          <button
            onClick={() => {
              // 先收菜单再弹确认（菜单 z-60 高于 dialog z-50，不收会被盖住、点不到确认）。
              setPendingDeleteId(assetId);
              closeContextMenu();
            }}
            disabled={busy}
            className="block w-full rounded px-2 py-1.5 text-left text-red-300 hover:bg-red-500/15 disabled:opacity-50"
          >
            物理删除
          </button>
        </div>
      )}
    </div>,
    document.body
  );
}
