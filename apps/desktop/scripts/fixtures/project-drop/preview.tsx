import { installCatalogPagingMock } from "../catalogPagingMock";
import React from "react";
import { createRoot } from "react-dom/client";
import { Toolbar } from "../../../src/components/Toolbar";
import { LibraryHome } from "../../../src/components/LibraryHome";
import { BatchBar } from "../../../src/components/BatchBar";
import { Sidebar } from "../../../src/components/Sidebar";
import { ToastViewport } from "../../../src/components/ToastViewport";
import { FileDropImport } from "../../../src/components/FileDropImport";
import { FileMediaCard } from "../../../src/components/FileMediaCard";
import { ProjectFolder } from "../../../src/components/ProjectFolder";
import { ProjectSection } from "../../../src/components/ProjectSection";
import { useProjectAssetDrop } from "../../../src/lib/useProjectAssetDrop";
import { setDragAssets } from "../../../src/lib/dragPayload";
import { useStore } from "../../../src/store";
import { useLocalFileMode } from "../../../src/lib/localFileMode";
import "../../../src/styles.css";
import "../../../src/components/LocalFileWorkspace.css";

// Closed synthetic IPC. Production components and drag payload; no user data or provider calls.
const w = window as any;
w.calls = []; w.fail = false;
localStorage.setItem("bowerbird.sidebarCollapsed", new URL(location.href).searchParams.has("rail") ? "1" : "0");
const image = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="#a5b5a0"/></svg>');
const assets = ["owned", "one", "two", "three"].map(id => ({ id, name: id, width: 240, height: 160, ext: "png", source: "imported", thumb_path: image, store_path: image }));
const projects = ["p", "q"].map((id, i) => ({ id, name: i ? "空项目" : "目标项目", kind: "blank", workspace_path: "blank:" + id, asset_count: i ? 0 : 1, created_at: 1, updated_at: 1 }));
let callbackId = 0;
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
w.__TAURI_INTERNALS__ = {
  transformCallback: () => ++callbackId,
  convertFileSrc: (path: string) => path,
  invoke: async (command: string, args: any) => {
    if (command === "plugin:event|listen") return args.handler;
    if (command === "plugin:event|unlisten") return null;
    if (command === "file_workspace_status") return { config: { root: null, places: [], projects: {} }, proposed_root: "/BowerbirdLibrary" };
    if (command === "file_workspace_all") return {entries:[],unavailable:[]};
    if (command === "global_classification_view") return {labels:[],pictures:[]};
    if (command === "external_files_browse") return { path: args.path || "/pictures", parent: null, entries: [], total: 0 };
    if (command === "folder_classification_view") return { root: args.path, storage: "folder", record: { version: 1, recursive: false, labels: [], pictures: [] } };
    w.calls.push({ command, args });
    if (command === "import_files") {
      const result = [];
      for (const path of args.sources) {
        const name = path.split(/[\\/]/).pop();
        if (name === "bad.png") throw "模拟图片损坏";
        if (w.holdImport) await new Promise(resolve => w.releaseImport = resolve);
        const asset = { ...assets[0], id: `connection-${w.calls.length}-${result.length}`, name, store_path: path, source: "external" };
        useStore.setState(s => ({ assets: [...s.assets, asset] as any, total: s.total + 1,
          libraryMemberships: args.projectId ? [...s.libraryMemberships, { projectId: args.projectId, assetId: asset.id }] : s.libraryMemberships }));
        result.push(asset);
      }
      return result;
    }
    if (command === "create_material_references") return;
    if (command === "import_image_bytes") {
      if (args.fileName === "bad.png") throw "模拟图片损坏";
      if (w.holdImport) await new Promise(resolve => w.releaseImport = resolve);
      const asset = { ...assets[0], id: `import-${w.calls.length}`, name: args.fileName };
      useStore.setState(s => ({ assets: [...s.assets, asset] as any, total: s.total + 1,
        libraryMemberships: args.projectId ? [...s.libraryMemberships, { projectId: args.projectId, assetId: asset.id }] : s.libraryMemberships }));
      return asset;
    }
    if (command === "add_assets_to_project") {
      if (w.fail) throw "模拟添加失败";
      if (w.hold) await new Promise(resolve => w.release = resolve);
      const previous = useStore.getState().libraryMemberships;
      const added = args.assetIds.filter((id: string) => !previous.some(m => m.projectId === args.projectId && m.assetId === id))
        .map((assetId: string) => ({ assetId, projectId: args.projectId }));
      const memberships = [...previous, ...added];
      // Mimic the normal library/projects changed-event refresh after the write.
      useStore.setState({ libraryMemberships: memberships, projects: projects.map(p => ({ ...p, asset_count: memberships.filter(m => m.projectId === p.id).length })) as any });
      return added.length;
    }
    if (command === "palette_overview") {
      if (w.failPalette) throw "模拟色板失败";
      return w.testPalette ?? [];
    }
    if (command === "recompute_colors") return null;
    if (command === "get_settings") return {};
    if (command === "local_classification_labels") return [];
    if (command === "local_classification_status") return { supported: true, installed: false, enabled: false, busy: false, phase: "", done: 0, total: 0, failed: 0, model: "local-test", message: "" };
    if (command === "list_tags") return w.testTags ?? [];
    if (command === "list_generation_groups") return {};
    if (command === "list_library_view") return { assets: [], total: 0, memberships: [] };
    if (command === "move_assets_to_folder") return args.assetIds.length;
    if (command.startsWith("list_")) return [];
    throw new Error("Unexpected IPC: " + command);
  },
};
useStore.setState({ assets: assets as any, total: assets.length, projects: projects as any,
  libraryMemberships: [{ assetId: "owned", projectId: "p" }], activeProjectId: null,
  projectAssetsCollapsed: true, boardOpen: false, settings: {} as any });
w.store = useStore;
function Library() {
  const mode = useStore(s => s.mode);
  return <>{mode === "manage" && <BatchBar />}<LibraryHome onCreateProject={async ids => { w.catalogCreatedProjectAssets = ids; }} /></>;
}
function TestToolbar() {
  const localFilesOpen=useLocalFileMode(s=>s.open);
  return <Toolbar localFilesOpen={localFilesOpen} canvasMode={new URL(location.href).searchParams.has("canvas-toolbar")} onExplore={()=>{}} onCanvasModeChange={()=>{}} onCreateCreative={()=>{w.createdProjects=(w.createdProjects||0)+1;}} onRefresh={async()=>{}}/>;
}
function FileDropSurface() {
  const assets = useStore(s => s.assets), memberships = useStore(s => s.libraryMemberships), projects = useStore(s => s.projects);
  const [expanded, setExpanded] = React.useState(false);
  const drop = useProjectAssetDrop(), project = projects.find(project => project.id === "p")!;
  const owned = assets.filter(asset => memberships.some(item => item.projectId === project.id && item.assetId === asset.id));
  const media = (asset: typeof assets[number]) => <FileMediaCard key={asset.id} assetId={asset.id} entry={{ path: asset.store_path!, name: asset.name, preview: asset.thumb_path, directory: false }} selected={false} revision={0} labels={[]} style={{ position: "relative", width: 140, height: 100 }} aspectRatio={1.5}
    onSelect={() => {}} onOpen={() => {}} onContextMenu={() => {}} onDragStart={event => { setDragAssets([asset.id], asset.name); event.dataTransfer.setData("text/plain", asset.id); }} onDragEnd={() => setDragAssets(null)}/>;
  return <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "auto" }}>
    <aside className="app-sidebar" style={{ width: 220 }}><ProjectSection/></aside>
    <div style={{ flex: 1, minWidth: 0, padding: 16 }}>
      <div style={{ width: 220 }}><ProjectFolder group={{ project, assets: owned }} onExpand={() => setExpanded(value => !value)}/></div>
      {expanded && <div className="library-project-frame" {...drop(project)} style={{ display: "flex", gap: 8, padding: 12, minHeight: 124 }}>{owned.map(media)}</div>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, paddingTop: 20 }}>{assets.filter(asset => asset.id !== "owned").map(media)}</div>
    </div>
  </div>;
}
const fileDrop = new URL(location.href).searchParams.has("file-drop");
installCatalogPagingMock(window);
createRoot(document.getElementById("root")!).render(<div className="app-shell" style={{ display: "flex", height: "100vh" }}>
  <FileDropImport />{!fileDrop && <Sidebar/>}<main className="explore-main" style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}><header data-test-topbar>测试工具栏 <input aria-label="测试搜索框" /></header>{new URL(location.href).searchParams.has("layout") && <TestToolbar/>}{fileDrop ? <FileDropSurface/> : <Library/>}</main><ToastViewport />
</div>);
