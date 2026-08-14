import { useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { understandProvider } from "../lib/entitlement";
import { loadDescribePrompt } from "../lib/describePrompt";
import { ConfirmDialog } from "./ConfirmDialog";
import { notifyError, notifySuccess } from "../lib/notify";
import type { AssetDeleteMode } from "../lib/types";

/**
 * 批量管理动作栏（manage 模式时显示在主区顶部）。
 *
 * 按语义分组：选择（已选/全选/清空）| 整理（移入新/已有文件夹、加入项目）| AI（批量反推）
 * | 危险（删除，对齐右键菜单三模式 + ConfirmDialog）| 完成。
 * 批量反推复用 store 的 describeQueue 串行队列：进度、取消、失败隔离全在状态圈会话面板可见。
 * 不用 window.confirm/prompt：Tauri 2 WKWebView 会拦截原生对话框。
 */
export function BatchBar() {
  const ids = useStore((s) => Array.from(s.selectedIds));
  const exitManage = useStore((s) => s.exitManage);
  const clearSelect = useStore((s) => s.clearSelect);
  const selectAll = useStore((s) => s.selectAll);
  const folders = useStore((s) => s.folders);
  const projects = useStore((s) => s.projects);
  const currentProjectId = useStore((s) => s.currentProjectId);
  const codexHealth = useStore((s) => s.codexHealth);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  const openDescribePicker = useStore((s) => s.openDescribePicker);
  const reloadProjects = useStore((s) => s.reloadProjects);
  const reloadFolders = useStore((s) => s.reloadFolders);
  const cloudAvailable = cloudAuth?.cloud_available ?? false;
  // 移入已有只列普通夹（排除 root、智能夹与收藏夹）。
  const existingFolders = folders.filter((f) => f.id !== "root" && (f.kind ?? "folder") === "folder");

  const [busy, setBusy] = useState(false);
  const [folderInput, setFolderInput] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [moveExisting, setMoveExisting] = useState(false);
  const [targetFolderId, setTargetFolderId] = useState("");
  const [projectInput, setProjectInput] = useState(false);
  const [targetProjectId, setTargetProjectId] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pendingPhysicalDelete, setPendingPhysicalDelete] = useState(false);
  const [failedNotice, setFailedNotice] = useState<string | null>(null);

  const empty = ids.length === 0;
  const understandRoute = understandProvider(cloudEntitlement);
  const understandReady = understandRoute === "codex"
    ? !!codexHealth?.ok
    : understandRoute === "bowerbird-cloud"
      ? cloudAvailable && !!cloudAuth?.logged_in
      : false;
  const understandLabel = understandRoute === "codex" ? "codex CLI" : "Bowerbird Cloud";
  const describeTitle = !understandReady
    ? understandRoute === "bowerbird-cloud"
      ? "免费版反推需要先登录 Bowerbird Cloud（每日 10 次）"
      : "当前账号没有可用的理解引擎"
    : understandRoute === "bowerbird-cloud" && ids.length > 10
      ? `已选 ${ids.length} 张，免费档每日仅 10 次，超出将失败`
      : `${understandLabel} 看图反推，结果进创作板 @ 池`;

  async function addToProject() {
    if (!targetProjectId) return;
    setBusy(true);
    try {
      await api.addAssetsToProject(targetProjectId, ids);
      await reloadProjects();
      notifySuccess("素材已加入项目");
      exitManage();
    } catch (e) {
      console.error("add to project failed", e);
      notifyError(e, "加入项目失败");
    } finally {
      setBusy(false);
      setProjectInput(false);
      setTargetProjectId("");
    }
  }

  async function moveToNewFolder() {
    if (!folderName.trim()) return;
    setBusy(true);
    try {
      const folderId = await api.createFolder(folderName.trim());
      await api.moveAssetsToFolder(ids, folderId);
      clearSelect();
      exitManage();
      useStore.getState().setCurrentFolder(folderId);
      await reloadFolders();
      notifySuccess("素材已移入新文件夹");
    } catch (e) {
      console.error("move failed", e);
      notifyError(e, "移入失败");
    } finally {
      setBusy(false);
      setFolderInput(false);
      setFolderName("");
    }
  }

  async function moveToExisting() {
    if (!targetFolderId) return;
    setBusy(true);
    try {
      await api.moveAssetsToFolder(ids, targetFolderId);
      clearSelect();
      exitManage();
      useStore.getState().setCurrentFolder(targetFolderId);
      await reloadFolders();
      notifySuccess("素材已移入文件夹");
    } catch (e) {
      console.error("move failed", e);
      notifyError(e, "移入失败");
    } finally {
      setBusy(false);
      setMoveExisting(false);
      setTargetFolderId("");
    }
  }

  /** 批量删除：keep=移出当前项目（数组 API 一次）；move_out/delete=循环单条 deleteAssetWithMode。
   *  全成功 → exitManage；有失败 → 留在 manage 显示失败反馈。 */
  async function runDelete(mode: AssetDeleteMode) {
    setBusy(true);
    setFailedNotice(null);
    let failedCount = 0;
    try {
      if (mode === "keep") {
        if (currentProjectId) await api.removeAssetsFromProject(currentProjectId, ids);
      } else {
        for (const id of ids) {
          try {
            await api.deleteAssetWithMode(id, mode, currentProjectId);
          } catch (e) {
            failedCount += 1;
            console.error("delete one failed", e);
          }
        }
      }
      await reloadProjects();
      if (failedCount > 0) {
        setFailedNotice(`${failedCount} 张删除失败，已保留在全局`);
        notifyError(null, `${failedCount} 张删除失败，已保留在全局`);
        return;
      }
      notifySuccess(
        mode === "keep"
          ? "素材已移出当前项目"
          : mode === "move_out"
            ? "素材已移出园丁鸟"
            : "素材已物理删除"
      );
      exitManage();
    } catch (e) {
      console.error("delete failed", e);
      setFailedNotice(typeof e === "string" ? e : "删除失败");
      notifyError(e, "删除失败");
    } finally {
      setBusy(false);
      setDeleteOpen(false);
      setPendingPhysicalDelete(false);
    }
  }

  function resetDelete() {
    setDeleteOpen(false);
    setPendingPhysicalDelete(false);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-edge bg-panel px-3 py-2 text-sm">
      {/* 选择区 */}
      <span className="text-muted">已选 {ids.length} 张</span>
      <button
        onClick={selectAll}
        disabled={busy}
        className="text-xs text-accent hover:opacity-80 disabled:opacity-50"
      >
        全选
      </button>
      <button
        onClick={clearSelect}
        disabled={busy || empty}
        className="text-xs text-muted hover:text-ink disabled:opacity-50"
      >
        清空
      </button>

      <Divider />

      {/* 整理区：移入新/已有文件夹 + 加入项目 */}
      {!folderInput && !moveExisting ? (
        <>
          <button
            onClick={() => setFolderInput(true)}
            disabled={busy || empty}
            className="rounded bg-panel2 px-2.5 py-1 text-xs hover:bg-edge disabled:opacity-50"
          >
            移入新文件夹
          </button>
          <button
            onClick={() => {
              setTargetFolderId(existingFolders[0]?.id ?? "");
              setMoveExisting(true);
            }}
            disabled={busy || empty || existingFolders.length === 0}
            className="rounded bg-panel2 px-2.5 py-1 text-xs hover:bg-edge disabled:opacity-50"
            title={existingFolders.length === 0 ? "还没有普通文件夹" : "移入已有文件夹"}
          >
            移入已有
          </button>
        </>
      ) : moveExisting ? (
        <div className="flex items-center gap-1">
          <select
            autoFocus
            value={targetFolderId}
            onChange={(e) => setTargetFolderId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setMoveExisting(false);
                setTargetFolderId("");
              }
            }}
            className="max-w-[10rem] rounded bg-panel2 px-1.5 py-1 text-xs outline-none ring-1 ring-edge focus:ring-accent"
          >
            {existingFolders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <button
            onClick={moveToExisting}
            disabled={busy || !targetFolderId}
            className="rounded bg-accent px-2 py-1 text-xs text-black disabled:opacity-50"
          >
            确定
          </button>
          <button
            onClick={() => {
              setMoveExisting(false);
              setTargetFolderId("");
            }}
            disabled={busy}
            className="text-xs text-muted hover:text-ink"
          >
            取消
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <input
            autoFocus
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") moveToNewFolder();
              if (e.key === "Escape") {
                setFolderInput(false);
                setFolderName("");
              }
            }}
            placeholder="文件夹名"
            className="w-32 rounded bg-panel2 px-2 py-1 text-xs outline-none ring-1 ring-edge focus:ring-accent"
          />
          <button
            onClick={moveToNewFolder}
            disabled={busy || !folderName.trim()}
            className="rounded bg-accent px-2 py-1 text-xs text-black disabled:opacity-50"
          >
            确定
          </button>
          <button
            onClick={() => {
              setFolderInput(false);
              setFolderName("");
            }}
            disabled={busy}
            className="text-xs text-muted hover:text-ink"
          >
            取消
          </button>
        </div>
      )}

      {!currentProjectId && projects.length > 0 && !projectInput && (
        <button
          onClick={() => {
            setTargetProjectId(projects[0]?.id ?? "");
            setProjectInput(true);
          }}
          disabled={busy || empty}
          className="rounded bg-panel2 px-2.5 py-1 text-xs hover:bg-edge disabled:opacity-50"
        >
          加入项目
        </button>
      )}
      {!currentProjectId && projectInput && (
        <div className="flex items-center gap-1">
          <select
            value={targetProjectId}
            onChange={(e) => setTargetProjectId(e.target.value)}
            className="max-w-[10rem] rounded bg-panel2 px-1.5 py-1 text-xs"
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <button onClick={addToProject} className="rounded bg-accent px-2 py-1 text-xs text-black">
            确定
          </button>
          <button onClick={() => setProjectInput(false)} className="text-xs text-muted">
            取消
          </button>
        </div>
      )}

      <Divider />

      {/* AI 区：批量反推 */}
      <button
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          openDescribePicker(
            { kind: "batch", ids, instruction: loadDescribePrompt() },
            { x: r.left, y: r.bottom },
          );
        }}
        disabled={busy || empty || !understandReady}
        title={describeTitle}
        className="rounded bg-panel2 px-2.5 py-1 text-xs hover:bg-edge disabled:opacity-50"
      >
        批量反推
      </button>

      {/* 危险区：删除三模式 */}
      {!deleteOpen ? (
        <button
          onClick={() => {
            setFailedNotice(null);
            setDeleteOpen(true);
          }}
          disabled={busy || empty}
          className="rounded bg-panel2 px-2.5 py-1 text-xs text-muted hover:text-red-400 disabled:opacity-50"
        >
          删除
        </button>
      ) : (
        <div className="flex items-center gap-1">
          {currentProjectId && (
            <button
              onClick={() => runDelete("keep")}
              disabled={busy}
              className="rounded bg-panel2 px-2 py-1 text-xs hover:bg-edge disabled:opacity-50"
            >
              仅移出当前项目
            </button>
          )}
          <button
            onClick={() => runDelete("move_out")}
            disabled={busy}
            title="把图片文件交回原始文件夹，并从素材库移除（共享素材仍保留在全局）"
            className="rounded bg-panel2 px-2 py-1 text-xs hover:bg-edge disabled:opacity-50"
          >
            移出园丁鸟
          </button>
          <button
            onClick={() => setPendingPhysicalDelete(true)}
            disabled={busy}
            className="rounded bg-red-500/15 px-2 py-1 text-xs text-red-300 hover:bg-red-500/25 disabled:opacity-50"
          >
            物理删除
          </button>
          <button onClick={resetDelete} disabled={busy} className="text-xs text-muted hover:text-ink">
            取消
          </button>
        </div>
      )}

      {failedNotice && <span className="text-xs text-red-400">{failedNotice}</span>}

      <button
        onClick={exitManage}
        disabled={busy}
        className="ml-auto rounded bg-accent px-3 py-1 text-xs font-medium text-black disabled:opacity-50"
      >
        完成
      </button>

      <ConfirmDialog
        open={pendingPhysicalDelete}
        danger
        title={`物理删除 ${ids.length} 张素材`}
        message="这些素材将从全局及所有项目物理删除，不可恢复。"
        confirmLabel="物理删除"
        onConfirm={() => runDelete("delete")}
        onCancel={resetDelete}
      />
    </div>
  );
}

function Divider() {
  return <span className="h-4 w-px bg-edge" />;
}
