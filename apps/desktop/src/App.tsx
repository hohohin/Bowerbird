import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Toolbar } from "./components/Toolbar";
import { Sidebar } from "./components/Sidebar";
import { MasonryGrid } from "./components/MasonryGrid";
import { AssetDetail } from "./components/AssetDetail";
import { BatchBar } from "./components/BatchBar";
import { CreationBoard } from "./components/CreationBoard";
import { GenerationPanel } from "./components/GenerationPanel";
import { CodexOnboarding } from "./components/CodexOnboarding";
import { useStore } from "./store";
import { api } from "./lib/api";
import type { CodexChunk } from "./lib/types";

function App() {
  const setAssets = useStore((s) => s.setAssets);
  const setTotal = useStore((s) => s.setTotal);
  const setPromptedAssets = useStore((s) => s.setPromptedAssets);
  const reloadFolders = useStore((s) => s.reloadFolders);
  const reloadAutoTags = useStore((s) => s.reloadAutoTags);
  const colorFilter = useStore((s) => s.colorFilter);
  const reloadPalette = useStore((s) => s.reloadPalette);
  const setClassifyProgress = useStore((s) => s.setClassifyProgress);
  const setAutoAnalyzing = useStore((s) => s.setAutoAnalyzing);
  const currentFolderId = useStore((s) => s.currentFolderId);
  const currentCollectionId = useStore((s) => s.currentCollectionId);
  const searchQuery = useStore((s) => s.searchQuery);
  const smartFilter = useStore((s) => s.smartFilter);
  const mode = useStore((s) => s.mode);
  const detailAssetId = useStore((s) => s.detailAssetId);
  const boardOpen = useStore((s) => s.boardOpen);
  const genPanelOpen = useStore((s) => s.genPanelOpen);
  const setCodexHealth = useStore((s) => s.setCodexHealth);

  async function refresh() {
    try {
      if (boardOpen) {
        // 创作板模式：瀑布流只显示有 caption（反推）的资产，它们即可作为槽的参考图
        const prompted = await api.listPromptedAssets();
        setPromptedAssets(prompted);
        setAssets(prompted);
        setTotal(await api.countAssets());
      } else {
        const [assets, total] = await Promise.all([
          searchQuery
            ? api.searchAssets(searchQuery)
            : smartFilter
              ? api.listAssetsSmart(smartFilter)
              : currentCollectionId
                ? api.listAssetsByCollection(currentCollectionId)
                : colorFilter
                  ? api.listAssetsByColor(colorFilter, currentFolderId ?? undefined)
                  : api.listAssets(currentFolderId ?? undefined),
          api.countAssets(),
        ]);
        setAssets(assets);
        setTotal(total);
      }
      await reloadFolders();
      await reloadAutoTags();
      await reloadPalette();
    } catch (e) {
      console.error("refresh failed", e);
    }
  }

  useEffect(() => {
    refresh();
    // 依赖 currentFolderId / searchQuery / boardOpen：切换文件夹、搜索或开关创作板时重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFolderId, currentCollectionId, searchQuery, smartFilter, colorFilter, boardOpen]);

  // 浏览器扩展采集入库后后端 emit `library://assets-changed`，
  // 去抖合并（扩展批量采集会连发多条 WS 消息）后刷新。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    listen("library://assets-changed", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => refresh(), 300);
    }).then((u) => (unlisten = u));
    return () => {
      unlisten?.();
      if (timer) clearTimeout(timer);
    };
    // boardOpen 进依赖：保证刷新闭包看到最新 boardOpen（创作板模式下取 prompted 集合）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFolderId, currentCollectionId, searchQuery, smartFilter, colorFilter, boardOpen]);

  // 反推后台化后，触发反推的组件可能早已卸载；后端 emit `analyses://changed`
  // 通知数据落地。仅创作板模式需要刷新 promptedAssets（浏览瀑布流只显缩略图，
  // 详情页各自监听本图事件自刷新）。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    listen<{ asset_id: string; kind: string }>("analyses://changed", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        if (!useStore.getState().boardOpen) return;
        try {
          setPromptedAssets(await api.listPromptedAssets());
        } catch (e) {
          console.error("refresh promptedAssets failed", e);
        }
      }, 300);
    }).then((u) => (unlisten = u));
    return () => {
      unlisten?.();
      if (timer) clearTimeout(timer);
    };
  }, [setPromptedAssets]);

  // 批量重归类进度（P2）：classify://progress {done,total,ended?}；ended 时清空。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<{ done: number; total: number; ended?: boolean }>(
      "classify://progress",
      (e) => {
        setClassifyProgress(
          e.payload.ended ? null : { done: e.payload.done, total: e.payload.total }
        );
      }
    ).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, [setClassifyProgress]);

  // 导入即基础分析在途计数（autoname 后台跑，fire-and-forget 否则前端无感）：
  // 后端拿到信号量 +1 / 释放 -1 时 emit `codex://auto-active`，>0 顶部状态圈算分析中。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<number>("codex://auto-active", (e) => setAutoAnalyzing(e.payload)).then(
      (u) => (unlisten = u)
    );
    return () => unlisten?.();
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

  const showDetail = mode === "browse" && detailAssetId !== null;

  return (
    <div className="flex h-full w-full flex-col">
      {/* codex 首启引导：未装/未登录时全屏遮罩（组件自管可见性，已就绪或已看过则返回 null） */}
      <CodexOnboarding />
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
