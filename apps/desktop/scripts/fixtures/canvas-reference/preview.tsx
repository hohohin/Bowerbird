import { installCatalogPagingMock } from "../catalogPagingMock";
import { installMediaImportMock } from "../mediaImportMock";
import { FileDropImport } from "../../../src/components/FileDropImport";
import { LibraryHome } from "../../../src/components/LibraryHome";
import React from "react";
import { createRoot } from "react-dom/client";
import { CanvasWorkspace } from "../../../src/components/CanvasWorkspace";
import { AssetContextMenu } from "../../../src/components/AssetContextMenu";
import { ImageAnnotator } from "../../../src/components/ImageAnnotator";
import { useStore } from "../../../src/store";
import { ExploreWorkspace } from "../../../src/components/ExploreWorkspace";
import { ToastViewport } from "../../../src/components/ToastViewport";
import { VisualProfileDialog } from "../../../src/components/VisualProfileDialog";
import { useLocalFileMode } from "../../../src/lib/localFileMode";
import { Toolbar } from "../../../src/components/Toolbar";
import { SettingsDialog } from "../../../src/components/SettingsDialog";
import App from "../../../src/App";
import { useOnboarding } from "../../../src/lib/onboardingStore";
import "../../../src/styles.css";
import "../../../src/components/TacticalProjection.css";
import "../../../src/components/TacticalDialogs.css";
import "../../../src/components/CanvasSecondaryTactical.css";
import "../../../src/components/MediaTactical.css";
import "../../../src/components/ManagementTactical.css";
import "../../../src/components/TacticalMenus.css";
import "../../../src/components/IndustrialTheme.css";
import "../../../src/components/IndustrialCanvas.css";
import "../../../src/components/IndustrialMenus.css";

// Closed synthetic IPC fixture: never reads a library or invokes a provider.
const w = window as any;
const mediaImport = new URLSearchParams(location.search).has("media-import");
const mediaHome = new URLSearchParams(location.search).has("media-home");
const explorer = new URLSearchParams(location.search).has("explorer");
const localFiles = new URLSearchParams(location.search).has("local-files");
const sourceLibrary = new URLSearchParams(location.search).has("source-library");
const canvasLibrary = new URLSearchParams(location.search).has("canvas-library");
const strictCanvas = new URLSearchParams(location.search).has("strict-canvas");
const detailRoute = new URLSearchParams(location.search).has("detail-route");
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
if (detailRoute) assets.push(...Array.from({ length: 60 }, (_, index) => ({ ...assets[0], id: `detail-${index}`, name: `返回位置测试 ${index}` })));
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
const fileChanges = new Map<string, { path: string; name: string } | null>();
const currentFiles = (entries: any[]) => entries.flatMap(entry => fileChanges.has(entry.path)
  ? fileChanges.get(entry.path) ? [{ ...entry, ...fileChanges.get(entry.path) }] : [] : [entry]);
w.snapshot = () => structuredClone(snapshot);
w.save = () => {
  sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
  sessionStorage.setItem("reference-drafts", JSON.stringify(assets.filter(asset => asset.source === "annotation" || asset.source === "external" || asset.source === "video-frame" || asset.ext === "mp4")));
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
    if (detailRoute) {
      if (command === "create_blank_project") {
        w.libraryProject = { ...project, id: "library-project", name: args.name, workspace_path: "/BowerbirdLibrary/项目/library-project", asset_count: 0 };
        return { project: w.libraryProject, imported_count: 0, member_count: 0 };
      }
      if (command === "add_assets_to_project") {
        w.libraryMembers = args.assetIds;
        for (const asset of assets) if (args.assetIds.includes(asset.id)) Object.assign(asset, { library_hidden: false });
        w.libraryProject.asset_count = args.assetIds.length;
        return args.assetIds.length;
      }
      if (command === "list_projects") return [project, ...(w.libraryProject ? [w.libraryProject] : [])];
      if (command === "project_canvas_get" && args.projectId === "library-project") return {
        ...structuredClone(snapshot), canvas: { ...canvas, projectId: args.projectId }, nodes: [], edges: [], groups: [], groupItems: [], threads: [], view: null,
      };
      if (command === "list_library_view") return { assets, memberships: [], total: assets.length };
      if (command === "generation_history") return { turns: [], references: [] };
      if (command === "layer_workspace_asset_ids") return [];
      if (command === "palette_overview") return [];
      if (command === "codex_health" || command === "dreamina_health") return { ok: false };
    }
    if (command === "file_workspace_status") return { config: { root: null, places: [], projects: {} }, proposed_root: "/BowerbirdLibrary" };
    if (command === "file_workspace_all") return {entries:currentFiles([
      {name:"原图.png",path:"/pictures/original.png",directory:false},
      {name:"另一张.png",path:"/pictures/other.png",directory:false},
    ]),unavailable:[]};
    if (command === "global_classification_view") return {labels:[],pictures:[]};
    if (command === "local_classification_status") return {busy:false,installed:true,supported:true,model:"qwen",enabled:false,done:0,total:0,failed:0,message:"",last_error:"",current_asset:null,jev_progress:null};
    if (command === "local_classification_labels") return [];
    if (command === "project_classification_labels") return [{id:"project-label",name:"插画",description:"共享规则",enabled:true,count:1,has_examples:false}];
    if (command === "project_classification_start") return null;
    if (command === "file_workspace_prepare") return args.projectId ? `/BowerbirdLibrary/项目/${args.projectId}` : "/BowerbirdLibrary";
    if ((localFiles || sourceLibrary) && command === "external_files_browse") {
      if (args.path === "/missing") throw "目录不存在";
      const path = args.path || "/pictures";
      return { path, parent: path === "/" ? null : "/", total: 3, entries: currentFiles([
        { name: "旅行", path: "/pictures/travel", directory: true },
        { name: "原图.png", path: `${path}/original.png`, directory: false },
        { name: "另一张.png", path: `${path}/other.png`, directory: false },
      ]) };
    }
    if ((localFiles || sourceLibrary) && command === "external_files_preview") return image("#68a4b5");
    if ((localFiles || sourceLibrary) && command === "folder_classification_view") return {root:args.path,record:{version:1,recursive:false,labels:[],pictures:[]}};
    if ((localFiles || sourceLibrary) && command === "external_files_media") return image("#68a4b5");
    if (localFiles && command === "external_files_index") {
      if (w.holdIndex) await new Promise(resolve => { w.releaseIndex = resolve; });
      if (w.failIndex) throw "原图片不可用";
      const id = args.path.endsWith("other.png") ? "external-other" : "external-original";
      let asset = assets.find(asset => asset.id === id);
      if (!asset) { asset = { id, name: id, width: 190, height: 150, store_path: image("#68a4b5"), thumb_path: image("#68a4b5"), source: "external" }; Object.assign(asset, { ext: "png" }); assets.push(asset); }
      Object.assign(asset, { library_hidden: !w.libraryMembers?.includes(id) }); return asset;
    }
    if (localFiles && command === "local_file_rename") {
      if (w.failFileRename) throw "同名文件已存在";
      const path = args.path.replace(/[^/]+$/, args.name + '.png');
      fileChanges.set(args.path, { path, name: args.name + '.png' });
      Object.assign(assets.find(asset => asset.id === args.assetId)!, { name: args.name });
      w.emitAssetsChanged(); return null;
    }
    if (localFiles && command === "local_file_delete") {
      if (w.failFileDeleteId === args.assetId) throw "文件正在使用中";
      const original = [...fileChanges].find(([, value]) => value?.path === args.path)?.[0] ?? args.path;
      fileChanges.set(original, null);
      const index = assets.findIndex(asset => asset.id === args.assetId);
      if (index >= 0) assets.splice(index, 1);
      w.emitAssetsChanged(); return null;
    }
    if (localFiles && command === "external_files_references") return assets.filter(asset => asset.source === "external" && snapshot.nodes.some((node: any) => node.assetId === asset.id)).map(asset => ({ asset, status: w.referenceStatus || "available" }));
    if (localFiles && command === "external_files_copy") { const asset = assets.find(asset => asset.id === args.assetId)!; Object.assign(asset, { source: "imported", library_hidden: false }); return asset; }
    if (localFiles && command === "external_files_update") { w.referenceStatus = "available"; return assets.find(asset => asset.id === args.assetId); }
    if (localFiles && command === "plugin:dialog|open") return w.dialogPath ?? null;
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
    if (command === "workflow_encapsulate") {
      if (w.failEncapsulate) throw '模拟封装失败';
      if (args.template && w.failTemplateSave) throw '模拟模板保存失败';
      const saved = JSON.parse(sessionStorage.getItem(`workflow-${args.projectId}`) || '{"revision":0,"document":{"schema_version":1,"nodes":[],"run":null}}');
      if (saved.revision !== args.revision) throw 'workflow revision conflict';
      const library = JSON.parse(sessionStorage.getItem('workflow-template-library') || '[]');
      if (args.template && (library.find((t: any) => t.id === args.template.id)?.revision ?? 0) !== args.template.revision) throw 'template revision conflict';
      const wanted = new Set(args.members);
      const rectangles = [...snapshot.nodes.filter((n: any) => n.hiddenAt == null && JSON.parse(n.payloadJson).note_type !== 'section'), ...snapshot.groups,
        ...saved.document.nodes.filter((n: any) => n.kind !== 'text').map((n: any) => ({ width: 320, height: 400, ...args.bounds.find((b: any) => b.id === n.id), ...n }))];
      const members = rectangles.filter((n: any) => wanted.has(n.id));
      if (members.length !== wanted.size) throw 'missing member';
      const left = Math.min(...members.map((n: any) => n.x)) - 32, top = Math.min(...members.map((n: any) => n.y)) - 64;
      const right = Math.max(...members.map((n: any) => n.x + n.width)) + 32, bottom = Math.max(...members.map((n: any) => n.y + n.height)) + 32;
      const collision = rectangles.some((n: any) => !wanted.has(n.id) && n.x < right && n.x + n.width > left && n.y < bottom && n.y + n.height > top);
      const dx = collision ? Math.max(right, ...rectangles.map((n: any) => n.x + n.width)) + 80 - left : 0;
      for (const n of [...snapshot.nodes, ...snapshot.groups, ...saved.document.nodes]) if (wanted.has(n.id)) n.x += dx;
      for (const n of snapshot.nodes) if (n.kind === 'note') {
        const note = JSON.parse(n.payloadJson);
        if (note.note_type === 'section') { note.member_ids = note.member_ids.filter((id: string) => !wanted.has(id)); n.payloadJson = JSON.stringify(note); if (note.workflow_container && !note.member_ids.length) n.hiddenAt = 20; }
      }
      const containerId = crypto.randomUUID();
      snapshot.nodes.push({ id: containerId, projectId: args.projectId, threadId: null, kind: 'note', assetId: null, role: null, x: left + dx, y: top, width: right - left, height: bottom - top,
        zIndex: 0, positionLocked: false, hiddenAt: null, createdAt: 10, updatedAt: 10, payloadJson: JSON.stringify({ schema_version: 1, note_type: 'section', workflow_container: true, text: args.name, cells: [], member_ids: args.members }) });
      saved.revision++;
      sessionStorage.setItem(`workflow-${args.projectId}`, JSON.stringify(saved));
      const template = args.template ? { ...args.template, revision: args.template.revision + 1 } : null;
      if (template) sessionStorage.setItem('workflow-template-library', JSON.stringify([...library.filter((t: any) => t.id !== template.id), template]));
      return { ...saved, containerId, bounds: { x: left + dx, y: top, width: right - left, height: bottom - top }, template };
    }
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
    if (command === "plugin:dialog|save" && String(args.options?.defaultPath ?? '').endsWith('.bbworkflow.json')) return w.cancelTemplateExport ? null : 'isolated-share.bbworkflow.json';
    if (command === "workflow_template_export") {
      if (w.failTemplateExport) throw '模拟数据包导出失败';
      const library = JSON.parse(sessionStorage.getItem('workflow-template-library') || '[]');
      sessionStorage.setItem('workflow-template-export', JSON.stringify(args.document ?? library.find((item: any) => item.id === args.id))); return;
    }
    if (command === "canvas_workflow_save") {
      if (w.failWorkflowSave) throw "模拟工作流保存失败";
      if (args.createdContent && w.failNodeSave) throw "模拟内容卡片保存失败";
      const revision = args.revision + 1;
      if (args.createdContent && !snapshot.nodes.some((node: any) => node.id === args.createdContent.id)) snapshot.nodes.push({ ...args.createdContent, hiddenAt: null, createdAt: 10, updatedAt: 10 });
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
      if (args.mode === "delete") {
        for (const prompt of snapshot.nodes.filter((node: any) => node.kind === "prompt" && JSON.parse(node.payloadJson).job_id)) {
          const outputs = snapshot.edges.filter((edge: any) => edge.fromNodeId === prompt.id && edge.kind === "produced")
            .map((edge: any) => snapshot.nodes.find((node: any) => node.id === edge.toNodeId))
            .filter((node: any) => node?.kind === "asset" && node.role === "output");
          if (outputs.some((node: any) => node.assetId === args.id)
            && !outputs.some((node: any) => node.assetId !== args.id && assets.some(asset => asset.id === node.assetId))) {
            prompt.hiddenAt = 20;
          }
        }
      }
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
    if (command === "import_image_bytes" && args.source === "video-frame") {
      if (w.holdFrameImport) await new Promise(resolve => { w.releaseFrameImport = resolve; });
      if (w.failFrameImport) throw "模拟截帧入库失败";
      const image = new Image(); image.src = args.dataUrl; await image.decode();
      const asset = { id: `frame-${assets.length}`, name: args.fileName, ext: "png", width: image.naturalWidth, height: image.naturalHeight,
        store_path: args.dataUrl, thumb_path: args.dataUrl, source: args.source };
      assets.push(asset); return asset;
    }
    if (command === "trim_video") {
      if (w.failVideoTrim) throw "模拟裁剪失败，原视频未修改";
      if (w.holdVideoTrim) await new Promise(resolve => { w.releaseVideoTrim = resolve; });
      const original = assets.find(asset => asset.store_path === args.sourcePath);
      if (!original) throw "未找到视频";
      const result = await w.trimFixture(args);
      const asset = { ...original, ...result, id: args.overwrite ? original.id : `trim-${assets.length}`,
        name: args.overwrite ? original.name : `${original.name}-裁剪`, duration: args.end - args.start, source: "video-trim" };
      if (args.overwrite) Object.assign(original, asset); else assets.push(asset);
      return asset;
    }
    if (command === "read_image_data_url") return w.templateImageData ?? args.path;
    if (command === "project_canvas_ensure") {
      if (strictCanvas) await new Promise(resolve => setTimeout(resolve, 150));
      canvasExists = true;
      return canvas;
    }
    if (command === "list_generation_groups") return {};
    if ((sourceLibrary || localFiles) && command === "list_library_view") {
      const filter = args.filter ?? {};
      let visible = assets.filter((asset: any) => !asset.library_hidden);
      if (filter.search) visible = visible.filter(asset => asset.name.includes(filter.search));
      else if (filter.smart?.startsWith("tag:")) visible = filter.smart === "tag:插画" ? visible.filter(asset => asset.id === "existing") : [];
      else if (filter.folderId) visible = visible.filter(asset => asset.id === "existing");
      if (filter.smart === "source:generated" || filter.smart === "source:!generated") {
        visible = visible.filter((asset: any) => !!asset.generation_session_id === (filter.smart === "source:generated"));
      }
      return { assets: visible, total: assets.length, memberships: [] };
    }
    if (canvasLibrary && command === "list_projects") return [{ ...project, asset_count: assets.filter((asset: any) => !asset.library_hidden).length }];
    if (command === "palette_overview") {
      if (w.failPalette) throw "模拟色板失败";
      return w.testPalette ?? [];
    }
    if (command === "recompute_colors") return null;
    if (sourceLibrary && command === "list_tags") {
      if (w.failTags) throw "模拟标签加载失败";
      return w.testTags ?? [{ id: "tag-a", name: "插画", count: 2 }, { id: "tag-b", name: "建筑", count: 0 }];
    }
    if (sourceLibrary && command === "list_assets_smart") return args.query === "tag:插画" ? assets.slice(0, 1) : [];
    if (sourceLibrary && command === "search_assets") return assets.filter(asset => asset.name.includes(args.query));
    if (sourceLibrary && command === "list_assets") return assets.filter((asset: any) => !asset.library_hidden && (!args.folderId || asset.id === "existing") && (args.projectId !== "library-project" || w.libraryMembers?.includes(asset.id)));
    if (sourceLibrary && command === "count_assets") return assets.filter((asset: any) => !asset.library_hidden).length;
    if (command === "material_catalog") return { tags: [], collections: [], prompts: [] };
    if (command === "material_catalog_assets") return canvasLibrary ? assets.filter((asset: any) => !asset.library_hidden) : [];
    if (command === "count_assets") return 0;
    if (command.startsWith("list_")) return [];
    return null;
  },
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
useStore.setState({ projects: (explorer ? [project, { ...project, id: "q", name: "另一个项目" }] : [project]) as any, activeProjectId: "p", folders: sourceLibrary ? [{ id: "source-folder", name: "测试文件夹", kind: "folder" }] as any : [], assets: assets.filter((asset: any) => !asset.library_hidden) as any, boardOpen: false, settings: JSON.parse(sessionStorage.getItem("canvas-settings") || "{}") });
if (detailRoute) {
  useStore.setState({ loadSettings: async () => {}, loadCloudAccount: async () => {}, loadGenJobs: async () => {}, loadCloudAgentRuns: async () => {} });
  useOnboarding.setState(state => ({ guide: { ...state.guide, status: "skipped" }, progress: { ...state.progress, updateSeen: true } }));
}
if (mediaHome) useStore.setState({ activeProjectId: null });
function Fixture() {
  const folderMode = useLocalFileMode(s => s.open);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  w.openSettings = () => setSettingsOpen(true);
  const projectId = useStore(state => state.activeProjectId)!;
  const reuse = useStore(state => state.pendingCreativeReuse);
  const [exploring, setExploring] = React.useState(explorer);
  const [toolbarCanvasMode, setToolbarCanvasMode] = React.useState(true);
  w.setToolbarCanvasMode = setToolbarCanvasMode;
  w.setExploring = setExploring;
  const canvas = <React.Profiler id="canvas" onRender={() => { w.canvasCommits = (w.canvasCommits || 0) + 1; }}>
    <CanvasWorkspace key={projectId} projectId={projectId} exploring={exploring}
      launchRequest={reuse?.targetProjectId === projectId ? { id: reuse.id, projectId, assetIds: [], promptLoad: reuse.promptLoad } : null}
      onLaunchConsumed={id => useStore.getState().ackPendingCreativeReuse(id)} />
  </React.Profiler>;
  if (mediaHome) return <div className="app-shell" style={{ display: "flex", flexDirection: "column", height: "100vh" }}><FileDropImport />
    <Toolbar localFilesOpen={folderMode} canvasMode={false} onCanvasModeChange={() => {}} onCreateCreative={() => {}} onRefresh={async () => {}} />
    <main style={{ flex: 1, minHeight: 0 }}><LibraryHome /></main><ToastViewport /></div>;
  return <div className="app-shell" style={{ display: "flex", height: "100vh" }}>
    {mediaImport && <FileDropImport />}
    {sourceLibrary || localFiles ? <div className="flex min-w-0 flex-1 flex-col">
      <Toolbar localFilesOpen={folderMode} canvasMode={toolbarCanvasMode} onCanvasModeChange={setToolbarCanvasMode} onCreateCreative={() => {}} onRefresh={async () => {}} />
      <div className="flex min-h-0 flex-1">{canvas}</div>
    </div> : explorer ? <ExploreWorkspace url="https://www.pinterest.com/" open={exploring} onClose={() => setExploring(false)}>{canvas}</ExploreWorkspace> : canvas}
    <AssetContextMenu /><ImageAnnotator /><ToastViewport /><VisualProfileDialog />{settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
  </div>;
}
installCatalogPagingMock(window);
if (mediaImport) installMediaImportMock(w, assets);
createRoot(document.getElementById("root")!).render(new URLSearchParams(location.search).has("strict")
  ? <React.StrictMode>{detailRoute ? <App /> : <Fixture />}</React.StrictMode> : detailRoute ? <App /> : <Fixture />);
