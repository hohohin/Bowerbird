import React from "react";
import { createRoot } from "react-dom/client";
import { FileMediaCard } from "../../../src/components/FileMediaCard";
import { AssetContextMenu } from "../../../src/components/AssetContextMenu";
import { ConnectedCollections } from "../../../src/components/ConnectedCollections";
import { FileDropImport } from "../../../src/components/FileDropImport";
import { ToastViewport } from "../../../src/components/ToastViewport";
import { getDragAssets, setDragAssets } from "../../../src/lib/dragPayload";
import { useStore } from "../../../src/store";
import type { Asset } from "../../../src/lib/types";
import "../../../src/styles.css";
import "../../../src/components/CategorizedLibrary.css";
import "../../../src/components/IndustrialTheme.css";
import "../../../src/components/IndustrialMenus.css";

const w = window as any;
const picture = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="240" height="180" fill="#8797b5"/></svg>');
const assets = ["image", "offscreen", "audio", "text", "video"].map(id => {
  const ext = ({ audio: "wav", text: "md", video: "mp4" } as Record<string, string>)[id] ?? "png";
  return { id, name: id, store_path: `C:/original/${id}.${ext}`, ext, source: "external", width: 240, height: 180, thumb_path: picture };
}) as Asset[];
w.calls = []; w.drops = []; w.ended = 0; w.selected = ["image", "offscreen", "image"];
w.isTauri = true;
const callbacks = new Map(); let callbackId = 0;
w.__TAURI_INTERNALS__ = {
  convertFileSrc: () => picture,
  transformCallback: (callback: any) => { callbacks.set(++callbackId, callback); return callbackId; },
  invoke: async (command: string, args: any) => {
    w.calls.push({ command, args });
    if (command === "start_external_drag") return new Promise((resolve, reject) => { w.resolveDrag = resolve; w.rejectDrag = reject; });
    if (command === "plugin:event|listen") return args.handler;
    if (command === "get_assets_by_ids") return assets.filter(asset => args.assetIds.includes(asset.id));
    if (command === "audio_waveform") return { sourceVersion: "test", duration: 2, sampleRate: 48000, channels: 1, framesPerPeak: 1500, totalFrames: 96000, peaks: Array(64).fill([-.4, .4]) };
    if (command === "folder_connections") return [{ id: "folder", parent_id: null, root_id: "folder", name: "目标集合", path: "C:/target", available: true, count: 0, scanning: false, error: null }];
    if (command === "connection_entries") return [];
    if (command === "file_preview") return picture;
    if (command === "plugin:event|unlisten") return;
    return null;
  },
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event: string, id: number) => callbacks.delete(id) };
w.payload = getDragAssets; w.clearPayload = () => setDragAssets(null);
window.addEventListener("bowerbird:external-drag-ended", () => w.ended++);
useStore.setState({ assets, activeProjectId: null, projects: [], mode: "browse", selectedIds: new Set(["unrelated"]), reloadProjects: async () => {} });
w.openMenu = (ids: string[] = ["image"], canvas = true) => useStore.getState().openContextMenu(300, 180, ids[0], {
  asset: assets.find(asset => asset.id === ids[0]),
  ...(canvas ? { canvasSelection: { projectId: "p1", nodeIds: ids.map((_, i) => `node${i}`), assetIds: ids } } : {}),
});
function Preview() {
  return <div className="app-shell" style={{ padding: 40 }}>
    <div style={{ width: 240 }}>
      {assets.filter(asset => asset.id !== "offscreen").map(asset => <FileMediaCard key={asset.id} assetId={asset.id}
        entry={{ path: asset.store_path!, name: asset.name, directory: false, preview: picture }} selected={false} revision={0} labels={[]}
        onOpen={() => { w.opened = (w.opened ?? 0) + 1; }} onSelect={() => { w.selectedClicks = (w.selectedClicks ?? 0) + 1; }} onContextMenu={() => w.openMenu([asset.id])}
        dragAssetIds={() => asset.id === "image" ? w.selected : [asset.id]}
        onDragEnd={() => setDragAssets(null)}/>) }
      <FileMediaCard entry={{ path: "C:/original", name: "folder", directory: true }} selected={false} revision={0} labels={[]}
        onOpen={() => {}} onSelect={() => {}} onContextMenu={() => {}}/>
    </div>
    <div id="internal-target" style={{ padding: 40 }} onDragOver={event => { if (getDragAssets()?.length) event.preventDefault(); }}
      onDrop={event => { const ids = getDragAssets(); if (!ids?.length) return; event.preventDefault(); w.drops.push([...ids]); setDragAssets(null); }}>内部放置</div>
    <div style={{ height: 300, position: "relative" }}><ConnectedCollections/></div>
    <AssetContextMenu/><FileDropImport/><ToastViewport/>
  </div>;
}
const root = createRoot(document.getElementById("root")!);
w.unmount = () => root.unmount();
root.render(<Preview/>);
