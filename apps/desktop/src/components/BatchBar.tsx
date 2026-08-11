import { useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { understandProvider } from "../lib/entitlement";

/**
 * 批量管理动作栏（manage 模式时显示在主区顶部）。
 * 删除 / 移入新文件夹 / 批量生成提示词（codex CLI 看图） + 完成。
 * 不用 window.confirm/prompt：Tauri 2 WKWebView 会拦截原生对话框。
 */
export function BatchBar() {
  const ids = useStore((s) => Array.from(s.selectedIds));
  const exitManage = useStore((s) => s.exitManage);
  const folders = useStore((s) => s.folders);
  const projects = useStore((s) => s.projects);
  const currentProjectId = useStore((s) => s.currentProjectId);
  const codexHealth = useStore((s) => s.codexHealth);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  const cloudAvailable = cloudAuth?.cloud_available ?? false;
  // 移入已有只列普通夹（排除 root、智能夹与收藏夹）。
  const existingFolders = folders.filter((f) => f.id !== "root" && (f.kind ?? "folder") === "folder");

  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteMode, setDeleteMode] = useState<"remove" | "global" | null>(null);
  const [projectInput, setProjectInput] = useState(false);
  const [targetProjectId, setTargetProjectId] = useState("");
  const [folderInput, setFolderInput] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [moveExisting, setMoveExisting] = useState(false);
  const [targetFolderId, setTargetFolderId] = useState("");
  const [genRole, setGenRole] = useState("main");
  const [genProgress, setGenProgress] = useState<string | null>(null);

  const empty = ids.length === 0;
  const understandRoute = understandProvider(cloudEntitlement);
  const understandReady = understandRoute === "codex"
    ? !!codexHealth?.ok
    : understandRoute === "bowerbird-cloud"
      ? cloudAvailable && !!cloudAuth?.logged_in
      : false;
  const understandLabel = understandRoute === "codex" ? "codex CLI" : "Bowerbird Cloud";

  async function del() {
    setBusy(true);
    try {
      if (currentProjectId && deleteMode === "remove") {
        await api.removeAssetsFromProject(currentProjectId, ids);
      } else {
        await Promise.all(ids.map((id) => api.deleteAsset(id)));
      }
      const st = useStore.getState();
      st.clearSelect();
      await st.reloadProjects();
    } catch (e) {
      console.error("delete failed", e);
    } finally {
      setBusy(false);
      setConfirmingDelete(false);
      setDeleteMode(null);
    }
  }

  async function addToProject() {
    if (!targetProjectId) return;
    setBusy(true);
    try {
      await api.addAssetsToProject(targetProjectId, ids);
      const st = useStore.getState();
      st.clearSelect();
      await st.reloadProjects();
    } catch (e) {
      console.error("add to project failed", e);
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
      const st = useStore.getState();
      st.clearSelect();
      st.exitManage();
      st.setCurrentFolder(folderId);
      await st.reloadFolders();
    } catch (e) {
      console.error("move failed", e);
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
      const st = useStore.getState();
      st.clearSelect();
      st.exitManage();
      st.setCurrentFolder(targetFolderId);
      await st.reloadFolders();
    } catch (e) {
      console.error("move failed", e);
    } finally {
      setBusy(false);
      setMoveExisting(false);
      setTargetFolderId("");
    }
  }

  async function generatePrompts() {
    if (empty) return;
    setBusy(true);
    try {
      for (let i = 0; i < ids.length; i++) {
        setGenProgress(`生成中 ${i + 1}/${ids.length}`);
        await api.codexGeneratePromptForAsset(ids[i], genRole);
      }
      setGenProgress(`已完成 ${ids.length} 张`);
    } catch (e) {
      console.error("generate failed", e);
      setGenProgress("生成失败");
    } finally {
      setBusy(false);
      setTimeout(() => setGenProgress(null), 2000);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-edge bg-panel px-3 py-2 text-sm">
      <span className="text-muted">已选 {ids.length} 张</span>

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

      <div className="flex items-center gap-1">
        <select
          value={genRole}
          onChange={(e) => setGenRole(e.target.value)}
          disabled={busy}
          title="生成提示词的角色"
          className="rounded bg-panel2 px-1.5 py-1 text-xs"
        >
          <option value="main">main</option>
          <option value="desc">desc</option>
        </select>
        <button
          onClick={generatePrompts}
          disabled={busy || empty || !understandReady}
          className="rounded bg-panel2 px-2.5 py-1 text-xs hover:bg-edge disabled:opacity-50"
          title={understandReady
            ? `${understandLabel} 看图生成提示词并写库`
            : "免费版需要先登录 Bowerbird Cloud；Pro 可使用本机 CLI"}
        >
          批量生成提示词
        </button>
      </div>

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

      {!confirmingDelete ? (
        <button
          onClick={() => {
            setConfirmingDelete(true);
            setDeleteMode(currentProjectId ? null : "global");
          }}
          disabled={busy || empty}
          className="rounded bg-panel2 px-2.5 py-1 text-xs text-muted hover:text-red-400 disabled:opacity-50"
        >
          删除
        </button>
      ) : currentProjectId && deleteMode === null ? (
        <div className="flex items-center gap-1">
          <button
            onClick={() => setDeleteMode("remove")}
            className="rounded bg-panel2 px-2 py-1 text-xs hover:bg-edge"
          >
            仅移出当前项目
          </button>
          <button
            onClick={() => setDeleteMode("global")}
            className="rounded bg-red-500/15 px-2 py-1 text-xs text-red-300 hover:bg-red-500/25"
          >
            从全局彻底删除
          </button>
          <button onClick={() => setConfirmingDelete(false)} className="text-xs text-muted">
            取消
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <button
            onClick={del}
            disabled={busy}
            className="rounded bg-red-500 px-2 py-1 text-xs text-white disabled:opacity-50"
            title={deleteMode === "global" ? "素材将从全局及所有项目消失" : undefined}
          >
            {busy
              ? "处理中…"
              : deleteMode === "remove"
                ? `确认移出 ${ids.length} 张`
                : `确认全局删除 ${ids.length} 张`}
          </button>
          <button
            onClick={() => {
              setConfirmingDelete(false);
              setDeleteMode(null);
            }}
            disabled={busy}
            className="text-xs text-muted hover:text-ink"
          >
            取消
          </button>
        </div>
      )}

      {genProgress && <span className="text-xs text-muted">{genProgress}</span>}

      <button
        onClick={exitManage}
        disabled={busy}
        className="ml-auto rounded bg-accent px-3 py-1 text-xs font-medium text-black disabled:opacity-50"
      >
        完成
      </button>
    </div>
  );
}
