import React from "react";
import { createRoot } from "react-dom/client";
import { Toolbar } from "../../../src/components/Toolbar";
import { LibraryHome } from "../../../src/components/LibraryHome";
import { AssetDetail } from "../../../src/components/AssetDetail";
import { AssetContextMenu } from "../../../src/components/AssetContextMenu";
import { FileDropImport } from "../../../src/components/FileDropImport";
import { ToastViewport } from "../../../src/components/ToastViewport";
import { RenameDialog } from "../../../src/components/RenameDialog";
import { CanvasAssetDeleteDialog } from "../../../src/components/CanvasAssetDeleteDialog";
import { externalFiles } from "../../../src/lib/externalFiles";
import { useStore } from "../../../src/store";
import { useLocalFileMode } from "../../../src/lib/localFileMode";
import { addMaterialAssets } from "../../../src/lib/materialActions";
import { prepareExplorerCanvasDrop, EXPLORER_CANVAS_DROP_EVENT } from "../../../src/lib/explorerCanvasDrop";
import type { Asset } from "../../../src/lib/types";
import "../../../src/styles.css";
import "../../../src/components/LocalFileWorkspace.css";
import "../../../src/components/IndustrialTheme.css";

// Real components with a closed IPC boundary; files are synthetic and served read-only.
const w = window as any, listeners = new Map<number, (event: unknown) => void>();
let callbackId = 0;
const params = new URLSearchParams(location.search);
const thumb = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="240" height="180" fill="#7b9eaa"/></svg>');
const audio = (id: string, file: string, duration: number): Asset => ({ id, name: file.replace(/\.[^.]+$/, ""), ext: file.split(".").pop(), store_path: `/audio-fixtures/${file}`, thumb_path: null, duration, file_mtime: 1, source: "external" });
const image: Asset = { id: "image", name: "image.png", ext: "png", store_path: thumb, thumb_path: thumb, width: 240, height: 180, source: "external" };
const video: Asset = { id: "video", name: "video.mp4", ext: "mp4", store_path: "/audio-fixtures/video.mp4", thumb_path: thumb, width: 240, height: 180, duration: 2, source: "external" };
const originals = [audio("wav", "chime.wav", 12), audio("mp3", "long-vbr.mp3", 3600), audio("flac", "rain.flac", 24), audio("m4a", "space.m4a", 36), image, video];
w.assets = [...originals, ...Array.from({ length: params.has("stress") ? 1200 : 65 }, (_, i) => ({ ...originals[0], id: `extra-${i}`, name: `声音 ${i}.wav` }))];
w.calls = []; w.unexpected = []; w.createdAssets = []; w.placed = []; w.libraryCloseCount = 0; w.clipboardPaths = [];
w.store = useStore; w.mode = useLocalFileMode;
w.externalFiles = externalFiles; w.mutations = [];
const folder = (id: string, parent_id: string | null, name: string) => ({ id, parent_id, root_id: "root", name, path: `/fixture/${id}`, available: true, count: 0, scanning: false, error: null });
w.folders = [folder("root", null, "声音素材"), folder("child", "root", "音乐"), folder("next", null, "另一集合")];
w.entries = w.assets.map((asset: Asset, i: number) => ({ id: `entry-${asset.id}`, folder_id: i === 1 ? "child" : i === 2 ? "next" : "root", asset_id: asset.id, name: asset.name, path: asset.store_path, asset, available: true, is_reference: false, version: "a".repeat(64) }));
const kind = (asset: Asset) => ["wav", "mp3", "flac", "m4a", "ogg"].includes(asset.ext ?? "") ? "audios" : asset.ext === "mp4" ? "videos" : "images";
const filtered = (filter: any = {}) => w.assets.filter((asset: Asset) => (!filter.media || kind(asset) === filter.media) && (!filter.id || (filter.id === "tag-music" ? asset.id === "mp3" : asset.id !== "mp3")));
const entries = (args: any) => w.entries.filter((entry: any) => (!args.folderId || entry.folder_id === args.folderId) && (!args.media || kind(entry.asset) === args.media));
const tags = [{ id: "tag-music", name: "音乐", description: "", count: 1, projectCount: 0 }];
const manualTags = new Map<string, string[]>();
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
w.__TAURI_INTERNALS__ = {
  transformCallback: (fn: (event: unknown) => void) => { listeners.set(++callbackId, fn); return callbackId; },
  convertFileSrc: (path: string) => path,
  invoke: async (command: string, args: any = {}) => {
    if (command === "plugin:event|listen") return args.handler;
    if (command === "plugin:event|unlisten") { listeners.delete(args.eventId); return; }
    w.calls.push({ command, args });
    if (["local_file_rename", "local_file_delete", "rename_asset", "delete_asset_with_mode"].includes(command)) {
      const player = document.querySelector<HTMLAudioElement>('audio[data-audio-preview]');
      w.mutations.push({ command, args, paused: player?.paused ?? true, src: player?.getAttribute("src") ?? null });
      return { deleted_assets: 1, removed_members: 1, failed_moves: [] };
    }
    if (command === "list_projects") return [];
    if (command === "folder_connections") return w.folders.map((item: any) => ({ ...item, count: entries({ ...args, folderId: item.id }).length }));
    if (command === "refresh_folder_connections") return;
    if (command === "connection_entries") return entries(args).slice(args.offset, args.offset + args.limit);
    if (command === "connection_entry_ids") return entries(args).slice(args.offset, args.offset + args.limit).map((entry: any) => entry.id);
    if (command === "resolve_connection_entries") return w.entries.filter((entry: any) => args.ids.includes(entry.id));
    if (command === "catalog_overview") return { total: filtered(args.filter).length, untagged: filtered(args.filter).filter((a: Asset) => a.id !== "mp3").length, catalog: { tags: args.filter.media === "audios" ? tags : [], collections: [], prompts: [], tag_asset_ids: {} } };
    if (command === "catalog_page") return filtered(args.filter).slice(args.offset, args.offset + args.limit);
    if (command === "catalog_ids") return filtered(args.filter).slice(args.offset, args.offset + args.limit).map((asset: Asset) => asset.id);
    if (command === "catalog_prepare_colors") return { after: null, more: false, failed: 0, updated: 0 };
    if (command === "get_assets_by_ids") return w.assets.filter((asset: Asset) => args.assetIds.includes(asset.id));
    if (command === "audio_waveform") {
      const asset = w.assets.find((item: Asset) => item.id === args.assetId);
      if (!asset || kind(asset) !== "audios") throw new Error("unexpected audio asset");
      const file = asset.id === "mp3" ? "long-vbr.mp3" : asset.id === "flac" ? "rain.flac" : asset.id === "m4a" ? "space.m4a" : "chime.wav";
      const peaks = await fetch(`/audio-fixtures/${file}.peaks.json`).then(response => response.json());
      return { ...peaks, sourceVersion: "a".repeat(64) };
    }
    if (command === "external_files_preview" || command === "external_files_media") {
      if (/\.(wav|mp3|flac|m4a|ogg)(?:\?|$)/i.test(args.path)) throw new Error("audio entered image preview");
      return args.path.endsWith(".mp4") ? args.path : thumb;
    }
    if (command === "list_asset_tags") return (manualTags.get(args.assetId) ?? []).map((name: string) => ({ name, source: "manual", origin: "manual" }));
    if (command === "set_asset_tags") { manualTags.set(args.assetId, args.tags ?? args.names); return; }
    if (["list_analyses_by_asset", "list_asset_collections", "list_generation_group", "list_folders"].includes(command)) return [];
    if (command === "generation_history") return { turns: [], references: [], products: [] };
    if (command === "codex_health") return { ok: false, reason: "隔离验证" };
    if (command === "plugin:dialog|open") return "/fixture/new";
    if (command === "connect_folder") return "root";
    if (command === "create_material_references") return;
    if (command === "clipboard_file_paths") return w.clipboardPaths;
    if (command === "import_files") return args.sources.map((path: string) => ({ ...originals[0], id: `imported-${path}`, store_path: path }));
    w.unexpected.push({ command, args });
    throw new Error(`Unexpected IPC: ${command}`);
  },
};
useStore.setState({ assets: w.assets, activeProjectId: null, libraryHomeView: "library", libraryThumbnailWidth: 230, projects: [], mode: "browse" });
w.guardResults = async () => {
  const results: any = {};
  try { await addMaterialAssets([image, originals[0]], null, () => w.libraryCloseCount++, async ids => { w.createdAssets.push(ids); }); results.add = null; }
  catch (error) { results.add = String(error); }
  const target = document.createElement("div"); document.body.append(target);
  target.addEventListener(EXPLORER_CANVAS_DROP_EVENT, (event: Event) => { (event as CustomEvent).detail.place = async (asset: Asset) => { w.placed.push(asset.id); }; });
  const place = prepareExplorerCanvasDrop(target, "p", 10, 20)!;
  try { await place(originals[0]); results.place = null; } catch (error) { results.place = String(error); }
  await place(image); await place(video); target.remove();
  return { ...results, created: w.createdAssets, closed: w.libraryCloseCount, placed: w.placed };
};
function Fixture() {
  const detail = useStore(state => state.detailAssetId);
  const [mutationDialog, setMutationDialog] = React.useState<string | null>(null);
  w.openMutationDialog = (kind: string) => { w.assets[0].source = kind === "delete-reference" ? "external" : "imported"; setMutationDialog(kind); };
  return <>
    {!params.has("guards") && <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column" }}>
      <Toolbar localFilesOpen canvasMode={false} onCanvasModeChange={() => {}} onRefresh={async () => {}} onCreateCreative={() => {}}/>
      {detail ? <AssetDetail onExploreSource={() => {}}/> : <LibraryHome onCreateProject={async ids => { w.createdAssets.push(ids); }}/>}<FileDropImport/>
    </div>}
    <AssetContextMenu/><ToastViewport/>
    {mutationDialog === "rename" && <RenameDialog open assetId="wav" currentName="chime" onClose={() => setMutationDialog(null)}/>}
    {mutationDialog?.startsWith("delete") && <CanvasAssetDeleteDialog target={{ assetIds: ["wav"], projectId: null }} onClose={() => setMutationDialog(null)}/>}
  </>;
}
document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Fixture/>);
