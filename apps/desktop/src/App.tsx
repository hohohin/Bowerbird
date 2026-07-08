import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Toolbar } from "./components/Toolbar";
import { Sidebar } from "./components/Sidebar";
import { MasonryGrid } from "./components/MasonryGrid";
import { AssetDetail } from "./components/AssetDetail";
import { BatchBar } from "./components/BatchBar";
import { CreationBoard } from "./components/CreationBoard";
import { useStore } from "./store";
import { api } from "./lib/api";

function App() {
  const setAssets = useStore((s) => s.setAssets);
  const setTotal = useStore((s) => s.setTotal);
  const setPromptedAssets = useStore((s) => s.setPromptedAssets);
  const reloadFolders = useStore((s) => s.reloadFolders);
  const currentFolderId = useStore((s) => s.currentFolderId);
  const searchQuery = useStore((s) => s.searchQuery);
  const smartFilter = useStore((s) => s.smartFilter);
  const mode = useStore((s) => s.mode);
  const detailAssetId = useStore((s) => s.detailAssetId);
  const boardOpen = useStore((s) => s.boardOpen);

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
              : api.listAssets(currentFolderId ?? undefined),
          api.countAssets(),
        ]);
        setAssets(assets);
        setTotal(total);
      }
      await reloadFolders();
    } catch (e) {
      console.error("refresh failed", e);
    }
  }

  useEffect(() => {
    refresh();
    // 依赖 currentFolderId / searchQuery / boardOpen：切换文件夹、搜索或开关创作板时重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFolderId, searchQuery, smartFilter, boardOpen]);

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
  }, [currentFolderId, searchQuery, smartFilter, boardOpen]);

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

  const showDetail = mode === "browse" && detailAssetId !== null;

  return (
    <div className="flex h-full w-full flex-col">
      <Toolbar onRefresh={refresh} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex flex-1 flex-col overflow-hidden bg-canvas">
          {mode === "manage" && <BatchBar />}
          <div className="flex-1 overflow-hidden">
            {showDetail ? <AssetDetail /> : <MasonryGrid />}
          </div>
        </main>
        {/* 创作板（核心枢纽）：Toolbar「🎬 创作板」按钮唤起，右侧常驻 */}
        {boardOpen && <CreationBoard />}
      </div>
    </div>
  );
}

export default App;
