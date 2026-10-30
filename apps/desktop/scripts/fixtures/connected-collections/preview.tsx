import React from "react";
import { createRoot } from "react-dom/client";
import { LibraryHome } from "../../../src/components/LibraryHome";
import { Toolbar } from "../../../src/components/Toolbar";
import { useLocalFileMode } from "../../../src/lib/localFileMode";
import { useStore } from "../../../src/store";
import { folderConnections } from "../../../src/lib/folderConnections";
import "../../../src/styles.css";
import "../../../src/components/LocalFileWorkspace.css";
import "../../../src/components/IndustrialTheme.css";

const w = window as any, listeners = new Map<number, (event: unknown) => void>();
let callbackId = 0, nextId = 0;
const thumb = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="240" height="180" fill="#7b9eaa"/><path d="M0 150L90 30l100 140" stroke="#d1d7c8" fill="none" stroke-width="12"/></svg>');
function folder(id: string, parent_id: string | null, name: string, available = true) {
  return { id, parent_id, root_id: parent_id ? "root" : id, name, path: `/fixture/${id}`, available, count: 0, scanning: false, error: null };
}
w.folders = [folder("root", null, "素材目录"), folder("child", "root", "风景"), folder("nested", "child", "晨间"), folder("empty", "root", "空集合"), folder("second", null, "另一目录"), folder("offline", null, "离线目录", false)];
function asset(id: string, video = false) { return { id, name: `${id}.${video ? "mp4" : "png"}`, ext: video ? "mp4" : "png", source: "external", width: 240, height: 180, store_path: `/fixture/${id}.${video ? "mp4" : "png"}`, thumb_path: thumb, file_mtime: 1, generation_session_id: null }; }
function entry(id: string, folder_id: string, asset_id = id, is_reference = false, video = false) { return { id, folder_id, asset_id, name: `${id}.${is_reference ? "bowerbird" : video ? "mp4" : "png"}`, path: `/fixture/${folder_id}/${id}`, is_reference, available: true, asset: asset(asset_id, video) }; }
w.entries = [...Array.from({ length: 125 }, (_, i) => entry(`root-${i}`, "root")), entry("child-0", "child"), entry("ref-one", "child", "root-0", true), entry("ref-two", "child", "root-0", true), entry("nested-0", "nested"), entry("second-0", "second"), entry("video-0", "second", "video-0", false, true)];
w.requests = []; w.picker = null; w.store = useStore; w.mode = useLocalFileMode; w.connections = folderConnections;
w.changed = () => listeners.forEach(fn => fn({ payload: null }));
function entries(args: any) { return w.entries.filter((item: any) => (!args.folderId || item.folder_id === args.folderId) && (!args.media || (item.asset.ext === "mp4") === (args.media === "videos"))); }
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
w.__TAURI_INTERNALS__ = {
  transformCallback: (fn: (event: unknown) => void) => { listeners.set(++callbackId, fn); return callbackId; },
  convertFileSrc: (path: string) => path,
  invoke: async (command: string, args: any = {}) => {
    if (command === "plugin:event|listen") return args.handler;
    if (command === "plugin:event|unlisten") { listeners.delete(args.eventId); return; }
    w.requests.push({ command, args });
    if (command === "folder_connections") return w.folders.map((item: any) => ({ ...item, count: entries({ ...args, folderId: item.id }).length }));
    if (command === "refresh_folder_connections") return;
    if (command === "connection_entries") return entries(args).slice(args.offset, args.offset + args.limit);
    if (command === "connection_entry_ids") return entries(args).slice(args.offset, args.offset + args.limit).map((item: any) => item.id);
    if (command === "resolve_connection_entries") return args.ids.map((id: string) => w.entries.find((item: any) => item.id === id)).filter(Boolean);
    if (command === "plugin:dialog|open") return w.picker;
    if (command === "connect_folder") { const id = `connected-${++nextId}`; w.folders.push(folder(id, null, "新连接")); return id; }
    if (command === "create_connected_collection") { const id = `created-${++nextId}`; w.folders.push(folder(id, args.parentId, args.name)); return id; }
    if (command === "rename_connected_collection") { w.folders.find((item: any) => item.id === args.id).name = args.name; return; }
    if (command === "create_material_references") { for (const id of args.assetIds) w.entries.push(entry(`ref-${++nextId}`, args.folderId, id, true)); return; }
    if (command === "rename_connection_entry") { w.entries.find((item: any) => item.id === args.id).name = args.name; return; }
    if (command === "trash_connection_entries") { w.entries = w.entries.filter((item: any) => !args.ids.includes(item.id)); return; }
    if (command === "move_connection_entries") { for (const item of w.entries) if (args.ids.includes(item.id)) item.folder_id = args.folderId; return; }
    if (command === "disconnect_folder") { w.folders = w.folders.filter((item: any) => item.root_id !== args.id); return; }
    if (command === "relocate_folder") { w.folders.find((item: any) => item.id === args.id).available = true; return; }
    if (command === "external_files_preview" || command === "external_files_media") return thumb;
    if (command === "catalog_overview") return { total: 1, untagged: 0, catalog: { tags: [{ id: "tag", name: "测试标签", description: "", count: 1, projectCount: 0 }], collections: [], prompts: [], tag_asset_ids: {} } };
    if (command === "catalog_page") return [asset("root-0")];
    if (command === "catalog_prepare_colors") return { after: null, more: false, failed: 0, updated: 0 };
    throw new Error(`Unexpected IPC: ${command}`);
  },
};
useStore.setState({ activeProjectId: null, libraryHomeView: "library", libraryThumbnailWidth: 150 });
useLocalFileMode.getState().setCatalogView("collections");
document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column" }}>
  <Toolbar localFilesOpen canvasMode={false} onCanvasModeChange={() => {}} onRefresh={async () => {}} onCreateCreative={() => {}}/>
  <LibraryHome onCreateProject={async ids => { w.createdAssets = ids; }}/>
</div>);
