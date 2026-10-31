import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ArrowDown, ArrowUp, Check, Coins, Copy, History, ImagePlus, LoaderCircle, LocateFixed, MessageCircle, Plus, Search, Square, Undo2, UserRound, Wrench, X } from "lucide-react";
import { api } from "../lib/api";
import { CHAT_PROVIDER_LABELS, LOCAL_CHAT_MAX_REFERENCES, localChatPreview, localChatRunning, localChatStatusLabel, type ChatCardAction, type ChatCardDefaults, type ChatConversation, type ChatMessage, type ChatSummary } from "../lib/localChat";
import { localChatDraft, useLocalChatStore, type LocalChatDraft } from "../lib/localChatStore";
import { notifyError } from "../lib/notify";
import { userErrorMessage } from "../lib/userError";
import { isVideoPath } from "../lib/videoGeneration";
import type { Asset } from "../lib/types";
import { ModalShell } from "./ModalShell";
import { BOARD_ASSET_PICK_EVENT } from "./creation/useCreationEditor";
import { QUOTA_SOURCES } from "./creation/ProviderQuota";
import { useChatProviderAccess } from "./creation/ChatProviderSelect";
import "./LocalChatPanel.css";

const emptyDraft: LocalChatDraft = { text: "", referenceAssetIds: [] };
const scrollPositions = new Map<string, { top: number; follow: boolean }>();
function timeLabel(at: number) {
  return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

/** Plain React nodes only: model output is never interpreted as HTML. */
function inlineText(text: string): ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((piece, index) => piece.startsWith("**") && piece.endsWith("**")
    ? <strong key={index}>{piece.slice(2, -2)}</strong>
    : piece.startsWith("`") && piece.endsWith("`") ? <code key={index}>{piece.slice(1, -1)}</code> : piece);
}
function MessageText({ text }: { text: string }) {
  return <div className="local-chat-text">{text.split(/(```[\s\S]*?(?:```|$))/g).map((part, index) => {
    if (part.startsWith("```")) {
      const content = part.replace(/^```[^\n]*\n?/, "").replace(/```$/, "");
      return <pre key={index}><code>{content}</code></pre>;
    }
    return part.split(/\n\s*\n/).filter(Boolean).map((paragraph, line) => {
      if (/^#{1,4}\s/.test(paragraph)) return <h3 key={`${index}:${line}`}>{inlineText(paragraph.replace(/^#{1,4}\s/, ""))}</h3>;
      return <p key={`${index}:${line}`}>{inlineText(paragraph)}</p>;
    });
  })}</div>;
}

export function LocalChatCard({ conversation }: { conversation: ChatSummary }) {
  const running = localChatRunning(conversation);
  return <div className="local-chat-card-content" data-local-chat-id={conversation.id} data-chat-status={conversation.status}>
    <div className="local-chat-card-heading"><span><MessageCircle size={15} />对话</span><small>{CHAT_PROVIDER_LABELS[conversation.provider]}</small></div>
    <strong className="local-chat-card-title">{conversation.title || "新对话"}</strong>
    <p className="local-chat-card-preview">{localChatPreview(conversation.preview) || (running ? "正在准备回复…" : "打开详情继续对话")}</p>
    <div className="local-chat-card-footer"><span className={running ? "is-running" : ""}>{running && <span className="local-chat-status-dot" />}{localChatStatusLabel(conversation.status)}</span><span>{conversation.turnCount} 轮 · {timeLabel(conversation.updatedAt)}</span></div>
  </div>;
}

export function LocalChatHistory({ projectId, activeConversationId, onOpen, onClose }: {
  projectId: string; activeConversationId?: string; onOpen: (conversationId: string) => void; onClose?: () => void;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const summaries = useLocalChatStore(state => state.summaries);
  const loading = useLocalChatStore(state => !!state.loadingProjects[projectId]);
  const error = useLocalChatStore(state => state.errors[projectId]);
  useEffect(() => { void useLocalChatStore.getState().loadProject(projectId).catch(() => {}); }, [projectId]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    searchRef.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const chats = useMemo(() => Object.values(summaries).filter(chat => chat.projectId === projectId
    && `${chat.title}\n${chat.preview}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt), [summaries, projectId, query]);
  return <div className="local-chat-history" aria-label="本项目对话历史" onKeyDown={event => {
    event.stopPropagation();
    if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); onClose?.(); }
  }}>
    <div className="local-chat-history-title"><strong>对话历史</strong>{onClose && <button type="button" className="app-icon-button" onClick={onClose} aria-label="关闭对话历史"><X size={15} /></button>}</div>
    <label className="local-chat-search"><Search size={14} /><input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} aria-label="搜索对话历史" placeholder="搜索标题或最近内容" /></label>
    {error != null && <div className="local-chat-notice" role="alert"><p>{userErrorMessage(error, "对话历史暂时无法读取，请重试。")}</p><button type="button" onClick={() => void useLocalChatStore.getState().loadProject(projectId).catch(() => {})}>重新读取</button></div>}
    <div className="local-chat-history-list">{chats.map(chat => <button type="button" key={chat.id} className="local-chat-history-entry" aria-current={chat.id === activeConversationId ? "true" : undefined} onClick={() => onOpen(chat.id)}>
      <span className="local-chat-history-entry-title"><MessageCircle size={14} /><strong>{chat.title}</strong></span><p>{localChatPreview(chat.preview) || "打开详情继续对话"}</p>
      <small>{CHAT_PROVIDER_LABELS[chat.provider]} · {chat.turnCount} 轮 · {localChatStatusLabel(chat.status)} · {new Date(chat.updatedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</small>
    </button>)}</div>
    {!chats.length && <p className="local-chat-empty">{loading ? "正在读取对话…" : query.trim() ? "没有找到匹配的对话。" : "还没有对话，发送第一条消息即可开始。"}</p>}
  </div>;
}

function CardAction({ action, onLocate, onUndo }: {
  action: ChatCardAction; onLocate?: (action: ChatCardAction) => Promise<void>; onUndo?: (action: ChatCardAction) => Promise<ChatConversation>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (undo: boolean) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      if (undo && onUndo) useLocalChatStore.getState().applyConversation(await onUndo(action));
      else await onLocate?.(action);
    } catch (reason) { setError(userErrorMessage(reason, undo ? "卡片暂未撤销，请稍后重试。" : "暂时无法定位卡片，请稍后重试。")); }
    finally { setBusy(false); }
  };
  const labels = { generation: "生成", "comfy-video": "本地 H3", content: "内容", trigger: "触发", loop: "循环", section: "分区" };
  const sections = action.cards.filter(card => card.kind === "section").length;
  return <div className="local-chat-card-action" data-chat-action-id={action.id}>
    <strong><Check size={14} />{action.status === "undone" ? "已撤销此次创建" : `已创建 ${action.cards.length - sections} 张卡片${sections ? ` · ${sections} 个分区` : ""}`}</strong>
    <ul>{action.cards.map(card => <li key={card.id}><span>{labels[card.kind]}</span>{card.title}</li>)}</ul>
    {action.status === "created" && <><small>已放入画板，等待你运行。</small><div className="local-chat-card-action-buttons">
      {onLocate && <button type="button" disabled={busy} onClick={() => void act(false)}><LocateFixed size={13} />定位卡片</button>}
      {onUndo && <button type="button" disabled={busy} onClick={() => void act(true)}><Undo2 size={13} />撤销此次创建</button>}
    </div></>}
    {error && <p className="local-chat-notice" role="alert">{error}</p>}
  </div>;
}

export function LocalChatPanel({ conversationId, projectId, onClose, onOpenLibrary, onSelectConversation, onNewConversation, getCardDefaults, onLocateCards, onUndoCards }: {
  conversationId: string; projectId: string; onClose: () => void; onOpenLibrary?: () => void;
  onSelectConversation?: (conversationId: string) => void; onNewConversation?: () => void;
  getCardDefaults?: () => ChatCardDefaults;
  onLocateCards?: (action: ChatCardAction) => Promise<void>;
  onUndoCards?: (action: ChatCardAction) => Promise<ChatConversation>;
}) {
  const chat = useLocalChatStore(state => state.conversations[conversationId]);
  const draft = useLocalChatStore(state => state.drafts[conversationId] ?? emptyDraft);
  const loading = useLocalChatStore(state => !!state.loadingConversations[conversationId]);
  const sending = useLocalChatStore(state => !!state.sending[conversationId]);
  const loadError = useLocalChatStore(state => state.errors[conversationId]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [assets, setAssets] = useState<Record<string, Asset>>({});
  const [preview, setPreview] = useState<Asset | null>(null);
  const [stopPending, setStopPending] = useState(false);
  const [recoverPending, setRecoverPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const currentId = useRef(conversationId);
  currentId.current = conversationId;
  const followRef = useRef(true);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>();
  const ownedChat = chat?.projectId === projectId ? chat : null;
  const provider = ownedChat?.provider ?? "codex-local";
  const cloud = provider === "deepseek-cloud";
  const access = useChatProviderAccess(cloud);
  const running = localChatRunning(ownedChat);
  const blockedReason = access.reason(provider);
  const canSend = !blockedReason;
  const referenceKey = JSON.stringify([...new Set([...(ownedChat?.messages.flatMap(message => message.referenceAssetIds) ?? []), ...draft.referenceAssetIds])]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); clearTimeout(copiedTimer.current); };
  }, []);
  useEffect(() => {
    setLocalError(null); setHistoryOpen(false); setPreview(null); setStopPending(false); setRecoverPending(false);
    const position = scrollPositions.get(conversationId);
    followRef.current = position?.follow ?? true;
    setFollow(followRef.current);
    void useLocalChatStore.getState().loadConversation(conversationId).catch(() => {});
  }, [conversationId]);
  useEffect(() => {
    let cancelled = false;
    const ids: string[] = JSON.parse(referenceKey);
    if (ids.length) void api.getAssetsByIds(ids).then(items => {
      if (!cancelled) setAssets(previous => ({ ...previous, ...Object.fromEntries(items.map(item => [item.id, item])) }));
    }).catch(() => { if (!cancelled) setLocalError("参考图片暂时无法读取，请稍后重新打开对话。"); });
    return () => { cancelled = true; };
  }, [referenceKey]);
  useEffect(() => {
    const onPick = (event: Event) => {
      const detail = (event as CustomEvent<string | { assetId?: string; id?: string }>).detail;
      const id = typeof detail === "string" ? detail : detail?.assetId || detail?.id;
      if (!id || !ownedChat) return;
      const targetId = conversationId;
      void api.getAssetsByIds([id]).then(items => {
        const asset = items[0];
        if (!asset) throw new Error("找不到所选参考图片，请重新选择。");
        if (isVideoPath(asset.store_path || asset.origin_path || asset.name)) throw new Error("对话参考暂时支持图片，请选择图片后继续。");
        const current = localChatDraft(targetId);
        if (!current.referenceAssetIds.includes(id) && current.referenceAssetIds.length >= LOCAL_CHAT_MAX_REFERENCES) throw new Error("每条消息最多添加 8 张参考图，请移除部分图片后继续。");
        if (!current.referenceAssetIds.includes(id)) useLocalChatStore.getState().setDraft(targetId, { ...current, referenceAssetIds: [...current.referenceAssetIds, id] });
        if (currentId.current === targetId) { setAssets(previous => ({ ...previous, [id]: asset })); setLocalError(null); }
      }).catch(error => { if (currentId.current === targetId) setLocalError(userErrorMessage(error, "添加参考图片失败，请重新选择。")); });
    };
    window.addEventListener(BOARD_ASSET_PICK_EVENT, onPick);
    return () => window.removeEventListener(BOARD_ASSET_PICK_EVENT, onPick);
  }, [conversationId, ownedChat?.id]);
  useLayoutEffect(() => {
    const element = messagesRef.current;
    if (!element) return;
    if (followRef.current) element.scrollTop = element.scrollHeight;
    else element.scrollTop = scrollPositions.get(conversationId)?.top ?? element.scrollTop;
  }, [conversationId, ownedChat?.revision, historyOpen]);
  useLayoutEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 144)}px`;
  }, [draft.text]);

  const references = (ids: string[], removable = false) => ids.length ? <div className={`local-chat-references${removable ? " is-draft" : ""}`}>{ids.map((id, index) => {
    const asset = assets[id];
    return <div className="local-chat-reference" key={id}>
      <button type="button" disabled={!asset?.store_path} onClick={() => asset && setPreview(asset)} aria-label={`查看参考图 ${index + 1}${asset ? `：${asset.name}` : ""}`}>
        {asset?.store_path ? <img src={convertFileSrc(asset.thumb_path || asset.store_path)} alt={asset.name || `参考图 ${index + 1}`} /> : <span>图片 {index + 1}</span>}
      </button>
      {removable && <button type="button" className="local-chat-reference-remove" onClick={() => useLocalChatStore.getState().setDraft(conversationId, { ...draft, referenceAssetIds: draft.referenceAssetIds.filter(value => value !== id) })} aria-label={`移除参考图 ${index + 1}`}><X size={11} /></button>}
    </div>;
  })}</div> : null;
  const copyMessage = async (message: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(message.text);
      clearTimeout(copiedTimer.current); setCopied(message.id);
      copiedTimer.current = setTimeout(() => setCopied(null), 1600);
    } catch (error) { notifyError(error, "复制回复失败，请重试。"); }
  };
  const recover = async () => {
    if (!ownedChat || recoverPending || sending || running) return;
    const targetId = conversationId;
    setRecoverPending(true); setLocalError(null);
    try { await useLocalChatStore.getState().recover(targetId); }
    catch (error) { if (currentId.current === targetId) setLocalError(userErrorMessage(error, "回复暂未取回，请稍后重试。")); }
    finally { if (currentId.current === targetId) setRecoverPending(false); }
  };
  const send = async () => {
    if (!ownedChat || running || sending || recoverPending || !canSend || !draft.text.trim()) return;
    const snapshot = { text: draft.text, referenceAssetIds: [...draft.referenceAssetIds] };
    const targetId = conversationId;
    setLocalError(null); followRef.current = true; setFollow(true);
    try {
      await useLocalChatStore.getState().send({ projectId, conversationId: targetId, provider, text: snapshot.text.trim(), referenceAssetIds: snapshot.referenceAssetIds, cardDefaults: getCardDefaults?.() });
      const current = localChatDraft(targetId);
      // Preserve typing or newly selected references added while the request was being accepted.
      if (current.text === snapshot.text && JSON.stringify(current.referenceAssetIds) === JSON.stringify(snapshot.referenceAssetIds)) useLocalChatStore.getState().setDraft(targetId, emptyDraft);
      if (currentId.current === targetId) inputRef.current?.focus();
    } catch (error) { if (currentId.current === targetId) setLocalError(userErrorMessage(error, "消息暂未发送，请查看对话状态后重试。")); }
  };
  const stop = async () => {
    if (stopPending || ownedChat?.status === "stopping") return;
    const targetId = conversationId;
    setStopPending(true); setLocalError(null);
    try { await useLocalChatStore.getState().stop(targetId); }
    catch (error) { if (currentId.current === targetId) setLocalError(userErrorMessage(error, "尚未确认停止，请稍后查看状态后重试。")); }
    finally { if (currentId.current === targetId) setStopPending(false); }
  };

  return <section ref={panelRef} tabIndex={-1} role="complementary" aria-label="对话详情" className="project-inspector-shell local-chat-panel" data-project-inspector="chat" data-local-chat-id={conversationId} onKeyDown={event => {
    if (document.querySelector('[role="dialog"]')) return;
    // Reading/copying/chat editing belongs to this panel, not canvas undo or Space-to-pan.
    event.stopPropagation();
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (historyOpen) setHistoryOpen(false); else onClose();
    }
  }}>
    <header className="project-inspector-header local-chat-panel-header"><span className="local-chat-heading-icon"><MessageCircle size={15} /></span>
      <div><strong title={ownedChat?.title}>{ownedChat?.title || "对话详情"}</strong><small aria-live="polite">{CHAT_PROVIDER_LABELS[provider]} · {ownedChat ? localChatStatusLabel(ownedChat.status) : "正在读取"}</small></div>
      {onSelectConversation && <button type="button" className="app-icon-button" onClick={() => setHistoryOpen(value => !value)} aria-label="查看对话历史" aria-expanded={historyOpen}><History size={16} /></button>}
      {onNewConversation && <button type="button" className="app-icon-button" onClick={onNewConversation} aria-label="发起新对话"><Plus size={16} /></button>}
      <button type="button" className="app-icon-button" onClick={onClose} aria-label="关闭对话详情" title="关闭详情（进行中的回复不会中断）"><X size={16} /></button>
    </header>
    {historyOpen && onSelectConversation ? <LocalChatHistory projectId={projectId} activeConversationId={conversationId} onOpen={id => { setHistoryOpen(false); onSelectConversation(id); }} onClose={() => setHistoryOpen(false)} /> : <>
      <div className="local-chat-reading"><div ref={messagesRef} className="local-chat-messages" tabIndex={0} aria-label="对话消息" onScroll={event => {
        const element = event.currentTarget;
        const nearBottom = element.scrollHeight - element.clientHeight - element.scrollTop < 44;
        followRef.current = nearBottom; setFollow(nearBottom);
        scrollPositions.set(conversationId, { top: element.scrollTop, follow: nearBottom });
      }}>
        {!ownedChat && <div className="local-chat-empty">{loadError != null ? <><p>{userErrorMessage(loadError, "对话暂时无法读取，请重试。")}</p><button type="button" onClick={() => void useLocalChatStore.getState().loadConversation(conversationId).catch(() => {})}>重新读取</button></> : loading ? "正在读取对话…" : "这段对话暂不可用，请返回画板重新打开。"}</div>}
        {ownedChat?.messages.map((message, index) => <Fragment key={message.id}>{message.role === "tool" ? <details className="local-chat-tool"><summary><Wrench size={12} />公开工具记录<span>{message.status === "running" ? "处理中" : message.status === "done" ? "已完成" : message.status === "stopped" ? "已停止" : "未完成"}</span></summary>
          <p>{message.status === "failed" ? userErrorMessage(message.text, "本次工具操作未完成，请查看回复内容。") : message.text}</p></details>
          : <article key={message.id} className={`local-chat-message is-${message.role}`} data-message-id={message.id} data-message-role={message.role}>
            <div className="local-chat-message-label"><strong>{message.role === "user" ? "你" : cloud ? "DeepSeek" : "Codex"}</strong><time dateTime={new Date(message.createdAt).toISOString()}>{timeLabel(message.createdAt)}</time></div>
            {references(message.referenceAssetIds)}
            {message.text ? <MessageText text={message.text} /> : <p className="local-chat-pending">{message.status === "running" ? <><LoaderCircle size={13} className="local-chat-spin" />正在准备回复…</> : "本轮尚未收到回复。"}</p>}
            {message.role === "assistant" && <div className="local-chat-message-actions">{message.text && <button type="button" onClick={() => void copyMessage(message)} aria-label="复制回复">{copied === message.id ? <Check size={12} /> : <Copy size={12} />}{copied === message.id ? "已复制" : "复制"}</button>}
              {message.status !== "done" && message.status !== "running" && <small>{{ stopped: "已停止 · 已收到的内容已保留", interrupted: "回复已中断 · 可以继续对话", failed: "本轮未完成" }[message.status]}</small>}</div>}
          </article>}
          {ownedChat.messages[index + 1]?.turnId !== message.turnId && ownedChat.actions?.filter(action => action.turnId === message.turnId).map(action =>
            <CardAction key={action.id} action={action} onLocate={onLocateCards} onUndo={onUndoCards} />)}
        </Fragment>)}
        {ownedChat?.error && <p className="local-chat-notice" role="alert">{userErrorMessage(ownedChat.error, "本轮回复未完成，请检查连接后继续对话。")}</p>}
        {ownedChat?.status === "interrupted" && !ownedChat.error && <p className="local-chat-notice" role="status">上次回复已中断，已收到的内容已保留。可以发送消息继续对话。</p>}
        {cloud && ownedChat && ["interrupted", "stopped", "failed"].includes(ownedChat.status) && <button type="button" className="local-chat-recover" disabled={recoverPending || sending} onClick={() => void recover()}>{recoverPending ? "正在取回…" : "取回回复"}</button>}
      </div>
      {!follow && <button type="button" className="local-chat-latest" onClick={() => { followRef.current = true; setFollow(true); if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight; }}><ArrowDown size={12} />回到最新消息</button>}
      </div>
      <div className="local-chat-reply-area">
        {localError && <p className="local-chat-notice" role="alert">{userErrorMessage(localError, "对话操作暂未完成，请稍后重试。")}</p>}
        {blockedReason && <p className="local-chat-access-notice">{blockedReason}</p>}
        {cloud && access.error && <button type="button" onClick={access.retry}>重新获取报价</button>}
        {cloud && draft.referenceAssetIds.length > 0 && <p className="local-chat-access-notice">图片仅用于建卡引用；看图分析请选择本机 Codex。</p>}
        <div className="local-chat-reply-box">
          {references(draft.referenceAssetIds, true)}
          <textarea ref={inputRef} aria-label="继续对话" placeholder={running ? "可以先写下一条消息…" : "继续对话…"} value={draft.text} rows={2}
            onChange={event => useLocalChatStore.getState().setDraft(conversationId, { ...draft, text: event.target.value })}
            onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }}
            onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !composingRef.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void send(); } }} />
          <div className="local-chat-reply-toolbar"><span className="local-chat-provider" data-quota={cloud ? "bowerbird" : "chatgpt"} title={cloud ? "使用 Bowerbird Bcoin" : QUOTA_SOURCES.chatgpt.detail}><span className="local-chat-provider-avatar">{cloud ? <Coins size={12} aria-hidden="true" /> : <UserRound size={12} aria-hidden="true" />}</span>{CHAT_PROVIDER_LABELS[provider]}{cloud && access.quote?.available && access.quote.unit_cost === 0 ? ` · ${access.quote.unit_cost} Bcoin` : ""}</span>
            {onOpenLibrary && <button type="button" className="local-chat-add-image" onClick={onOpenLibrary} aria-label="添加对话参考图" title="从素材库选择参考图"><ImagePlus size={16} /></button>}
            {running ? <button type="button" className="local-chat-send is-stop" onClick={() => void stop()} disabled={stopPending || ownedChat?.status === "stopping"} aria-label="停止回复">{stopPending || ownedChat?.status === "stopping" ? <LoaderCircle size={14} className="local-chat-spin" /> : <Square size={12} />}</button>
              : <button type="button" className="local-chat-send" onClick={() => void send()} disabled={!ownedChat || !canSend || !draft.text.trim() || sending || recoverPending} aria-label="发送对话消息">{sending ? <LoaderCircle size={16} className="local-chat-spin" /> : <ArrowUp size={17} />}</button>}
          </div>
        </div>
        <small className="local-chat-reply-hint">Enter 换行 · Ctrl / ⌘ + Enter 发送</small>
      </div>
    </>}
    {preview && <ModalShell title={preview.name || "对话参考图"} width="lg" onClose={() => setPreview(null)}><img className="local-chat-image-preview" src={convertFileSrc(preview.store_path!)} alt={preview.name || "对话参考图"} /></ModalShell>}
  </section>;
}
