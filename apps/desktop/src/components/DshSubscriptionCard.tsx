import { useEffect, useId, useRef, useState, type Ref } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { RefreshCw } from "lucide-react";
import { localChat, type ChatDshAccount } from "../lib/localChat";
import { dshNeedsConfiguration, publishDshAccount, setupChatDsh } from "../lib/chatCapabilities";
import { userErrorMessage } from "../lib/userError";
import { ModalShell } from "./ModalShell";
import { useChatProviderAccess } from "./creation/ChatProviderSelect";

const labels: Record<ChatDshAccount["state"], string> = {
  notInstalled: "未安装", signedOut: "未登录", pending: "等待授权", verified: "✓ 就绪",
  unverified: "登录状态待确认", failed: "授权失败", cancelled: "已取消", expired: "授权已过期",
};

async function openDshAuthorization(raw: string) {
  const url = new URL(raw);
  if (url.origin !== "https://platform.deepseek.com" || url.pathname !== "/dsh/authorize" || url.username || url.password || url.hash) {
    throw new Error("授权地址无效，请取消后重新登录。");
  }
  await open(url.href);
}

export function DshSubscriptionCard({ cardRef, allowed }: { cardRef?: Ref<HTMLDivElement>; allowed: boolean }) {
  const [account, setAccount] = useState<ChatDshAccount>();
  const [busy, setBusy] = useState<"start" | "cancel" | "logout" | "check" | null>(null);
  const [notice, setNotice] = useState("");
  const [settings, setSettings] = useState(false);
  const access = useChatProviderAccess();
  const sequence = useRef(0);
  const openOnReady = useRef(false);
  async function update(action: "status" | "start" | "cancel" | "logout", poll = false) {
    const request = ++sequence.current;
    if (!poll) setBusy(action === "status" ? "check" : action);
    if (action === "start") openOnReady.current = true;
    if (action === "cancel") openOnReady.current = false;
    try {
      const result = await localChat.dshAccount(action, action === "cancel" ? account?.attemptId : undefined);
      if (sequence.current !== request) return;
      if (result.state !== "pending") publishDshAccount(result);
      setAccount(result);
      if (!poll) setNotice("");
      if (openOnReady.current && result.state === "pending" && result.authorizeUrl) {
        openOnReady.current = false;
        try { await openDshAuthorization(result.authorizeUrl); }
        catch { if (sequence.current === request) setNotice("未能打开官方授权网页，请重新打开。"); }
      } else if (result.state !== "pending") openOnReady.current = false;
    } catch (error) {
      if (sequence.current === request) {
        setNotice(userErrorMessage(error, action === "status" ? "无法确认登录状态，请重新检测。" : "授权操作未完成，请重试。"));
        // Keep the attempt ID if a status read failed, so the user can still cancel it.
        setAccount(previous => previous?.state === "pending" ? { ...previous } : { state: "unverified" });
      }
    } finally { if (sequence.current === request && !poll) setBusy(null); }
  }
  useEffect(() => {
    void update("status");
    return () => { sequence.current++; };
  }, []);
  useEffect(() => {
    if (account?.state !== "pending" || busy) return;
    const timer = setTimeout(() => void update("status", true), 1500);
    return () => clearTimeout(timer);
  }, [account, busy]);
  const pending = account?.state === "pending";
  return <div ref={cardRef} tabIndex={-1} data-modal-autofocus={cardRef ? true : undefined}
    role="region" aria-label="DeepSeek 账号授权" className="settings-card px-3 py-2.5">
    <div className="flex items-center justify-between gap-2">
      <span className="text-ink">DeepSeek</span>
      <span className="flex items-center gap-1.5">
        <span aria-live="polite" className={`rounded px-2 py-0.5 text-xs ${account?.state === "verified" ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-300"}`}>
          {busy === "start" ? (account?.state === "notInstalled" ? "正在安装 DSH…" : "正在准备授权…") : account ? labels[account.state] : busy ? "检测中…" : "待检测"}
        </span>
        <button type="button" disabled={!!busy} title="重新检测" aria-label="重新检测 DSH 登录状态"
          className="flex size-6 items-center justify-center rounded text-muted hover:bg-edge disabled:opacity-50" onClick={() => void update("status")}>
          <RefreshCw size={13} className={busy === "check" ? "animate-spin" : undefined} />
        </button>
      </span>
    </div>
    <p className="mt-1 text-xs text-muted">{pending ? (account?.authorizeUrl ? "请在浏览器中完成 DeepSeek 官方授权。" : "正在等待官方授权网页…")
      : account?.state === "verified" ? "可在创作框或 Agent 卡片中选择「本机 DSH」。" : "首次使用会自动安装 DSH，再打开 DeepSeek 官方登录页。"}</p>
    <div className="mt-2 flex items-center gap-2">
      <button type="button" disabled={!!busy || (pending && !account?.attemptId)}
        className="shrink-0 rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-black hover:opacity-90 disabled:opacity-50"
        onClick={() => void update(pending ? "cancel" : "start")}>{pending ? "取消授权" : "登录授权"}</button>
      {(account?.state === "verified" || account?.state === "unverified") && <button type="button"
        disabled={!!busy} onClick={() => void update("logout")}
        className="shrink-0 rounded border border-edge px-3 py-1 text-[12px] text-ink hover:bg-edge disabled:opacity-50">
        {busy === "logout" ? "退出中…" : "退出登录"}
      </button>}
      {pending && account?.authorizeUrl && <button type="button" disabled={!!busy} className="text-xs text-ink underline" onClick={() =>
        void openDshAuthorization(account.authorizeUrl!).catch(() => setNotice("未能打开官方授权网页，请重新检测后再试。"))}>打开授权网页</button>}
      {!allowed && !pending && <small className="text-muted">本机 DSH 对话需要 Pro 或 Studio。</small>}
      {!pending && <button type="button" className="text-xs text-ink underline" disabled={!!busy} onClick={() => setSettings(true)}>服务连接设置</button>}
      {notice && <small role="alert" className="text-red-300">{notice}</small>}
    </div>
    {settings && <ChatDshSetupDialog access={access} onClose={() => setSettings(false)} onAuthorize={() => void update("status")} />}
  </div>;
}

function ChatDshSetupDialog({ access, onClose, onAuthorize }: {
  access: ReturnType<typeof useChatProviderAccess>; onClose: () => void; onAuthorize: () => void;
}) {
  const [url, setUrl] = useState(access.dsh?.localUrl ?? "http://127.0.0.1:3080");
  const [authUrl, setAuthUrl] = useState("");
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const mounted = useRef(false);
  const current = useRef({access, onClose, onAuthorize});
  current.current = {access, onClose, onAuthorize};
  const attempt = useRef(0);
  async function setup(manualAddress: boolean) {
    if (!current.current.access.localAllowed) { setBusy(false); return; }
    const request = ++attempt.current;
    setBusy(true); setError(null);
    try {
      if (!manualAddress) {
        const account = await localChat.dshAccount("status").catch(() => undefined);
        if (!mounted.current || request !== attempt.current || !current.current.access.localAllowed) return;
        if (account && dshNeedsConfiguration(account)) {
          current.current.onClose();
          current.current.onAuthorize();
          return;
        }
      }
      const status = await setupChatDsh(manualAddress
          ? { mode: "local", url: url.trim(), ...(authUrl.trim() ? { authUrl: authUrl.trim() } : {}) } : { mode: "auto" });
      if (!mounted.current || request !== attempt.current) return;
      if (!status.localAvailable) setError(userErrorMessage(status.localReason, "本机 DSH 暂未就绪，请重试。"));
      else if (current.current.access.localAllowed) {
        if (!manualAddress || !status.localNote) current.current.onClose();
      }
    } catch (reason) {
      if (mounted.current && request === attempt.current) setError(userErrorMessage(reason, "DSH 设置未完成，请重试。"));
    } finally { if (mounted.current && request === attempt.current) setBusy(false); }
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return <ModalShell title="DSH 设置" onClose={onClose} preventClose={busy} footer={<>
    <button type="button" className="app-modal-button" disabled={busy} onClick={onClose}>取消</button>
    <button type="button" className="app-modal-button is-primary" disabled={busy || !access.localAllowed || (manual && !url.trim())} onClick={() => void setup(manual)}>{busy ? "正在连接…" : manual ? "连接" : "一键连接本机 DSH"}</button>
  </>}>
    <fieldset disabled={busy} className="space-y-4">
      <p className="text-sm">{access.dsh?.localAvailable && access.dsh.localMode !== "auto" ? "当前使用手动服务地址。一键连接可切换到本机自动模式。" : "使用本机 DSH 的登录账号和 Web 配置中的默认模型。"}</p>
      <button type="button" aria-expanded={manual} onClick={() => setManual(!manual)}>手动配置服务地址</button>
      {manual && <><div><label htmlFor={`${id}-url`} className="text-sm">服务地址</label><input id={`${id}-url`} className="app-form-input mt-2 px-3 text-sm" type="url" value={url} onChange={event => setUrl(event.target.value)} spellCheck={false} /></div>
        <div><label htmlFor={`${id}-auth`} className="text-sm">登录链接（可选）</label><input id={`${id}-auth`} className="app-form-input mt-2 px-3 text-sm" type="password" autoComplete="off" value={authUrl} onChange={event => setAuthUrl(event.target.value)} spellCheck={false} /></div></>}
      {!access.localAllowed && <p role="alert">{access.reason("dsh-local")}</p>}
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      {error && access.localAllowed && <button type="button" onClick={() => { onClose(); onAuthorize(); }}>前往登录授权</button>}
      {access.dsh?.localAvailable && access.dsh.localMode !== "auto" && access.dsh.localNote && <p className="text-sm text-amber-200">{access.dsh.localNote}</p>}
    </fieldset>
  </ModalShell>;
}
