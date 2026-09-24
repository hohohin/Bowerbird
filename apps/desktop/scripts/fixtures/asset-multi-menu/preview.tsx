import React from "react";
import { createRoot } from "react-dom/client";
import { LibraryHome } from "../../../src/components/LibraryHome";
import { AssetContextMenu } from "../../../src/components/AssetContextMenu";
import { DescribeProviderPicker } from "../../../src/components/DescribeProviderPicker";
import { ToastViewport } from "../../../src/components/ToastViewport";
import { useStore } from "../../../src/store";
import "../../../src/styles.css";

// 多选右键菜单合成夹具：全局素材库 manage 模式 + 3 张选中，验证批量菜单
// （集合 / 项目 / 批量反推 / 批量删除）与单选菜单的分流。invoke 全部合成，不落盘。
const w = window as any;
const picture = (color: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="240" height="180" fill="${color}"/></svg>`)}`;
const asset = (id: string, color: string) => ({ id, name: `素材 ${id}`, width: 240, height: 180,
  thumb_path: picture(color), store_path: picture(color), source: "imported", ext: "svg", origin_path: `C:/in/${id}.svg` });
const assets = [asset("a1", "#8797b5"), asset("a2", "#77874b"), asset("a3", "#c6a576"), asset("a4", "#a89aba")];
const callbacks = new Map();
let callbackId = 0;
w.calls = [];
w.deleted = [];
w.__TAURI_INTERNALS__ = {
  transformCallback: (callback: any) => { callbacks.set(++callbackId, callback); return callbackId; },
  convertFileSrc: (path: string) => path,
  invoke: async (command: string, args: any) => {
    w.calls.push({ command, args });
    if (command === "plugin:event|listen") return args.handler;
    if (command === "list_generation_groups") return {};
    if (command === "list_projects") return [
      { id: "p1", name: "画册项目", kind: "user" }, { id: "p2", name: "网站改版", kind: "user" }];
    if (command === "list_folders") return [
      { id: "root", name: "全部", kind: "folder" },
      { id: "f1", name: "设计参考", kind: "folder" },
      { id: "f2", name: "待整理", kind: "folder" },
      { id: "smart1", name: "PNG 图", kind: "smart" },
      { id: "c1", name: "收藏夹一", kind: "collection" }];
    if (command === "move_assets_to_folder") return null;
    if (command === "create_folder") return `new-${args.name}`;
    if (command === "add_assets_to_project") return args.assetIds.length;
    if (command === "remove_assets_from_project") return args.assetIds.length;
    if (command === "delete_asset_with_mode") {
      w.deleted.push(args);
      return { deleted_assets: 1, removed_members: 0, moved_files: 0, failed_moves: [] };
    }
    return null;
  },
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event: string, id: number) => callbacks.delete(id) };
localStorage.setItem("bowerbird.sidebarCollapsed", "0");
useStore.setState({
  folders: [
    { id: "root", name: "全部", kind: "folder" },
    { id: "f1", name: "设计参考", kind: "folder" },
    { id: "f2", name: "待整理", kind: "folder" },
    { id: "smart1", name: "PNG 图", kind: "smart" },
    { id: "c1", name: "收藏夹一", kind: "collection" },
  ] as any,
  assets: assets as any,
  total: assets.length,
  projects: [
    { id: "p1", name: "画册项目", kind: "user" } as any,
    { id: "p2", name: "网站改版", kind: "user" } as any,
  ],
  activeProjectId: null,
  currentFolderId: null,
  libraryMemberships: [],
  mode: "manage",
  selectedIds: new Set(["a1", "a2", "a3"]),
  boardOpen: false,
  settings: {} as any,
  cloudAuth: { cloud_available: true, logged_in: true } as any,
  cloudEntitlement: {
    user_id: "u1", tier: "free",
    balances: { daily: 5, sub: 0, topup: 0 },
    policy: { can_use_byo: false, can_use_cloud: true, understand_daily_limit: 10 },
    recent_transactions: [], issued_at: "", refresh_after: "", grace_until: "",
    entitlement_version: 1, signature_version: 1, signature: null, offline_state: null,
  } as any,
});
w.fixtureStore = useStore;
// 每组用例前重置回「manage + 3 张选中」的基线。
w.resetSelection = () => useStore.setState({ mode: "manage", selectedIds: new Set(["a1", "a2", "a3"]), currentFolderId: null });

function Preview() {
  return <div className="app-shell flex h-screen">
    <main className="relative min-w-0 flex flex-1 flex-col overflow-hidden">
      <div id="home" className="min-h-0 flex-1 overflow-y-auto"><LibraryHome /></div>
    </main>
    <AssetContextMenu />
    <DescribeProviderPicker />
    <ToastViewport />
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
