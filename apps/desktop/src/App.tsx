import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Toolbar } from "./components/Toolbar";
import { Sidebar } from "./components/Sidebar";
import { MasonryGrid } from "./components/MasonryGrid";
import { AssetDetail } from "./components/AssetDetail";
import { AssetContextMenu } from "./components/AssetContextMenu";
import { BatchBar } from "./components/BatchBar";
import { CreationBoard } from "./components/CreationBoard";
import { GenerationPanel } from "./components/GenerationPanel";
import { Onboarding } from "./components/Onboarding";
import { CodexOnboarding } from "./components/CodexOnboarding";
import { ExtensionOnboarding } from "./components/ExtensionOnboarding";
import { useStore } from "./store";
import { api } from "./lib/api";
import type { CodexChunk } from "./lib/types";

let refreshVersion = 0;

function App() {
  const setAssets = useStore((s) => s.setAssets);
  const setTotal = useStore((s) => s.setTotal);
  const setPromptedAssets = useStore((s) => s.setPromptedAssets);
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
  const genPanelOpen = useStore((s) => s.genPanelOpen);
  const setCodexHealth = useStore((s) => s.setCodexHealth);
  const setExtensionConnected = useStore((s) => s.setExtensionConnected);
  const loadSettings = useStore((s) => s.loadSettings);

  // 应用设置：App 挂载时加载一次。
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  async function refresh() {
    const version = ++refreshVersion;
    try {
      if (boardOpen) {
        // 创作板模式：瀑布流只显示有 caption（反推）的资产，它们即可作为槽的参考图
        const [prompted, total] = await Promise.all([
          api.listPromptedAssets(currentProjectId),
          api.countAssets(currentProjectId),
        ]);
        if (version !== refreshVersion) return;
        setPromptedAssets(prompted);
        setAssets(prompted);
        setTotal(total);
      } else {
        const [assets, total] = await Promise.all([
          searchQuery
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
      }
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
      if (version === refreshVersion) console.error("refresh failed", e);
    }
  }

  useEffect(() => {
    refresh();
    // 依赖 currentFolderId / searchQuery / boardOpen：切换文件夹、搜索或开关创作板时重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId, currentFolderId, currentCollectionId, searchQuery, smartFilter, colorFilter, boardOpen]);

  // 浏览器扩展采集入库后后端 emit `library://assets-changed`，
  // 去抖合并（扩展批量采集会连发多条 WS 消息）后刷新。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    listen("library://assets-changed", () => {
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
    // boardOpen 进依赖：保证刷新闭包看到最新 boardOpen（创作板模式下取 prompted 集合）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId, currentFolderId, currentCollectionId, searchQuery, smartFilter, colorFilter, boardOpen]);

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
  // 通知数据落地。仅创作板模式需要刷新 promptedAssets（浏览瀑布流只显缩略图，
  // 详情页各自监听本图事件自刷新）。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    listen<{ asset_id: string; kind: string }>("analyses://changed", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        if (!useStore.getState().boardOpen) return;
        try {
          setPromptedAssets(await api.listPromptedAssets(useStore.getState().currentProjectId));
        } catch (e) {
          console.error("refresh promptedAssets failed", e);
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
  }, [setPromptedAssets]);

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

  const showDetail = mode === "browse" && detailAssetId !== null;

  return (
    <div className="flex h-full w-full flex-col">
      {/* 统一「环境状态」总览：codex/扩展任一未就绪时首启自动弹（设置可手动唤起） */}
      <Onboarding />
      {/* 二级引导：点总览卡片「前往配置」唤起，不再各自自动弹 */}
      <CodexOnboarding />
      <ExtensionOnboarding />
      {/* 图片右键菜单（全局单实例，store.contextMenu 驱动） */}
      <AssetContextMenu />
      <Toolbar onRefresh={refresh} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex flex-1 flex-col overflow-hidden bg-canvas">
          {mode === "manage" && <BatchBar />}
          <div className="relative flex-1 overflow-hidden">
            {showDetail ? <AssetDetail /> : <MasonryGrid />}
            {/* 生成结果面板：主区覆盖层（像详情页），创作板在右槽始终可用 */}
            {genPanelOpen && <GenerationPanel />}
          </div>
        </main>
        {/* 创作板（核心枢纽）：Toolbar「🎬 创作板」按钮唤起，右侧常驻 */}
        {boardOpen && <CreationBoard />}
      </div>
    </div>
  );
}

export default App;
