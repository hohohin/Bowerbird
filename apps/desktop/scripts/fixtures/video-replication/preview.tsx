import "../../../src/styles.css";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasToolbox } from "../../../src/components/CanvasToolbox";
import { CanvasToolGroups, useCanvasToolMemory } from "../../../src/components/CanvasToolGroup";
import { ModalShell } from "../../../src/components/ModalShell";
import { VideoReplicationDialog } from "../../../src/components/VideoReplicationDialog";
import { useStore } from "../../../src/store";
import { canUseComfyVideo } from "../../../src/lib/comfyVideo";
import { notify } from "../../../src/lib/notify";
import "../../../src/components/CanvasNotes.css";
import "../../../src/components/TacticalDialogs.css";
import "../../../src/components/CanvasSecondaryTactical.css";
import "../../../src/components/MediaTactical.css";

const w = window as any;
w.store = useStore;
useStore.setState({ activeProjectId: "p" });
w.calls = [];
w.capabilityMode = new URLSearchParams(location.search).get("capability");
let tasks = JSON.parse(sessionStorage.getItem("replication-tasks") || "[]");
let acquisitions: any[] = [];
w.__TAURI_INTERNALS__ = {
  convertFileSrc: (path: string) => path,
  transformCallback: () => 1,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  invoke: async (command: string, args: any) => {
    w.calls.push({ command, args });
    if (command !== "video_replication") throw new Error(`Unexpected IPC ${command}`);
    const { action, data } = args;
    if (action === "case-list") return structuredClone(tasks);
    if (action === "case-save") { tasks = [data, ...tasks.filter((item: any) => item.id !== data.id)]; sessionStorage.setItem("replication-tasks", JSON.stringify(tasks)); return structuredClone(data); }
    if (action === "douyin-list") return structuredClone(acquisitions);
    if (action === "douyin-create") { const task = { id: "douyin", state: "needs_login", message: "需要登录验证", shareText: data.text, sourceUrl: "https://v.douyin.com/example/" }; acquisitions = [task]; return structuredClone(task); }
    if (action === "douyin-login") { acquisitions[0] = { ...acquisitions[0], state: "ready", message: "视频已获取", reference: { id: "reference", name: "抖音参考视频.mp4", duration: 8, shareText: acquisitions[0].shareText, originalUrl: "https://www.douyin.com/video/1234567890123456" } }; return location.search.includes("immediate") ? structuredClone(acquisitions[0]) : { ...structuredClone(acquisitions[0]), state: "downloading", reference: undefined }; }
    if (action === "media") throw new Error("隔离测试不提供真实媒体文件，历史文本仍保留");
    if (action === "preferences") return { products: [{ id: "product", name: "白色洗发水", description: "白色瓶身，其他信息待确认" }] };
    if (action === "capabilities") {
      if (w.capabilityMode === "pending") await new Promise(resolve => { w.releaseCapabilities = resolve; });
      if (w.capabilityMode === "error") throw new Error("Cloud 连接中断，请重试");
      if (w.capabilityMode === "malformed") return { services: [] };
      return { services: ["video-analysis", "text-rewrite"].map(operation => {
        const available = location.search.includes("enabled") || w.capabilityMode === "all-enabled" || (w.capabilityMode === "analysis-only" && operation === "video-analysis");
        return { operation, available, credits: available ? 3 : null };
      }) };
    }
    if (action === "list") return structuredClone(tasks);
    if (action === "create") {
      const task = { ...data, id: crypto.randomUUID(), projectId: args.projectId, createdAt: new Date().toISOString(), state: "rewritten", rewrittenText: "镜头 1：白色瓶身置于台面，镜头缓慢推进。", rewriteOriginalText: "镜头 1：白色瓶身置于台面，镜头缓慢推进。", message: "改写完成", error: "", model: "mock", apiBase: "mock" };
      tasks.unshift(task); sessionStorage.setItem("replication-tasks", JSON.stringify(tasks)); return structuredClone(task);
    }
    if (action === "save-result") { const task = tasks.find((item: any) => item.id === data.id); Object.assign(task, { rewrittenText: data.text, firstFramePrompt: data.firstFramePrompt, frameReference: data.frameReference }); sessionStorage.setItem("replication-tasks", JSON.stringify(tasks)); return structuredClone(task); }
    if (action === "save-preferences") return data;
    if (action === "sources") return [];
    throw new Error(`Unexpected action ${action}`);
  },
};
function App() {
  const [opened, setOpened] = useState(false);
  const [upgrade, setUpgrade] = useState(false);
  const auth = useStore(state => state.cloudAuth);
  const entitlement = useStore(state => state.cloudEntitlement);
  const account = auth?.logged_in && auth.user_id === entitlement?.user_id ? entitlement : null;
  const canUseLocalVideo = canUseComfyVideo(auth, entitlement);
  const pro = (account?.tier === "pro" || account?.tier === "studio") && (account.offline_state === "fresh" || account.offline_state === "grace");
  const { remembered, remember } = useCanvasToolMemory();
  return <div style={{ height: "100vh", background: "var(--bb-bg)", color: "var(--bb-ink)", padding: 32 }}><h1>项目画板</h1>
    <CanvasToolGroups hoverBlocked={() => false}>
      <CanvasToolbox workflowReady pro={pro} canUseLocalVideo={canUseLocalVideo} isTestAccount={account?.is_test_account === true}
        active="select" remembered={remembered.toolbox} onTool={tool => {
          if ((tool === "comfy-video" && !canUseLocalVideo) || (tool === "voice" && !pro)) { setUpgrade(true); return; }
          if (tool === "replication") setOpened(true);
          if (tool === "comfy-video") window.dispatchEvent(new Event("local-video-placement"));
          if (tool === "video-to-doc") { notify("功能开发中"); return; }
          remember("toolbox", tool);
        }} />
    </CanvasToolGroups>
    {upgrade && <ModalShell title="解锁 Pro" onClose={() => setUpgrade(false)}>已有结果仍可查看和导出</ModalShell>}
    {opened && <VideoReplicationDialog projectId="p" ensureProject={async () => {}} onClose={() => setOpened(false)} />}
  </div>;
}
document.documentElement.dataset.theme = "light";
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
