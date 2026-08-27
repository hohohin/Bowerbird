import { useEffect, useRef, useState } from "react";
import { EyeOff, FolderPlus, Library, PanelLeftClose, PanelLeftOpen, RefreshCw, Sparkles } from "lucide-react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { getDragAssets } from "../lib/dragPayload";
import { understandProvider } from "../lib/entitlement";
import { notifyError, notifySuccess } from "../lib/notify";
import { ProjectSection } from "./ProjectSection";
import { SidebarAccount } from "./SidebarAccount";
import { SidebarStatus } from "./SidebarStatus";
import type { Folder } from "../lib/types";

/** 颜色桶 key → 中文 label（P3；hex 由后端 palette_overview 带回）。 */
const COLOR_LABELS: Record<string, string> = {
  red: "红", orange: "橙", yellow: "黄", green: "绿", cyan: "青",
  blue: "蓝", purple: "紫", pink: "粉", brown: "棕", gray: "灰",
  white: "白", black: "黑",
};

/** 项目圆标首字（中文名取第一个字），空名兜底 P。 */
function projectInitial(name: string) {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "P";
}

const SIDEBAR_COLLAPSED_KEY = "bowerbird.sidebarCollapsed";
const SIDEBAR_WIDTH_KEY = "bowerbird.sidebarWidth";
// 拖拽调宽下限：低于此宽度文件夹名/操作按钮放不下（媒体查询最窄 162px，取整 160）。
const SIDEBAR_MIN_WIDTH = 160;

function loadSidebarCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function loadSidebarWidth() {
  try {
    const n = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(n) && n >= SIDEBAR_MIN_WIDTH ? n : null;
  } catch {
    return null;
  }
}

/** 左侧栏：素材统计 + 文件夹/智能文件夹 + 颜色筛选 + 底部账号区。 */
export function Sidebar() {
  const total = useStore((s) => s.total);
  const selectedCount = useStore((s) => s.selectedIds.size);
  const currentFolderId = useStore((s) => s.currentFolderId);
  const currentProjectId = useStore((s) => s.currentProjectId);
  const projects = useStore((s) => s.projects);
  const enterProject = useStore((s) => s.enterProject);
  const exitProject = useStore((s) => s.exitProject);
  const openProjectContextMenu = useStore((s) => s.openProjectContextMenu);
  const currentCollectionId = useStore((s) => s.currentCollectionId);
  const setCurrentFolder = useStore((s) => s.setCurrentFolder);
  const colorFilter = useStore((s) => s.colorFilter);
  const setColorFilter = useStore((s) => s.setColorFilter);
  const folders = useStore((s) => s.folders);
  const smartFilter = useStore((s) => s.smartFilter);
  const setSmartFilter = useStore((s) => s.setSmartFilter);
  const reloadFolders = useStore((s) => s.reloadFolders);
  const autoTags = useStore((s) => s.autoTags);
  const colorRebuild = useStore((s) => s.colorRebuild);
  const classifyProgress = useStore((s) => s.classifyProgress);
  const codexHealth = useStore((s) => s.codexHealth);
  const cloudAuth = useStore((s) => s.cloudAuth);
  const cloudEntitlement = useStore((s) => s.cloudEntitlement);
  const tourActive = useStore((s) => s.tourActive);
  const tourStep = useStore((s) => s.tourStep);
  // 智能归类可用性（照设置面板原算法）：free 需登录云端；Pro 可用本机 CLI。
  const understandRoute = understandProvider(cloudEntitlement);
  const understandReady = understandRoute === "codex"
    ? !!codexHealth?.ok
    : understandRoute === "bowerbird-cloud"
      ? !!cloudAuth?.cloud_available && !!cloudAuth.logged_in
      : false;
  const understandLabel = understandRoute === "codex" ? "codex CLI" : "Bowerbird Cloud";

  // inline 新建表单：none | folder | smart | collection（避开 window.prompt——Tauri WKWebView 拦截原生对话框）。
  const [creating, setCreating] = useState<"none" | "folder" | "smart" | "collection">("none");
  const [draftName, setDraftName] = useState("");
  const [smartKind, setSmartKind] = useState<"source" | "ext">("source");
  const [smartValue, setSmartValue] = useState("");
  const [collapsed, setCollapsed] = useState(loadSidebarCollapsed);
  // 自定义宽度（null = 用 CSS 默认 198px/媒体查询宽度）。拖拽右缘把手调整，持久化到 localStorage。
  const [width, setWidth] = useState<number | null>(loadSidebarWidth);
  const [resizing, setResizing] = useState<{ startX: number; startWidth: number } | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  const palette = useStore((s) => s.palette);
  const normalFolders = folders.filter(
    (f) => f.id !== "root" && (f.kind ?? "folder") === "folder"
  );
  const smartFolders = folders.filter((f) => f.id !== "root" && f.kind === "smart");
  const collections = folders.filter((f) => f.id !== "root" && f.kind === "collection");

  function setSidebarCollapsed(next: boolean) {
    setCollapsed(next);
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // ignore storage errors
    }
  }

  useEffect(() => {
    if (tourActive && (tourStep === 1 || tourStep === 2 || tourStep === 3)) setCollapsed(false);
  }, [tourActive, tourStep]);

  /** 宽度夹取：最小 160px，最大不超过主面板（侧栏所在 flex 行）的 1/4。 */
  function clampSidebarWidth(w: number | null) {
    if (w == null) return null;
    const rowWidth = sidebarRef.current?.parentElement?.clientWidth ?? window.innerWidth;
    const max = Math.max(SIDEBAR_MIN_WIDTH, Math.round(rowWidth / 4));
    return Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, Math.round(w)));
  }

  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizing({ startX: e.clientX, startWidth: sidebarRef.current?.offsetWidth ?? 198 });
  }

  function moveResize(e: React.PointerEvent<HTMLDivElement>) {
    if (!resizing) return;
    setWidth(clampSidebarWidth(resizing.startWidth + e.clientX - resizing.startX));
  }

  function endResize() {
    if (!resizing) return;
    setResizing(null);
    if (width != null) {
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
      } catch {
        // ignore storage errors
      }
    }
  }

  const isResizing = resizing !== null;

  // 拖拽期间：全局锁定 col-resize 光标 + 禁止选中文本（把手 pointer capture 后事件仍落在页面上）。
  useEffect(() => {
    if (!isResizing) return;
    document.body.classList.add("app-sidebar-resizing");
    return () => document.body.classList.remove("app-sidebar-resizing");
  }, [isResizing]);

  // 窗口变化（含首挂载）时把已存宽度重新压回 1/4 上限内。
  useEffect(() => {
    const reclamp = () => setWidth((w) => clampSidebarWidth(w));
    reclamp();
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 窄轨检测：侧栏拖窄后「AI 新作」两段文字放不下 → 只留图标不换行。
  // collapsed 变化时 ref 重新挂载，依赖它重绑 observer。
  const [genIconsOnly, setGenIconsOnly] = useState(false);
  useEffect(() => {
    const el = sidebarRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setGenIconsOnly(el.offsetWidth < 195));
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapsed]);

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
      notifySuccess(
        creating === "folder"
          ? "文件夹已创建"
          : creating === "collection"
            ? "收藏夹已创建"
            : "智能文件夹已创建"
      );
    } catch (e) {
      console.error("create folder failed", e);
      notifyError(e, "创建失败");
    }
    resetCreate();
  }

  function startCreate(kind: "folder" | "smart" | "collection") {
    setCreating(kind);
    setDraftName("");
    setSmartValue("");
  }

  if (collapsed) {
    return (
      <aside className="app-sidebar is-collapsed flex shrink-0 flex-col items-center border-r border-edge">
        <button
          type="button"
          onClick={() => setSidebarCollapsed(false)}
          className="app-sidebar-rail-toggle"
          title="展开侧栏"
          aria-label="展开侧栏"
        >
          <PanelLeftOpen size={17} />
        </button>
        <div className="app-sidebar-rail-divider" />
        <SidebarStatus collapsed />
        <div className="app-sidebar-rail-divider" />
        {/* 项目圆标轨：G=全局 + 每个项目一枚首字圆标，点击直接切换（不展开侧栏）。 */}
        <div className="flex w-full flex-1 flex-col items-center gap-2 overflow-y-auto py-1">
          <button
            type="button"
            onClick={() => currentProjectId && void exitProject()}
            className={`app-sidebar-project-badge ${currentProjectId ? "" : "is-active"}`}
            title="全局素材"
            aria-label="全局素材"
          >
            G
          </button>
          {projects.map((p) => {
            const active = p.id === currentProjectId;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => !active && void enterProject(p.id)}
                onContextMenu={(e) => {
                  // 收起态圆标同样支持项目右键菜单（更新项目文件等）。
                  e.preventDefault();
                  openProjectContextMenu(e.clientX, e.clientY, p.id);
                }}
                className={`app-sidebar-project-badge ${active ? "is-active" : ""}`}
                title={p.name}
                aria-label={`切换到项目 ${p.name}`}
              >
                {projectInitial(p.name)}
              </button>
            );
          })}
        </div>
      </aside>
    );
  }

  return (
    <aside
      ref={sidebarRef}
      style={width != null ? { width } : undefined}
      className="app-sidebar flex shrink-0 flex-col border-r border-edge text-sm"
    >
      <button
        type="button"
        onClick={() => setSidebarCollapsed(true)}
        className="app-sidebar-expanded-toggle"
        title="收起侧栏"
        aria-label="收起侧栏"
      >
        <PanelLeftClose size={16} />
      </button>
      <div className="flex-1 overflow-y-auto p-3 pt-4">
      <SidebarStatus />

      <ProjectSection />

      <div className="panel-kicker mb-2 flex items-center justify-between">
        <span>文件夹</span>
        <span className="flex gap-2 normal-case tracking-normal">
          <button
            onClick={() => (creating === "folder" ? resetCreate() : startCreate("folder"))}
            className="rounded px-1 text-cold hover:opacity-80"
            title="新建文件夹"
          >
            <FolderPlus size={13} />
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
        <button
          type="button"
          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left ${
            currentFolderId === null && !smartFilter && !currentCollectionId ? "bg-panel2" : "hover:bg-panel2"
          }`}
          onClick={() => setCurrentFolder(null)}
        >
          <Library size={15} className="text-muted" />
          {currentProjectId ? "项目全部" : "全部素材"}
        </button>
        {normalFolders.map((f) => (
          <FolderRow key={f.id} folder={f} />
        ))}
      </div>

      {collections.length > 0 && (
        <>
          <div className="panel-kicker mb-2 mt-5">收藏夹</div>
          <div className="space-y-1">
            {collections.map((f) => (
              <FolderRow key={f.id} folder={f} />
            ))}
          </div>
        </>
      )}

      {smartFolders.length > 0 && (
        <>
          <div className="panel-kicker mb-2 mt-5">智能文件夹</div>
          <div className="space-y-1">
            {smartFolders.map((f) => (
              <FolderRow key={f.id} folder={f} />
            ))}
          </div>
        </>
      )}

      {autoTags.length > 0 && (
        <>
          <div className="panel-kicker mb-2 mt-5 flex items-center justify-between">
            <span>自动归类</span>
            <span className="flex items-center gap-1.5 normal-case tracking-normal">
              {classifyProgress && (
                <span className="tabular-nums text-[10px] text-muted">
                  归类中 {classifyProgress.done}/{classifyProgress.total}
                </span>
              )}
              {smartFilter?.startsWith("tag:") && (
                <button
                  onClick={() => setSmartFilter(null)}
                  className="text-cold hover:opacity-80"
                >
                  清除
                </button>
              )}
              <button
                onClick={() =>
                  api.reclassifyAll().catch((e) => console.error("reclassifyAll failed", e))
                }
                disabled={!!classifyProgress || !understandReady}
                title={
                  understandReady
                    ? `使用 ${understandLabel} 重新归类`
                    : "免费版需要先登录 Bowerbird Cloud；Pro 可使用本机 CLI"
                }
                className="rounded px-1 text-cold hover:opacity-80 disabled:opacity-40"
              >
                <RefreshCw size={13} />
              </button>
            </span>
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
          <div className="panel-kicker mb-2 mt-5 flex items-center justify-between">
            <span>颜色</span>
            <span className="flex items-center gap-1.5 normal-case tracking-normal">
              {colorRebuild && (
                <span className="tabular-nums text-[10px] text-muted">
                  重建中 {colorRebuild.done}/{colorRebuild.total}
                </span>
              )}
              {colorFilter && (
                <button
                  onClick={() => setColorFilter(null)}
                  className="text-cold hover:opacity-80"
                >
                  清除
                </button>
              )}
              <button
                onClick={() =>
                  api.recomputeColors().catch((e) => console.error("recomputeColors failed", e))
                }
                disabled={!!colorRebuild}
                title="重建色板（后台重新量化全库主色）"
                className="rounded px-1 text-cold hover:opacity-80 disabled:opacity-40"
              >
                <RefreshCw size={13} />
              </button>
            </span>
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
      </div>
      {/* 生成图显示模式 + 素材数量小字 + 账号区：常驻左下角，不随内容滚动 */}
      <div className="px-3 pt-2">
        <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted">生成图显示模式</div>
        {/* 左右两段开关（样式同详情面板「信息/再创作」tab）——左=仅生成图，右=隐藏生成图；
            再点当前段取消（显示全部）；窄轨只留图标不换行。 */}
        <div className="app-sidebar-gen-toggle" role="tablist" aria-label="生成图显示模式">
          <button
            type="button"
            role="tab"
            aria-selected={smartFilter === "source:generated"}
            className={smartFilter === "source:generated" ? "is-active" : ""}
            onClick={() =>
              setSmartFilter(smartFilter === "source:generated" ? null : "source:generated")
            }
            title="只看生成图（codex / 即梦 / Bowerbird Cloud）；再点一次显示全部"
          >
            <Sparkles size={13} />
            {!genIconsOnly && "仅生成图"}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={smartFilter === "source:!generated"}
            className={smartFilter === "source:!generated" ? "is-active" : ""}
            onClick={() =>
              setSmartFilter(smartFilter === "source:!generated" ? null : "source:!generated")
            }
            title="隐藏所有生成图，只看导入素材；再点一次显示全部"
          >
            <EyeOff size={13} />
            {!genIconsOnly && "隐藏生成图"}
          </button>
        </div>
      </div>
      <div className="px-3 pb-0.5 pt-2 text-[10px] uppercase tracking-wide text-muted">
        {currentProjectId ? "Project assets" : "Library assets"} · {total}
      </div>
      <SidebarAccount />
      {/* 右缘拖拽把手：调侧栏宽度（最小 160px，最大主面板 1/4） */}
      <div
        className={`app-sidebar-resizer ${isResizing ? "is-active" : ""}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧栏宽度"
        title="拖动调整侧栏宽度"
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
      />
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
  const currentProjectId = useStore((s) => s.currentProjectId);
  const openVisualProfile = useStore((s) => s.openVisualProfile);
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
      notifySuccess("名称已更新");
    } catch (e) {
      console.error("rename failed", e);
      notifyError(e, "重命名失败");
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
      notifySuccess("已删除");
    } catch (e) {
      console.error("delete folder failed", e);
      notifyError(e, "删除失败");
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
        {!isSmart && !isCollection && currentProjectId && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              openVisualProfile({ id: folder.id, name: folder.name });
            }}
            className="rounded px-1 text-xs text-muted hover:text-accent"
            title="提炼视觉设定（只读已有反推文字，不上传图片）"
          >
            ✦
          </button>
        )}
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
