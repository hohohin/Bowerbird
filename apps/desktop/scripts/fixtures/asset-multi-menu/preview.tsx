import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AssetContextMenu } from "../../../src/components/AssetContextMenu";
import { ProjectContextMenu } from "../../../src/components/ProjectContextMenu";
import { GenerationSessionSurface } from "../../../src/components/GenerationSessionSurface";
import { WorkflowDisconnectMenu } from "../../../src/components/WorkflowDisconnectMenu";
import { CatalogTagIndex } from "../../../src/components/CatalogTagIndex";
import { useStore } from "../../../src/store";
import "../../../src/styles.css";
import "../../../src/components/CategorizedLibrary.css";

const w = window as any;
const picture = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="240" height="180" fill="#8797b5"/></svg>');
const asset = (id: string) => ({ id, name: `${id}.png`, width: 240, height: 180, thumb_path: picture,
  store_path: `C:/test/${id}.png`, source: "imported", ext: "png", origin_path: `C:/original/${id}.png` });
const assets = [asset("a1"), asset("a2"), { ...asset("video"), store_path: "C:/test/video.mp4", ext: "mp4" }, { ...asset("external"), source: "external" }];
w.calls = []; w.describe = []; w.completed = 0;
const callbacks = new Map(); let callbackId = 0;
w.__TAURI_INTERNALS__ = {
  transformCallback: (callback: any) => { callbacks.set(++callbackId, callback); return callbackId; },
  convertFileSrc: () => picture,
  invoke: async (command: string, args: any) => {
    w.calls.push({ command, args });
    if (command === "plugin:event|listen") return args.handler;
    if (command === "get_assets_by_ids") return assets.filter(a => args.assetIds.includes(a.id));
    if (command === "list_collections") return [{ id: "c1", name: "参考", kind: "collection" }];
    if (command === "list_generation_group") return assets.slice(0, 2);
    if (command === "project_canvas_get") return { nodes: [{ kind: "asset", assetId: "a1" }] };
    if (command === "delete_asset_with_mode") { if (w.failDelete === args.id) throw new Error('模拟失败'); return { deleted_assets: 1, removed_members: 0, moved_files: 0, failed_moves: [] }; }
    if (command === "reveal_asset_folder" && w.holdReveal) await new Promise(resolve => { w.releaseReveal = resolve; });
    return null;
  },
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event: string, id: number) => callbacks.delete(id) };
useStore.setState({ assets: assets as any, activeProjectId: null, mode: "browse", projects: [{ id: "p1", name: "项目", kind: "blank" }] as any,
  cloudAuth: { cloud_available: true, logged_in: true } as any,
  cloudEntitlement: { tier: "free", balances: { daily: 5, sub: 0, topup: 0 }, policy: { can_use_byo: false, can_use_cloud: true } } as any,
  reloadProjects: async () => {}, runDescribe: (id, instruction, provider) => { w.describe.push({ id, instruction, provider }); },
});
w.fixtureStore = useStore;
w.openMenu = (kind = "single", x = 100, y = 100) => {
  const ids = kind === "mixed" ? ["a1", "video"] : ["a1", "a2"];
  const target = assets.find(a => a.id === kind) ?? assets[0];
  useStore.setState({ mode: "browse", selectedIds: new Set(["unrelated"]), activeProjectId: kind === "canvas" ? "p1" : null });
  useStore.getState().openContextMenu(x, y, target.id, {
    asset: target as any,
    ...(kind === "canvas" ? { canvasSelection: { projectId: "p1", nodeIds: ["n1", "n2"], assetIds: ["a1", "a2"] } }
      : kind === "multi" || kind === "mixed" ? { fileSelection: { assets: assets.filter(a => ids.includes(a.id)) as any,
        select: () => {}, openReferences: () => {}, onComplete: () => w.completed++ } } : {}),
  });
};
function Preview() {
  const [disconnect, setDisconnect] = useState(false);
  return <div className="app-shell" style={{ padding: 16 }}>
    <button id="trigger" onClick={() => w.openMenu()} onContextMenu={event => { event.preventDefault(); w.openMenu("single", event.clientX, event.clientY); }}>素材菜单</button>
    <button id="after">后续按钮</button>
    <button id="project" onClick={event => { const r = event.currentTarget.getBoundingClientRect(); useStore.getState().openProjectContextMenu(r.left, r.bottom, "p1"); }}>项目菜单</button>
    <button id="disconnect" onClick={() => setDisconnect(true)}>连线菜单</button>
    <GenerationSessionSurface jobId="job1" className="session-test">会话</GenerationSessionSurface>
    <CatalogTagIndex tags={[{ id: "tag1", name: "标签" }]} active={null} alphabetic={false} pinned={[]} onTogglePin={() => {}} onNavigate={() => {}} onLetter={() => {}} />
    {disconnect && <WorkflowDisconnectMenu x={200} y={200} onClose={() => setDisconnect(false)} choices={[
      { key: "busy", label: "运行中", detail: "输入", disabled: true, disconnect: () => {} },
      { key: "ready", label: "图片输入", detail: "素材", disabled: false, disconnect: () => w.disconnected = true },
    ]} />}
    <AssetContextMenu /><ProjectContextMenu />
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
