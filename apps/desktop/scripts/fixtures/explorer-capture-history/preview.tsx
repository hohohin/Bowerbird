import "../../../src/styles.css";
import "../../../src/components/IndustrialTheme.css";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ExploreWorkspace } from "../../../src/components/ExploreWorkspace";
import { ToastViewport } from "../../../src/components/ToastViewport";
import { useStore } from "../../../src/store";
const w = window as any;
w.calls = []; w.callbacks = {}; w.pending = {}; w.deliveries = []; w.failDelivery = false;
w.store = useStore;
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
w.__TAURI_INTERNALS__ = {
  convertFileSrc: (path: string) => path,
  transformCallback: (callback: any) => { const id = Object.keys(w.callbacks).length + 1; w.callbacks[id] = callback; return id; },
  unregisterCallback: () => {},
  invoke: async (command: string, args: any = {}) => {
    w.calls.push({ command, args });
    if (command === "plugin:event|listen") return w.calls.length;
    if (command === "claim_source_browser_analysis") return false;
    if (command === "capture_source_browser_image") return new Promise((resolve, reject) => { w.pending[args.captureId] = { resolve, reject, args }; });
    if (command === "cancel_source_browser_capture") {
      if (w.failCancel) throw "HTTP 500 https://secret.fixture/?token=CANCEL_SECRET";
      if (w.refuseCancel) return false;
      w.pending[args.captureId]?.reject("采集已取消"); return true;
    }
    if (command === "get_assets_by_ids") return [{ id: args.assetIds[0], name: "已采集素材", ext: "png" }];
    return null;
  },
};
w.emitProgress = (payload: any) => {
  w.calls.filter((c: any) => c.command === "plugin:event|listen" && c.args.event === "source-browser://capture-progress")
    .forEach((c: any) => w.callbacks[c.args.handler]({ payload }));
};
w.complete = (id: string) => {
  const item = w.pending[id];
  item.resolve({ id: `asset-${id}`, name: w.remoteAssetMetadata ? "https://cdn.fixture/private.mp4?signature=SAVE_SECRET" : item.args.mediaKind === "video" ? "海边短片.mp4" : "建筑参考.png", ext: item.args.mediaKind === "video" ? "mp4" : "png",
    width: 320, height: 180, thumb_path: w.remoteAssetMetadata ? "https://cdn.fixture/private.png?signature=THUMB_SECRET" : "/scripts/fixtures/explorer-capture-history/thumb.svg" });
};
useStore.setState({ assets: [], total: 0, projects: [{ id: "p", name: "测试画板", kind: "blank", provisional: false } as any], activeProjectId: "p", projectRoutePending: false,
  projectRouteRevision: 0, settings: {}, mode: "browse", projectCanvasFlush: async () => {} });
document.addEventListener("bowerbird:prepare-explorer-canvas-drop", ((event: CustomEvent) => {
  const { projectId, clientX, clientY } = event.detail;
  event.detail.place = async (asset: any) => {
    w.deliveries.push({ assetId: asset.id, projectId, clientX, clientY });
    if (w.failDelivery) throw new Error("模拟保存失败");
    return "saved-node";
  };
  }));
function Fixture() {
  const [opened, setOpened] = useState(true);
  return <div className="app-shell" style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <ToastViewport /><button onClick={() => setOpened(value => !value)}>切换探索</button>
    <ExploreWorkspace url="https://www.pinterest.com/" open={opened} onClose={() => setOpened(false)}>
      <div data-canvas-stage data-project-drop-id="p" style={{ flex: 1, padding: 30 }}>画板</div>
    </ExploreWorkspace>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
