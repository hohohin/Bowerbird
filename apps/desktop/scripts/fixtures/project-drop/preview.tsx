import React from "react";
import { createRoot } from "react-dom/client";
import { LibraryHome } from "../../../src/components/LibraryHome";
import { Sidebar } from "../../../src/components/Sidebar";
import { ToastViewport } from "../../../src/components/ToastViewport";
import { useStore } from "../../../src/store";
import "../../../src/styles.css";

// Closed synthetic IPC. Production components and drag payload; no user data or provider calls.
const w = window as any;
w.calls = []; w.fail = false;
localStorage.setItem("bowerbird.sidebarCollapsed", new URL(location.href).searchParams.has("rail") ? "1" : "0");
const image = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="#a5b5a0"/></svg>');
const assets = ["owned", "one", "two", "three"].map(id => ({ id, name: id, width: 240, height: 160, ext: "png", source: "imported", thumb_path: image, store_path: image }));
const projects = ["p", "q"].map((id, i) => ({ id, name: i ? "空项目" : "目标项目", kind: "blank", workspace_path: "blank:" + id, asset_count: i ? 0 : 1, created_at: 1, updated_at: 1 }));
w.__TAURI_INTERNALS__ = {
  convertFileSrc: (path: string) => path,
  invoke: async (command: string, args: any) => {
    w.calls.push({ command, args });
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
    if (command === "list_generation_groups") return {};
    if (command.startsWith("list_")) return [];
    throw new Error("Unexpected IPC: " + command);
  },
};
useStore.setState({ assets: assets as any, total: assets.length, projects: projects as any,
  libraryMemberships: [{ assetId: "owned", projectId: "p" }], activeProjectId: null,
  projectAssetsCollapsed: true, boardOpen: false, settings: {} as any });
w.store = useStore;
createRoot(document.getElementById("root")!).render(<div className="app-shell" style={{ display: "flex", height: "100vh" }}>
  <Sidebar /><main style={{ flex: 1, minWidth: 0, overflow: "hidden" }}><LibraryHome /></main><ToastViewport />
</div>);
