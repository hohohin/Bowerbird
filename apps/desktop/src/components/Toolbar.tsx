import { useEffect, useRef, useState } from "react";
import { ChevronDown, FolderOpen, LoaderCircle, Search, Sparkles, Upload, X } from "lucide-react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { notifyError, notifySuccess } from "../lib/notify";

/** 顶部工具栏：导入 + 搜索 + 创作板入口 + 运行状态。 */
export function Toolbar({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const setLoading = useStore((s) => s.setLoading);
  const busy = useStore((s) => s.loading);
  const boardOpen = useStore((s) => s.boardOpen);
  const toggleBoard = useStore((s) => s.toggleBoard);
  const searchQuery = useStore((s) => s.searchQuery);
  const currentProjectId = useStore((s) => s.currentProjectId);
  const projects = useStore((s) => s.projects);
  const setSearchQuery = useStore((s) => s.setSearchQuery);
  const collectedNotice = useStore((s) => s.collectedNotice);
  const setCollectedNotice = useStore((s) => s.setCollectedNotice);
  const setCurrentFolder = useStore((s) => s.setCurrentFolder);
  const setCurrentCollection = useStore((s) => s.setCurrentCollection);
  const setSmartFilter = useStore((s) => s.setSmartFilter);
  const setColorFilter = useStore((s) => s.setColorFilter);
  const [importOpen, setImportOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLDivElement>(null);

  const currentProject = projects.find((p) => p.id === currentProjectId) ?? null;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        !!target?.isContentEditable;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape" && document.activeElement === searchRef.current) {
        searchRef.current?.blur();
      }
    }
    function onPointerDown(e: MouseEvent) {
      if (!importRef.current?.contains(e.target as Node)) setImportOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onPointerDown);
    };
  }, []);

  // 扩展采集入根库；清空当前范围让用户立刻看见新素材。
  function showCollectedAsset() {
    setCurrentCollection(null);
    setCurrentFolder(null);
    setSearchQuery("");
    setSmartFilter(null);
    setColorFilter(null);
    setCollectedNotice(null);
  }

  async function withBusy(fn: () => Promise<boolean>, successMessage: string) {
    setLoading(true);
    try {
      const changed = await fn();
      if (!changed) return;
      await onRefresh();
      notifySuccess(successMessage);
    } catch (error) {
      console.error(error);
      notifyError(error, "导入失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  function importFiles() {
    setImportOpen(false);
    void withBusy(async () => {
      const paths = await api.pickImageFiles();
      if (!paths.length) return false;
      await api.importFiles(paths, currentProjectId);
      return true;
    }, "素材已导入");
  }

  function importFolder() {
    setImportOpen(false);
    void withBusy(async () => {
      const path = await api.pickFolder();
      if (!path) return false;
      await api.importFolder(path, currentProjectId);
      return true;
    }, "文件夹已导入");
  }

  return (
    <header className="app-topbar" aria-busy={busy}>
      <div ref={importRef} className="app-topbar-import relative">
        <button
          type="button"
          data-import-trigger
          onClick={() => setImportOpen((v) => !v)}
          disabled={busy}
          className="app-button-dark disabled:opacity-50"
          aria-haspopup="menu"
          aria-expanded={importOpen}
        >
          {busy ? <LoaderCircle size={15} className="animate-spin" /> : <Upload size={15} />}
          {busy ? "导入中" : "导入"}
          <ChevronDown size={13} className={importOpen ? "rotate-180" : ""} />
        </button>
        {importOpen && (
          <div className="app-popover absolute left-0 top-full z-[70] mt-2 w-48" role="menu" aria-label="导入素材">
            <button
              type="button"
              onClick={importFiles}
              className="app-context-item px-3 py-2 text-xs"
              role="menuitem"
            >
              <Upload size={14} className="text-muted" />
              导入图片
            </button>
            <button
              type="button"
              onClick={importFolder}
              className="app-context-item px-3 py-2 text-xs"
              role="menuitem"
            >
              <FolderOpen size={14} className="text-muted" />
              导入文件夹
            </button>
            {/* 其他导入方式提示：Ctrl+V 粘贴与拖拽随时可用，不走此菜单 */}
            <div className="app-context-divider" />
            <div className="pointer-events-none px-3 pb-1 pt-1.5 text-[10px] leading-4 text-muted">
              <span className="block">支持 Ctrl+V 粘贴导入</span>
              <span className="block">支持拖拽导入</span>
            </div>
          </div>
        )}
      </div>

      <div className="app-search">
        <Search size={15} strokeWidth={1.8} aria-hidden />
        <input
          ref={searchRef}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={currentProject ? `搜索 ${currentProject.name} 中的素材…` : "搜索素材…"}
          aria-label="搜索素材"
        />
        {searchQuery ? (
          <button
            type="button"
            onClick={() => setSearchQuery("")}
            className="app-search-clear"
            title="清除搜索"
            aria-label="清除搜索"
          >
            <X size={14} />
          </button>
        ) : (
          <kbd>/</kbd>
        )}
      </div>

      <div className="app-topbar-actions">
        <button
          type="button"
          onClick={toggleBoard}
          className={`app-button-light ${boardOpen ? "is-active" : ""}`}
          title="打开创作板"
        >
          <Sparkles size={15} />
          <span className="topbar-action-label">创作板</span>
        </button>
      </div>
      {collectedNotice && (
        <button
          onClick={showCollectedAsset}
          className="absolute right-4 top-[calc(100%+22px)] z-50 max-w-72 truncate rounded-full border border-lime/25 bg-panel px-3 py-2 text-xs text-lime shadow-panel hover:bg-panel2"
          title={`已采集：${collectedNotice}。点击回到总库查看。`}
        >
          已采集「{collectedNotice}」 · 查看
        </button>
      )}
      {busy && <div className="app-progress-line" aria-hidden="true" />}
    </header>
  );
}
