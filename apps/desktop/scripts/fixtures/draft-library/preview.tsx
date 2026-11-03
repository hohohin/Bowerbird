import "../draft-editor/preview";
import { useLocalFileMode } from "../../../src/lib/localFileMode";
import { setDragAssets } from "../../../src/lib/dragPayload";

const w = window as any;
w.isTauri = true;
const base = w.__TAURI_INTERNALS__.invoke;
function png(color: string) {
  const canvas = document.createElement("canvas"); canvas.width = 120; canvas.height = 80;
  const ctx = canvas.getContext("2d")!; ctx.fillStyle = color; ctx.fillRect(0, 0, 120, 80);
  return canvas.toDataURL();
}
const red = png("#ea4422"), blue = png("#2266ea");
const assets = [
  { id: "library-red", name: "红色样片.png", ext: "png", store_path: "/isolated/red.png", thumb_path: red, width: 120, height: 80 },
  { id: "library-blue", name: "蓝色样片.png", ext: "png", store_path: "/isolated/blue.png", thumb_path: blue, width: 120, height: 80 },
];
const connectedEntries = assets.map(asset => ({ id: `entry-${asset.id}`, folder_id: "collection-a", asset_id: asset.id,
  name: asset.name, path: asset.store_path, is_reference: false, available: true, version: "1", asset }));
w.libraryState = useLocalFileMode; w.setDragAssets = setDragAssets; w.backgroundDrops = 0;
document.addEventListener("drop", () => w.backgroundDrops++);
let callback = 0;
w.__TAURI_INTERNALS__.transformCallback = () => ++callback;
w.__TAURI_INTERNALS__.unregisterCallback = () => {};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
  const known = ["folder_connections", "refresh_folder_connections", "connection_entries", "connection_entry_ids", "resolve_connection_entries", "catalog_overview", "catalog_page", "catalog_ids", "catalog_prepare_colors", "get_assets_by_ids", "read_image_data_url", "plugin:event|listen", "plugin:event|unlisten"];
  if (!known.includes(command)) return base(command, args);
  w.calls.push({ command, args });
  if (command === "folder_connections") return [{ id: "collection-a", root_id: "collection-a", parent_id: null, name: "参考合集", path: "/isolated", available: true, scanning: false, count: args.projectId ? 1 : 2 }];
  if (command === "refresh_folder_connections") return;
  if (command === "resolve_connection_entries") return connectedEntries.filter(entry => args.ids.includes(entry.id));
  if (command === "connection_entries" || command === "connection_entry_ids") {
    const entries = connectedEntries.filter(entry => !args.projectId || entry.asset_id === "library-red").slice(args.offset, args.offset + args.limit);
    return command === "connection_entries" ? entries : entries.map(entry => entry.id);
  }
  if (command === "plugin:event|listen") return args.handler;
  if (command === "plugin:event|unlisten") return null;
  if (command === "catalog_prepare_colors") return { after: null, more: false, failed: 0, updated: 0 };
  if (command === "get_assets_by_ids") return assets.filter(asset => args.assetIds.includes(asset.id));
  if (command === "read_image_data_url") {
    if (w.delayRead) await new Promise(resolve => { w.releaseRead = resolve; });
    if (w.failRead) throw "模拟原文件不可用";
    if (args.path === "/isolated/red.png") return red;
    if (args.path === "/isolated/blue.png") return blue;
    throw new Error(`Unexpected path: ${args.path}`);
  }
  const filtered = assets.filter(asset => (!args.filter.projectId || asset.id === "library-red")
    && (!args.filter.query || asset.name.includes(args.filter.query))
    && (args.filter.kind !== "collections" || args.filter.id === "collection-a"));
  if (command === "catalog_overview") return { total: filtered.length, untagged: filtered.length,
    catalog: { tags: [], collections: [{ id: "collection-a", name: "参考合集", parent_id: null, count: 2 }], prompts: [], tag_asset_ids: {} } };
  if (command === "catalog_ids") return filtered.map(asset => asset.id);
  return filtered.slice(args.offset, args.offset + args.limit);
};
