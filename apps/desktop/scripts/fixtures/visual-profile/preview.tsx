import React from "react";
import { createRoot } from "react-dom/client";
import { VisualProfileDialog } from "../../../src/components/VisualProfileDialog";
import { VisualProfileSelect } from "../../../src/components/creation/VisualProfileSelect";
import { SidebarStatus } from "../../../src/components/SidebarStatus";
import { ToastViewport } from "../../../src/components/ToastViewport";
import { useVisualProfileTasks } from "../../../src/lib/visualProfileTasks";
import { listenForNotices } from "../../../src/lib/notify";
import { useStore } from "../../../src/store";
import "../../../src/styles.css";

// Closed synthetic IPC; real components and the real serial analysis queue. No provider or user data access.
const w = window as any;
localStorage.removeItem("bowerbird.visualProfile.selected");
w.calls = []; w.fail = null; w.hold = null; w.pending = []; w.missing = ["a6", "a7"];
w.notices = []; listenForNotices((notice) => w.notices.push(notice));
w.taskStore = useVisualProfileTasks;
const labels = ["composition", "palette", "light", "mood", "material", "layout"];
const values = ["以充足留白和清晰层级组织画面，让产品成为自然的视觉中心。", "低饱和暖白与柔和自然绿，少量深色用于强调。", "柔和自然侧光，阴影保留层次，避免生硬闪光。", "安静、克制、自然，带有真实生活的温度。", "细腻纸张、亚麻与磨砂质感，避免镜面塑料感。", "文字清晰而疏朗，标题与正文保持舒适的间距。"];
const make = (id = "draft", version = 1, status = "draft") => ({
  id, projectId: "p", folderId: "f", name: "自然生活品牌", version, status, extractor: "cloud_model",
  summary: "温润的自然色调、柔和侧光与充足留白，共同形成安静而有质感的品牌风格。",
  sourceCount: w.assets?.length ?? 8, sourceAssetIds: w.assets?.map((a: any) => a.id) ?? [], ruleCount: 6, createdAt: 1788951600, confirmedAt: null, sourceScopeHash: "synthetic",
  rules: labels.map((category, i) => ({ id: "", category, value: values[i], polarity: i === 0 ? "must" : "prefer", confidence: .8,
    supportingAssetIds: i === 5 ? [] : ["a0", "a1", "a2", "a3", "a4", "a5"], opposingAssetIds: [], confirmedByUser: false })),
  conflicts: [], contentThemes: [{ value: "植物与器皿", supportingAssetIds: ["a0"] }], candidateDirections: [],
});
function picture(i: number) {
  const colors = ["#e7e1d4", "#b5bba8", "#d6cec0", "#e8e4d9", "#c7cbbd", "#cbbda6", "#e3dfd3", "#a8b29c"];
  return "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="${colors[i % 8]}"/><path d="M0 305L400 265V400H0Z" fill="#000" opacity=".035"/><ellipse cx="215" cy="320" rx="90" ry="12" fill="#000" opacity=".07"/>${i % 3 === 0 ? '<rect x="142" y="108" width="118" height="210" rx="4" fill="#f7f4e9"/><rect x="142" y="108" width="118" height="45" fill="#6d7b62"/>' : i % 3 === 1 ? '<rect x="162" y="100" width="73" height="32" rx="4" fill="#4d5c45"/><rect x="148" y="126" width="100" height="188" rx="23" fill="#f5f0e2"/>' : '<path d="M145 180H260L246 311H162Z" fill="#f8f6ee"/><path d="M205 185Q133 105 159 56Q212 83 205 185M205 185Q250 83 290 100Q270 160 205 185" fill="#667a59"/>'}<text x="202" y="235" text-anchor="middle" fill="#67745d" font-family="serif" font-size="18" letter-spacing="4">NATURA</text><text x="202" y="253" text-anchor="middle" fill="#898b7e" font-family="sans-serif" font-size="6" letter-spacing="2">DAILY RITUALS</text></svg>`);
}
w.assets = Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, name: `品牌作品 ${i + 1}`, ext: "png", source: "imported", folder_id: "f", thumb_path: picture(i), store_path: picture(i) }));
w.profiles = new URL(location.href).searchParams.has("history") ? [make("confirmed", 1, "confirmed"), make("draft", 2)] : [];
w.makeProfile = make;
w.__TAURI_INTERNALS__ = {
  convertFileSrc: (path: string) => path,
  invoke: async (command: string, args: any) => {
    w.calls.push({ command, args });
    if (command === "set_active_project") return null;
    if (w.hold === command) await new Promise((resolve) => w.pending.push(resolve));
    if (w.fail === command) throw "模拟网络或写入失败，请重试";
    if (command === "visual_profile_preview") return { assetIds: w.assets.map((a: any) => a.id), folderId: args.folderId, folderName: "自然生活品牌", inFolder: w.assets.length, effective: w.assets.length - w.missing.length, minRequired: 1, missing: w.missing.map((assetId: string) => ({ assetId, name: assetId, reason: "no_caption" })) };
    if (command === "get_assets_by_ids") return w.assets.filter((a: any) => args.assetIds.includes(a.id));
    if (command === "codex_describe_asset") { w.missing = w.missing.filter((id: string) => id !== args.assetId); return "analysis-id"; }
    if (command === "visual_profile_list") return structuredClone(w.profiles.filter((p: any) => p.status !== "archived" && (!args.folderId || p.folderId === args.folderId)));
    if (command === "visual_profile_delete") { w.profiles.find((p: any) => p.id === args.profileId).status = "archived"; return null; }
    if (command === "visual_profile_get") return structuredClone(w.profiles.find((p: any) => p.id === args.profileId));
    if (command === "visual_profile_cloud_extract") { const p = make("new-" + w.profiles.length, w.profiles.length + 1); w.profiles.unshift(p); return structuredClone(p); }
    if (command === "visual_profile_update_draft") { const p = w.profiles.find((p: any) => p.id === args.profileId); p.rules = args.rules; p.ruleCount = p.rules.length; return structuredClone(p); }
    if (command === "visual_profile_confirm") { const p = w.profiles.find((p: any) => p.id === args.profileId); p.status = "confirmed"; return structuredClone(p); }
    if (command === "visual_profile_generate_validation") return { imagePath: picture(2), prompt: "静物台面，自然柔光。", credits: 1, service: "image_hd" };
    if (command === "visual_profile_confirm_validation") return { assetId: "adopted", name: "品牌试画" };
    if (command === "visual_profile_discard_validation") return null;
    throw new Error("Unexpected IPC: " + command);
  },
};
useStore.setState({ activeProjectId: "p", projectRouteRevision: 1, projects: [{ id: "p", name: "自然生活品牌" }] as any,
  visualProfileFolder: { id: "f", name: "自然生活品牌", profileId: new URL(location.href).searchParams.has("history") ? "confirmed" : undefined }, visualProfiles: w.profiles, assets: w.assets,
  folders: [{ id: "f", name: "自然生活品牌", kind: "folder" }] as any,
  cloudAuth: { logged_in: true, cloud_available: true } as any,
  cloudEntitlement: { policy: { can_use_cloud: true, can_use_visual_profiles: true }, generation_services: [{ credits: 1, service: "image_hd" }] } as any,
});
w.fixtureStore = useStore;
function Preview() {
  const value = useStore((s) => s.activeVisualProfileId);
  return <div className="app-shell" style={{ padding: 30 }}><header style={{ position: "absolute", right: 30, top: 30 }}><SidebarStatus /></header><VisualProfileSelect value={value} onChange={useStore.getState().setActiveVisualProfile} /><VisualProfileDialog /><ToastViewport /></div>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Preview /></React.StrictMode>);
