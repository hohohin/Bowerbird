import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, FolderOpen, LayoutDashboard, LoaderCircle, Search, Upload, X } from "lucide-react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { notifyError, notifySuccess } from "../lib/notify";

/** 顶部工具栏：导入 + 画布模式 + 搜索 + 运行状态。（创作板对话框已常驻。） */
export function Toolbar({
  onRefresh,
  canvasMode,
  onCanvasModeChange,
  onCreateCreative,
}: {
  onRefresh: () => Promise<void>;
  canvasMode: boolean;
  onCanvasModeChange: (active: boolean) => void;
  onCreateCreative: (blank: boolean) => void;
}) {
  const setLoading = useStore((s) => s.setLoading);
  const busy = useStore((s) => s.loading);
  const searchQuery = useStore((s) => s.searchQuery);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const projects = useStore((s) => s.projects);
  const setSearchQuery = useStore((s) => s.setSearchQuery);
  const collectedNotice = useStore((s) => s.collectedNotice);
  const setCollectedNotice = useStore((s) => s.setCollectedNotice);
  const setCurrentFolder = useStore((s) => s.setCurrentFolder);
  const setCurrentCollection = useStore((s) => s.setCurrentCollection);
  const setSmartFilter = useStore((s) => s.setSmartFilter);
  const setColorFilter = useStore((s) => s.setColorFilter);
  const [importOpen, setImportOpen] = useState(false);
  const [creativeOpen, setCreativeOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLDivElement>(null);
  const creativeRef = useRef<HTMLDivElement>(null);

  const currentProject = projects.find((p) => p.id === activeProjectId) ?? null;

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
      if (!creativeRef.current?.contains(e.target as Node)) setCreativeOpen(false);
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
      await api.importFiles(paths, activeProjectId);
      return true;
    }, "素材已导入");
  }

  function importFolder() {
    setImportOpen(false);
    void withBusy(async () => {
      const path = await api.pickFolder();
      if (!path) return false;
      await api.importFolder(path, activeProjectId);
      return true;
    }, "文件夹已导入");
  }

  return (
    <header className="app-topbar" aria-busy={busy}>
      <div className="app-topbar-leading">
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
        {canvasMode ? (
          <button
            type="button"
            className="app-button-dark canvas-mode-toggle is-active"
            title="返回素材库"
            onClick={() => onCanvasModeChange(false)}
          >
            <ArrowLeft size={15} />
            返回素材库
          </button>
        ) : (
          <div ref={creativeRef} className="relative flex">
            <button
              type="button"
              className="app-button-dark rounded-r-none"
              title="用当前明确选中的素材开始一项新创作"
              onClick={() => onCreateCreative(false)}
            >
              <LayoutDashboard size={15} />
              新建创作
            </button>
            <button
              type="button"
              className="app-button-dark rounded-l-none border-l-0 px-2"
              aria-haspopup="menu"
              aria-expanded={creativeOpen}
              aria-label="新建创作选项"
              onClick={() => setCreativeOpen((open) => !open)}
            >
              <ChevronDown size={13} className={creativeOpen ? "rotate-180" : ""} />
            </button>
            {creativeOpen && (
              <div className="app-popover absolute left-0 top-full z-[70] mt-2 w-52" role="menu" aria-label="新建创作">
                <button
                  type="button"
                  className="app-context-item px-3 py-2 text-xs"
                  role="menuitem"
                  onClick={() => {
                    setCreativeOpen(false);
                    onCreateCreative(false);
                  }}
                >
                  <LayoutDashboard size={14} className="text-muted" />
                  新建创作
                </button>
                <button
                  type="button"
                  className="app-context-item px-3 py-2 text-xs"
                  role="menuitem"
                  onClick={() => {
                    setCreativeOpen(false);
                    onCreateCreative(true);
                  }}
                >
                  <LayoutDashboard size={14} className="text-muted" />
                  新建空白项目
                </button>
              </div>
            )}
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

      <div className="app-topbar-actions" />
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
