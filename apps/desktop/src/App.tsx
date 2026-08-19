import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Toolbar } from "./components/Toolbar";
import { Sidebar } from "./components/Sidebar";
import { MasonryGrid } from "./components/MasonryGrid";
import { AssetDetail } from "./components/AssetDetail";
import { AssetContextMenu } from "./components/AssetContextMenu";
import { ProjectContextMenu } from "./components/ProjectContextMenu";
import { ImageAnnotator } from "./components/ImageAnnotator";
import { CaptionRing } from "./components/creation/CaptionRing";
import { DescribeProviderPicker } from "./components/DescribeProviderPicker";
import { BatchBar } from "./components/BatchBar";
import { CreationBoard } from "./components/CreationBoard";
import { GenerationPanel } from "./components/GenerationPanel";
import { CodexOnboarding } from "./components/CodexOnboarding";
import { ExtensionOnboarding } from "./components/ExtensionOnboarding";
import { DreaminaOnboarding } from "./components/DreaminaOnboarding";
import { AccountOnboarding } from "./components/AccountOnboarding";
import { OnboardingTour } from "./components/OnboardingTour";
import { ToastViewport } from "./components/ToastViewport";
import { useStore } from "./store";
import { api } from "./lib/api";
import { notifyError, notifySuccess } from "./lib/notify";
import type { AuthSnapshot, CodexChunk } from "./lib/types";

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
  const [initializing, setInitializing] = useState(true);
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
  const currentProjectId = useStore((s) => s.currentProjectId);
  const currentCollectionId = useStore((s) => s.currentCollectionId);
  const searchQuery = useStore((s) => s.searchQuery);
  const smartFilter = useStore((s) => s.smartFilter);
  const mode = useStore((s) => s.mode);
  const detailAssetId = useStore((s) => s.detailAssetId);
  const boardOpen = useStore((s) => s.boardOpen);
  const genEditing = useStore((s) => s.genEditing);
  // 「隐藏项目素材」等设置在后端命令层生效；订阅 settings 让设置变化后重拉瀑布流。
  const settings = useStore((s) => s.settings);
  const genPanelOpen = useStore((s) => s.genPanelOpen);
  const setCodexHealth = useStore((s) => s.setCodexHealth);
  const setDreaminaHealth = useStore((s) => s.setDreaminaHealth);
  const setExtensionConnected = useStore((s) => s.setExtensionConnected);
  const setCollectedNotice = useStore((s) => s.setCollectedNotice);
  const loadSettings = useStore((s) => s.loadSettings);
  const loadCloudAccount = useStore((s) => s.loadCloudAccount);
  const setCloudAuth = useStore((s) => s.setCloudAuth);
  const setCloudError = useStore((s) => s.setCloudError);

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
    // 创作板 / 会话底部编辑坞（重新编辑、底部对话框续轮）共用挑图语义：默认显示全部资产
    // （含未反推），任意图点一下即可插为参考图；promptedAssets 给编辑器补 caption/sections ——
    // 有反推的图可展开维度片段，没反推的作纯参考图。创作板常驻后为不吞掉库的浏览能力，
    // 用户显式筛选（搜索 / 文件夹 / 收藏 / 颜色 / 智能）仍生效，筛出的结果照样可点插 chip。
    const pickAll = (boardOpen || genEditing) && !searchQuery && !currentFolderId && !currentCollectionId && !colorFilter && !smartFilter;
    try {
      const [assets, total] = await Promise.all([
        pickAll
          ? api.listAssets(undefined, currentProjectId)
          : searchQuery
            ? api.searchAssets(searchQuery, currentProjectId)
            : smartFilter
              ? api.listAssetsSmart(smartFilter, currentProjectId)
              : currentCollectionId
                ? api.listAssetsByCollection(currentCollectionId, currentProjectId)
                : colorFilter
                  ? api.listAssetsByColor(
                      colorFilter,
                      currentFolderId ?? undefined,
                      currentProjectId
                    )
                  : api.listAssets(currentFolderId ?? undefined, currentProjectId),
        api.countAssets(currentProjectId),
      ]);
      if (version !== refreshVersion) return;
      setAssets(assets);
      setTotal(total);
      // promptedAssets 无条件拉取：对话框常驻（未激活也可能有草稿 chip），序列化/维度环
      // 随时要 caption/sections，不能只在创作模式激活时才有。
      const prompted = await api.listPromptedAssets(currentProjectId);
      if (version !== refreshVersion) return;
      setPromptedAssets(prompted);
      await reloadFolders();
      if (version !== refreshVersion) return;
      await reloadProjects();
      if (version !== refreshVersion) return;
      await reloadAutoTags();
      if (version !== refreshVersion) return;
      await reloadPalette();
      if (version !== refreshVersion) return;
      await reloadPresets();
    } catch (e) {
      if (version === refreshVersion) {
        console.error("refresh failed", e);
        notifyError(e, "素材库加载失败");
      }
    } finally {
      if (version === refreshVersion) setInitializing(false);
    }
  }

  useEffect(() => {
    refresh();
    // 依赖 currentFolderId / searchQuery / boardOpen / genEditing / settings：切换文件夹、搜索、
    // 开关创作板/进入会话编辑、或改了影响列表的设置（如隐藏项目素材）时重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId, currentFolderId, currentCollectionId, searchQuery, smartFilter, colorFilter, boardOpen, genEditing, settings]);

  // 有反推的资产 id 集合（project 级，缩略图标 🏷️ 用）：只随项目切换重拉，切 folder/filter 不重拉。
  useEffect(() => {
    api
      .listCaptionedAssetIds(currentProjectId)
      .then(setCaptionedIds)
      .catch((e) => console.error("load captionedIds failed", e));
  }, [currentProjectId, setCaptionedIds]);

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
  }, [currentProjectId, currentFolderId, currentCollectionId, searchQuery, smartFilter, colorFilter, boardOpen, setCollectedNotice]);

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
    listen<{ asset_id: string; kind: string }>("analyses://changed", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        const st = useStore.getState();
        try {
          // caption（反推）变化 → 🏷️ 标记集合刷新（轻量，始终拉）。
          setCaptionedIds(await api.listCaptionedAssetIds(st.currentProjectId));
          // 创作板与会话编辑坞同款对待（二者挑图/维度数据同源）：任一开着都刷新
          // promptedAssets，编辑坞期间新反推的维度也能进编辑器 assetById 供展开。
          if (st.boardOpen || st.genEditing) {
            setPromptedAssets(await api.listPromptedAssets(st.currentProjectId));
          }
        } catch (e) {
          console.error("refresh after analyses changed failed", e);
        }
      }, 300);
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
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

  // 首启空库 → 起 tour（阶段 B，替代自动注入；startTour 进 step 0 入口弹窗）。
  // 「环境状态」总览已并入设置面板，不再有弹出的环境 dialog，直接起。
  useEffect(() => {
    if (localStorage.getItem("bowerbird.tutorialSeen") === "1") return;
    const t = setTimeout(() => {
      const s = useStore.getState();
      if (s.assets.length !== 0) return;
      s.startTour();
    }, 1500);
    return () => clearTimeout(t);
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

  // 启动恢复（Task 5）：挂载拉本地未完成生成 job 重建 genJobs（恢复中 job 在面板可见）。
  // 必须在 codex://chunk listener 注册之后（listener 先就绪，后端 recover_started 早到也不丢）。
  useEffect(() => {
    void useStore.getState().loadGenJobs();
  }, []);

  // 全局粘贴入库（Ctrl+V）：截图后直接粘贴图片进当前项目 scope（source=clipboard）。
  // 焦点在 input/textarea/contenteditable（搜索框/创作板 ProseMirror）时不拦截，让正常文本/图片粘贴。
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
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
      const projectId = useStore.getState().currentProjectId;
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

  return (
    <div className="app-shell flex h-full w-full flex-col">
      <ToastViewport />
      {/* 环境引导：codex/扩展/即梦由设置面板对应分区直接唤起，不再有「环境状态」总览 */}
      <CodexOnboarding />
      <ExtensionOnboarding />
      <DreaminaOnboarding />
      <AccountOnboarding />
      {/* 新手引导 tour（阶段 B）：spotlight 分步引导，替代首启自动注入 */}
      <OnboardingTour />
      {/* 图片右键菜单（全局单实例，store.contextMenu 驱动） */}
      <AssetContextMenu />
      {/* 项目右键菜单（全局单实例，store.projectContextMenu 驱动） */}
      <ProjectContextMenu />
      {/* 图片标注面板（全局单实例，store.annotator 驱动，全屏遮罩） */}
      <ImageAnnotator />
      {/* 反推引擎选择浮层（全局单实例，store.describePicker 驱动） */}
      <DescribeProviderPicker />
      {/* 维度环形菜单（全局单实例，store.captionRing 驱动，长按图片呼出） */}
      <CaptionRing />
      <Toolbar onRefresh={refresh} />
      <div className="app-shell-hatch" aria-hidden="true"><span /></div>
      <div className="relative flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="app-workspace flex flex-1 flex-col overflow-hidden bg-canvas">
          {mode === "manage" && <BatchBar />}
          <div className="relative flex-1 overflow-hidden">
            {initializing ? <LibraryLoadingState /> : showDetail ? <AssetDetail /> : <MasonryGrid />}
            {/* 生成结果面板：主区覆盖层（像详情页） */}
            {genPanelOpen && <GenerationPanel />}
            {/* 创作板（核心枢纽）：底部浮动对话框常驻显示（激活与否都在），但与两个
                详情界面互斥——图片详情 / 会话详情（genPanelOpen）期间不出现（详情页经
                右键「添加到对话框」回主界面插 chip；会话界面用自带的继续对话/重新编辑坞）。
                会话编辑坞（genEditing）期间也让位（两个 useCreationEditor 互斥）。 */}
            {!genEditing && !showDetail && !genPanelOpen && <CreationBoard />}
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
        </main>
      </div>
    </div>
  );
}

export default App;
