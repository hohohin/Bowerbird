import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ExploreWorkspace } from "../../../src/components/ExploreWorkspace";
import { Toolbar } from "../../../src/components/Toolbar";
import { ToastViewport } from "../../../src/components/ToastViewport";
import { MasonryGrid } from "../../../src/components/MasonryGrid";
import { Lightbox } from "../../../src/components/Lightbox";
import { FileDropImport } from "../../../src/components/FileDropImport";
import { Sidebar } from "../../../src/components/Sidebar";
import { useStore } from "../../../src/store";
import "../../../src/styles.css";
const w = window as any;
const withSidebar = new URLSearchParams(location.search).has("sidebar");
w.calls = []; w.hold = false; w.fail = false; w.release = null; w.callbacks = {};
w.analysisResolvers = {}; w.captureResolvers = {}; w.claimResolvers = {}; w.captureSequence = 0;
w.store = useStore;
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
w.__TAURI_INTERNALS__ = {
  convertFileSrc: (path: string) => path,
  transformCallback: (callback: any) => { const id = Object.keys(w.callbacks).length + 1; w.callbacks[id] = callback; return id; },
  unregisterCallback: (id: number) => delete w.callbacks[id],
  invoke: async (command: string, args: any = {}) => {
    w.calls.push({ command, args });
    if (command === "plugin:event|listen") return w.calls.length;
    if (command === "claim_source_browser_analysis") {
      if (w.holdClaim) await new Promise(resolve => { w.claimResolvers[args.dragId] = resolve; });
      if (w.claimError) throw w.claimError;
      return w.analyse ?? false;
    }
    if (command === "finish_source_browser_analysis") {
      let held: string[] | undefined;
      if (w.holdAnalysis) held = await new Promise((resolve, reject) => {
        const finish = (tags?: string[]) => { delete w.analysisResolvers[args.dragId]; resolve(tags); };
        w.analysisResolvers[args.dragId] = { resolve: finish, reject: (error: string) => { delete w.analysisResolvers[args.dragId]; reject(error); } };
        w.finishAnalysis = finish;
      });
      if (w.failAnalysis) throw "模拟分类失败";
      return held ?? w.analysisTags ?? ["插画", "柔光"];
    }
    if (command === "capture_source_browser_image") {
      if (w.hold) await new Promise(resolve => { w.captureResolvers[args.dragId] = resolve; w.release = resolve; });
      if (w.fail) throw "模拟网站拒绝图片";
      const sequence = ++w.captureSequence;
      const color = w.uniqueCaptures ? ["#4868ff", "#6b8b67", "#c98957", "#aa6c91"][sequence % 4] : "#4868ff";
      const asset = { id: w.uniqueCaptures ? `captured-${sequence}` : "captured", name: w.uniqueCaptures ? `采集图片 ${sequence}` : "采集图片", width: 200, height: 240, ext: "png", source: "extension", source_url: args.pageUrl,
        thumb_path: "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="240"><rect width="200" height="240" fill="${color}"/></svg>`) };
      if (useStore.getState().activeProjectId === args.projectId) useStore.setState(state => ({ assets: w.uniqueCaptures ? [...state.assets, asset] : [asset], total: w.uniqueCaptures ? state.assets.length + 1 : 1 }));
      return asset;
    }
    if (command === "project_canvas_materialize") {
      if (JSON.parse(args.value.draftJson).schema_version !== 1) throw "invalid draft";
      return {};
    }
    return null;
  },
};
useStore.setState({ assets: [], total: 0, projects: withSidebar ? [{ id: "p", name: "探索侧栏测试", kind: "blank" } as any] : [], activeProjectId: withSidebar ? "p" : null, projectRoutePending: false,
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
    <div className="relative min-h-0 flex flex-1">{withSidebar && <Sidebar />}<ExploreWorkspace url={url} open={opened} onClose={() => setOpened(false)}>
      <input aria-label="主页面草稿" defaultValue="" />
      <div className="min-h-0 flex-1"><MasonryGrid onOpenPreview={asset => setPreview(asset.thumb_path || null)} /></div>
    </ExploreWorkspace></div>
    {preview && <Lightbox images={[preview]} index={0} onClose={() => setPreview(null)} onIndexChange={() => {}} />}
    {dialog && <div role="dialog" style={{ position: "fixed", top: 120, left: 400, zIndex: 100, background: "white" }}>对话框</div>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
