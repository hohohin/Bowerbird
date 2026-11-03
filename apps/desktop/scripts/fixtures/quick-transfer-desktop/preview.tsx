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
w.emit = (patch: any) => {
  w.snapshot = { ...w.snapshot, ...patch, revision: patch.revision ?? w.snapshot.revision + 1 };
  callbacks.get(eventHandler)?.({ event: "quick-transfer://changed", payload: { ...w.snapshot } });
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
w.__TAURI_INTERNALS__ = {
  transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++callbackId, callback); return callbackId; },
  unregisterCallback: (id: number) => callbacks.delete(id),
  invoke: async (command: string, args: any) => {
    w.calls.push({ command, args });
    if (w.failures?.[command]) throw w.failures[command];
    if (command === "plugin:event|listen") { eventHandler = args.handler; return eventHandler; }
    if (command === "plugin:event|unlisten") { callbacks.delete(args.eventId); return; }
    if (command === "quick_transfer_addresses") return w.addresses;
    if (command === "quick_transfer_directory") return "D:\\BowerbirdLibrary\\快传";
    if (command === "quick_transfer_status") {
      const snapshot = { ...w.snapshot };
      if (w.holdStatus) await new Promise<void>(resolve => { w.releaseStatus = resolve; });
      return snapshot;
    }
    if (command === "plugin:dialog|open") return w.cancelPicker ? null : "D:\\素材\\手机快传";
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
