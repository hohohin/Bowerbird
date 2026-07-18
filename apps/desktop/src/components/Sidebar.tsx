import { useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { getDragAssets } from "../lib/dragPayload";
import type { Folder } from "../lib/types";

/** 颜色桶 key → 中文 label（P3；hex 由后端 palette_overview 带回）。 */
const COLOR_LABELS: Record<string, string> = {
  red: "红", orange: "橙", yellow: "黄", green: "绿", cyan: "青",
  blue: "蓝", purple: "紫", pink: "粉", brown: "棕", gray: "灰",
  white: "白", black: "黑",
};

/** 左侧栏：素材统计 + 文件夹/智能文件夹 + 颜色筛选。 */
export function Sidebar() {
  const total = useStore((s) => s.total);
  const selectedCount = useStore((s) => s.selectedIds.size);
  const currentFolderId = useStore((s) => s.currentFolderId);
  const currentCollectionId = useStore((s) => s.currentCollectionId);
  const setCurrentFolder = useStore((s) => s.setCurrentFolder);
  const colorFilter = useStore((s) => s.colorFilter);
  const setColorFilter = useStore((s) => s.setColorFilter);
  const folders = useStore((s) => s.folders);
  const smartFilter = useStore((s) => s.smartFilter);
  const setSmartFilter = useStore((s) => s.setSmartFilter);
  const reloadFolders = useStore((s) => s.reloadFolders);
  const autoTags = useStore((s) => s.autoTags);

  // inline 新建表单：none | folder | smart | collection（避开 window.prompt——Tauri WKWebView 拦截原生对话框）。
  const [creating, setCreating] = useState<"none" | "folder" | "smart" | "collection">("none");
  const [draftName, setDraftName] = useState("");
  const [smartKind, setSmartKind] = useState<"source" | "ext">("source");
  const [smartValue, setSmartValue] = useState("");

  const palette = useStore((s) => s.palette);
  const normalFolders = folders.filter(
    (f) => f.id !== "root" && (f.kind ?? "folder") === "folder"
  );
  const smartFolders = folders.filter((f) => f.id !== "root" && f.kind === "smart");
  const collections = folders.filter((f) => f.id !== "root" && f.kind === "collection");

  function resetCreate() {
    setCreating("none");
    setDraftName("");
    setSmartKind("source");
    setSmartValue("");
  }

  async function submitCreate() {
    const name = draftName.trim();
    if (!name) return;
    try {
      if (creating === "folder") {
        await api.createFolder(name);
      } else if (creating === "collection") {
        await api.createCollection(name);
      } else {
        const val = smartValue.trim();
        if (!val) return;
        // 前端限定 source/ext 前缀：list_assets_smart 未知前缀会静默走 1=1（返回全部）。
        await api.createSmartFolder(name, `${smartKind}:${val}`);
      }
      await reloadFolders();
    } catch (e) {
      console.error("create folder failed", e);
    }
    resetCreate();
  }

  function startCreate(kind: "folder" | "smart" | "collection") {
    setCreating(kind);
    setDraftName("");
    setSmartValue("");
  }

  return (
    <aside className="w-56 shrink-0 overflow-y-auto border-r border-edge bg-panel p-3 text-sm">
      <div className="mb-4">
        <div className="text-xs uppercase tracking-wide text-muted">素材总数</div>
        <div className="text-2xl font-semibold">{total}</div>
      </div>

      <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wide text-muted">
        <span>文件夹</span>
        <span className="flex gap-2 normal-case tracking-normal">
          <button
            onClick={() => (creating === "folder" ? resetCreate() : startCreate("folder"))}
            className="rounded text-accent hover:opacity-80"
            title="新建文件夹"
          >
            + 文件夹
          </button>
          <button
            onClick={() => (creating === "smart" ? resetCreate() : startCreate("smart"))}
            className="rounded text-accent hover:opacity-80"
            title="新建智能文件夹"
          >
            + 智能
          </button>
          <button
            onClick={() => (creating === "collection" ? resetCreate() : startCreate("collection"))}
            className="rounded text-accent hover:opacity-80"
            title="新建收藏夹"
          >
            + 收藏
          </button>
        </span>
      </div>

      {creating !== "none" && (
        <div className="mb-2 flex flex-col gap-1.5 rounded bg-panel2 p-2 normal-case">
          <input
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCreate();
              if (e.key === "Escape") resetCreate();
            }}
            placeholder={
              creating === "folder"
                ? "文件夹名"
                : creating === "collection"
                  ? "收藏夹名"
                  : "智能文件夹名"
            }
            className="rounded bg-panel px-2 py-1 outline-none ring-1 ring-edge focus:ring-accent"
          />
          {creating === "smart" && (
            <div className="flex items-center gap-1">
              <select
                value={smartKind}
                onChange={(e) => setSmartKind(e.target.value as "source" | "ext")}
                className="rounded bg-panel px-1.5 py-1"
              >
                <option value="source">来源 source</option>
                <option value="ext">格式 ext</option>
              </select>
              <input
                value={smartValue}
                onChange={(e) => setSmartValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitCreate();
                  if (e.key === "Escape") resetCreate();
                }}
                placeholder={smartKind === "source" ? "如 codex / extension" : "如 png"}
                className="flex-1 rounded bg-panel px-2 py-1 outline-none ring-1 ring-edge focus:ring-accent"
              />
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={submitCreate}
              disabled={!draftName.trim() || (creating === "smart" && !smartValue.trim())}
              className="rounded bg-accent px-2 py-0.5 text-black disabled:opacity-50"
            >
              确定
            </button>
            <button onClick={resetCreate} className="text-xs text-muted hover:text-ink">
              取消
            </button>
          </div>
        </div>
      )}

      <div className="space-y-1">
        <div
          className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 ${
            currentFolderId === null && !smartFilter && !currentCollectionId ? "bg-panel2" : "hover:bg-panel2"
          }`}
          onClick={() => setCurrentFolder(null)}
        >
          📚 全部
        </div>
        <div
          className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 ${
            smartFilter === "source:codex" ? "bg-panel2" : "hover:bg-panel2"
          }`}
          onClick={() =>
            setSmartFilter(smartFilter === "source:codex" ? null : "source:codex")
          }
          title="只看 codex 生成的图（source:codex）"
        >
          ✨ 生成图
        </div>
        {normalFolders.map((f) => (
          <FolderRow key={f.id} folder={f} />
        ))}
      </div>

      {collections.length > 0 && (
        <>
          <div className="mb-2 mt-4 text-xs uppercase tracking-wide text-muted">收藏夹</div>
          <div className="space-y-1">
            {collections.map((f) => (
              <FolderRow key={f.id} folder={f} />
            ))}
          </div>
        </>
      )}

      {smartFolders.length > 0 && (
        <>
          <div className="mb-2 mt-4 text-xs uppercase tracking-wide text-muted">智能文件夹</div>
          <div className="space-y-1">
            {smartFolders.map((f) => (
              <FolderRow key={f.id} folder={f} />
            ))}
          </div>
        </>
      )}

      {autoTags.length > 0 && (
        <>
          <div className="mb-2 mt-4 flex items-center justify-between text-xs uppercase tracking-wide text-muted">
            <span>自动归类</span>
            {smartFilter?.startsWith("tag:") && (
              <button
                onClick={() => setSmartFilter(null)}
                className="text-accent hover:opacity-80"
              >
                清除
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-1">
            {autoTags.map((t) => {
              const active = smartFilter === `tag:${t.name}`;
              return (
                <div
                  key={t.id}
                  className={`flex cursor-pointer items-center gap-1 rounded px-2 py-1.5 text-xs ${
                    active ? "bg-panel2" : "hover:bg-panel2"
                  }`}
                  onClick={() => setSmartFilter(active ? null : `tag:${t.name}`)}
                  title={`tag:${t.name}`}
                >
                  <span className="text-muted">#</span>
                  <span className="flex-1 truncate">{t.name}</span>
                  <span className="text-[10px] tabular-nums text-muted">{t.count}</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {palette.length > 0 && (
        <>
          <div className="mb-2 mt-4 flex items-center justify-between text-xs uppercase tracking-wide text-muted">
            <span>颜色</span>
            {colorFilter && (
              <button
                onClick={() => setColorFilter(null)}
                className="text-accent hover:opacity-80"
              >
                清除
              </button>
            )}
          </div>
          <div className="grid grid-cols-6 gap-1.5">
            {palette.map((c) => (
              <button
                key={c.key}
                onClick={() => setColorFilter(colorFilter === c.key ? null : c.key)}
                className={`aspect-square rounded ring-offset-2 ring-offset-panel ${
                  colorFilter === c.key ? "ring-2 ring-accent" : ""
                }`}
                style={{ background: c.hex }}
                title={`${COLOR_LABELS[c.key] ?? c.key} (${c.count})`}
              />
            ))}
          </div>
        </>
      )}

      {selectedCount > 0 && (
        <>
          <div className="mb-2 mt-4 text-xs uppercase tracking-wide text-muted">已选</div>
          <div className="text-accent">{selectedCount} 张</div>
          <div className="mt-1 text-xs text-muted">批量模式 · 点击切换选中</div>
        </>
      )}
    </aside>
  );
}

/** 单个文件夹行：点击进入 + hover/当前时露出 改名/删除（inline，避开原生对话框）。
 *  改名 = 行内 input（Enter 存 / Esc 取消）；删除 = 两段式确认。 */
function FolderRow({ folder }: { folder: Folder }) {
  const currentFolderId = useStore((s) => s.currentFolderId);
  const currentCollectionId = useStore((s) => s.currentCollectionId);
  const setCurrentFolder = useStore((s) => s.setCurrentFolder);
  const setCurrentCollection = useStore((s) => s.setCurrentCollection);
  const reloadFolders = useStore((s) => s.reloadFolders);
  const isSmart = folder.kind === "smart";
  const isCollection = folder.kind === "collection";
  const active = isCollection ? currentCollectionId === folder.id : currentFolderId === folder.id;

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(folder.name);
  const [confirming, setConfirming] = useState(false);
  // 拖拽放置高亮：用计数器防 dragleave 抖动（子元素进出会触发父 dragenter/dragleave 成对）。
  const [dragOver, setDragOver] = useState(0);

  async function saveRename() {
    const n = name.trim();
    setEditing(false);
    if (!n || n === folder.name) return;
    try {
      await api.renameFolder(folder.id, n);
      await reloadFolders();
    } catch (e) {
      console.error("rename failed", e);
    }
  }

  async function doDelete() {
    setConfirming(false);
    try {
      await api.deleteFolder(folder.id);
      // 删的是当前所在夹/收藏夹 → 回「全部」，否则当前 scope 悬空导致列表空白。
      if (useStore.getState().currentFolderId === folder.id) setCurrentFolder(null);
      if (useStore.getState().currentCollectionId === folder.id) setCurrentCollection(null);
      await reloadFolders();
    } catch (e) {
      console.error("delete folder failed", e);
    }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1 rounded px-1 py-0.5">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveRename();
            if (e.key === "Escape") setEditing(false);
          }}
          className="flex-1 rounded bg-panel2 px-2 py-1 text-xs outline-none ring-1 ring-accent"
        />
        <button onClick={saveRename} className="text-xs text-accent hover:opacity-80" title="保存">
          ✓
        </button>
        <button
          onClick={() => setEditing(false)}
          className="text-xs text-muted hover:text-ink"
          title="取消"
        >
          ✕
        </button>
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-1 rounded bg-panel2 px-2 py-1.5 text-[10px] text-muted">
        <span className="flex-1 truncate">
          {isSmart ? "不影响素材，删除？" : isCollection ? "只移除收藏关系，删除？" : "素材回到全部，删除？"}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            doDelete();
          }}
          className="rounded bg-red-500 px-1.5 py-0.5 text-white"
        >
          删除
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(false);
          }}
          className="text-muted hover:text-ink"
        >
          取消
        </button>
      </div>
    );
  }

  // hover 或 当前行 才露出操作（否则当前选中夹的操作永远够不着）。
  const actionCls = active ? "opacity-100" : "opacity-0 group-hover:opacity-100";

  return (
    <div
      className={`group flex cursor-pointer items-center gap-1 rounded px-2 py-1.5 ${
        dragOver > 0
          ? "ring-2 ring-accent bg-accent/10"
          : active
            ? "bg-panel2"
            : "hover:bg-panel2"
      }`}
      onClick={() => (isCollection ? setCurrentCollection(folder.id) : setCurrentFolder(folder.id))}
      title={folder.smart_query ?? ""}
      // 拖拽放置：仅普通文件夹（folder）接收（约定 12：collection 多对多、smart 无意义）。
      // collection/smart 行 onDragOver 不 preventDefault → 不允许 drop。
      onDragOver={(e) => {
        if (isCollection || isSmart) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDragEnter={(e) => {
        if (isCollection || isSmart || !getDragAssets()) return;
        e.preventDefault();
        setDragOver((c) => c + 1);
      }}
      onDragLeave={() => setDragOver((c) => Math.max(0, c - 1))}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(0);
        if (isCollection || isSmart) return;
        const ids = getDragAssets();
        if (!ids || ids.length === 0) return;
        // 当前所在夹幂等跳过（省无用 emit）；移动后 clearSelect（manage 选中集可能被移走），
        // 列表刷新交给 assets-changed 监听器。
        if (useStore.getState().currentFolderId === folder.id) return;
        api.moveAssetsToFolder(ids, folder.id).then(
          () => useStore.getState().clearSelect(),
          (err) => console.error("move failed", err)
        );
      }}
    >
      <span className="flex-1 truncate">
        {isSmart ? "🔍" : isCollection ? "★" : "📁"} {folder.name}
      </span>
      <span className={`flex items-center gap-0.5 ${actionCls}`}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setEditing(true);
            setName(folder.name);
          }}
          className="rounded px-1 text-xs text-muted hover:text-accent"
          title="改名"
        >
          ✎
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(true);
          }}
          className="rounded px-1 text-xs text-muted hover:text-red-400"
          title={isSmart ? "删除（不影响素材）" : isCollection ? "删除（只移除收藏关系）" : "删除（素材回到全部）"}
        >
          ✕
        </button>
      </span>
    </div>
  );
}
