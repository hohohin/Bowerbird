import React from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "../../../src/components/Sidebar";
import { LibraryHome } from "../../../src/components/LibraryHome";
import { CollectionAddMode } from "../../../src/components/CollectionAddMode";
import { ToastViewport } from "../../../src/components/ToastViewport";
import { VisualProfileDialog } from "../../../src/components/VisualProfileDialog";
import { useStore } from "../../../src/store";
import "../../../src/styles.css";

const w = window as any;
const picture = (color: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="240" height="180" fill="${color}"/></svg>`)}`;
const asset = (id: string, name: string, color: string) => ({ id, name, width: 240, height: 180,
  thumb_path: picture(color), store_path: picture(color), source: "imported", ext: "svg" });
const homeAssets = Array.from({ length: 40 }, (_, i) => asset(`home-${i}`, `首页素材 ${i}`, "#8797b5"));
const folderAssets = [asset("one", "集合素材一", "#77874b"), asset("two", "集合素材二", "#c6a576")];
const addedAssets = new Map<string, any[]>();
const importedAssets = new Map<string, any>();
const callbacks = new Map();
let callbackId = 0;
w.failure = true;
w.calls = [];
w.__TAURI_INTERNALS__ = {
  transformCallback: (callback: any) => { callbacks.set(++callbackId, callback); return callbackId; },
  convertFileSrc: (path: string) => path,
  invoke: async (command: string, args: any) => {
    w.calls.push({ command, args });
    if (command === "plugin:event|listen") return args.handler;
    if (command === "list_library_view") {
      if (args.filter.folderId === "failure" && w.failure) throw "合成加载失败";
      if (args.filter.folderId === "slow") await new Promise((resolve) => setTimeout(resolve, 300));
      return { assets: addedAssets.get(args.filter.folderId)
        ?? (args.filter.folderId === "empty" ? [] : args.filter.folderId === "overflow" ? homeAssets : folderAssets), memberships: [], total: 40 };
    }
    if (command === "move_assets_to_folder") {
      if (args.assetIds.some((id: string) => importedAssets.has(id))) {
        if (w.failImportLink) throw "合成归入集合失败";
        const current = addedAssets.get(args.folderId) ?? (args.folderId === "empty" ? [] : folderAssets);
        addedAssets.set(args.folderId, [...current, ...args.assetIds.map((id: string) => importedAssets.get(id))]);
        return null;
      }
      if (w.failAdd) throw "合成添加失败";
      if (w.holdAdd) await new Promise((resolve) => { w.releaseAdd = resolve; });
      addedAssets.set(args.folderId, [...folderAssets, ...homeAssets.filter((asset) => args.assetIds.includes(asset.id))]);
      return null;
    }
    if (command === "import_image_bytes") {
      if (args.fileName === "invalid.txt") throw "不支持的图片格式";
      if (w.holdImport) await new Promise((resolve) => { w.releaseImport = resolve; });
      const value = asset(`import-${args.fileName}`, args.fileName, "#a89aba");
      importedAssets.set(value.id, value);
      return value;
    }
    if (command === "list_generation_groups") return {};
    if (command === "visual_profile_list") return [];
    if (command === "visual_profile_preview") return { folderId: args.folderId, folderName: "设计参考", assetIds: ["one", "two"],
      inFolder: 2, effective: 0, minRequired: 1, missing: [] };
    if (command === "get_assets_by_ids") return folderAssets;
    return null;
  },
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event: string, id: number) => callbacks.delete(id) };
w.refreshCollection = () => callbacks.forEach((callback: any) => callback({ event: "library://assets-changed", payload: {} }));
localStorage.setItem("bowerbird.sidebarCollapsed", "0");
useStore.setState({ folders: [
  { id: "one", name: "设计参考", kind: "folder" }, { id: "empty", name: "空集合", kind: "folder" },
  { id: "failure", name: "重试集合", kind: "folder" }, { id: "slow", name: "慢速集合", kind: "folder" },
  { id: "overflow", name: "滚动集合", kind: "folder" },
] as any, assets: homeAssets as any, total: homeAssets.length, projects: [], activeProjectId: null,
  currentFolderId: null, searchQuery: "保留搜索", selectedIds: new Set(["home-1"]),
  boardOpen: false, settings: {} as any });
w.fixtureStore = useStore;
function Preview() {
  const adding = useStore((s) => s.collectionAddTargetId);
  return <div className="app-shell flex h-screen">
    <Sidebar /><main className="relative min-w-0 flex flex-1 flex-col overflow-hidden">
      <div id="home" className={`min-h-0 flex-1 overflow-y-auto ${adding ? "collection-add-workspace" : ""}`}><LibraryHome /></div>
      <CollectionAddMode />
    </main><ToastViewport /><VisualProfileDialog />
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
