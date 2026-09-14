import React from "react";
import { createRoot } from "react-dom/client";
import { CanvasWorkspace } from "../../../src/components/CanvasWorkspace";
import { AssetContextMenu } from "../../../src/components/AssetContextMenu";
import { useStore } from "../../../src/store";
import { ToastViewport } from "../../../src/components/ToastViewport";
import "../../../src/styles.css";
import { OnboardingTour } from "../../../src/components/OnboardingTour";
import { useOnboarding } from "../../../src/lib/onboardingStore";
import { CaptionRing } from "../../../src/components/creation/CaptionRing";
import { Sidebar } from "../../../src/components/Sidebar";
import { AccountOnboarding } from "../../../src/components/AccountOnboarding";
import { SettingsDialog } from "../../../src/components/SettingsDialog";

// Closed synthetic IPC fixture: never reads a library or invokes a provider.
const w = window as any;
w.store = useStore;
w.lesson = useOnboarding;
const callbacks = new Map();
const listeners = new Map();
const folders = [{id:'existing-folder', name:'已有品牌集合', kind:'folder'}, {id:'favorite', name:'收藏夹不属于集合', kind:'collection'}];
const project = JSON.parse(sessionStorage.getItem("lesson-project") || "null") || { id: "p", name: "入门引导合成验收", kind: "blank", workspace_path: "blank:p", asset_count: 2,
  title_source: "manual", created_at: 1, updated_at: 1 };
const canvas = { projectId: project.id, draftJson: "{}", createdAt: 1, updatedAt: 1 };
const image = (color: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="190" height="150"><rect width="190" height="150" fill="${color}"/></svg>`)}`;
const assets = ["existing", "a"].map((id, i) => ({ id, name: `合成参考 ${id}`, width: 190, height: 150,
  store_path: image(["#64748b", "#0369a1", "#4f46e5", "#0d9488", "#9333ea"][i]), source: "imported" }));
let snapshot = JSON.parse(sessionStorage.getItem("reference-fixture") || "null") || {
  canvas, nodes: [],
  edges: [], groups: [], groupItems: [], threads: [{ id: "t", projectId: "p", title: "合成线程", archivedAt: null }],
  executionLinks: [], view: { projectId: "p", panX: 100, panY: 60, zoom: 0.9, sourcePanelWidth: 300, viewMode: "canvas", timelineScope: "all" },
};
w.calls = [];
w.snapshot = () => structuredClone(snapshot);
w.save = () => sessionStorage.setItem("reference-fixture", JSON.stringify(snapshot));
for (const asset of assets) Object.assign(asset, { thumb_path: asset.store_path, ext: 'png', sections: [{ id: 'palette-' + asset.id, title: "色调", body: "以蓝色和奶油白为主色，保留柔和的明暗层次。" }] });
w.persistLesson = () => { w.save(); sessionStorage.setItem("lesson-project", JSON.stringify(project)); };
w.__TAURI_INTERNALS__ = {
  transformCallback: (callback: any) => { const id = callbacks.size + 1; callbacks.set(id, callback); return id; },
  convertFileSrc: (path: string) => path,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  invoke: async (command: string, args: any) => {
    w.calls.push({ command, args });
    if (command === "plugin:event|listen") { listeners.set(args.handler, args.event); return args.handler; }
    if (command === "create_onboarding_project") {
      if (w.failSample) throw "模拟示例缺失";
      if (w.holdSample) await new Promise(resolve => { w.releaseSample = resolve; });
      Object.assign(project, { id: args.projectId, name: "我的第一次创作" });
      canvas.projectId = project.id; snapshot.canvas.projectId = project.id;
      snapshot.nodes = []; snapshot.edges = [];
      return { project, imported_count: 2, member_count: 2 };
    }
    if (command === "get_prompted_asset") return assets.find(a => a.id === args.assetId);
    if (command === "create_folder") {
      if (w.failCollection) throw '模拟集合创建失败';
      const id = 'new-collection';
      folders.push({ id, name: args.name, kind:'folder' });
      return id;
    }
    if (command === "list_folders") {
      if (w.failFolders) throw '模拟集合列表加载失败';
      return folders;
    }
    if (command === "list_library_view") return {assets:[], memberships:[], total:0};
    if (command === "list_projects") return w.missingProject ? [] : [project];
    if (command === "project_canvas_get") return structuredClone(snapshot);
    if (command === "project_canvas_node_create") {
      const node = { ...args.value, hiddenAt: null, createdAt: 10, updatedAt: 10 };
      snapshot.nodes.push(node); return node;
    }
    if (command === "project_canvas_update_draft") {
      if (w.failSave) throw '模拟保存失败';
      snapshot.canvas.draftJson = args.draftJson; return snapshot.canvas;
    }
    if (command === "project_canvas_node_update") {
      const node = snapshot.nodes.find((n: any) => n.id === args.nodeId);
      Object.assign(node, args.value); return structuredClone(node);
    }
    if (command === "project_canvas_group_update") {
      const group = snapshot.groups.find((g: any) => g.id === args.value.id);
      Object.assign(group, args.value); return structuredClone(group);
    }
    if (command === "project_canvas_view_upsert" || command === "project_canvas_view_flush") { snapshot.view = { ...args.value }; return snapshot.view; }
    if (command === "get_assets_by_ids") return assets.filter(a => args.assetIds.includes(a.id));
    if (command === "project_canvas_ensure") return canvas;
    if (command === "list_generation_groups") return {};
    if (command === "count_assets") return 0;
    if (command.startsWith("list_")) return [];
    return null;
  },
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
useStore.setState({ folders: folders as any, projects: [project] as any, activeProjectId: project.id, assets: assets as any, promptedAssets: assets as any, promptedAssetsLoaded: true, boardOpen: true, settings: {} as any });
if (useOnboarding.getState().progress.status === "new") useOnboarding.getState().show("welcome");
function Fixture() {
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const projectId = useStore(state => state.activeProjectId)!;
  const navigation = useStore(state => state.creativeNavigation);
  // The full App normally consumes task navigation; this isolated shell already
  // displays the requested project and only acknowledges that local navigation.
  React.useEffect(() => { if (navigation) useStore.getState().clearCreativeNavigation(); }, [navigation]);
  return <div className="app-shell" style={{ display: "flex", height: "100vh" }}>
    <Sidebar />
    <CanvasWorkspace key={projectId} projectId={projectId} />
    <div style={{ position: "fixed", top: 0, left: 400, zIndex: 49 }}>
      <button onClick={() => useStore.getState().setAccountOnboardingForceOpen(true)}>测试登录入口</button>
      <button onClick={() => setSettingsOpen(true)}>测试设置入口</button>
    </div>
    <AccountOnboarding />{settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    <AssetContextMenu /><ToastViewport /><CaptionRing /><OnboardingTour />
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
