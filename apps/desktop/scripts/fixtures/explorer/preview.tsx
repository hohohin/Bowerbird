import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ExploreWorkspace } from "../../../src/components/ExploreWorkspace";
import { Toolbar } from "../../../src/components/Toolbar";
import { ToastViewport } from "../../../src/components/ToastViewport";
import { MasonryGrid } from "../../../src/components/MasonryGrid";
import { Lightbox } from "../../../src/components/Lightbox";
import { FileDropImport } from "../../../src/components/FileDropImport";
import { useStore } from "../../../src/store";
import "../../../src/styles.css";
const w = window as any;
w.calls = []; w.hold = false; w.fail = false; w.release = null; w.callbacks = {};
w.store = useStore;
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
w.__TAURI_INTERNALS__ = {
  convertFileSrc: (path: string) => path,
  transformCallback: (callback: any) => { const id = Object.keys(w.callbacks).length + 1; w.callbacks[id] = callback; return id; },
  unregisterCallback: (id: number) => delete w.callbacks[id],
  invoke: async (command: string, args: any = {}) => {
    w.calls.push({ command, args });
    if (command === "plugin:event|listen") return w.calls.length;
    if (command === "capture_source_browser_image") {
      if (w.hold) await new Promise(resolve => { w.release = resolve; });
      if (w.fail) throw "模拟网站拒绝图片";
      const asset = { id: "captured", name: "采集图片", width: 200, height: 240, ext: "png", source: "extension", source_url: args.pageUrl,
        thumb_path: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="240"><rect width="200" height="240" fill="#4868ff"/></svg>') };
      if (useStore.getState().activeProjectId === args.projectId) useStore.setState({ assets: [asset], total: 1 });
      return asset;
    }
    if (command === "project_canvas_materialize") {
      if (JSON.parse(args.value.draftJson).schema_version !== 1) throw "invalid draft";
      return {};
    }
    return null;
  },
};
useStore.setState({ assets: [], total: 0, projects: [], activeProjectId: null, projectRoutePending: false,
  projectRouteRevision: 0, settings: {}, mode: "browse", boardOpen: false, projectCanvasFlush: async () => {} });
function Fixture() {
  const [opened, setOpened] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  return <div className="app-shell flex flex-col" style={{ height: "100vh" }}><ToastViewport /><FileDropImport />
    <Toolbar canvasMode={false} onCanvasModeChange={() => {}} onCreateCreative={() => {}} onRefresh={async () => {}}
      onExplore={() => { setUrl("https://www.pinterest.com/"); setOpened(v => !v); }} exploring={opened} />
    <button onClick={() => setDialog(v => !v)}>测试弹窗</button>
    <div className="relative min-h-0 flex-1"><ExploreWorkspace url={url} open={opened} onClose={() => setOpened(false)}>
      <input aria-label="主页面草稿" defaultValue="" />
      <div className="min-h-0 flex-1"><MasonryGrid onOpenPreview={asset => setPreview(asset.thumb_path || null)} /></div>
    </ExploreWorkspace></div>
    {preview && <Lightbox images={[preview]} index={0} onClose={() => setPreview(null)} onIndexChange={() => {}} />}
    {dialog && <div role="dialog" style={{ position: "fixed", top: 120, left: 400, zIndex: 100, background: "white" }}>对话框</div>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
