import React from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "../../../src/components/Sidebar";
import { ProjectSection } from "../../../src/components/ProjectSection";
import { useStore } from "../../../src/store";
import { api } from "../../../src/lib/api";
import "../../../src/styles.css";

// Closed synthetic IPC: real components/store, no desktop app or user database.
const w = window as any;
const initial = [
  { id: "a", name: "山丘", created_at: 10, updated_at: 70, last_opened_at: 30 },
  { id: "b", name: "湖泊", created_at: 30, updated_at: 90, last_opened_at: 20 },
  { id: "c", name: "森林", created_at: 20, updated_at: 80, last_opened_at: 10 },
].map((p) => ({ ...p, kind: "blank", workspace_path: `blank:${p.id}`, asset_count: 0 }));
let rows = JSON.parse(sessionStorage.getItem("fixture.projects") ?? "null") ?? initial;
let clock = 100;
w.calls = [];
w.backendActive = null;
w.failSwitch = false;
w.failFlush = false;
w.failList = false;
w.__TAURI_INTERNALS__ = {
  transformCallback: () => 1,
  convertFileSrc: (path: string) => path,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  invoke: async (command: string, args: any) => {
    w.calls.push({ command, args });
    if (command === "list_projects") {
      if (w.failList) throw new Error("synthetic list failure");
      const result = rows.map((p: any) => ({ ...p })).sort((a: any, b: any) =>
        b.last_opened_at - a.last_opened_at || b.created_at - a.created_at || b.id.localeCompare(a.id));
      if (w.deferList) {
        w.deferList = false;
        return new Promise((resolve) => { w.releaseList = () => resolve(result); });
      }
      return result;
    }
    if (command === "set_active_project") {
      if (w.failSwitch) throw new Error("synthetic switch failure");
      w.backendActive = args.projectId;
      const row = rows.find((p: any) => p.id === args.projectId);
      if (row) row.last_opened_at = ++clock;
      sessionStorage.setItem("fixture.projects", JSON.stringify(rows));
      return null;
    }
    if (command === "project_canvas_rename") {
      const row = rows.find((p: any) => p.id === args.projectId);
      row.name = args.title;
      row.updated_at = ++clock;
      return true;
    }
    if (command === "delete_project") {
      rows = rows.filter((p: any) => p.id !== args.projectId);
      if (w.backendActive === args.projectId) w.backendActive = null;
      return { deleted: true };
    }
    if (command.startsWith("list_")) return [];
    if (command.startsWith("plugin:")) return null;
    throw new Error(`Unexpected synthetic command: ${command}`);
  },
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
w.fixtureStore = useStore;
w.rows = () => rows;
w.rename = async (id: string, name: string) => {
  await api.projectCanvasRename(id, name);
  await useStore.getState().reloadProjects();
};
w.add = () => rows.push({ ...initial[0], id: "d", name: "新项目", created_at: ++clock, last_opened_at: clock });
useStore.setState({ projectCanvasFlush: async () => {
  w.calls.push({ command: "flush" });
  if (w.failFlush) throw new Error("synthetic draft failure");
} });
localStorage.setItem("bowerbird.sidebarCollapsed", "1");
await useStore.getState().reloadProjects();
createRoot(document.getElementById("root")!).render(
  <div className="app-shell" style={{ display: "flex", height: 650 }}>
    <Sidebar />
    <aside id="expanded" style={{ width: 260, padding: 20 }}><ProjectSection /></aside>
  </div>,
);
