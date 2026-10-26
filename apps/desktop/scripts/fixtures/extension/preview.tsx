import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { SourceBrowserPanel } from "../../../src/components/SourceBrowserPanel";
import { ExtensionOnboarding } from "../../../src/components/ExtensionOnboarding";
import { useStore } from "../../../src/store";
import "../../../src/styles.css";

const w = window as any;
const query = new URLSearchParams(location.search);
w.calls = [];
w.clipboardWrites = [];
w.clipboardPending = [];
w.connected = query.has("connected");
w.statusError = query.has("status-error") ? "fixture status failure" : null;
w.folderError = query.has("folder-error") ? "fixture folder failure" : null;
w.folderPath = "C:\\Program Files\\Bowerbird\\resources\\extension";
w.clipboardError = null;
w.store = useStore;
w.closedBrowser = 0;
w.emit = emit;
w.setConnection = async (connected: boolean) => {
  w.connected = connected;
  // App owns the global heartbeat-to-store bridge; the panel consumes this same store.
  useStore.getState().setExtensionConnected(connected);
  await emit(connected ? "collect://extension-connected" : "collect://extension-disconnected", null);
};
Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
  writeText: async (text: string) => {
    if (w.holdClipboard) await new Promise<void>((resolve, reject) => { w.clipboardPending.push({ text, resolve, reject }); });
    if (w.clipboardError) throw new Error(w.clipboardError);
    w.clipboardWrites.push(text);
  },
} });
mockWindows("main");
mockIPC(async (command, args = {}) => {
  w.calls.push({ command, args });
  if (command === "extension_status") {
    if (w.holdStatus) return new Promise(resolve => { w.resolveStatus = resolve; });
    if (w.statusError) throw w.statusError;
    return w.connected;
  }
  if (command === "extension_folder_path") {
    if (w.folderError) throw w.folderError;
    return w.folderPath;
  }
  if (command === "open_source_browser" || command === "navigate_source_browser") {
    await emit("source-browser://status", { url: (args as any).url, loading: false });
  }
  return null;
}, { shouldMockEvents: true });
useStore.setState({ extensionConnected: false, extensionOnboardingForceOpen: false });

function Fixture() {
  const [visible, setVisible] = useState(true);
  return <div className="app-shell flex flex-col" style={{ height: "100vh" }}>
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <div style={{ display: visible ? "flex" : "none", width: "min(780px, 100vw)", minWidth: 0 }}>
        <SourceBrowserPanel url="https://fixture.example/collection/original" visible={visible}
          onClose={() => { w.closedBrowser += 1; setVisible(false); }} />
      </div>
      <main style={{ flex: 1, minWidth: 0 }}><input aria-label="主页面草稿" defaultValue="保留主页面状态" /></main>
    </div>
    <ExtensionOnboarding />
  </div>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
