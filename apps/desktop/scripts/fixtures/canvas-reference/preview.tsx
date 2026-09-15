import React from "react";
import { createRoot } from "react-dom/client";
import { CanvasWorkspace } from "../../../src/components/CanvasWorkspace";
import { AssetContextMenu } from "../../../src/components/AssetContextMenu";
import { ImageAnnotator } from "../../../src/components/ImageAnnotator";
import { useStore } from "../../../src/store";
import { ExploreWorkspace } from "../../../src/components/ExploreWorkspace";
import { ToastViewport } from "../../../src/components/ToastViewport";
import { Toolbar } from "../../../src/components/Toolbar";
import "../../../src/styles.css";

// Closed synthetic IPC fixture: never reads a library or invokes a provider.
const w = window as any;
const explorer = new URLSearchParams(location.search).has("explorer");
const sourceLibrary = new URLSearchParams(location.search).has("source-library");
w.store = useStore;
const callbacks = new Map();
const listeners = new Map();
const project = { id: "p", name: "引用布局合成验收", kind: "blank", workspace_path: "blank:p", asset_count: 5,
  title_source: "manual", created_at: 1, updated_at: 1 };
if (new URLSearchParams(location.search).has("provisional") && !sessionStorage.getItem("reference-fixture")) Object.assign(project, { provisional: true, title_source: "default" });
const canvas = { projectId: "p", draftJson: "{}", createdAt: 1, updatedAt: 1 };
const base = { projectId: "p", threadId: "t", hiddenAt: null, positionLocked: false, createdAt: 1, updatedAt: 1,
  width: 190, height: 180, zIndex: 1, role: "reference", kind: "asset", assetId: "existing" };
const image = (color: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="190" height="150"><rect width="190" height="150" fill="${color}"/></svg>`)}`;
const assets = ["existing", "a", "b", "c", "d"].map((id, i) => ({ id, name: `合成参考 ${id}`, width: 190, height: 150,
  ...(sourceLibrary ? { thumb_path: image(["#64748b", "#0369a1", "#4f46e5", "#0d9488", "#9333ea"][i]) } : {}),
  store_path: image(["#64748b", "#0369a1", "#4f46e5", "#0d9488", "#9333ea"][i]), source: "imported" }));
if (explorer) assets.push({ ...assets[1], id: "collected", name: "网页采集图片", source: "extension" });
if (sessionStorage.getItem("canvas-media-dimensions")) {
  for (const [id, width, height] of [["a", 1600, 400], ["b", 400, 1600]] as const) {
    const asset = assets.find(asset => asset.id === id)!;
    Object.assign(asset, { width, height, store_path: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#64748b"/></svg>`)}` });
  }
}
assets.push(...JSON.parse(sessionStorage.getItem("reference-drafts") || "[]"));
const payload = (id: string) => JSON.stringify({ schema_version: 1, snapshot: { name: `合成参考 ${id}`, width: 190, height: 150 } });
let snapshot = JSON.parse(sessionStorage.getItem("reference-fixture") || "null") || {
  canvas, nodes: [{ ...base, id: "old", x: 400, y: 300, payloadJson: payload("existing") },
    { ...base, id: "far", kind: "note", role: null, assetId: null, x: 20000, y: 88, payloadJson: '{"schema_version":1,"text":"远处既有节点"}' }],
  edges: [], groups: [], groupItems: [], threads: [{ id: "t", projectId: "p", title: "合成线程", archivedAt: null }],
  executionLinks: [], view: { projectId: "p", panX: 100, panY: 60, zoom: 0.9, sourcePanelWidth: 300, viewMode: "canvas", timelineScope: "all" },
};
w.calls = [];
w.snapshot = () => structuredClone(snapshot);
w.save = () => {
  sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  sessionStorage.setItem("reference-drafts", JSON.stringify(assets.filter(asset => asset.source === "annotation")));
};
w.emitChange = () => {
  for (const [handler, event] of listeners) if (event === "creative://changed") callbacks.get(handler)?.({ event, id: handler, payload: { projectId: "p" } });
};
w.emitAssetsChanged = () => {
  for (const [handler, event] of listeners) if (event === "library://assets-changed") callbacks.get(handler)?.({ event, id: handler, payload: null });
};
w.launch = (agent = false) => {
  const prompt = { ...base, id: agent ? "agent-prompt:launch:0:0" : "gen-prompt:job:turn:0", kind: "prompt", role: null, assetId: null,
    x: 20264, y: 70, width: 260, height: 148, createdAt: 2, payloadJson: JSON.stringify({ schema_version: 1, text: "用这些图片生成海报", status: "running", provider: "jimeng", ...(agent ? {} : { job_id: "job", turn_key: "turn" }) }) };
  const refs = ["a", "b", "c", "d"].map((id, i) => ({ ...base, id: `${agent ? "agent-reference:launch:0" : "gen-reference:job:turn"}:${i}`, assetId: id,
    x: 20002, y: 88 + i * 42, height: 180, createdAt: 2, payloadJson: payload(id) }));
  snapshot.nodes.push(prompt, ...refs);
  snapshot.edges.push(...[snapshot.nodes[0], ...refs].map((ref, i) => ({ id: `input-${i}`, projectId: "p", threadId: "t", fromNodeId: ref.id,
    toNodeId: prompt.id, kind: "input", ordinal: i, createdAt: 2 })));
  w.emitChange();
};
w.addAgentGroup = () => {
  const prompt = snapshot.nodes.find((n: any) => n.id.startsWith("agent-prompt:"));
  const group = { ...base, id: "agent-group:run:0:0", kind: "agent_group", role: null, assetId: null,
    x: 20300, y: 88, width: 286, height: 184, createdAt: 3,
    payloadJson: JSON.stringify({ schema_version: 1, run_id: "run", skill_id: "bowerbird-unified-agent", status: "running" }) };
  snapshot.nodes.push(group);
  snapshot.edges.push({ id: "run-edge", projectId: "p", threadId: "t", fromNodeId: prompt.id, toNodeId: group.id, kind: "input", ordinal: 0, createdAt: 3 });
  w.emitChange();
};
w.__TAURI_INTERNALS__ = {
  transformCallback: (callback: any) => { const id = callbacks.size + 1; callbacks.set(id, callback); return id; },
  convertFileSrc: (path: string) => path,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  invoke: async (command: string, args: any) => {
    w.calls.push({ command, args });
    if (command === "plugin:event|listen") { listeners.set(args.handler, args.event); return args.handler; }
    if (command === "list_projects") return explorer ? [project, { ...project, id: "q", name: "另一个项目" }] : [project];
    if (command === "project_canvas_get") return args.projectId === "q"
      ? { ...structuredClone(snapshot), canvas: { ...canvas, projectId: "q" }, nodes: [], edges: [], groups: [], groupItems: [], threads: [], view: null }
      : structuredClone(snapshot);
    if (command === "capture_source_browser_image") {
      if (w.holdCapture) await new Promise(resolve => { w.releaseCapture = resolve; });
      if (w.failCapture) throw "模拟采集失败";
      return assets.find(asset => asset.id === "collected");
    }
    if (command === "project_canvas_node_create") {
      if (w.failNodeSave) throw "模拟草稿卡片保存失败";
      const node = { ...args.value, hiddenAt: null, createdAt: 10, updatedAt: 10 };
      snapshot.nodes.push(node); return node;
    }
    if (command === "project_canvas_note_update") {
      if (w.failNoteSave) throw "模拟文本保存失败";
      const node = snapshot.nodes.find((n: any) => n.id === args.nodeId);
      node.payloadJson = args.payloadJson; return structuredClone(node);
    }
    if (command === "project_canvas_node_update") {
      const node = snapshot.nodes.find((n: any) => n.id === args.nodeId);
      Object.assign(node, args.value); return structuredClone(node);
    }
    if (command === "project_canvas_node_remove") {
      const node = snapshot.nodes.find((n: any) => n.id === args.nodeId);
      if (node) node.hiddenAt = 20;
      return null;
    }
    if (command === "project_canvas_node_restore") {
      const node = snapshot.nodes.find((n: any) => n.id === args.nodeId);
      if (!node) return false;
      node.hiddenAt = null;
      return true;
    }
    if (command === "project_canvas_group_update") {
      const group = snapshot.groups.find((g: any) => g.id === args.value.id);
      Object.assign(group, args.value); return structuredClone(group);
    }
    if (command === "project_canvas_view_upsert" || command === "project_canvas_view_flush") {
      if (w.holdViewSave) await new Promise(resolve => { w.releaseViewSave = resolve; });
      if (w.failViewSave) throw "模拟画板保存失败";
      snapshot.view = { ...args.value }; return snapshot.view;
    }
    if (command === "get_assets_by_ids") return assets.filter(a => args.assetIds.includes(a.id));
    if (command === "delete_asset_with_mode") {
      if (w.failAssetDelete) throw "模拟删除失败";
      for (const node of snapshot.nodes) {
        if (node.assetId === args.id && (args.mode === "delete" || node.projectId === args.projectId)) {
          node.hiddenAt = 20;
          if (args.mode === "delete") node.assetId = null;
        }
      }
      if (args.mode === "delete") {
        const index = assets.findIndex(asset => asset.id === args.id);
        if (index >= 0) assets.splice(index, 1);
      }
      w.emitAssetsChanged();
      return { deleted_assets: args.mode === "delete" ? 1 : 0, removed_members: args.mode === "keep" ? 1 : 0, moved_files: 0, failed_moves: [] };
    }
    if (command === "save_annotated_image") {
      if (w.failDraftSave) throw "模拟草稿保存失败";
      const asset = { id: `draft-${assets.length}`, name: args.fileName, ext: "png", width: 1600, height: 1200,
        store_path: args.dataUrl, source: "annotation" };
      assets.push(asset);
      return asset;
    }
    if (command === "read_image_data_url") return args.path;
    if (command === "project_canvas_ensure") return canvas;
    if (command === "list_generation_groups") return {};
    if (sourceLibrary && command === "list_assets") return assets;
    if (command === "count_assets") return 0;
    if (command.startsWith("list_")) return [];
    return null;
  },
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
useStore.setState({ projects: (explorer ? [project, { ...project, id: "q", name: "另一个项目" }] : [project]) as any, activeProjectId: "p", assets: assets as any, boardOpen: false, settings: {} as any });
function Fixture() {
  const projectId = useStore(state => state.activeProjectId)!;
  const [exploring, setExploring] = React.useState(explorer);
  const [toolbarCanvasMode, setToolbarCanvasMode] = React.useState(true);
  w.setToolbarCanvasMode = setToolbarCanvasMode;
  w.setExploring = setExploring;
  const canvas = <React.Profiler id="canvas" onRender={() => { w.canvasCommits = (w.canvasCommits || 0) + 1; }}>
    <CanvasWorkspace key={projectId} projectId={projectId} exploring={exploring} />
  </React.Profiler>;
  return <div className="app-shell" style={{ display: "flex", height: "100vh" }}>
    {sourceLibrary ? <div className="flex min-w-0 flex-1 flex-col">
      <Toolbar canvasMode={toolbarCanvasMode} onCanvasModeChange={setToolbarCanvasMode} onCreateCreative={() => {}} onRefresh={async () => {}} />
      <div className="flex min-h-0 flex-1">{canvas}</div>
    </div> : explorer ? <ExploreWorkspace url="https://www.pinterest.com/" open={exploring} onClose={() => setExploring(false)}>{canvas}</ExploreWorkspace> : canvas}
    <AssetContextMenu /><ImageAnnotator /><ToastViewport />
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
