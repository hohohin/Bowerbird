import React from "react";
import { createRoot } from "react-dom/client";
import { LibraryHome } from "../../../src/components/LibraryHome";
import { Toolbar } from "../../../src/components/Toolbar";
import { useStore } from "../../../src/store";
import { useLocalFileMode } from "../../../src/lib/localFileMode";
import { installCatalogPagingMock } from "../catalogPagingMock";
import "../../../src/styles.css";
import "../../../src/components/LocalFileWorkspace.css";

// Real library components and styles; all media and IPC are isolated synthetic fixtures.
const w = window as any;
const tags = [{ id: "a", name: "A 品牌" }, { id: "z", name: "Z 插画" }];
const assets = Array.from({ length: 32 }, (_, index) => {
  const height = [160, 240, 320][index % 3];
  const image = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="${height}"><rect width="240" height="${height}" fill="${index % 2 ? "#7e9294" : "#bdac92"}"/><path d="M0 0L240 ${height}M240 0L0 ${height}" stroke="#ffffff" opacity=".2"/><text x="20" y="50" fill="#fff" font-size="20">${String(index + 1).padStart(2, "0")}</text></svg>`);
  return { id: `tactical-${index}`, name: `素材 ${index + 1}`, ext: "png", source: "imported", width: 240, height,
    store_path: image, thumb_path: image, created_at: 1000 - index, generation_session_id: index % 5 === 0 ? "generated" : null };
});
const videos = [{ ...assets[0], id: "video-0", name: "示例视频", ext: "mp4", store_path: "/fixture/video.mp4" }];
const catalog = { tags: tags.map(tag => ({ ...tag, count: 16, projectCount: 0, description: "" })), prompts: [],
  collections: [{ id: "collection", name: "收藏", kind: "collection", parent_id: null }],
  tag_asset_ids: Object.fromEntries(tags.map((tag, index) => [tag.id, assets.slice(index * 16, index * 16 + 16).map(asset => asset.id)])) };
let callbackId = 0;
w.store = useStore; w.mode = useLocalFileMode; w.calls = [];
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
w.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++callbackId,
  convertFileSrc: (path: string) => path,
  invoke: async (command: string, args: any = {}) => {
    w.calls.push({ command, args });
    if (command === "plugin:event|listen") return args.handler;
    if (command === "plugin:event|unlisten" || command === "set_setting") return;
    if (command === "material_catalog") return catalog;
    if (command === "material_catalog_assets") return args.kind === "collections" ? assets.slice(0, 8) : [...assets, ...videos];
    if (command === "get_assets_by_ids") return [...assets, ...videos].filter(asset => args.assetIds.includes(asset.id));
    if (command === "external_files_preview" || command === "external_files_media") return args.path?.startsWith("data:") ? args.path : assets[0].thumb_path;
    if (command === "file_colors") return [assets.findIndex(asset => asset.store_path === args.path) % 2 ? "red" : "blue"];
    if (command === "get_projects" || command === "list_projects" || command === "get_folders" || command === "get_collections") return [];
    if (command === "get_settings") return {};
    if (command.startsWith("plugin:dialog|")) return null;
    if (command === "get_asset") return assets.find(asset => asset.id === args.id) ?? assets[0];
    if (command === "file_workspace_status") return { config: { root: "/fixture", places: [], projects: {} }, proposed_root: "/fixture" };
    if (command === "file_workspace_all") return { entries: [], unavailable: [] };
    if (command === "global_classification_view") return { labels: [], pictures: [] };
    if (command === "external_files_browse") return { path: args.path ?? "/fixture", parent: null, entries: [], total: 0 };
    return null;
  },
};
installCatalogPagingMock(w);
useStore.setState({ activeProjectId: null, libraryThumbnailWidth: 180, loading: false, assets: assets as any, mode: "browse",
  cloudAuth: { logged_in: true, display_name: "Fixture", cloud_available: true } as any,
  cloudEntitlement: { tier: "pro", balances: { daily: 0, sub: 0, topup: 1230 }, policy: { can_use_cloud: true, can_use_byo: true }, recent_transactions: [], generation_services: [], prompt_configs: [] } as any });
useLocalFileMode.setState({ mode: "tags", views: { global: "tags", project: "tags" }, query: "" });

createRoot(document.getElementById("root")!).render(<>
  <div className="app-shell flex h-full w-full flex-col">
    <Toolbar localFilesOpen canvasMode={false} onCanvasModeChange={() => {}} onRefresh={async () => {}} onCreateCreative={() => {}} onExplore={() => {}}/>
    <main className="app-workspace relative flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas"><LibraryHome/></main>
  </div>
  <button data-unrelated-control className="library-floating-surface library-filter-trigger" style={{ position: "fixed", left: -1000 }}>Unrelated surface</button>
</>);
