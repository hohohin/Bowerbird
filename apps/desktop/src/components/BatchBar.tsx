import { useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";

/**
 * 批量管理动作栏（manage 模式时显示在主区顶部）。
 * 删除 / 移入新文件夹 / 批量生成提示词（Mock） + 完成。
 * 不用 window.confirm/prompt：Tauri 2 WKWebView 会拦截原生对话框。
 */
export function BatchBar() {
  const ids = useStore((s) => Array.from(s.selectedIds));
  const exitManage = useStore((s) => s.exitManage);

  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [folderInput, setFolderInput] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [genRole, setGenRole] = useState("main");
  const [genProgress, setGenProgress] = useState<string | null>(null);

  const empty = ids.length === 0;

  async function del() {
    setBusy(true);
    try {
      await Promise.all(ids.map((id) => api.deleteAsset(id)));
      const remove = new Set(ids);
      const st = useStore.getState();
      st.setAssets(st.assets.filter((a) => !remove.has(a.id)));
      st.setTotal(Math.max(0, st.total - ids.length));
      st.clearSelect();
    } catch (e) {
      console.error("delete failed", e);
    } finally {
      setBusy(false);
      setConfirmingDelete(false);
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

  async function generatePrompts() {
    if (empty) return;
    setBusy(true);
    try {
      for (let i = 0; i < ids.length; i++) {
        setGenProgress(`生成中 ${i + 1}/${ids.length}`);
        await api.codexGeneratePromptForAsset(ids[i], genRole, false);
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

      {!folderInput ? (
        <button
          onClick={() => setFolderInput(true)}
          disabled={busy || empty}
          className="rounded bg-panel2 px-2.5 py-1 text-xs hover:bg-edge disabled:opacity-50"
        >
          移入新文件夹
        </button>
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
          disabled={busy || empty}
          className="rounded bg-panel2 px-2.5 py-1 text-xs hover:bg-edge disabled:opacity-50"
          title="Mock provider 生成占位提示词并写库；真实多模态待 Phase 5"
        >
          批量生成提示词
        </button>
      </div>

      {!confirmingDelete ? (
        <button
          onClick={() => setConfirmingDelete(true)}
          disabled={busy || empty}
          className="rounded bg-panel2 px-2.5 py-1 text-xs text-muted hover:text-red-400 disabled:opacity-50"
        >
          删除
        </button>
      ) : (
        <div className="flex items-center gap-1">
          <button
            onClick={del}
            disabled={busy}
            className="rounded bg-red-500 px-2 py-1 text-xs text-white disabled:opacity-50"
          >
            {busy ? "删除中…" : `确认删除 ${ids.length} 张`}
          </button>
          <button
            onClick={() => setConfirmingDelete(false)}
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
