import { ArrowUp, History, LoaderCircle, Wrench } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { agentChatOptions, type ChatCardDefaults, type ChatSummary } from "../lib/localChat";
import { localChatDraft, useLocalChatStore } from "../lib/localChatStore";
import { notifyError } from "../lib/notify";
import { userErrorMessage } from "../lib/userError";
import { MessageText } from "./LocalChatPanel";

export function AgentCardConversation({ summary, busy, blocked, history, runPrompts, getCardDefaults, onOpen }: {
  summary: ChatSummary;
  busy: boolean;
  blocked: boolean;
  history: { key: string; label: string; conversationId?: string }[];
  runPrompts: ReadonlyMap<string, string>;
  getCardDefaults: () => ChatCardDefaults;
  onOpen: (conversationId?: string, entryKey?: string) => void;
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
  const [scrolled, setScrolled] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [historyOpen, setHistoryOpen] = useState(false);
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
        text: snapshot.text.trim(), referenceAssetIds: snapshot.referenceAssetIds, cardDefaults: getCardDefaults() });
      if (localChatDraft(id) === snapshot) store.setDraft(id, { ...snapshot, text: "", referenceAssetIds: [] });
    } catch (error) {
      notifyError(error, "消息暂未发送，请查看对话状态后重试");
    } finally {
      submitting.current = false;
    }
  }
  return <div className="workflow-agent-conversation" onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
    onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape" && !event.nativeEvent.isComposing) setHistoryOpen(false); }}>
    <div className="workflow-agent-reading">
      <div ref={scroll} tabIndex={0} aria-label="Agent 对话记录" className="workflow-agent-messages" data-scrolled={scrolled}
        onScroll={event => {
          const el = event.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          setScrolled(el.scrollTop > 1);
        }}>
        {!chat && (loadError ? <button type="button" onClick={read}>重新读取对话</button> : <p>正在读取对话…</p>)}
        {chat?.messages.map((message, index) => {
          const oldAnswer = message.role === "assistant" && index !== latestAssistantIndex;
          const collapsed = oldAnswer && !expanded.has(message.id);
          const excerpt = collapsed ? message.text.trimStart().slice(0, 160).split("\n", 1)[0] || "本轮未收到回复" : "";
          return <Fragment key={message.id}>
            {message.role === "tool" ? <p className="workflow-agent-tool"><Wrench size={12} />
              {message.status === "failed" ? userErrorMessage(message.text, "工具操作未完成") : message.text}</p>
              : <article className={`workflow-agent-message is-${message.role}`} data-message-id={message.id}>
                <strong>{message.role === "user" ? "你" : "Agent"}</strong>
                {message.role === "user" && message.referenceAssetIds.length > 0 && <small>{message.referenceAssetIds.length} 个引用素材</small>}
                {collapsed ? <button type="button" className="workflow-agent-excerpt" aria-label={`展开 Agent 回答：${excerpt}`}
                  aria-expanded={false} onClick={() => setExpanded(previous => new Set(previous).add(message.id))}>{excerpt}</button>
                  : message.text ? <MessageText text={message.role === "user" ? runPrompts.get(message.turnId) ?? message.text : message.text} />
                    : <p>{message.status === "running" ? "正在准备回复…" : "本轮未收到回复"}</p>}
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
    <div className="workflow-agent-composer">
      <textarea ref={input} rows={1} aria-label="续聊消息" placeholder="继续对话…" value={draft?.text ?? ""}
        onChange={event => useLocalChatStore.getState().setDraft(id, { ...localChatDraft(id), text: event.target.value })}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault();
            void send();
          }
        }} />
      <button type="button" className="app-icon-button" aria-label="发送续聊消息" title="发送续聊消息"
        disabled={!chat || !draft?.text.trim() || busy || blocked || sending} onClick={() => void send()}>
        {sending ? <LoaderCircle size={16} className="local-chat-spin" /> : <ArrowUp size={16} />}
      </button>
    </div>
  </div>;
}
