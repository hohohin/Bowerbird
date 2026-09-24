import React from "react";
import { createRoot } from "react-dom/client";
import { CanvasWorkspace } from "../../../src/components/CanvasWorkspace";
import { AssetContextMenu } from "../../../src/components/AssetContextMenu";
import { ImageAnnotator } from "../../../src/components/ImageAnnotator";
import { useStore } from "../../../src/store";
import { ExploreWorkspace } from "../../../src/components/ExploreWorkspace";
import { ToastViewport } from "../../../src/components/ToastViewport";
import { VisualProfileDialog } from "../../../src/components/VisualProfileDialog";
import { Toolbar } from "../../../src/components/Toolbar";
import { SettingsDialog } from "../../../src/components/SettingsDialog";
import "../../../src/styles.css";

// Closed synthetic IPC fixture: never reads a library or invokes a provider.
const w = window as any;
const explorer = new URLSearchParams(location.search).has("explorer");
const sourceLibrary = new URLSearchParams(location.search).has("source-library");
const canvasLibrary = new URLSearchParams(location.search).has("canvas-library");
const strictCanvas = new URLSearchParams(location.search).has("strict-canvas");
let canvasExists = !strictCanvas;
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
if (canvasLibrary) {
  const hidden: string[] = JSON.parse(sessionStorage.getItem("canvas-only-assets") || "[]");
  for (const asset of assets) Object.assign(asset, { ext: "svg", library_hidden: hidden.includes(asset.id) });
}
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
w.launch = (agent = false, withReferences = true) => {
  const prompt = { ...base, id: agent ? "agent-prompt:launch:0:0" : "gen-prompt:job:turn:0", kind: "prompt", role: null, assetId: null,
    x: 20264, y: 70, width: 260, height: 148, createdAt: 2, payloadJson: JSON.stringify({ schema_version: 1, text: "用这些图片生成海报", status: "running", provider: "jimeng", ...(agent ? {} : { job_id: "job", turn_key: "turn" }) }) };
  const refs = (withReferences ? ["a", "b", "c", "d"] : []).map((id, i) => ({ ...base, id: `${agent ? "agent-reference:launch:0" : "gen-reference:job:turn"}:${i}`, assetId: id,
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
    if (command === "project_canvas_materialize") {
      canvasExists = true;
      Object.assign(project, { provisional: false });
      return canvas;
    }
    if (strictCanvas && command === "project_canvas_get" && !canvasExists) {
      w.earlyCanvasReads = (w.earlyCanvasReads ?? 0) + 1;
      throw `not found: project canvas ${args.projectId}`;
    }
    if (strictCanvas && command === "canvas_workflow_save" && !canvasExists) throw "project not materialized";
    if (command === "canvas_workflow_get") return JSON.parse(sessionStorage.getItem(`workflow-${args.projectId}`) || '{"revision":0,"document":{"schema_version":1,"nodes":[],"run":null}}');
    if (command === "workflow_templates_list") return JSON.parse(sessionStorage.getItem('workflow-template-library') || '[]');
    if (command === "workflow_template_save") {
      if (w.failTemplateSave) throw '模拟模板保存失败';
      const library = JSON.parse(sessionStorage.getItem('workflow-template-library') || '[]');
      const old = library.find((item: any) => item.id === args.document.id);
      if ((old?.revision ?? 0) !== args.expectedRevision) throw 'template revision conflict';
      const saved = { ...args.document, revision: args.expectedRevision + 1 };
      sessionStorage.setItem('workflow-template-library', JSON.stringify([...library.filter((item: any) => item.id !== saved.id), saved])); return saved;
    }
    if (command === "workflow_template_delete") {
      const library = JSON.parse(sessionStorage.getItem('workflow-template-library') || '[]');
      if (!library.some((item: any) => item.id === args.id && item.revision === args.expectedRevision)) throw 'template revision conflict';
      sessionStorage.setItem('workflow-template-library', JSON.stringify(library.filter((item: any) => item.id !== args.id))); return;
    }
    if (command === "plugin:dialog|save" && String(args.options?.defaultPath ?? '').endsWith('.bbworkflow.json')) return 'isolated-share.bbworkflow.json';
    if (command === "workflow_template_export") {
      const library = JSON.parse(sessionStorage.getItem('workflow-template-library') || '[]');
      sessionStorage.setItem('workflow-template-export', JSON.stringify(library.find((item: any) => item.id === args.id))); return;
    }
    if (command === "canvas_workflow_save") {
      if (w.failWorkflowSave) throw "模拟工作流保存失败";
      const revision = args.revision + 1;
      sessionStorage.setItem(`workflow-${args.projectId}`, JSON.stringify({ revision, document: args.document })); return revision;
    }
    if (command === "generation_history") return { turns: [{ prompt: "保持产品主体，生成清晨场景" }], references: [assets[0]] };
    if (command === "project_thread_create") return args.value;
    if (command === "get_settings") return JSON.parse(sessionStorage.getItem("canvas-settings") || "{}");
    if (command === "update_settings") { sessionStorage.setItem("canvas-settings", JSON.stringify(args.settings)); return null; }
    if (command === "plugin:event|listen") { listeners.set(args.handler, args.event); return args.handler; }
    if (command === "plugin:event|emit") {
      for (const [handler, event] of listeners) if (event === args.event) callbacks.get(handler)?.({ event, id: handler, payload: args.payload });
      return null;
    }
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
    if (command === "project_canvas_group_create") {
      const group = { ...args.value, createdAt: 10, updatedAt: 10 };
      snapshot.groups.push(group);
      snapshot.groupItems.push(...args.nodeIds.map((nodeId: string, ordinal: number) => ({ groupId: group.id, nodeId, ordinal })));
      return structuredClone(group);
    }
    if (command === "project_canvas_group_set_items") {
      snapshot.groupItems = snapshot.groupItems.filter((item: any) => item.groupId !== args.groupId);
      const items = args.nodeIds.map((nodeId: string, ordinal: number) => ({ groupId: args.groupId, nodeId, ordinal }));
      snapshot.groupItems.push(...items);
      return structuredClone(items);
    }
    if (command === "project_canvas_group_update") {
      const group = snapshot.groups.find((g: any) => g.id === args.value.id);
      Object.assign(group, args.value); return structuredClone(group);
    }
    if (command === "project_canvas_group_delete") {
      snapshot.groups = snapshot.groups.filter((group: any) => group.id !== args.groupId);
      snapshot.groupItems = snapshot.groupItems.filter((item: any) => item.groupId !== args.groupId);
      return true;
    }
    if (command === "project_canvas_view_upsert" || command === "project_canvas_view_flush") {
      if (w.holdViewSave) await new Promise(resolve => { w.releaseViewSave = resolve; });
      if (w.failViewSave) throw "模拟画板保存失败";
      snapshot.view = { ...args.value }; return snapshot.view;
    }
    if (command === "get_assets_by_ids") return assets.filter(a => args.assetIds.includes(a.id));
    if (command === "set_canvas_asset_library_visibility") {
      if (w.failLibraryVisibility) throw "模拟归属修改失败";
      const asset = assets.find(asset => asset.id === args.assetId);
      if (!asset || !snapshot.nodes.some((node: any) => node.projectId === args.projectId && node.assetId === args.assetId && node.hiddenAt == null)) throw "请先将图片拖到当前画布";
      Object.assign(asset, { library_hidden: !args.visible });
      sessionStorage.setItem("canvas-only-assets", JSON.stringify(assets.filter((asset: any) => asset.library_hidden).map(asset => asset.id)));
      useStore.setState({ assets: assets.filter((asset: any) => !asset.library_hidden) as any });
      w.emitAssetsChanged();
      return null;
    }
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
    if (command === "import_image_bytes" && args.source === "workflow-template") {
      const asset = { ...assets[0], id: `template-${assets.length}`, name: args.fileName, store_path: args.dataUrl, source: args.source };
      assets.push(asset); return asset;
    }
    if (command === "read_image_data_url") return w.templateImageData ?? args.path;
    if (command === "project_canvas_ensure") {
      if (strictCanvas) await new Promise(resolve => setTimeout(resolve, 150));
      canvasExists = true;
      return canvas;
    }
    if (command === "list_generation_groups") return {};
    if (canvasLibrary && command === "list_projects") return [{ ...project, asset_count: assets.filter((asset: any) => !asset.library_hidden).length }];
    if (sourceLibrary && command === "list_assets") return assets.filter((asset: any) => !asset.library_hidden);
    if (command === "count_assets") return 0;
    if (command.startsWith("list_")) return [];
    return null;
  },
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
useStore.setState({ projects: (explorer ? [project, { ...project, id: "q", name: "另一个项目" }] : [project]) as any, activeProjectId: "p", assets: assets.filter((asset: any) => !asset.library_hidden) as any, boardOpen: false, settings: JSON.parse(sessionStorage.getItem("canvas-settings") || "{}") });
function Fixture() {
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  w.openSettings = () => setSettingsOpen(true);
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
    <AssetContextMenu /><ImageAnnotator /><ToastViewport /><VisualProfileDialog />{settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
