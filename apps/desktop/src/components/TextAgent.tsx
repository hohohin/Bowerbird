import { createContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, Square, X } from "lucide-react";
import type { PlateEditor } from "platejs/react";
import { useStore } from "../store";
import { normalizeDocument, parseMarkdown, serializeReadableMarkdown } from "../lib/documentCodec";
import { usePortalTarget } from "../lib/portalTarget";
import { textAgentSource, textAgentUnavailable, type TextAgentMessage } from "../lib/textAgent";
import { initialTextAgentTask } from "../lib/textAgentTask";
import { userErrorMessage } from "../lib/userError";
import { EditorAgentModel, useTextEditorServices } from "./text-editor/TextEditorServices";
import "./TextAgent.css";

export const TextAgentContext = createContext<((id: string, rect: DOMRect) => void) | null>(null);
interface Anchor { id: string; snapshot: string }
interface Target { anchor: Anchor; left: number; top: number }
function anchorFor(editor: PlateEditor, id: string): Anchor | null {
  const node = editor.children.find(node => node.id === id);
  return node ? { id, snapshot: JSON.stringify(node) } : null;
}

export function TextAgentScope({ editor, children }: { editor: PlateEditor; children: ReactNode }) {
  const [target, setTarget] = useState<Target | null>(null);
  const open = (id: string, rect: DOMRect) => {
    const anchor = anchorFor(editor, id);
    if (anchor) setTarget({ anchor, left: rect.left, top: rect.bottom + 8 });
  };
  return <TextAgentContext.Provider value={open}>{children}{target && <TextAgentBubble key={target.anchor.id} editor={editor} target={target} onClose={(restoreFocus = true) => { setTarget(null); if (restoreFocus) editor.tf.focus(); }}/>}</TextAgentContext.Provider>;
}

function writeAfter(editor: PlateEditor, anchor: Anchor, text: string): Anchor | null {
  const index = editor.children.findIndex(node => node.id === anchor.id);
  if (index < 0 || JSON.stringify(editor.children[index]) !== anchor.snapshot) return null;
  const nodes = parseMarkdown(text);
  editor.tf.insertNodes(nodes, { at: [index + 1] });
  return anchorFor(editor, nodes[nodes.length - 1].id);
}

function useTextAgentConversation(editor: PlateEditor, target: Target) {
  const services = useTextEditorServices();
  const [prompt, setPrompt] = useState(""), [messages, setMessages] = useState<TextAgentMessage[]>([]);
  const state = services.owner === 'paragraph' && (messages.length > 0 || services.state.resumable) ? services.state : initialTextAgentTask;
  const [pending, setPending] = useState<string | null>(null), [error, setError] = useState("");
  const anchor = useRef(target.anchor), request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function send() {
    if (request.current) return;
    const controller = new AbortController();
    try {
      const node = editor.children.find(node => node.id === anchor.current.id);
      if (!node) throw new Error("原段落已删除，请在新的段落打开 Agent。");
      anchor.current = anchorFor(editor, anchor.current.id)!;
      const source = textAgentSource(serializeReadableMarkdown(normalizeDocument([node])), messages);
      const response = services.generate(prompt, source, controller.signal, 'paragraph');
      request.current = controller;
      setError("");
      setMessages(previous => [...previous, { role: "user", text: prompt }]); setPrompt("");
      const text = await response;
      if (controller.signal.aborted) return;
      setMessages(previous => [...previous, { role: "assistant", text }]);
      const next = writeAfter(editor, anchor.current, text);
      if (next) anchor.current = next; else setPending(text);
    } catch (reason) {
      if (!controller.signal.aborted && !(reason instanceof DOMException && reason.name === 'AbortError')) {
        setError(userErrorMessage(reason, "本次内容无法提交，请检查段落后重试。"));
      }
    } finally { request.current = null; }
  }
  function insert() {
    if (!pending) return;
    const nodes = parseMarkdown(pending);
    editor.tf.insertNodes(nodes, { select: true });
    anchor.current = anchorFor(editor, nodes[nodes.length - 1].id)!;
    setPending(null); editor.tf.focus();
  }
  const reason = useStore(state => textAgentUnavailable(services.provider, state));
  return { prompt, setPrompt, messages, pending, state, error, send, insert, reason, busy: services.busy,
    canResume: services.owner === 'paragraph' && services.canResume,
    resume: () => services.resume('paragraph'), stop: () => services.stop('paragraph') };
}
type Conversation = ReturnType<typeof useTextAgentConversation>;

function AgentInput({ conversation: c }: { conversation: Conversation }) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => input.current?.focus(), []);
  return <textarea ref={input} aria-label="发送给 Agent" placeholder="帮我写…" maxLength={3600} value={c.prompt} onChange={event => c.setPrompt(event.target.value)} onKeyDown={event => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (canSend(c)) c.send(); }
  }}/>;
}
function canSend(c: Conversation) { return !c.busy && !c.pending && !!c.prompt.trim() && !c.reason; }
function AgentFooter({ conversation: c }: { conversation: Conversation }) {
  if (c.state.busy) return <div className="text-agent-footer"><button aria-label="停止" onClick={c.stop}><Square size={13}/></button></div>;
  return <div className="text-agent-footer">
    {c.pending && <button onMouseDown={event => event.preventDefault()} onClick={c.insert}>插入到光标处</button>}
    {c.state.resumable ? <><button onClick={c.stop}>停止</button>{c.canResume && <button onClick={c.resume}>继续取回</button>}</>
      : <button aria-label="发送" disabled={!canSend(c)} onClick={c.send}><ArrowUp size={16}/></button>}
  </div>;
}
function AgentHistory({ conversation: c }: { conversation: Conversation }) {
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [c.messages, c.state.preview]);
  return <>
    {c.messages.length > 0 && <div ref={log} className="text-agent-messages" role="log">{c.messages.map((message, index) => <p key={index} data-role={message.role}>{message.text}</p>)}{c.state.preview && <p aria-label="Agent 回复预览">{c.state.preview}</p>}</div>}
    {(c.state.error || c.error) && <p role="alert">{c.state.error || c.error}</p>}
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
function TextAgentBubble({ editor, target, onClose }: { editor: PlateEditor; target: Target; onClose(restoreFocus?: boolean): void }) {
  const portal = usePortalTarget(), position = useBubblePosition(target), c = useTextAgentConversation(editor, target);
  const root = useRef<HTMLDivElement>(null);
  useAgentDismiss(root, onClose);
  return createPortal(<div ref={root} role="dialog" aria-label="段落 Agent" className="text-agent-bubble" style={position}
    onPointerDown={event => event.stopPropagation()} onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); onClose(); } }}>
    <div className="text-agent-heading"><EditorAgentModel/><button aria-label="关闭 Agent" onClick={() => onClose()}><X size={15}/></button></div>
    <AgentHistory conversation={c}/><AgentInput conversation={c}/><AgentFooter conversation={c}/>
  </div>, portal);
}
