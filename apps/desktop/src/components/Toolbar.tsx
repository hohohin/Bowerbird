import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Compass, LayoutDashboard, Link2, LoaderCircle } from "lucide-react";
import { SidebarAccount } from "./SidebarAccount";
import { ProjectManagerPanel } from "./ProjectManagerPanel";
import { GeneratedImageFilter } from "./GeneratedImageFilter";
import { MediaTypeFilter } from "./MediaTypeFilter";
import { useStore } from "../store";
import { useActiveLibraryModeStore, useActiveLibraryPane } from "../lib/libraryPane";
import { api } from "../lib/api";
import { folderConnections, navigateConnectedFolder } from "../lib/folderConnections";
import { prepareMediaImport } from "../lib/mediaImport";
import { notifyError, notifySuccess } from "../lib/notify";
import { beginOnboardingOperation, useOnboarding } from "../lib/onboardingStore";
import "./LibraryTactical.css";

/** 顶部工具栏：建立连接 + 项目/主页入口 + 用户中心。 */
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
  const setLoading = useStore((s) => s.setLoading);
  const busy = useStore((s) => s.loading);
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
  const [projectsOpen, setProjectsOpen] = useState(false);
  const toolbarRef = useRef<HTMLElement>(null);
  const tactical = !canvasMode && localFilesOpen && !exploring;

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
      notifyError(error, "建立连接失败，请检查文件夹是否可访问");
    } finally {
      setLoading(false);
    }
  }

  function connectFolder() {
    const routeRevision = useStore.getState().projectRouteRevision;
    const guide = useOnboarding.getState().guide;
    const completeLesson = beginOnboardingOperation(guide.role === "designer" ? "folder" : "import", activeProjectId);
    const paneId = useActiveLibraryPane.getState().pane?.id;
    const starterFolder = guide.status === "active" && guide.role === "designer"
      && [1, 7, 8].includes(guide.sessions.designer?.step ?? -1) && guide.sessions.designer?.projectId === activeProjectId;
    void withBusy(async () => {
      const parent = starterFolder ? await api.releasePresetPack() : undefined;
      const path = await api.pickFolder(parent);
      if (!path) return null;
      await prepareMediaImport(activeProjectId, routeRevision);
      if (parent) {
        const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
        if (normalize(path) !== normalize(parent + "/初始引导")) throw new Error("请选择「初始引导」文件夹，再继续入门引导");
        await useStore.getState().projectCanvasFlush?.();
        await api.importFolder(path, activeProjectId);
      }
      const id = await folderConnections.connect(path, activeProjectId);
      const current = useStore.getState();
      if (current.activeProjectId === activeProjectId && current.projectRouteRevision === routeRevision && !current.projectRoutePending) {
        navigateConnectedFolder(id, paneId);
        useLocalFileMode.getState().setCatalogView("collections");
        useLocalFileMode.getState().setOpen(true);
      }
      completeLesson();
      return "已建立连接，正在读取素材";
    });
  }

  return (
    <header ref={toolbarRef} className={`app-topbar is-search-hidden${canvasMode ? " canvas-tactical" : " is-library"}${tactical ? " library-tactical" : ""}${localFilesOpen ? " is-global-materials" : ""}`} aria-busy={busy}>
      <div className="app-topbar-leading">
        <div className="app-topbar-import">
          <button type="button" data-import-trigger data-tour="import-folder" onClick={connectFolder} disabled={busy}
            className="app-button-dark disabled:opacity-50" aria-label={busy ? "连接中" : "建立连接"} title="建立连接">
            {busy ? <LoaderCircle size={15} className="animate-spin" /> : <Link2 size={15} />}
            <span className="app-topbar-button-label">{busy ? "连接中" : "建立连接"}</span>
          </button>
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

      {tactical && <span className="library-toolbar-context"><i aria-hidden="true"/><span>素材库<small>ASSET LIBRARY</small></span></span>}

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
          className="toolbar-import-notice absolute right-4 top-[calc(100%+22px)] z-50 max-w-72 truncate rounded-full border border-lime/25 bg-panel px-3 py-2 text-xs text-lime shadow-panel hover:bg-panel2"
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
