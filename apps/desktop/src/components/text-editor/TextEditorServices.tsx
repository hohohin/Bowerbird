import { createContext, useCallback, useContext, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { useStore } from '../../store';
import { TEXT_AGENT_LABELS, textAgentUnavailable, type TextAgentProvider } from '../../lib/textAgent';
import { TextAgentTask, initialTextAgentTask, type TextAgentTaskState } from '../../lib/textAgentTask';
import { importDroppedMedia } from '../../lib/mediaImport';
import { documentMedia } from '../../lib/textDocuments';
import { ModelSelect } from '../creation/ModelSelect';
import { saveDocumentAttachment } from '../../lib/documentAttachments';

export interface EditorUpload { name: string; url: string; assetId?: string; sourcePath?: string; attachmentId?: string }
type AgentOwner = 'toolbar' | 'paragraph';
interface Services {
  provider: TextAgentProvider;
  setProvider(provider: TextAgentProvider): void;
  busy: boolean;
  state: TextAgentTaskState;
  owner: AgentOwner | null;
  canResume: boolean;
  resume(owner: AgentOwner): void;
  stop(owner: AgentOwner): void;
  generate(prompt: string, source: string, signal?: AbortSignal, owner?: AgentOwner): Promise<string>;
  upload(file: File): Promise<EditorUpload>;
}
const ServicesContext = createContext<Services | null>(null);
export function useTextEditorServices() {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('Editor services are unavailable');
  return services;
}
export function EditorAgentModel() {
  const { provider, setProvider, busy } = useTextEditorServices();
  const auth = useStore(state => state.cloudAuth), entitlement = useStore(state => state.cloudEntitlement);
  useStore(state => state.codexHealth); useStore(state => state.cloudAgentRuns);
  const balance = entitlement ? entitlement.balances.daily + entitlement.balances.sub + entitlement.balances.topup : null;
  return <ModelSelect value={provider} label={TEXT_AGENT_LABELS[provider]} kind="Agent" source={provider === 'cloud' ? 'cloud' : 'personal'}
    options={(['codex-cli', 'cloud'] as const).map(key => ({ key, label: TEXT_AGENT_LABELS[key], source: key === 'cloud' ? 'cloud' : 'personal', reason: busy ? '请先完成或停止当前请求' : textAgentUnavailable(key) }))}
    onChange={key => { if (!busy && (key === 'cloud' || key === 'codex-cli')) setProvider(key); }} cloudBalance={balance} cloudLoggedIn={auth?.logged_in}/>;
}
export function EditorAgentStatus() {
  const { state, owner, resume, stop, canResume } = useTextEditorServices();
  if (!state.error || !owner || (owner !== 'toolbar' && canResume)) return null;
  return <div className="text-editor-agent-error"><p role="alert">{state.error}</p>{state.resumable && <button disabled={state.busy} onClick={() => canResume ? resume(owner) : stop(owner)}>{canResume ? '取回原请求' : '再次停止'}</button>}</div>;
}
export function EditorAgentPreview() {
  const { owner, state } = useTextEditorServices();
  if (owner !== 'toolbar' || !state.preview) return null;
  return <p className="text-editor-agent-preview" aria-label="Agent 回复预览">{state.preview}</p>;
}
type PendingReply = { owner: AgentOwner; resolve(text: string): void; reject(error: unknown): void };
function useEditorTask() {
  const [state, setState] = useState(initialTextAgentTask);
  const latest = useRef(initialTextAgentTask);
  const pending = useRef<PendingReply | null>(null);
  const [task] = useState(() => new TextAgentTask(next => {
    latest.current = next;
    setState(next);
    if (next.error && !next.busy && !next.resumable) pending.current?.reject(new Error(next.error));
  }, text => pending.current?.resolve(text)));
  useEffect(() => { task.activate(); return () => { task.close(); pending.current?.reject(new DOMException('已关闭编辑器', 'AbortError')); }; }, [task]);
  return { state, latest, pending, task };
}
async function generateReply(task: TextAgentTask, pending: MutableRefObject<PendingReply | null>, request: Parameters<TextAgentTask['run']>[0], owner: AgentOwner, signal?: AbortSignal) {
  const abort = () => {
    if (pending.current?.owner !== owner) return;
    pending.current.reject(new DOMException('已停止', 'AbortError'));
    void task.stop();
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    return await new Promise<string>((resolve, reject) => { pending.current = { owner, resolve, reject }; void task.run(request); });
  } finally { pending.current = null; signal?.removeEventListener('abort', abort); }
}
function useAgentGeneration(taskInfo: ReturnType<typeof useEditorTask>, setOwner: (value: AgentOwner) => void, provider: TextAgentProvider, projectId?: string) {
  const { latest, pending, task } = taskInfo;
  const sessionId = useRef(crypto.randomUUID());
  return useCallback((prompt: string, source: string, signal?: AbortSignal, owner: AgentOwner = 'toolbar') => {
    signal?.throwIfAborted();
    if (pending.current || latest.current.busy || latest.current.resumable) throw new Error('请先完成或停止当前 Agent 请求。');
    setOwner(owner);
    return generateReply(task, pending, { provider, prompt, source, projectId, sessionId: sessionId.current, requestId: crypto.randomUUID(), editor: true }, owner, signal);
  }, [provider, projectId, task, latest, pending, setOwner]);
}
async function uploadFile(file: File, projectId?: string): Promise<EditorUpload> {
  if (!/\.(png|jpe?g|webp|gif|avif|bmp|tiff?|heic|heif|mp4|mov|mkv|webm|m4v|avi|wav|mp3|m4a|ogg|flac|aac)$/i.test(file.name)) return saveDocumentAttachment(file);
  // Browser pickers add a relative path; it is not a native file-system path.
  const bytes = new File([file], file.name, { type: file.type, lastModified: file.lastModified });
  const asset = await importDroppedMedia(bytes, projectId ?? null);
  const media = documentMedia(asset);
  if (!media) throw new Error('无法读取此媒体文件，请检查格式后重试。');
  return { name: asset.name, url: media.url, assetId: asset.id, sourcePath: media.path };
}
export function TextEditorServices({ projectId, children }: { projectId?: string; children: ReactNode }) {
  const [provider, setProvider] = useState<TextAgentProvider>(() => textAgentUnavailable('codex-cli') && !textAgentUnavailable('cloud') ? 'cloud' : 'codex-cli');
  const taskInfo = useEditorTask();
  const { state, task, pending } = taskInfo;
  const [owner, setOwner] = useState<AgentOwner | null>(null);
  const generate = useAgentGeneration(taskInfo, setOwner, provider, projectId);
  return <ServicesContext.Provider value={{ provider, setProvider, busy: state.busy || state.resumable || !!pending.current, state, owner, canResume: !!pending.current,
    resume: target => { if (pending.current?.owner === target) void task.run(); },
    stop: target => { if (owner !== target) return; pending.current?.reject(new DOMException('已停止', 'AbortError')); void task.stop(); },
    generate, upload: file => uploadFile(file, projectId) }}>{children}</ServicesContext.Provider>;
}
