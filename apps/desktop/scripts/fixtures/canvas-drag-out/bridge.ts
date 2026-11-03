import React from "react";
import { createRoot } from "react-dom/client";
import { SourceBrowserPanel } from "../../../src/components/SourceBrowserPanel";
import { startExternalDrag } from "../../../src/lib/externalDrag";
import { getDragAssets, setDragAssets } from "../../../src/lib/dragPayload";
import "../../../src/styles.css";
import "../../../src/components/IndustrialTheme.css";

const w = window as any;
w.calls = [];
w.notices = [];
w.drops = [];
w.ended = 0;
w.finished = 0;
w.isTauri = true;
w.nativePhase = "preparing";
let callbackId = 0;
const callbacks = new Map();
w.__TAURI_INTERNALS__ = {
  convertFileSrc: (path: string) => path,
  transformCallback: (callback: unknown) => { callbacks.set(++callbackId, callback); return callbackId; },
  invoke: async (command: string, args: any) => {
    w.calls.push({ command, args });
    if (command === "start_external_drag") {
      return new Promise((resolve, reject) => { w.resolveDrag = resolve; w.rejectDrag = reject; });
    }
    if (command === "cancel_pending_external_drag") {
      const cancelled = w.nativePhase !== "started";
      if (cancelled) w.nativePhase = "cancelled";
      if (w.deferCancelAck) return new Promise(resolve => { w.resolveCancel = () => resolve(cancelled); });
      return cancelled;
    }
    if (command === "plugin:event|listen") return args.handler;
    return null;
  },
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event: string, id: number) => callbacks.delete(id) };
window.addEventListener("bowerbird://notify", event => w.notices.push((event as CustomEvent).detail));
window.addEventListener("bowerbird:external-drag-ended", () => w.ended++);
w.payload = getDragAssets;
w.begin = (source: "library" | "canvas" = "canvas", aborted = false) => {
  w.controller = new AbortController();
  if (aborted) w.controller.abort();
  setDragAssets(["image", "video"], "原件");
  w.operation = startExternalDrag(["image", "video"], "hold", { source, signal: w.controller.signal })
    .then(() => { w.finished++; });
};
w.abort = () => w.controller.abort();
w.nativeCalls = () => w.calls.filter((call: any) => call.command === "start_external_drag");
w.cancelCalls = () => w.calls.filter((call: any) => call.command === "cancel_pending_external_drag");
w.browserVisible = () => w.calls.filter((call: any) => call.command === "resize_source_browser").at(-1)?.args.visible;

const frame = window.requestAnimationFrame.bind(window);
const cancelFrame = window.cancelAnimationFrame.bind(window);
const pendingFrames = new Map<number, FrameRequestCallback>();
let frameId = 100000;
w.pauseFrames = () => {
  window.requestAnimationFrame = callback => { pendingFrames.set(++frameId, callback); return frameId; };
  window.cancelAnimationFrame = id => { if (!pendingFrames.delete(id)) cancelFrame(id); };
};
w.stepFrame = () => {
  const pending = [...pendingFrames.values()];
  pendingFrames.clear();
  pending.forEach(callback => callback(performance.now()));
};
w.restoreFrames = () => {
  pendingFrames.clear();
  window.requestAnimationFrame = frame;
  window.cancelAnimationFrame = cancelFrame;
};
w.fireInternalDrop = () => {
  const element = document.getElementById("internal-target")!;
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(new File(["synthetic"], "original.png", { type: "image/png" }));
  Object.defineProperty(dataTransfer, "dropEffect", { value: "copy", writable: true });
  const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer });
  element.dispatchEvent(over);
  const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer });
  element.dispatchEvent(drop);
  return { effect: dataTransfer.dropEffect, prevented: drop.defaultPrevented, count: w.drops.length };
};
document.getElementById("internal-target")!.addEventListener("dragover", event => {
  event.preventDefault();
  (event as DragEvent).dataTransfer!.dropEffect = "copy";
});
document.getElementById("internal-target")!.addEventListener("drop", event => {
  event.preventDefault();
  w.drops.push([...(getDragAssets() ?? [])]);
});

const style = document.createElement("style");
style.textContent = `body { margin:0; background:var(--bb-bg); color:var(--bb-ink); } #root { padding:36px; }
  #fixed-reference { position:fixed; left:31px; top:17px; width:150px; height:22px; }
  #internal-target { margin:30px 0; width:400px; height:70px; background:var(--bb-surface-2); border:1px solid var(--bb-line); }
  #browser-root { width:460px; height:460px; } .source-browser-viewport { min-height:280px; }
  #portal-reference { position:fixed; right:26px; top:65px; z-index:1500; padding:20px; background:var(--bb-surface-2); border:1px solid var(--bb-line); }`;
document.head.append(style);
createRoot(document.getElementById("browser-root")!).render(React.createElement(SourceBrowserPanel, {
  url: "https://example.com/fixture-only", visible: true, onClose: () => {},
}));
w.ready = true;
