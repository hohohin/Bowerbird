import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasWorkspace } from "../../../src/components/CanvasWorkspace";
import { AssetContextMenu } from "../../../src/components/AssetContextMenu";
import { ToastViewport } from "../../../src/components/ToastViewport";
import { useStore } from "../../../src/store";
import { installCatalogPagingMock } from "../catalogPagingMock";
import { advance, assets, controls, createCards, failRunning, finish, inspect, install, interrupt, projects, releaseReplies, reset, setDelayReply, setFault, setHold, staleEvent, subscribe } from "./mock";
import "../../../src/styles.css";
import "./preview.css";

install(window);
installCatalogPagingMock(window);
const entitlement = (enabled: boolean) => ({ plan: enabled ? "pro" : "free", policy: { can_use_byo: enabled, can_use_cloud: true, max_parallel_jobs: 3 }, balances: { daily: 0, sub: 0, topup: 100 } });
useStore.setState({ projects: projects as any, activeProjectId: inspect().activeProjectId, assets: assets as any, boardOpen: false,
  settings: inspect().settings, cloudAuth: { logged_in: true, cloud_available: true } as any, cloudEntitlement: entitlement(true) as any,
  activeGenProvider: "codex", codexHealth: { ok: true, reason: "" }, dreaminaHealth: { ok: true, reason: "" } });

function Fixture() {
  const projectId = useStore(state => state.activeProjectId)!;
  const [snapshot, setSnapshot] = useState(inspect);
  const [authenticated, setAuthenticated] = useState(true);
  const [entitled, setEntitled] = useState(true);
  const [hold, updateHold] = useState(controls.hold);
  const [fault, updateFault] = useState(controls.fault);
  const [delayReply, updateDelayReply] = useState(controls.delayReply);
  const [dark, setDark] = useState(false);
  useEffect(() => subscribe(() => setSnapshot(inspect())), []);
  const chats = Object.values(snapshot.conversations);
  const running = chats.some(chat => chat.status === "running" || chat.status === "stopping");
  const localCalls = snapshot.calls.filter(call => call.command.startsWith("local_chat_"));
  return <div className="chat-fixture app-shell">
    <header className="chat-fixture-bar">
      <strong>本机对话 · 隔离验收</strong><span>合成 IPC；不连接模型／用户素材库</span>
      <label>项目 <select aria-label="测试项目" value={projectId} onChange={event => void useStore.getState().enterProject(event.target.value)}>
        {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>
      <button type="button" onClick={() => { setDark(!dark); document.documentElement.dataset.theme = dark ? "light" : "dark"; }}>{dark ? "浅色" : "深色"}</button>
      <button type="button" onClick={() => location.reload()}>刷新界面</button>
      <button type="button" onClick={reset}>重置验收数据</button>
    </header>
    <details className="chat-fixture-controls" open>
      <summary>测试控制 <output data-fixture-summary>项目 {projectId.toUpperCase()}：{chats.filter(chat => chat.projectId === projectId).length} 条对话；全部：{chats.length} 条</output></summary>
      <div className="chat-fixture-actions">
        <label><input type="checkbox" checked={hold} onChange={event => { updateHold(event.target.checked); setHold(event.target.checked); }} />手动推进回复</label>
        <button type="button" disabled={!running} onClick={() => advance()}>追加回复片段</button>
        <button type="button" disabled={!running} onClick={() => finish()}>完成回复</button>
        <button type="button" disabled={!running} onClick={interrupt}>模拟进程中断</button>
        <button type="button" disabled={!running} onClick={failRunning}>模拟本轮失败</button>
        <button type="button" disabled={!chats.length} onClick={staleEvent}>发送过期事件</button>
        <button type="button" disabled={!chats.length} onClick={() => void createCards("rows")}>创建逐行循环四卡</button>
        <button type="button" disabled={!chats.length} onClick={() => void createCards("count")}>创建按次数循环四卡</button>
        <label><input type="checkbox" checked={delayReply} onChange={event => { updateDelayReply(event.target.checked); setDelayReply(event.target.checked); }} />延迟发送回执</label>
        <button type="button" disabled={!snapshot.pendingReplies} onClick={releaseReplies}>释放发送回执（{snapshot.pendingReplies}）</button>
        <label>故障 <select aria-label="测试故障" value={fault} onChange={event => { updateFault(event.target.value); setFault(event.target.value); }}>
          <option value="none">无</option><option value="send">发送失败</option><option value="stop">停止失败</option><option value="read">读取失败</option>
        </select></label>
        <label><input type="checkbox" checked={authenticated} onChange={event => { const value = event.target.checked; setAuthenticated(value); controls.authenticated = value; useStore.setState({ codexHealth: { ok: value, reason: value ? "" : "尚未登录" } }); }} />Codex 已登录</label>
        <label><input type="checkbox" checked={entitled} onChange={event => { const value = event.target.checked; setEntitled(value); controls.entitled = value; useStore.setState({ cloudEntitlement: entitlement(value) as any }); }} />本机权益</label>
      </div>
      <details className="chat-fixture-evidence"><summary>IPC 记录（{localCalls.length}）</summary><pre aria-label="合成 IPC 记录">{JSON.stringify(localCalls, null, 2)}</pre></details>
    </details>
    <main className="chat-fixture-workspace"><CanvasWorkspace key={projectId} projectId={projectId} /><AssetContextMenu /><ToastViewport /></main>
  </div>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
