import React from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { WindowTitlebar } from "../../../src/components/WindowTitlebar";
import { Toolbar } from "../../../src/components/Toolbar";
import { useStore } from "../../../src/store";
import "../../../src/styles.css";

const w = window as any;
w.isTauri = true;
w.calls = [];
w.store = useStore;
w.maximized = false;
mockWindows("main");
mockIPC(async command => {
  w.calls.push(command);
  if (command === "plugin:window|is_maximized") return w.maximized;
  if (command === "plugin:window|toggle_maximize") {
    w.maximized = !w.maximized;
    await emit("tauri://resize", { width: 1280, height: 800 });
  }
}, { shouldMockEvents: true });
w.externalResize = async () => {
  w.maximized = !w.maximized;
  await emit("tauri://resize", { width: 900, height: 600 });
};
createRoot(document.getElementById("root")!).render(<React.StrictMode>
  <div className="app-shell flex h-full flex-col">
    <WindowTitlebar />
    <Toolbar onRefresh={async () => {}} canvasMode={false} onCanvasModeChange={() => {}}
      onCreateCreative={() => {}} onExplore={() => {}} />
  </div>
</React.StrictMode>);
