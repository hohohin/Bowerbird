import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";
import { api } from "../lib/api";
import { loadDescribePrompt } from "../lib/describePrompt";
import { understandProvider } from "../lib/entitlement";
import type { AssetDeleteMode, AssetDeleteResult } from "../lib/types";

/** 物理删除的确认口令（与「删除项目」一致，避开 window.confirm——Tauri WKWebView 拦截原生对话框）。 */
const CONFIRM_TEXT = "确认删除";

const MENU_WIDTH = 232;
const MENU_HEIGHT = 280;

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
  const codexHealth = useStore((s) => s.codexHealth);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  const cloudEnabled = useStore((s) => s.settings?.cloud_enabled ?? false);

  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 每次打开重置子状态；关闭时清掉自动关闭定时器。
  useEffect(() => {
    setBusy(false);
    setConfirmingDelete(false);
    setConfirmText("");
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

  if (!menu) return null;

  // 守卫后捕获，闭包里直接用（TS 不会把守卫的收窄带进嵌套函数）。
  const assetId = menu.assetId;
  const storePath = assets.find((a) => a.id === assetId)?.store_path ?? null;
  // 反推项置灰：该图正在反推或已排队（runDescribe 内部已去重，置灰仅为给用户明确反馈）。
  const describing =
    useStore.getState().describingId === assetId ||
    useStore.getState().describeQueue.some((q) => q.assetId === assetId);
  const understandRoute = understandProvider(cloudEntitlement);
  const understandReady = understandRoute === "codex"
    ? !!codexHealth?.ok
    : understandRoute === "bowerbird-cloud"
      ? cloudEnabled && !!cloudAuth?.logged_in
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

  async function runDelete(mode: AssetDeleteMode) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.deleteAssetWithMode(assetId, mode, currentProjectId);
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
        onClick={reveal}
        disabled={busy || done !== null}
        className="block w-full rounded px-2 py-1.5 text-left text-ink hover:bg-panel2 disabled:opacity-50"
      >
        打开所在文件夹
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

      <div className="my-1 border-t border-edge" />

      {done !== null ? (
        <div className="px-2 py-1.5 text-emerald-400">{done}</div>
      ) : message ? (
        <div className="px-2 py-1.5 text-red-400">{message}</div>
      ) : confirmingDelete ? (
        <div className="space-y-1.5 px-1 py-1">
          <div className="px-1 text-red-300">
            素材将从全局及所有项目物理删除，不可恢复。
          </div>
          <input
            autoFocus
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && confirmText === CONFIRM_TEXT) runDelete("delete");
              if (e.key === "Escape") setConfirmingDelete(false);
            }}
            placeholder={`输入「${CONFIRM_TEXT}」`}
            className="w-full rounded bg-panel px-2 py-1 text-xs text-ink outline-none ring-1 ring-edge focus:ring-red-400/60"
          />
          <button
            onClick={() => runDelete("delete")}
            disabled={busy || confirmText !== CONFIRM_TEXT}
            className="block w-full rounded bg-red-500/25 px-2 py-1 text-left text-red-200 hover:bg-red-500/35 disabled:opacity-40"
          >
            物理删除
          </button>
          <button
            onClick={() => setConfirmingDelete(false)}
            disabled={busy}
            className="block w-full rounded px-2 py-1 text-left text-muted hover:bg-panel2"
          >
            取消
          </button>
        </div>
      ) : (
        <div className="space-y-0.5">
          {currentProjectId && (
            <button
              onClick={() => runDelete("keep")}
              disabled={busy}
              className="block w-full rounded px-2 py-1.5 text-left text-ink hover:bg-panel2 disabled:opacity-50"
            >
              仅移出当前项目 · 素材留在全局
            </button>
          )}
          <button
            onClick={() => runDelete("move_out")}
            disabled={busy}
            title="把图片文件交回原始文件夹，并从素材库移除（共享素材仍保留在全局）"
            className="block w-full rounded px-2 py-1.5 text-left text-ink hover:bg-panel2 disabled:opacity-50"
          >
            移出园丁鸟 · 文件回到原始位置
          </button>
          <button
            onClick={() => {
              setConfirmingDelete(true);
              setConfirmText("");
            }}
            disabled={busy}
            className="block w-full rounded px-2 py-1.5 text-left text-red-300 hover:bg-red-500/15 disabled:opacity-50"
          >
            物理删除 · 需输入「{CONFIRM_TEXT}」
          </button>
        </div>
      )}
    </div>,
    document.body
  );
}
