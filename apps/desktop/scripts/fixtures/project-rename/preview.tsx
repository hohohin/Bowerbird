import React from "react";
import { createRoot } from "react-dom/client";
import { ProjectSection } from "../../../src/components/ProjectSection";
import { Sidebar } from "../../../src/components/Sidebar";
import { LibraryHome } from "../../../src/components/LibraryHome";
import { CanvasWorkspace } from "../../../src/components/CanvasWorkspace";
import { ProjectContextMenu } from "../../../src/components/ProjectContextMenu";
import { useStore } from "../../../src/store";
import "../../../src/styles.css";

// Entire UI is real; IPC is a closed synthetic database. No user library access.
const w = window as any;
w.calls = [];
w.failure = false;
w.missing = false;
const provisional = new URL(location.href).searchParams.has("provisional");
const inactive = new URL(location.href).searchParams.has("inactive");
const rail = new URL(location.href).searchParams.has("rail");
if (rail) localStorage.setItem("bowerbird.sidebarCollapsed", "1");
let project = { id: "p", name: "测试项目", kind: "blank", workspace_path: "blank:p", asset_count: 1,
  title_source: "default", created_at: 1, updated_at: 1, provisional };
const canvas = { projectId: "p", draftJson: "{}", createdAt: 1, updatedAt: 1 };
w.__TAURI_INTERNALS__ = {
  transformCallback: () => 1,
  convertFileSrc: (path: string) => path,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  invoke: async (command: string, args: any) => {
    w.calls.push({ command, args });
    if (command === "list_projects") return project.provisional ? [] : [{ ...project }];
    if (command === "project_canvas_rename") {
      if (w.failure) throw "合成写入失败，请重试";
      if (w.missing) return false;
      project = { ...project, name: args.title, title_source: "manual" };
      return true;
    }
    if (command === "project_canvas_materialize") {
      if (w.failure) throw "合成写入失败，请重试";
      project = { ...project, name: args.value.name, title_source: args.value.titleSource, provisional: false };
      return canvas;
    }
    if (command === "project_canvas_ensure") return canvas;
    if (command === "project_canvas_get") return { canvas, nodes: [], edges: [], groups: [], groupItems: [], threads: [], executionLinks: [], view: null };
    if (command === "list_generation_groups") return {};
    if (command === "count_assets") return 0;
    if (command === "project_delete_impact") return { project_asset_count: 1, thread_count: 0, node_count: 0,
      running_generation_count: 0, running_agent_count: 0, physical: { exclusive_asset_count: 1, exclusive_file_count: 1,
        preserved_shared_count: 0, preserved_unsafe_count: 0, confirmation: "synthetic" } };
    if (command.startsWith("list_") || command === "get_assets_by_ids") return [];
    return null;
  },
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
const asset = { id: "asset", name: "合成素材", width: 10, height: 10, source: "imported" };
useStore.setState({ projects: [{ ...project }] as any, activeProjectId: inactive ? null : "p", assets: [asset] as any,
  total: 1, libraryMemberships: [{ assetId: "asset", projectId: "p" }], projectAssetsCollapsed: true,
  boardOpen: false, settings: {} as any });
w.fixtureStore = useStore;
w.persistedProject = () => project;
function Preview() {
  return <div className="app-shell" style={{ padding: 20 }}>
    <div style={{ display: "flex", height: 330 }}><aside style={{ width: 240 }}>{rail ? <Sidebar /> : <ProjectSection />}</aside>
      <main style={{ flex: 1 }}><LibraryHome /></main></div>
    {!inactive && <div style={{ height: 480 }}><CanvasWorkspace projectId="p" /></div>}
    <ProjectContextMenu />
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
