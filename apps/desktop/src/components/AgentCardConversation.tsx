import { ArrowUp, Check, ChevronRight, Copy, History, LoaderCircle, RotateCw, Square, Wrench } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { agentChatOptions, type ChatCardDefaults, type ChatSummary } from "../lib/localChat";
import { localChatDraft, useLocalChatStore } from "../lib/localChatStore";
import { ChatPaymentCancelled } from "../lib/localChatPaid";
import { notifyError } from "../lib/notify";
import { userErrorMessage } from "../lib/userError";
import { MessageText, useCopyChatReply } from "./LocalChatPanel";

export function AgentCardConversation({ summary, busy, blocked, history, runPrompts, getCardDefaults, onOpen, onStop, onRerun }: {
  summary: ChatSummary;
  busy: boolean;
  blocked: boolean;
  history: { key: string; label: string; conversationId?: string }[];
  runPrompts: ReadonlyMap<string, string>;
  getCardDefaults: () => ChatCardDefaults;
  onOpen: (conversationId?: string, entryKey?: string) => void;
  onStop?: () => void | Promise<unknown>;
  onRerun: () => void;
}) {
  const id = summary.id;
  const chat = useLocalChatStore(state => state.conversations[id]);
  const draft = useLocalChatStore(state => state.drafts[id]);
  const sending = useLocalChatStore(state => !!state.sending[id]);
  const loadError = useLocalChatStore(state => state.errors[id]);
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(true);
  const composing = useRef(false);
  const submitting = useRef(false);
  const stopRequest = useRef(false);
  const [stopPending, setStopPending] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [historyOpen, setHistoryOpen] = useState(false);
  const { copied, copyMessage } = useCopyChatReply();
  const stopping = stopPending || summary.status === "stopping";
  const read = () => { void useLocalChatStore.getState().loadConversation(id).catch(() => {}); };
  useEffect(() => {
    if (!useLocalChatStore.getState().conversations[id]) {
      void useLocalChatStore.getState().loadConversation(id).catch(() => {});
    }
  }, [id]);
  useLayoutEffect(() => {
    const el = scroll.current;
    if (el && follow.current) {
      el.scrollTop = el.scrollHeight;
      setScrolled(el.scrollTop > 1);
    }
  }, [chat]);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [draft?.text]);

  let latestAssistantIndex = (chat?.messages.length ?? 0) - 1;
  while (latestAssistantIndex >= 0 && chat?.messages[latestAssistantIndex].role !== "assistant") latestAssistantIndex--;
  async function send() {
    const snapshot = localChatDraft(id);
    if (submitting.current || sending || busy || blocked || !chat || !snapshot.text.trim()) return;
    submitting.current = true;
    follow.current = true;
    const store = useLocalChatStore.getState();
    try {
      await store.send({ projectId: summary.projectId, conversationId: id, provider: summary.provider,
        codexOptions: agentChatOptions(summary.provider, snapshot.codexOptions ?? summary.codexOptions),
        text: snapshot.text.trim(), referenceAssetIds: snapshot.referenceAssetIds, cardDefaults: getCardDefaults() }, true);
      if (localChatDraft(id) === snapshot) store.setDraft(id, { ...snapshot, text: "", referenceAssetIds: [] });
    } catch (error) {
      if (!(error instanceof ChatPaymentCancelled)) notifyError(error, "消息暂未发送，请查看对话状态后重试");
    } finally {
      submitting.current = false;
    }
  }
  async function stop() {
    if (!onStop || stopRequest.current || stopping) return;
    stopRequest.current = true;
    setStopPending(true);
    try {
      await onStop();
    } catch (error) {
      notifyError(error, "尚未确认停止，请稍后查看状态后重试");
    } finally {
      stopRequest.current = false;
      setStopPending(false);
    }
  }
  const actionLabel = onStop ? "停止回复" : "发送续聊消息";
  const rerunButton = <button type="button" className="app-icon-button" aria-label="按当前输入重跑"
    title="按当前输入重跑（开启新对话）" disabled={busy || blocked || sending} onClick={onRerun}>
    <RotateCw size={14} aria-hidden="true" />
  </button>;
  return <div className="workflow-agent-conversation" onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
    onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape" && !event.nativeEvent.isComposing) setHistoryOpen(false); }}>
    <div className="workflow-agent-reading" data-scrolled={scrolled}>
      <div ref={scroll} tabIndex={0} aria-label="Agent 对话记录" className="workflow-agent-messages"
        onScroll={event => {
          const el = event.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          setScrolled(el.scrollTop > 1);
        }}>
        {!chat && (loadError ? <button type="button" onClick={read}>重新读取对话</button> : <p>正在读取对话…</p>)}
        {chat?.messages.map((message, index) => {
          const assistant = message.role === "assistant";
          const oldAnswer = assistant && index !== latestAssistantIndex;
          const collapsed = oldAnswer && !expanded.has(message.id);
          const excerpt = collapsed ? message.text.trimStart().slice(0, 160).split("\n", 1)[0] || "本轮未收到回复" : "";
          const settled = assistant && !collapsed && message.status !== "running";
          const copyable = settled && !!message.text.trim();
          const rerunnable = settled && !oldAnswer;
          return <Fragment key={message.id}>
            {message.role === "tool" ? <p className="workflow-agent-tool"><Wrench size={12} />
              {message.status === "failed" ? userErrorMessage(message.text, "工具操作未完成") : message.text}</p>
              : <article className={`workflow-agent-message is-${message.role}${collapsed ? " is-collapsed" : ""}`} data-message-id={message.id}>
                {!collapsed && <strong>{message.role === "user" ? "你" : "Agent"}</strong>}
                {message.role === "user" && message.referenceAssetIds.length > 0 && <small>{message.referenceAssetIds.length} 个引用素材</small>}
                {collapsed ? <button type="button" className="workflow-agent-excerpt" aria-label={`展开 Agent 回答：${excerpt}`}
                  aria-expanded={false} onClick={() => setExpanded(previous => new Set(previous).add(message.id))}>
                  <ChevronRight size={12} aria-hidden="true" /><span>{excerpt}</span>
                </button>
                  : message.text ? <MessageText text={message.role === "user" ? runPrompts.get(message.turnId) ?? message.text : message.text} />
                    : <p>{message.status === "running" ? "正在准备回复…" : "本轮未收到回复"}</p>}
                {(copyable || rerunnable) && <div className="workflow-agent-reply-actions" role="group" aria-label="回复操作">
                  {copyable && <button type="button" className="app-icon-button" aria-label="复制 Agent 回答"
                    title={copied === message.id ? "已复制" : "复制 Agent 回答"} onClick={() => void copyMessage(message)}>
                    {copied === message.id ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                  </button>}
                  {rerunnable && rerunButton}
                </div>}
                {!collapsed && oldAnswer && <button type="button" aria-expanded={true}
                  onClick={() => setExpanded(previous => new Set([...previous].filter(key => key !== message.id)))}>收起</button>}
              </article>}
            {chat.messages[index + 1]?.turnId !== message.turnId && chat.actions?.filter(action => action.turnId === message.turnId).map(action =>
              <button type="button" key={action.id} className="workflow-agent-tool" onClick={() => onOpen(id)}>
                <Wrench size={12} />{action.status === "created" ? "已创建" : "已撤销"} · {action.cards.map(card => card.title).join("、")}
              </button>)}
          </Fragment>;
        })}
        {chat?.error && <p role="status">{userErrorMessage(chat.error, "本轮回复未完成")}</p>}
        {chat && latestAssistantIndex < 0 && !busy && <div className="workflow-agent-reply-actions" role="group" aria-label="回复操作">{rerunButton}</div>}
      </div>
      {!!history.length && <div className="workflow-agent-history">
        <button type="button" className="app-icon-button" aria-label="查看运行历史" title="查看运行历史" aria-expanded={historyOpen}
          onClick={() => setHistoryOpen(open => !open)}><History size={15} /></button>
        {historyOpen && <div className="workflow-agent-history-list">{history.map(entry => <button type="button" key={entry.key}
          onClick={() => { setHistoryOpen(false); onOpen(entry.conversationId, entry.key); }}>{entry.label}</button>)}</div>}
      </div>}
    </div>
    {!!draft?.referenceAssetIds.length && <button type="button" className="workflow-agent-tool" onClick={() => onOpen(id)}>
      查看待发送的 {draft.referenceAssetIds.length} 个引用素材
    </button>}
    <span className="sr-only" role="status">{copied ? "已复制" : ""}</span>
    <div className="workflow-agent-composer workflow-agent-input">
      <textarea ref={input} rows={1} aria-label="续聊消息" placeholder="继续对话…" value={draft?.text ?? ""}
        onChange={event => useLocalChatStore.getState().setDraft(id, { ...localChatDraft(id), text: event.target.value })}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault();
            void send();
          }
        }} />
      <button type="button" className="app-icon-button" aria-label={actionLabel} title={actionLabel}
        disabled={onStop ? stopping : !chat || !draft?.text.trim() || busy || blocked || sending}
        onClick={() => { if (onStop) void stop(); else void send(); }}>
        {(onStop ? stopping : sending) ? <LoaderCircle size={16} className="local-chat-spin" />
          : onStop ? <Square size={13} fill="currentColor" /> : <ArrowUp size={16} />}
      </button>
    </div>
  </div>;
}
