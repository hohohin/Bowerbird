import { createContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, Square, X } from "lucide-react";
import type { PlateEditor } from "platejs/react";
import { useStore } from "../store";
import { readDocumentState } from "../lib/documentState";
import { normalizeDocument, parseMarkdown, serializeMarkdown } from "../lib/documentCodec";
import { usePortalTarget } from "../lib/portalTarget";
import { textAgentSource, textAgentUnavailable, TEXT_AGENT_LABELS, type TextAgentMessage, type TextAgentProvider } from "../lib/textAgent";
import { TextAgentTask, initialTextAgentTask } from "../lib/textAgentTask";
import { userErrorMessage } from "../lib/userError";
import { ModelSelect } from "./creation/ModelSelect";
import "./TextAgent.css";

export const TextAgentContext = createContext<((id: string, rect: DOMRect) => void) | null>(null);
interface Anchor { id: string; snapshot: string }
interface Target { anchor: Anchor; left: number; top: number }
function anchorFor(editor: PlateEditor, id: string): Anchor | null {
  const node = editor.children.find(node => node.id === id);
  return node ? { id, snapshot: JSON.stringify(node) } : null;
}

/** A single bubble owns requests, so moving/deleting a block cannot retarget an in-flight write. */
export function TextAgentScope({ editor, projectId, children }: { editor: PlateEditor; projectId?: string; children: ReactNode }) {
  const [target, setTarget] = useState<Target | null>(null);
  const open = (id: string, rect: DOMRect) => {
    const anchor = anchorFor(editor, id);
    if (anchor) setTarget({ anchor, left: rect.left, top: rect.bottom + 8 });
  };
  return <TextAgentContext.Provider value={open}>{children}{target && <TextAgentBubble key={target.anchor.id} editor={editor} projectId={projectId} target={target} onClose={(restoreFocus = true) => { setTarget(null); if (restoreFocus) editor.tf.focus(); }}/>}</TextAgentContext.Provider>;
}

export function TextAgentModel({ provider, setProvider, busy }: { provider: TextAgentProvider; setProvider(value: TextAgentProvider): void; busy: boolean }) {
  const auth = useStore(state => state.cloudAuth), entitlement = useStore(state => state.cloudEntitlement);
  useStore(state => state.codexHealth); useStore(state => state.cloudAgentRuns);
  const balance = entitlement ? entitlement.balances.daily + entitlement.balances.sub + entitlement.balances.topup : null;
  return <ModelSelect value={provider} label={TEXT_AGENT_LABELS[provider]} kind="Agent" source={provider === "cloud" ? "cloud" : "personal"}
    options={(["codex-cli", "cloud"] as const).map(key => ({ key, label: TEXT_AGENT_LABELS[key], source: key === "cloud" ? "cloud" : "personal", reason: busy ? "请先等待当前回复" : textAgentUnavailable(key) }))}
    onChange={key => { if (key === "cloud" || key === "codex-cli") setProvider(key); }} cloudBalance={balance} cloudLoggedIn={auth?.logged_in}/>;
}

function defaultProvider(): TextAgentProvider { return textAgentUnavailable("codex-cli") && !textAgentUnavailable("cloud") ? "cloud" : "codex-cli"; }
function writeAfter(editor: PlateEditor, anchor: Anchor, text: string): Anchor | null {
  const index = editor.children.findIndex(node => node.id === anchor.id);
  if (index < 0 || JSON.stringify(editor.children[index]) !== anchor.snapshot) return null;
  const nodes = parseMarkdown(text);
  editor.tf.insertNodes(nodes, { at: [index + 1] });
  return anchorFor(editor, nodes[nodes.length - 1].id);
}

function useTextAgentConversation(editor: PlateEditor, target: Target, projectId?: string) {
  const [provider, setProvider] = useState<TextAgentProvider>(defaultProvider);
  const [prompt, setPrompt] = useState(""), [messages, setMessages] = useState<TextAgentMessage[]>([]);
  const [pending, setPending] = useState<string | null>(null), [state, setState] = useState(initialTextAgentTask);
  const anchor = useRef(target.anchor), sessionId = useRef(crypto.randomUUID());
  const [task] = useState(() => new TextAgentTask(setState, text => {
    setMessages(previous => [...previous, { role: "assistant", text }]);
    const next = writeAfter(editor, anchor.current, text);
    if (next) anchor.current = next; else setPending(text);
  }));
  useEffect(() => { task.activate(); return () => task.close(); }, [task]);
  function send() {
    try {
      const node = editor.children.find(node => node.id === anchor.current.id);
      if (!node) throw new Error("原段落已删除，请在新的段落打开 Agent。");
      anchor.current = anchorFor(editor, anchor.current.id)!;
      const source = textAgentSource(readDocumentState(serializeMarkdown(normalizeDocument([node]))).source, messages);
      setMessages(previous => [...previous, { role: "user", text: prompt }]); setPrompt("");
      void task.run({ provider, prompt, source, projectId, sessionId: sessionId.current, requestId: crypto.randomUUID() });
    } catch (reason) { setState(previous => ({ ...previous, error: userErrorMessage(reason, "本次内容无法提交，请检查段落后重试。") })); }
  }
  function insert() {
    if (!pending) return;
    const nodes = parseMarkdown(pending);
    editor.tf.insertNodes(nodes, { select: true });
    anchor.current = anchorFor(editor, nodes[nodes.length - 1].id)!;
    setPending(null); editor.tf.focus();
  }
  const reason = useStore(state => textAgentUnavailable(provider, state));
  return { provider, setProvider, prompt, setPrompt, messages, pending, state, task, send, insert, reason };
}
type Conversation = ReturnType<typeof useTextAgentConversation>;

function AgentInput({ conversation: c }: { conversation: Conversation }) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => input.current?.focus(), []);
  return <textarea ref={input} aria-label="发送给 Agent" placeholder="帮我写…" maxLength={3600} value={c.prompt} onChange={event => c.setPrompt(event.target.value)} onKeyDown={event => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (canSend(c)) c.send(); }
  }}/>;
}
function canSend(c: Conversation) { return !c.state.busy && !c.state.resumable && !c.pending && !!c.prompt.trim() && !c.reason; }
function AgentFooter({ conversation: c }: { conversation: Conversation }) {
  if (c.state.busy) return <div className="text-agent-footer"><button aria-label="停止" onClick={() => void c.task.stop()}><Square size={13}/></button></div>;
  return <div className="text-agent-footer">
    {c.pending && <button onMouseDown={event => event.preventDefault()} onClick={c.insert}>插入到光标处</button>}
    {c.state.resumable ? <><button onClick={() => void c.task.stop()}>停止</button><button onClick={() => void c.task.run()}>继续取回</button></>
      : <button aria-label="发送" disabled={!canSend(c)} onClick={c.send}><ArrowUp size={16}/></button>}
  </div>;
}
function AgentHistory({ conversation: c }: { conversation: Conversation }) {
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [c.messages]);
  return <>
    {c.messages.length > 0 && <div ref={log} className="text-agent-messages" role="log">{c.messages.map((message, index) => <p key={index} data-role={message.role}>{message.text}</p>)}</div>}
    {c.state.error && <p role="alert">{c.state.error}</p>}
    <p role="status">{c.pending ? "段落已变化，结果尚未写入。" : c.state.status}</p>
    {!c.state.busy && c.reason && <p className="text-agent-unavailable">{c.reason}</p>}
  </>;
}
function useBubblePosition(target: Target) {
  const place = () => { const top = Math.max(12, Math.min(target.top, window.innerHeight - 440)); return { left: Math.max(12, Math.min(target.left, window.innerWidth - 412)), top, maxHeight: window.innerHeight - top - 12 }; };
  const [position, setPosition] = useState(place);
  useEffect(() => { const resize = () => setPosition(place()); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, [target]);
  return position;
}
function useAgentDismiss(root: RefObject<HTMLDivElement>, onClose: (restoreFocus?: boolean) => void) {
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const node = event.target as Node;
      if (root.current?.contains(node)) return;
      // The model selector is a portal owned by the bubble's aria-controls trigger.
      const controls = root.current?.querySelectorAll('[aria-controls]') ?? [];
      for (const trigger of controls) if (document.getElementById(trigger.getAttribute('aria-controls')!)?.contains(node)) return;
      onClose(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [root, onClose]);
}
function TextAgentBubble({ editor, projectId, target, onClose }: { editor: PlateEditor; projectId?: string; target: Target; onClose(restoreFocus?: boolean): void }) {
  const portal = usePortalTarget(), position = useBubblePosition(target), c = useTextAgentConversation(editor, target, projectId);
  const root = useRef<HTMLDivElement>(null);
  useAgentDismiss(root, onClose);
  return createPortal(<div ref={root} role="dialog" aria-label="段落 Agent" className="text-agent-bubble" style={position}
    onPointerDown={event => event.stopPropagation()} onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); onClose(); } }}>
    <div className="text-agent-heading"><TextAgentModel provider={c.provider} setProvider={c.setProvider} busy={c.state.busy || c.state.resumable}/><button aria-label="关闭 Agent" onClick={() => onClose()}><X size={15}/></button></div>
    <AgentHistory conversation={c}/><AgentInput conversation={c}/><AgentFooter conversation={c}/>
  </div>, portal);
}
