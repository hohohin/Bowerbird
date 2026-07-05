import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Toolbar } from "./components/Toolbar";
import { Sidebar } from "./components/Sidebar";
import { MasonryGrid } from "./components/MasonryGrid";
import { AssetDetail } from "./components/AssetDetail";
import { BatchBar } from "./components/BatchBar";
import { useStore } from "./store";
import { api } from "./lib/api";

function App() {
  const setAssets = useStore((s) => s.setAssets);
  const setTotal = useStore((s) => s.setTotal);
  const reloadFolders = useStore((s) => s.reloadFolders);
  const currentFolderId = useStore((s) => s.currentFolderId);
  const searchQuery = useStore((s) => s.searchQuery);
  const mode = useStore((s) => s.mode);
  const detailAssetId = useStore((s) => s.detailAssetId);

  async function refresh() {
    try {
      const [assets, total] = await Promise.all([
        searchQuery
          ? api.searchAssets(searchQuery)
          : api.listAssets(currentFolderId ?? undefined),
        api.countAssets(),
      ]);
      setAssets(assets);
      setTotal(total);
      await reloadFolders();
    } catch (e) {
      console.error("refresh failed", e);
    }
  }

  useEffect(() => {
    refresh();
    // 依赖 currentFolderId / searchQuery：切换文件夹或搜索框时重新拉取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFolderId, searchQuery]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFolderId, searchQuery]);

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
      </div>
    </div>
  );
}

export default App;
