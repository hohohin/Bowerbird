import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, Compass, FolderOpen, LayoutDashboard, LoaderCircle, Upload } from "lucide-react";
import { SidebarAccount } from "./SidebarAccount";
import { ProjectManagerPanel } from "./ProjectManagerPanel";
import { GeneratedImageFilter } from "./GeneratedImageFilter";
import { MediaTypeFilter } from "./MediaTypeFilter";
import { useStore } from "../store";
import { useActiveLibraryModeStore, useActiveLibraryPane } from "../lib/libraryPane";
import { api } from "../lib/api";
import { prepareMediaImport, showImportedMedia } from "../lib/mediaImport";
import { prepareExplorerCanvasDrop } from "../lib/explorerCanvasDrop";
import { notifyError, notifySuccess } from "../lib/notify";
import { beginOnboardingOperation, useOnboarding } from "../lib/onboardingStore";
import "./LibraryTactical.css";

/** 顶部工具栏：导入 + 项目/主页入口 + 用户中心。 */
export function Toolbar({
  onRefresh,
  canvasMode,
  onCanvasModeChange,
  onCreateCreative,
  onExplore,
  exploring = false,
  localFilesOpen = false,
}: {
  onRefresh: () => Promise<void>;
  canvasMode: boolean;
  onCanvasModeChange: (active: boolean) => void;
  onCreateCreative: (blank: boolean) => void;
  onExplore?: () => void;
  exploring?: boolean;
  localFilesOpen?: boolean;
}) {
  const useLocalFileMode = useActiveLibraryModeStore();
  const activePane = useActiveLibraryPane(s => s.pane);
  const setLoading = useStore((s) => s.setLoading);
  const busy = useStore((s) => s.loading);
  const setNavigationHost = useLocalFileMode(s => s.setNavigationHost);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const setLibraryQuery = useStore((s) => s.setSearchQuery);
  const setFolderQuery = useLocalFileMode(s => s.setQuery);
  const setSearchQuery = localFilesOpen ? setFolderQuery : setLibraryQuery;
  const collectedNotice = useStore((s) => s.collectedNotice);
  const setCollectedNotice = useStore((s) => s.setCollectedNotice);
  const setCurrentFolder = useStore((s) => s.setCurrentFolder);
  const setCurrentCollection = useStore((s) => s.setCurrentCollection);
  const setSmartFilter = useStore((s) => s.setSmartFilter);
  const homeView = useStore(s => s.libraryHomeView);
  const setColorFilter = useStore((s) => s.setColorFilter);
  const [importOpen, setImportOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const fileMode = useLocalFileMode(s => s.mode);
  const showFileNavigation = localFilesOpen && fileMode === "files" && !activePane;
  const importRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLElement>(null);
  const tactical = localFilesOpen && !exploring;

  useEffect(() => {
    if (!tactical) return;
    const toolbar = toolbarRef.current!;
    const sync = () => { toolbar.dataset.libraryMotionPaused = String(document.hidden); };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      delete toolbar.dataset.libraryMotionPaused;
      document.removeEventListener("visibilitychange", sync);
    };
  }, [tactical]);

  // Hidden search must not leave an invisible filter behind after a view change.
  useEffect(() => { setLibraryQuery(""); setFolderQuery(""); }, [setLibraryQuery, setFolderQuery]);
  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (!importRef.current?.contains(e.target as Node)) setImportOpen(false);
    }
    window.addEventListener("mousedown", onPointerDown);
    return () => {
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

  async function withBusy(fn: () => Promise<string | null>) {
    const route = useStore.getState();
    const routeRevision = route.projectRouteRevision;
    setLoading(true);
    try {
      const message = await fn();
      if (!message) return;
      const current = useStore.getState();
      if (current.activeProjectId === route.activeProjectId
        && current.projectRouteRevision === routeRevision && !current.projectRoutePending) {
        showCollectedAsset();
      }
      await onRefresh();
      notifySuccess(message);
    } catch (error) {
      console.error(error);
      notifyError(error, "导入失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  function importFiles() {
    const revision = useStore.getState().projectRouteRevision;
    const stage = canvasMode ? document.querySelector<HTMLElement>(".canvas-stage:not(.is-view-hidden)") : null;
    const rect = stage?.getBoundingClientRect();
    const place = rect ? prepareExplorerCanvasDrop(stage, activeProjectId, rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
    const completeLesson = beginOnboardingOperation("import", activeProjectId);
    setImportOpen(false);
    void withBusy(async () => {
      const paths = await api.pickMediaFiles();
      if (!paths.length) return null;
      if (canvasMode && !place) throw new Error("画布尚未就绪，请稍后重试");
      await prepareMediaImport(activeProjectId, revision);
      const assets = await api.importFiles(paths, activeProjectId);
      if (!assets.length) throw new Error("未导入任何素材，请检查所选文件是否可读取");
      if (place) for (const asset of assets) await place(asset);
      const current = useStore.getState();
      if (current.activeProjectId === activeProjectId && current.projectRouteRevision === revision && !current.projectRoutePending) showImportedMedia(assets, useLocalFileMode);
      completeLesson();
      if (assets.length < paths.length) notifyError(null, `${paths.length - assets.length} 个文件导入失败`);
      return `已导入 ${assets.length} 个文件（相同文件复用已有素材）`;
    });
  }

  function importFolder() {
    const completeLesson = beginOnboardingOperation("folder", activeProjectId);
    const guide = useOnboarding.getState().guide;
    const starterFolder = guide.status === "active" && guide.role === "designer"
      && [1, 7, 8].includes(guide.sessions.designer?.step ?? -1) && guide.sessions.designer?.projectId === activeProjectId;
    setImportOpen(false);
    void withBusy(async () => {
      const parent = starterFolder ? await api.releasePresetPack() : undefined;
      const path = await api.pickFolder(parent);
      if (!path) return null;
      if (parent) {
        const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
        if (normalize(path) !== normalize(parent + "/初始引导")) {
          throw new Error("请在打开的位置选择「初始引导」文件夹，再继续入门引导");
        }
      }
      await useStore.getState().projectCanvasFlush?.();
      const count = await api.importFolder(path, activeProjectId);
      if (!count) throw new Error("文件夹中没有成功导入的素材，请检查文件格式和读取权限");
      completeLesson();
      return starterFolder ? `已导入初始引导：${count} 个素材及完整画板` : `已从文件夹导入 ${count} 个文件（相同文件复用已有素材）`;
    });
  }

  return (
    <header ref={toolbarRef} className={`app-topbar is-search-hidden${canvasMode ? "" : " is-library"}${tactical ? " library-tactical" : ""}${showFileNavigation ? " has-file-navigation" : localFilesOpen ? " is-global-materials" : ""}`} aria-busy={busy}>
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
            aria-label={busy ? "导入中" : "导入"}
            title={busy ? "导入中" : "导入"}
          >
            {busy ? <LoaderCircle size={15} className="animate-spin" /> : <Upload size={15} />}
            <span className="app-topbar-button-label">{busy ? "导入中" : "导入"}</span>
            <ChevronDown size={13} className={importOpen ? "rotate-180" : ""} />
          </button>
          {importOpen && (
            <div className="app-popover absolute left-0 top-full z-[70] mt-2 w-48" role="menu" aria-label="导入素材">
              <button
                type="button"
                onClick={importFiles}
                data-tour="import-files"
                className="app-context-item px-3 py-2 text-xs"
                role="menuitem"
              >
                <Upload size={14} className="text-muted" />
                导入图片或视频
              </button>
              <button
                type="button"
                onClick={importFolder}
                data-tour="import-folder"
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
        {onExplore && <button type="button" data-tour="explore" className="app-button-dark" aria-pressed={exploring}
          onClick={onExplore} aria-label="探索" title="浏览灵感网站，拖图采集到素材库"><Compass size={15} /><span className="app-topbar-button-label">探索</span></button>}
        {canvasMode ? (
          <button
            type="button"
            className="app-button-dark canvas-mode-toggle is-active"
            title="返回主页"
            aria-label="返回主页"
            onClick={() => onCanvasModeChange(false)}
          >
            <ArrowLeft size={15} />
            <span className="app-topbar-button-label">返回主页</span>
          </button>
        ) : (
          <button
            type="button"
            className="app-button-accent library-projects-trigger"
            data-tour="new-creation"
            title="打开项目管理"
            aria-label="我的项目"
            aria-haspopup="dialog"
            aria-expanded={projectsOpen}
            onClick={() => setProjectsOpen(true)}
          >
            <LayoutDashboard size={15} />
            <span className="app-topbar-button-label">我的项目</span>
          </button>
        )}
      </div>

      {showFileNavigation && <div className="app-file-navigation-slot" ref={setNavigationHost} />}
      {tactical && !showFileNavigation && <span className="library-toolbar-context"><i aria-hidden="true"/><span>素材库<small>ASSET LIBRARY</small></span></span>}

      <div className="app-topbar-actions" aria-label="视图与账号">
        {!localFilesOpen && (canvasMode || homeView === "library") && <div className="app-topbar-view-controls" role="group" aria-label="素材视图">
          <GeneratedImageFilter />
          <MediaTypeFilter />

        </div>}
        <SidebarAccount placement="topbar" />
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
      {projectsOpen && <ProjectManagerPanel onClose={() => setProjectsOpen(false)} onCreate={() => onCreateCreative(true)} />}
    </header>
  );
}
