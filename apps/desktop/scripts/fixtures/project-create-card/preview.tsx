import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { useStore } from "../../../src/store";
import { ProjectManagerPreview } from "./ProjectManagerPreview";
import "../../../src/styles.css";
import "./preview.css";

// Closed synthetic data: no Tauri process, files, providers, or real project writes.
const w = window as any;
const params = new URL(location.href).searchParams;
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
const names = ["山野护肤 · 品牌视觉", "秋日系列 · 电商海报", "山间徒步 · 视频分镜", "栖木咖啡 · 包装探索", "理想居所 · 空间灵感"];
const now = Math.floor(Date.now() / 1000);
const projects = names.map((name, index) => ({ id: `preview-${index}`, name, kind: "blank", workspace_path: `blank:preview-${index}`, asset_count: 12 + index, created_at: now - 86400, updated_at: now - index * 3600 }));
const assets = Array.from({ length: 6 }, (_, index) => {
  const path = `/src-tauri/resources/samples/preset-0${index + 1}.webp`;
  return { id: `image-${index}`, name: `素材 ${index}`, thumb_path: path, store_path: path, width: 600, height: 400 };
});
const memberships = projects.flatMap((project, index) => assets.slice(index % 3, index % 3 + 3).map(asset => ({ projectId: project.id, assetId: asset.id })));
w.__TAURI_INTERNALS__ = {
  convertFileSrc: (path: string) => path,
  invoke: async (command: string) => {
    if (command === "list_library_view") return { assets, memberships, total: assets.length };
    throw new Error(`Unexpected preview IPC: ${command}`);
  },
};
w.previewEvents = [];
w.store = useStore;
useStore.setState({ projects: params.has("empty") ? [] : projects as any, activeProjectId: null, projectsThumbnailWidth: 200,
  openProjectContextMenu: (_x: number, _y: number, id: string) => { w.previewEvents.push({ type: "menu", id }); },
  enterProject: async (id: string) => { w.previewEvents.push({ type: "open", id }); } });
function Preview() {
  const [open, setOpen] = useState(true);
  const [created, setCreated] = useState(false);
  return <>
    <main className="project-preview-canvas">
      {created && <div className="project-preview-result" role="status"><span>空白项目画板</span><button onClick={() => { setCreated(false); setOpen(true); }}>返回项目列表</button></div>}
      {!created && !open && <button className="project-preview-return" onClick={() => setOpen(true)}>打开项目面板</button>}
    </main>
    {open && <ProjectManagerPreview onClose={() => { w.previewEvents.push({ type: "close" }); setOpen(false); }} onCreate={() => { w.previewEvents.push({ type: "create" }); setCreated(true); }}/>} 
  </>;
}
createRoot(document.getElementById("root")!).render(<Preview/>);
