import { createContext, useCallback, useContext, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { textAgentUnavailable, type TextAgentProvider } from '../../lib/textAgent';
import { TextAgentTask, initialTextAgentTask, type TextAgentTaskState } from '../../lib/textAgentTask';
import { importDroppedMedia } from '../../lib/mediaImport';
import { documentMedia } from '../../lib/textDocuments';
import { TextAgentModel } from '../TextAgent';
import { saveDocumentAttachment } from '../../lib/documentAttachments';

export interface EditorUpload { name: string; url: string; assetId?: string; sourcePath?: string; attachmentId?: string }
interface Services {
  provider: TextAgentProvider;
  setProvider(provider: TextAgentProvider): void;
  busy: boolean;
  state: TextAgentTaskState;
  canResume: boolean;
  resume(): void;
  generate(prompt: string, source: string, signal?: AbortSignal): Promise<string>;
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
  return <TextAgentModel provider={provider} setProvider={setProvider} busy={busy}/>;
}
export function EditorAgentStatus() {
  const { state, resume, canResume } = useTextEditorServices();
  if (!state.error) return null;
  return <div className="text-editor-agent-error"><p role="alert">{state.error}</p>{state.resumable && <button disabled={state.busy} onClick={resume}>{canResume ? '取回原请求' : '再次停止'}</button>}</div>;
}
type PendingReply = { resolve(text: string): void; reject(error: unknown): void };
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
async function generateReply(task: TextAgentTask, pending: MutableRefObject<PendingReply | null>, request: Parameters<TextAgentTask['run']>[0], signal?: AbortSignal) {
  const abort = () => { pending.current?.reject(new DOMException('已停止', 'AbortError')); void task.stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    return await new Promise<string>((resolve, reject) => { pending.current = { resolve, reject }; void task.run(request); });
  } finally { pending.current = null; signal?.removeEventListener('abort', abort); }
}
function useAgentGeneration(taskInfo: ReturnType<typeof useEditorTask>, provider: TextAgentProvider, projectId?: string) {
  const { latest, pending, task } = taskInfo;
  const sessionId = useRef(crypto.randomUUID());
  return useCallback((prompt: string, source: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (pending.current || latest.current.busy || latest.current.resumable) throw new Error('请先完成或停止当前 Agent 请求。');
    return generateReply(task, pending, { provider, prompt, source, projectId, sessionId: sessionId.current, requestId: crypto.randomUUID() }, signal);
  }, [provider, projectId, task, latest, pending]);
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
  const generate = useAgentGeneration(taskInfo, provider, projectId);
  return <ServicesContext.Provider value={{ provider, setProvider, busy: state.busy || !!pending.current, state, canResume: !!pending.current, resume: () => { void (pending.current ? task.run() : task.stop()); }, generate, upload: file => uploadFile(file, projectId) }}>{children}</ServicesContext.Provider>;
}
