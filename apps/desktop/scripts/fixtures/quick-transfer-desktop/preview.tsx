import React from "react";
import { createRoot } from "react-dom/client";
import { QuickTransfer } from "../../../src/components/QuickTransferPanel";
import "../../../src/styles.css";
import "../../../src/components/IndustrialTheme.css";

// Isolated IPC only: no receiver, filesystem writes, real library or account.
const w = window as any;
const params = new URLSearchParams(location.search);
const callbacks = new Map<number, (event: unknown) => void>();
let callbackId = 0;
let eventHandler = 0;
w.calls = [];
w.addresses = params.has("offline") ? [] : ["192.168.1.23", "10.0.0.9"];
w.holdStatus = params.has("holdStatus");
Object.defineProperty(navigator, "clipboard", { value: { writeText: async (value: string) => { w.copiedAddress = value; } } });
w.snapshot = { revision: 0, active: false, directory: null, url: null, transfers: [] };
function thumbnail(color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 32; canvas.height = 24;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color; context.fillRect(0, 0, 32, 24);
  context.fillStyle = "#ffffff"; context.fillRect(24, 0, 8, 8);
  return canvas.toDataURL("image/png");
}
w.assets = {
  "asset-red": { id: "asset-red", name: "红色照片.heic", ext: "heic", store_path: "D:\\快传\\红色照片.heic", thumb_path: null, file_mtime: 1, size: 100 },
  "asset-blue": { id: "asset-blue", name: "蓝色视频.mp4", ext: "mp4", store_path: "D:\\快传\\蓝色视频.mp4", thumb_path: null, file_mtime: 1, size: 100 },
  "asset-text": { id: "asset-text", name: "笔记.txt", ext: "txt", store_path: "D:\\快传\\笔记.txt", thumb_path: null },
  "asset-broken": { id: "asset-broken", name: "坏图.jpg", ext: "jpg", store_path: "D:\\快传\\坏图.jpg", thumb_path: null },
};
w.previewResults = { "D:\\快传\\红色照片.heic": "D:\\cache\\red.jpg", "D:\\快传\\蓝色视频.mp4": "D:\\cache\\blue.jpg", "D:\\快传\\坏图.jpg": "D:\\cache\\broken.jpg" };
w.previewImages = { "D:\\cache\\red.jpg": thumbnail("#e32636"), "D:\\cache\\blue.jpg": thumbnail("#2555d9"), "D:\\cache\\broken.jpg": "data:image/png;base64,bm90LWEtcG5n" };
w.assetWaiters = [];
w.previewWaiters = [];
w.activePreviews = 0;
w.maxPreviews = 0;
w.convertedPaths = [];
w.emit = (patch: any) => {
  w.snapshot = { ...w.snapshot, ...patch, revision: patch.revision ?? w.snapshot.revision + 1 };
  callbacks.get(eventHandler)?.({ event: "quick-transfer://changed", payload: { ...w.snapshot } });
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
w.__TAURI_INTERNALS__ = {
  convertFileSrc: (path: string) => { w.convertedPaths.push(path); return w.previewImages[path] ?? "data:image/png;base64,bm90LWEtcG5n"; },
  transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++callbackId, callback); return callbackId; },
  unregisterCallback: (id: number) => callbacks.delete(id),
  invoke: async (command: string, args: any) => {
    w.calls.push({ command, args });
    if (w.failures?.[command]) throw w.failures[command];
    if (command === "plugin:event|listen") { eventHandler = args.handler; return eventHandler; }
    if (command === "plugin:event|unlisten") { callbacks.delete(args.eventId); return; }
    if (command === "quick_transfer_addresses") return w.addresses;
    if (command === "quick_transfer_directory") return "D:\\BowerbirdLibrary\\快传";
    if (command === "get_assets_by_ids") {
      const assets = args.assetIds.map((id: string) => w.assets[id]).filter(Boolean).reverse();
      if (w.holdAssetIds?.some((id: string) => args.assetIds.includes(id))) await new Promise<void>(resolve => w.assetWaiters.push({ ids: args.assetIds, resolve }));
      return assets;
    }
    if (command === "external_files_preview") {
      w.activePreviews++; w.maxPreviews = Math.max(w.maxPreviews, w.activePreviews);
      try {
        if (w.holdPreviewPaths?.includes(args.path)) await new Promise<void>(resolve => w.previewWaiters.push({ path: args.path, resolve }));
        if (w.failedPreviewPaths?.includes(args.path)) throw "预览生成失败";
        return w.previewResults[args.path];
      } finally { w.activePreviews--; }
    }
    if (command === "quick_transfer_status") {
      const snapshot = { ...w.snapshot };
      if (w.holdStatus) await new Promise<void>(resolve => { w.releaseStatus = resolve; });
      return snapshot;
    }
    if (command === "plugin:dialog|open") return w.cancelPicker ? null : w.pickFiles ?? "D:\\素材\\手机快传";
    if (command === "quick_transfer_send_start") {
      w.emit({ sending: { url: `http://${args.address}:53318/?pin=87654321`, files: args.files.map((path: string) => ({ id: path, name: path.split(/[\\/]/).pop(), size: 1234 })) } });
      return w.snapshot;
    }
    if (command === "quick_transfer_send_stop") { w.emit({ sending: null }); return w.snapshot; }
    if (command === "quick_transfer_start") {
      const snapshot = { ...w.snapshot, revision: w.snapshot.revision + 1, active: true,
        directory: "D:\\BowerbirdLibrary\\快传", url: `http://${args.address}:53317/?pin=01234567` };
      w.emit(snapshot);
      if (w.holdStart) await new Promise<void>(resolve => { w.releaseStart = resolve; });
      return snapshot;
    }
    if (command === "quick_transfer_stop") { w.emit({ active: false, url: null }); return w.snapshot; }
    if (command === "quick_transfer_retry") {
      w.emit({ transfers: w.snapshot.transfers.map((file: any) => file.id === args.id
        ? { ...file, status: "complete", retryable: false, error: null, assetId: "asset-1" } : file) });
      return w.snapshot;
    }
    throw new Error(`Unexpected IPC: ${command}`);
  },
};
document.documentElement.dataset.theme = params.get("theme") ?? "dark";
createRoot(document.getElementById("root")!).render(<React.StrictMode>
  <div style={{ padding: 24 }}><p style={{ marginBottom: 20, color: "var(--bb-muted)" }}>正式组件 · 隔离数据，不会开启接收</p>
    <div className="app-topbar"><QuickTransfer /></div>
  </div>
</React.StrictMode>);
