import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Toolbar } from "./components/Toolbar";
import { Sidebar } from "./components/Sidebar";
import { LibraryHome } from "./components/LibraryHome";
import { CanvasWorkspace } from "./components/CanvasWorkspace";
import { AssetDetail } from "./components/AssetDetail";
import { AssetContextMenu } from "./components/AssetContextMenu";
import { ProjectContextMenu } from "./components/ProjectContextMenu";
import { VisualProfileDialog } from "./components/VisualProfileDialog";
import { ImageAnnotator } from "./components/ImageAnnotator";
import { CaptionRing } from "./components/creation/CaptionRing";
import { DescribeProviderPicker } from "./components/DescribeProviderPicker";
import { BatchBar } from "./components/BatchBar";
import { CollectionAddMode } from "./components/CollectionAddMode";
import { AGENT_DS_DONE_EVENT } from "./components/CreationBoard";
import { APPEND_TEXT_EVENT } from "./components/creation/useCreationEditor";
import { GenerationPanel } from "./components/GenerationPanel";
import { CloudAgentSession } from "./components/CloudAgentPanel";
import { CloudAgentRuntimeCoordinator } from "./components/CloudAgentRuntimeCoordinator";
import { LEGACY_CREATIVE_SESSION_FALLBACK_ENABLED } from "./lib/featureFlags";
import { ExploreWorkspace } from "./components/ExploreWorkspace";
import { EXPLORER_SITES } from "./lib/explorer";
import { CodexOnboarding } from "./components/CodexOnboarding";
import { ExtensionOnboarding } from "./components/ExtensionOnboarding";
import { DreaminaOnboarding } from "./components/DreaminaOnboarding";
import { AccountOnboarding } from "./components/AccountOnboarding";
import { useOnboarding } from "./lib/onboardingStore";
import { OnboardingTour } from "./components/OnboardingTour";
import { ToastViewport } from "./components/ToastViewport";
import { FileDropImport } from "./components/FileDropImport";
import { prepareGenerationSound } from "./lib/generationNotifications";
import { useStore } from "./store";
import { api } from "./lib/api";
import { notify, notifyError, notifySuccess } from "./lib/notify";
import {
  creativeLaunchAssetIds,
  creativeLaunchTargetsProject,
  type CreativeLaunchRequest,
} from "./lib/creativeLaunch";
import { resolveProjectInspectorPlacement } from "./lib/projectInspector";
import {
  isWorkspaceOperationCurrent,
  resolveWorkspaceProjectId,
  shouldDiscardCreativeTarget,
} from "./lib/workspaceRoute";
import type { AuthSnapshot, CodexChunk, JimengOrphanTask } from "./lib/types";

let refreshVersion = 0;

function LibraryLoadingState() {
  return (
    <div className="library-loading" role="status" aria-label="正在加载素材库">
      <div className="library-loading-grid" aria-hidden="true">
        {Array.from({ length: 12 }, (_, index) => <span key={index} />)}
      </div>
      <span className="sr-only">正在加载素材库</span>
    </div>
  );
}

function App() {
  useEffect(prepareGenerationSound, []);
  const [initializing, setInitializing] = useState(true);
  const [creativeLaunch, setCreativeLaunch] = useState<CreativeLaunchRequest | null>(null);
  const [creativeTarget, setCreativeTarget] = useState<{
    projectId: string;
    threadId: string | null;
    nodeId: string | null;
    requestId: string;
  } | null>(null);
  const [sourceBrowserUrl, setSourceBrowserUrl] = useState<string | null>(null);
  const [sourceBrowserOpen, setSourceBrowserOpen] = useState(false);
  const [sourceBrowserNavigation, setSourceBrowserNavigation] = useState(0);
  const setAssets = useStore((s) => s.setAssets);
  const setTotal = useStore((s) => s.setTotal);
  const setPromptedAssets = useStore((s) => s.setPromptedAssets);
  const setCaptionedIds = useStore((s) => s.setCaptionedIds);
  const reloadFolders = useStore((s) => s.reloadFolders);
  const reloadProjects = useStore((s) => s.reloadProjects);
  const reloadAutoTags = useStore((s) => s.reloadAutoTags);
  const colorFilter = useStore((s) => s.colorFilter);
  const reloadPalette = useStore((s) => s.reloadPalette);
  const reloadPresets = useStore((s) => s.reloadPresets);
  const setClassifyProgress = useStore((s) => s.setClassifyProgress);
  const setColorRebuild = useStore((s) => s.setColorRebuild);
  const setAutoAnalyzing = useStore((s) => s.setAutoAnalyzing);
  const currentFolderId = useStore((s) => s.currentFolderId);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const projectRoutePending = useStore((s) => s.projectRoutePending);
  const projectRouteRevision = useStore((s) => s.projectRouteRevision);
  const projects = useStore((s) => s.projects);
  const currentCollectionId = useStore((s) => s.currentCollectionId);
  const searchQuery = useStore((s) => s.searchQuery);
  const smartFilter = useStore((s) => s.smartFilter);
  const mode = useStore((s) => s.mode);
  const collectionAddTargetId = useStore((s) => s.collectionAddTargetId);
  const detailAssetId = useStore((s) => s.detailAssetId);
  const boardOpen = useStore((s) => s.boardOpen);
  const genEditing = useStore((s) => s.genEditing);
  // 「隐藏项目素材」等设置在后端命令层生效；订阅 settings 让设置变化后重拉瀑布流。
  const settings = useStore((s) => s.settings);
  const genPanelOpen = useStore((s) => s.genPanelOpen);
  const activeSessionKind = useStore((s) => s.activeSessionKind);
  const genJobs = useStore((s) => s.genJobs);
  const activeJobId = useStore((s) => s.activeJobId);
  const cloudAgentRuns = useStore((s) => s.cloudAgentRuns);
  const activeCloudAgentRunId = useStore((s) => s.activeCloudAgentRunId);
  const setCodexHealth = useStore((s) => s.setCodexHealth);
  const setDreaminaHealth = useStore((s) => s.setDreaminaHealth);
  const setExtensionConnected = useStore((s) => s.setExtensionConnected);
  const setCollectedNotice = useStore((s) => s.setCollectedNotice);
  const loadSettings = useStore((s) => s.loadSettings);
  const loadCloudAccount = useStore((s) => s.loadCloudAccount);
  const setCloudAuth = useStore((s) => s.setCloudAuth);
  const setCloudError = useStore((s) => s.setCloudError);
  const creativeNavigation = useStore((s) => s.creativeNavigation);
  const clearCreativeNavigation = useStore((s) => s.clearCreativeNavigation);
  const pendingCreativeReuse = useStore((s) => s.pendingCreativeReuse);
  const ackPendingCreativeReuse = useStore((s) => s.ackPendingCreativeReuse);
  const cancelPendingCreativeReuse = useStore((s) => s.cancelPendingCreativeReuse);
  const activeProjectIsProvisional = projects.find((project) => project.id === activeProjectId)?.provisional === true;
  const workspaceProjectId = resolveWorkspaceProjectId(activeProjectId, projects);
  const projectWorkspaceActive = workspaceProjectId !== null;
  const activeInspectorExecution = activeSessionKind === "generation"
    ? (activeJobId ? genJobs[activeJobId] ?? null : null)
    : (activeCloudAgentRunId ? cloudAgentRuns[activeCloudAgentRunId] ?? null : null);
  const legacyInspectorOpen = LEGACY_CREATIVE_SESSION_FALLBACK_ENABLED
    && resolveProjectInspectorPlacement({
      open: genPanelOpen,
      loading: initializing,
      navigationPending: creativeNavigation != null || projectRoutePending,
      activeProjectId: workspaceProjectId,
      execution: activeInspectorExecution,
    }) === "legacy";

  useEffect(() => {
    if (!creativeNavigation) return;
    let cancelled = false;
    const target = creativeNavigation;
    const requestId = crypto.randomUUID();
    setCreativeLaunch(null);
    setCreativeTarget({ ...target, requestId });
    void useStore.getState().enterProject(target.projectId).then(() => {
      if (cancelled) return;
      const state = useStore.getState();
      if (state.activeProjectId !== target.projectId) return;
      state.setFocusedThreadId(target.threadId);
      if (target.threadId) {
        state.setProjectTimelineScope("focused");
        state.clearProjectThreadUnread(target.projectId, target.threadId);
      }
    }).catch((error) => {
      if (cancelled || useStore.getState().creativeNavigation !== target) return;
      console.error("creative task navigation failed", error);
      notifyError(error, "无法打开任务所属项目");
      setCreativeTarget((current) => current?.requestId === requestId ? null : current);
      useStore.getState().setGenPanelOpen(false);
    }).finally(() => {
      if (useStore.getState().creativeNavigation === target) clearCreativeNavigation();
    });
    return () => {
      cancelled = true;
    };
  }, [creativeNavigation, clearCreativeNavigation]);

  useEffect(() => {
    if (!pendingCreativeReuse) return;
    let cancelled = false;
    const request = pendingCreativeReuse;
    void (async () => {
      try {
        let targetProjectId = request.targetProjectId;
        const state = useStore.getState();
        if (targetProjectId) {
          await state.enterProject(targetProjectId);
        } else {
          targetProjectId = await state.beginProvisionalProject();
        }
        if (cancelled || useStore.getState().pendingCreativeReuse?.id !== request.id) return;
        const route = useStore.getState();
        if (!isWorkspaceOperationCurrent(
          targetProjectId,
          route.activeProjectId,
          route.projectRoutePending,
        )) {
          throw new Error("复用目标项目已变化");
        }
        setCreativeLaunch({
          id: request.id,
          projectId: targetProjectId,
          assetIds: [],
          promptLoad: request.promptLoad,
        });
        setCreativeTarget(null);
        if (route.mode === "manage") route.exitManage();
        ackPendingCreativeReuse(request.id);
      } catch (error) {
        if (cancelled || useStore.getState().pendingCreativeReuse?.id !== request.id) return;
        console.error("creative prompt reuse routing failed", error);
        cancelPendingCreativeReuse(request.id);
        notifyError(error, "无法打开复用提示词的创作项目");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingCreativeReuse, ackPendingCreativeReuse, cancelPendingCreativeReuse]);

  useEffect(() => {
    if (!shouldDiscardCreativeTarget(creativeTarget, activeProjectId, creativeNavigation)) return;
    const requestId = creativeTarget?.requestId;
    setCreativeTarget((current) => current?.requestId === requestId ? null : current);
  }, [activeProjectId, creativeNavigation, creativeTarget]);

  // 应用设置：App 挂载时加载一次。
  useEffect(() => {
    void loadSettings();
    void loadCloudAccount();
  }, [loadSettings, loadCloudAccount]);

  // 在线账号每 6 小时刷新一次权益；具体操作前 Rust 仍会对过期/无可信缓存再同步。
  useEffect(() => {
    const timer = window.setInterval(() => {
      const state = useStore.getState();
      if (state.cloudAuth?.logged_in) void state.syncCloudEntitlement();
    }, 6 * 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  // 每分钟静默对账：Fresh 时只是本地读（无网络）；降级态由 Rust 在线自愈并回写 store。
  // 修复：Pro 账号在重启/网络瞬断/超 6h 窗口后被显示成 free，需要手动刷新才恢复。
  useEffect(() => {
    const timer = window.setInterval(() => {
      void useStore.getState().reconcileCloudEntitlement();
    }, 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Auth callback 由 Rust deep-link/single-instance 处理，只把脱敏 snapshot/error 推给前端。
  useEffect(() => {
    let unlistenChanged: UnlistenFn | undefined;
    let unlistenError: UnlistenFn | undefined;
    let alive = true;
    listen<AuthSnapshot>("cloud://auth-changed", (e) => {
      setCloudAuth(e.payload);
      setCloudError(null);
      void useStore.getState().syncCloudEntitlement();
    }).then((u) => alive ? (unlistenChanged = u) : u());
    listen<string>("cloud://auth-error", (e) => setCloudError(e.payload)).then((u) =>
      alive ? (unlistenError = u) : u()
    );
    return () => {
      alive = false;
      unlistenChanged?.();
      unlistenError?.();
    };
  }, [setCloudAuth, setCloudError]);

  async function refresh() {
    const version = ++refreshVersion;
    const initial = useStore.getState();
    const expectedProjectId = initial.activeProjectId;
    const expectedRouteRevision = initial.projectRouteRevision;
    if (initial.projectRoutePending) return;
    const activeProject = initial.projects.find((project) => project.id === expectedProjectId);
    // provisional 项目还没有数据库成员，素材栏先展示中央库；第一次拖入时再连同项目/节点原子落库。
    const assetProjectId = activeProject?.provisional ? null : expectedProjectId;
    const isCurrentRefresh = () => {
      const current = useStore.getState();
      return version === refreshVersion && isWorkspaceOperationCurrent(
        expectedProjectId,
        current.activeProjectId,
        current.projectRoutePending,
        expectedRouteRevision,
        current.projectRouteRevision,
      );
    };
    // 创作板 / 会话底部编辑坞（重新编辑、底部对话框续轮）共用挑图语义：默认显示全部资产
    // （含未反推），任意图点一下即可插为参考图；promptedAssets 给编辑器补 caption/sections ——
    // 有反推的图可展开维度片段，没反推的作纯参考图。创作板常驻后为不吞掉库的浏览能力，
    // 用户显式筛选（搜索 / 文件夹 / 收藏 / 颜色 / 智能）仍生效，筛出的结果照样可点插 chip。
    const pickAll = (initial.boardOpen || initial.genEditing)
      && !initial.searchQuery
      && !initial.currentFolderId
      && !initial.currentCollectionId
      && !initial.colorFilter
      && !initial.smartFilter;
    try {
      if (!expectedProjectId) {
        const view = await api.listLibraryView({
          search: initial.searchQuery,
          smart: initial.smartFilter,
          folderId: initial.currentFolderId,
          collectionId: initial.currentCollectionId,
          color: initial.colorFilter,
        });
        if (!isCurrentRefresh()) return;
        useStore.setState({ assets: view.assets, total: view.total, libraryMemberships: view.memberships });
      } else {
        const [assets, total] = await Promise.all([
          pickAll
            ? api.listAssets(undefined, assetProjectId)
            : initial.searchQuery
              ? api.searchAssets(initial.searchQuery, assetProjectId)
              : initial.smartFilter
                ? api.listAssetsSmart(initial.smartFilter, assetProjectId)
                : initial.currentCollectionId
                  ? api.listAssetsByCollection(initial.currentCollectionId, assetProjectId)
                  : initial.colorFilter
                    ? api.listAssetsByColor(
                        initial.colorFilter,
                        initial.currentFolderId ?? undefined,
                        assetProjectId
                      )
                    : api.listAssets(initial.currentFolderId ?? undefined, assetProjectId),
          api.countAssets(assetProjectId),
        ]);
        if (!isCurrentRefresh()) return;
        setAssets(assets);
        setTotal(total);
      }
      // promptedAssets 无条件拉取：对话框常驻（未激活也可能有草稿 chip），序列化/维度环
      // 随时要 caption/sections，不能只在创作模式激活时才有。
      const prompted = await api.listPromptedAssets(assetProjectId);
      if (!isCurrentRefresh()) return;
      setPromptedAssets(prompted);
      await reloadFolders();
      if (!isCurrentRefresh()) return;
      await reloadProjects();
      if (!isCurrentRefresh()) return;
      await reloadAutoTags(expectedProjectId);
      if (!isCurrentRefresh()) return;
      await reloadPalette(expectedProjectId);
      if (!isCurrentRefresh()) return;
      await reloadPresets();
    } catch (e) {
      if (isCurrentRefresh()) {
        console.error("refresh failed", e);
        notifyError(e, "素材库加载失败");
      }
    } finally {
      if (isCurrentRefresh()) setInitializing(false);
    }
  }

  useEffect(() => {
    refresh();
    // 依赖 currentFolderId / searchQuery / boardOpen / genEditing / settings：切换文件夹、搜索、
    // 开关创作板/进入会话编辑、或改了影响列表的设置（如隐藏项目素材）时重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, activeProjectIsProvisional, projectRoutePending, projectRouteRevision, currentFolderId, currentCollectionId, searchQuery, smartFilter, colorFilter, boardOpen, genEditing, settings]);

  // 有反推的资产 id 集合（project 级，缩略图标 🏷️ 用）：只随项目切换重拉，切 folder/filter 不重拉。
  useEffect(() => {
    if (projectRoutePending) return;
    let alive = true;
    const expectedProjectId = activeProjectId;
    const expectedRouteRevision = projectRouteRevision;
    const assetProjectId = activeProjectIsProvisional ? null : activeProjectId;
    api
      .listCaptionedAssetIds(assetProjectId)
      .then((ids) => {
        const current = useStore.getState();
        if (alive && isWorkspaceOperationCurrent(
          expectedProjectId,
          current.activeProjectId,
          current.projectRoutePending,
          expectedRouteRevision,
          current.projectRouteRevision,
        )) setCaptionedIds(ids);
      })
      .catch((e) => {
        if (alive) console.error("load captionedIds failed", e);
      });
    return () => {
      alive = false;
    };
  }, [activeProjectId, activeProjectIsProvisional, projectRoutePending, projectRouteRevision, setCaptionedIds]);

  // 浏览器扩展采集入库后后端 emit `library://assets-changed`，
  // 去抖合并（扩展批量采集会连发多条 WS 消息）后刷新。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    listen<{ name?: string }>("library://assets-changed", (e) => {
      if (e.payload?.name) setCollectedNotice(e.payload.name);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => refresh(), 300);
    }).then((u) => {
      // StrictMode 双挂载：cleanup 先于 listen 完成时必须立刻注销，
      // 否则监听器带着首帧（全局 scope）refresh 闭包永久泄漏，
      // 后续 scope 切换也清不掉它的去抖定时器（见踩坑）。
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
      if (timer) clearTimeout(timer);
    };
    // boardOpen 进依赖：保证刷新闭包看到最新 boardOpen（创作板模式下取全量资产 + prompted 集合）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, currentFolderId, currentCollectionId, searchQuery, smartFilter, colorFilter, boardOpen, setCollectedNotice]);

  // 项目成员/列表变化：刷新侧栏项目计数；项目被删时 reloadProjects 会安全退回全局。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let alive = true;
    listen("projects://changed", () => {
      void reloadProjects();
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [reloadProjects]);

  // 用途（preset）CRUD 后后端 emit `presets://changed`，刷新创作板下拉。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let alive = true;
    listen("presets://changed", () => {
      void reloadPresets();
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [reloadPresets]);

  // 反推后台化后，触发反推的组件可能早已卸载；后端 emit `analyses://changed`
  // 通知数据落地。创作板模式刷新 promptedAssets；任何模式都刷新 captionedIds（瀑布流 🏷️ 标记）。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    let requestVersion = 0;
    listen<{ asset_id: string; kind: string }>("analyses://changed", () => {
      if (timer) clearTimeout(timer);
      const version = ++requestVersion;
      timer = setTimeout(async () => {
        const st = useStore.getState();
        if (st.projectRoutePending) return;
        const expectedProjectId = st.activeProjectId;
        const expectedRouteRevision = st.projectRouteRevision;
        const activeProject = st.projects.find((project) => project.id === expectedProjectId);
        const assetProjectId = activeProject?.provisional ? null : expectedProjectId;
        const isCurrentRead = () => {
          const current = useStore.getState();
          return alive
            && version === requestVersion
            && isWorkspaceOperationCurrent(
              expectedProjectId,
              current.activeProjectId,
              current.projectRoutePending,
              expectedRouteRevision,
              current.projectRouteRevision,
            );
        };
        try {
          // caption（反推）变化 → 🏷️ 标记集合刷新（轻量，始终拉）。
          const captionedIds = await api.listCaptionedAssetIds(assetProjectId);
          if (!isCurrentRead()) return;
          setCaptionedIds(captionedIds);
          // 创作板与会话编辑坞同款对待（二者挑图/维度数据同源）：任一开着都刷新
          // promptedAssets，编辑坞期间新反推的维度也能进编辑器 assetById 供展开。
          const current = useStore.getState();
          if (current.boardOpen || current.genEditing) {
            const promptedAssets = await api.listPromptedAssets(assetProjectId);
            if (!isCurrentRead()) return;
            setPromptedAssets(promptedAssets);
          }
        } catch (e) {
          if (isCurrentRead()) console.error("refresh after analyses changed failed", e);
        }
      }, 300);
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      requestVersion += 1;
      unlisten?.();
      if (timer) clearTimeout(timer);
    };
  }, [setPromptedAssets, setCaptionedIds]);

  // 批量重归类进度（P2）：classify://progress {done,total,ended?}；ended 时清空。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let alive = true;
    listen<{ done: number; total: number; ended?: boolean }>(
      "classify://progress",
      (e) => {
        setClassifyProgress(
          e.payload.ended ? null : { done: e.payload.done, total: e.payload.total }
        );
      }
    ).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [setClassifyProgress]);

  // Wait for actual library state; upgrades receive a separate introduction.
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      void Promise.all([api.countAssets(), api.listProjects()]).then(([count, projects]) => {
        if (!alive) return;
        const lesson = useOnboarding.getState();
        if (lesson.panel !== "closed" || lesson.progress.status !== "new" || lesson.progress.updateSeen) return;
        let legacySeen = false;
        try { legacySeen = localStorage.getItem("bowerbird.tutorialSeen") === "1"; } catch { /* optional legacy preference */ }
        lesson.show(legacySeen || count > 0 || projects.length > 0 ? "update" : "welcome");
      }).catch(() => { /* Settings still offers the lesson after a library read failure. */ });
    }, 1500);
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  // 重建色板进度（P3）：color://rebuild-progress {done,total,ended?}；ended 时清空。
  // 从 Toolbar 提到全局——设置面板开关不影响后台重建进度的跟踪。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let alive = true;
    listen<{ done: number; total: number; ended?: boolean }>(
      "color://rebuild-progress",
      (e) => {
        setColorRebuild(
          e.payload.ended ? null : { done: e.payload.done, total: e.payload.total }
        );
      }
    ).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [setColorRebuild]);

  // 导入即基础分析在途计数（autoname 后台跑，fire-and-forget 否则前端无感）：
  // 后端拿到信号量 +1 / 释放 -1 时 emit `codex://auto-active`，>0 顶部状态圈算分析中。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let alive = true;
    listen<number>("codex://auto-active", (e) => setAutoAnalyzing(e.payload)).then(
      (u) => {
        if (alive) unlisten = u;
        else u();
      }
    );
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [setAutoAnalyzing]);

  // 浏览器扩展加载后及之后每 15 秒向本地 WS 发 ping；后端收到后 emit collect://extension-connected。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen("collect://extension-connected", () => setExtensionConnected(true)).then(
      (u) => (unlisten = u)
    );
    return () => unlisten?.();
  }, [setExtensionConnected]);

  // 生成结果流式回显（创作板「发送」/ 生成面板「继续修改」触发）：
  // 生成 UI 独立成面板后，codex://chunk 监听挪到全局。App 单次挂载，但 StrictMode 双挂载下
  // 仍需 alive 守卫——否则同一 Done 被两个监听器各收一次 → 同一张图 append 两次（见踩坑）。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let alive = true;
    listen<CodexChunk>("codex://chunk", (e) => useStore.getState().applyGenChunk(e.payload)).then(
      (u) => {
        if (alive) unlisten = u;
        else u();
      }
    );
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // 即梦孤儿任务（约定 23 阶段 3）：启动 list_task 比对发现的远端在跑/未取回任务，
  // 进会话面板「生成」tab 顶部的取回入口。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let alive = true;
    listen<JimengOrphanTask[]>("codex://jimeng-orphans", (e) => {
      useStore.getState().setJimengOrphans(e.payload);
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // Agent Z / Agent DS（dev-only）回传：后端 watcher 转发 .agent-z/inbox 事件。无 kind =
  // Claude Code TUI 桥的纯文本回传 → 追加进创作板（原行为）；ds_reply = Agent DS 终答
  // （同追加）；ds_status = Agent DS 阶段通知（tool 进行中提示 / done、error 解除 busy）。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let alive = true;
    listen<{ text: string; kind?: string | null; phase?: string | null }>("agent-z://output", (e) => {
      const { text, kind, phase } = e.payload;
      if (kind === "ds_status") {
        if (phase === "done" || phase === "error") {
          if (phase === "error") notifyError(text, "Agent DS 本轮处理失败");
          window.dispatchEvent(new CustomEvent(AGENT_DS_DONE_EVENT));
        } else if (text) {
          notify(text, "info");
        }
        return;
      }
      window.dispatchEvent(new CustomEvent(APPEND_TEXT_EVENT, { detail: text }));
      notifySuccess(kind === "ds_reply" ? "Agent DS 回复已追加到创作板" : "Agent Z 输出已追加到创作板");
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // 启动恢复：先恢复普通生成 job，再恢复独立持久化的 Cloud Agent Run；若 Agent 正在
  // 等待用户或执行中，则复用同一会话详情主区并优先显示它。两者仍保持独立数据源。
  useEffect(() => {
    void (async () => {
      await useStore.getState().loadGenJobs();
      await useStore.getState().loadCloudAgentRuns();
    })();
  }, []);

  // 全局粘贴入库（Ctrl+V）：截图后直接粘贴图片进当前项目 scope（source=clipboard）。
  // 焦点在 input/textarea/contenteditable（搜索框/创作板 ProseMirror）时不拦截，让正常文本/图片粘贴。
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (e.defaultPrevented || useStore.getState().collectionPanelId) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      let imageFile: File | null = null;
      for (const it of items) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          imageFile = it.getAsFile();
          if (imageFile) break;
        }
      }
      if (!imageFile) return;
      const ae = document.activeElement;
      if (
        ae instanceof HTMLInputElement ||
        ae instanceof HTMLTextAreaElement ||
        (ae instanceof HTMLElement && ae.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      const file = imageFile;
      const projectId = useStore.getState().activeProjectId;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        api
          .importImageBytes({
            dataUrl,
            fileName: file.name || "clipboard.png",
            projectId,
            source: "clipboard",
          })
          .then(() => notifySuccess("剪贴板图片已加入素材库"))
          .catch((err) => {
            console.error("paste import failed", err);
            notifyError(err, "粘贴图片导入失败");
          });
      };
      reader.readAsDataURL(file);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  // codex 可用性：App 挂载取一次，创作板/生成面板共用（约定 7 置灰依据）。
  useEffect(() => {
    api
      .codexHealth()
      .then(setCodexHealth)
      .catch(() => setCodexHealth({ ok: false, reason: "codex 状态检测失败" }));
  }, [setCodexHealth]);

  // 安装/登录成功后端 emit `codex://health-changed` → 重取 codexHealth（创作板/生成面板置灰按钮
  // 据此刷新；AssetDetail 有独立 codexHealth 副本，自己监听自刷新）。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let alive = true;
    listen("codex://health-changed", () => {
      api.codexHealth().then(setCodexHealth).catch(() => {});
    }).then((u) => (alive ? (unlisten = u) : u()));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [setCodexHealth]);

  // 扩展连接状态：挂载取一次 + listen 连/断（心跳经 collect://extension-connected/disconnected）。
  useEffect(() => {
    api.extensionStatus().then(setExtensionConnected).catch(() => {});
    let unlistenConn: UnlistenFn | undefined;
    let unlistenDisc: UnlistenFn | undefined;
    let alive = true;
    listen("collect://extension-connected", () => setExtensionConnected(true)).then(
      (u) => (alive ? (unlistenConn = u) : u())
    );
    listen("collect://extension-disconnected", () => setExtensionConnected(false)).then(
      (u) => (alive ? (unlistenDisc = u) : u())
    );
    return () => {
      alive = false;
      unlistenConn?.();
      unlistenDisc?.();
    };
  }, [setExtensionConnected]);

  // 即梦可用性：同 codex，挂载取一次（吃后端 TTL 缓存；provider 切换置灰依据）。
  useEffect(() => {
    api
      .dreaminaHealth()
      .then(setDreaminaHealth)
      .catch(() => setDreaminaHealth({ ok: false, reason: "dreamina 状态检测失败" }));
  }, [setDreaminaHealth]);

  // dreamina 一键安装成功后端 emit `dreamina://health-changed` → 强制重取 dreaminaHealth
  // （provider 切换置灰依据 + DreaminaOnboarding 自动重检回一级）。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let alive = true;
    listen("dreamina://health-changed", () => {
      api.dreaminaHealth(true).then(setDreaminaHealth).catch(() => {});
    }).then((u) => (alive ? (unlisten = u) : u()));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [setDreaminaHealth]);

  // dreamina 登录（OAuth Device Flow）：dreamina_login 命令逐行透传 stdout 到 store，
  // DreaminaLoginDialog 读 dreaminaLoginLines 展示 verification_uri/user_code。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<string>("dreamina://login", (e) => {
      useStore.getState().pushDreaminaLoginLine(e.payload);
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  // 登录子进程结束 → 标记流程结束 + 强制刷 dreaminaHealth（登录态可能已变）。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen("dreamina://login-done", () => {
      useStore.getState().setDreaminaLoginActive(false);
      api.dreaminaHealth(true).then(setDreaminaHealth).catch(() => {});
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, [setDreaminaHealth]);

  const showDetail = mode === "browse" && detailAssetId !== null;

  const acknowledgeCreativeLaunch = useCallback((requestId: string) => {
    setCreativeLaunch((current) => current?.id === requestId ? null : current);
  }, []);

  const acknowledgeCreativeTarget = useCallback((requestId: string) => {
    setCreativeTarget((current) => current?.requestId === requestId ? null : current);
  }, []);

  async function createCreative(blank: boolean) {
    const state = useStore.getState();
    const assetIds = creativeLaunchAssetIds(blank, state.selectedIds);
    const createdProjectId = await state.beginProvisionalProject();
    const route = useStore.getState();
    if (!isWorkspaceOperationCurrent(
      createdProjectId,
      route.activeProjectId,
      route.projectRoutePending,
    )) return;
    setCreativeLaunch({ id: crypto.randomUUID(), projectId: createdProjectId, assetIds });
    setSourceBrowserOpen(false);
    setCreativeTarget(null);
    if (state.mode === "manage") state.exitManage();
  }

  function exitCreative() {
    setSourceBrowserOpen(false);
    setCreativeLaunch(null);
    setCreativeTarget(null);
    void useStore.getState().exitProject().catch((error) => {
      notifyError(error, "项目仍有未保存修改，已留在当前画板");
    });
  }

  return (
    <div className="app-shell flex h-full w-full flex-col">
      <CloudAgentRuntimeCoordinator />
      <ToastViewport />
      <FileDropImport />
      {/* 环境引导：codex/扩展/即梦由设置面板对应分区直接唤起，不再有「环境状态」总览 */}
      <CodexOnboarding />
      <ExtensionOnboarding />
      <DreaminaOnboarding />
      <AccountOnboarding />
      {/* 版本化入门引导，独立保存学习进度 */}
      <OnboardingTour />
      {/* 图片右键菜单（全局单实例，store.contextMenu 驱动） */}
      <AssetContextMenu />
      {/* 项目右键菜单（全局单实例，store.projectContextMenu 驱动） */}
      <ProjectContextMenu />
      <VisualProfileDialog />
      {/* 图片标注面板（全局单实例，store.annotator 驱动，全屏遮罩） */}
      <ImageAnnotator />
      {/* 反推引擎选择浮层（全局单实例，store.describePicker 驱动） */}
      <DescribeProviderPicker />
      {/* 维度环形菜单（全局单实例，store.captionRing 驱动，长按图片呼出） */}
      <CaptionRing />
      <Toolbar
        onRefresh={refresh}
        canvasMode={projectWorkspaceActive}
        onCanvasModeChange={(active) => active ? createCreative(false) : exitCreative()}
        onCreateCreative={createCreative}
        exploring={sourceBrowserOpen}
        onExplore={() => {
          if (!sourceBrowserUrl) {
            let lastUrl = EXPLORER_SITES[0].url as string;
            try { lastUrl = localStorage.getItem("bowerbird.explorer.lastUrl") || lastUrl; } catch { /* unavailable storage */ }
            setSourceBrowserUrl(lastUrl);
          }
          setSourceBrowserOpen(current => !current);
        }}
      />
      <div className="app-shell-hatch" aria-hidden="true"><span /></div>
      <div className="relative flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="app-workspace relative flex flex-1 flex-col overflow-hidden bg-canvas">
          <ExploreWorkspace url={sourceBrowserUrl} navigationId={sourceBrowserNavigation} open={sourceBrowserOpen && !collectionAddTargetId} onClose={() => setSourceBrowserOpen(false)}>
          {projectWorkspaceActive ? (
            initializing ? <LibraryLoadingState /> : (
              <CanvasWorkspace
                key={workspaceProjectId}
                projectId={workspaceProjectId}
                exploring={sourceBrowserOpen && !collectionAddTargetId}
                focusThreadId={creativeTarget?.projectId === workspaceProjectId ? creativeTarget.threadId : null}
                focusNodeId={creativeTarget?.projectId === workspaceProjectId ? creativeTarget.nodeId : null}
                focusRequestId={creativeTarget?.projectId === workspaceProjectId ? creativeTarget.requestId : null}
                onFocusConsumed={acknowledgeCreativeTarget}
                launchRequest={creativeLaunchTargetsProject(creativeLaunch, workspaceProjectId) ? creativeLaunch : null}
                onLaunchConsumed={acknowledgeCreativeLaunch}
                onExit={exitCreative}
              />
            )
          ) : (
            <>
              {mode === "manage" && !collectionAddTargetId && <BatchBar />}
              <div className={`relative flex-1 overflow-hidden ${collectionAddTargetId ? "collection-add-workspace" : ""}`}>
                {initializing ? (
                  <LibraryLoadingState />
                ) : showDetail ? (
                  <AssetDetail onExploreSource={url => { setSourceBrowserUrl(url); setSourceBrowserNavigation(id => id + 1); setSourceBrowserOpen(true); }} />
                ) : (
                  <LibraryHome />
                )}
                {/* 生成结果面板：主区覆盖层（像详情页） */}
                {!collectionAddTargetId && legacyInspectorOpen && activeSessionKind === "generation" && <GenerationPanel readOnly />}
                {!collectionAddTargetId && legacyInspectorOpen && activeSessionKind === "agent" && <CloudAgentSession readOnly />}
                {/* 创作模式视觉标记：瀑布流区品牌蓝线框 + 顶部居中刘海「创作模式」。
                    仅在挑图面（瀑布流）实际可见时呈现：被会话面板/详情页盖住时不显示。 */}
                {boardOpen && !genEditing && !genPanelOpen && !showDetail && (
                  <>
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 z-20 ring-2 ring-inset ring-[#4868ff] shadow-[inset_0_0_24px_rgba(72,104,255,0.18)]"
                    />
                    <div
                      aria-hidden="true"
                      className="creation-mode-notch pointer-events-none absolute left-1/2 top-0 z-20"
                    >
                      创作模式
                    </div>
                  </>
                )}
              </div>
            </>
          )}
          <CollectionAddMode />
          </ExploreWorkspace>
        </main>
      </div>
    </div>
  );
}

export default App;
