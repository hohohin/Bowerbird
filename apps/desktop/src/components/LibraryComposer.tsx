import { useEffect, useRef, useState } from "react";
import { Folder } from "lucide-react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { clearSentCreativeChatDraft, parseCreativeComposerState } from "../lib/creativeDraft";
import { useLocalChatStore } from "../lib/localChatStore";
import { DEFAULT_VIDEO_OPTIONS } from "../lib/videoGeneration";
import { canvasWorkflowController } from "../lib/canvasWorkflowRuntime";
import { startComposerLocalVideo } from "../lib/composerLocalVideo";
import { prepareFileWorkspace } from "../lib/fileWorkspace";
import type { ComposerLocalVideoRequest } from "../lib/comfyVideo";
import type { ChatComposeRequest } from "../lib/localChat";
import { CreativeComposer } from "./CreativeComposer";
import { TacticalSelect } from "./TacticalSelect";
import { LocalChatHistory } from "./LocalChatPanel";
import "./LibraryComposer.css";

const DRAFT_KEY = "bowerbird.libraryComposer.draft.v1";
function readDraft() {
  try { return localStorage.getItem(DRAFT_KEY) ?? ""; } catch { return ""; }
}

function useLibraryDraft() {
  const [draftJson, setDraftJson] = useState(readDraft);
  const draft = useRef(draftJson);
  const [draftRevision, setDraftRevision] = useState(0);
  const flush = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  function saveDraft(value: string) {
    draft.current = value;
    setDraftJson(value);
    try { localStorage.setItem(DRAFT_KEY, value); } catch { /* Keep the current window's draft. */ }
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; flush.current?.(); useStore.getState().setBoardActive(false); }; }, []);
  function clearSent(sent: string) {
    if (!mounted.current) return;
    flush.current?.();
    const cleared = clearSentCreativeChatDraft(draft.current, sent);
    if (cleared !== null) { saveDraft(cleared); setDraftRevision(value => value + 1); }
  }
  return { draftJson, draft, draftRevision, flush, mounted, saveDraft, clearSent };
}

async function prepareLibraryProject(target: string | null, isMounted: () => boolean) {
    let project;
    try { project = await api.prepareLibraryGenerationProject(target); }
    catch (error) {
      if (!String(error).includes("FILE_ROOT_REQUIRED:")) throw error;
      await prepareFileWorkspace();
      if (!isMounted()) throw new Error("已离开素材库，请重新发送");
      project = await api.prepareLibraryGenerationProject(target);
    }
    await useStore.getState().reloadProjects();
    return project.id;
}

async function placement(projectId: string) {
    const snapshot = await api.projectCanvasGet(projectId);
    const nodes = snapshot.nodes.filter(node => node.hiddenAt == null);
    return { x: 80, y: nodes.length ? Math.max(...nodes.map(node => node.y + node.height)) + 80 : 80 };
}
function requireProject(projectId?: string) {
    if (!projectId) throw new Error("请重新选择项目后发送");
    return projectId;
}

async function startLibraryThread(prompt: string, target?: string) {
  const projectId = requireProject(target);
  const thread = await api.projectThreadCreate({ id: crypto.randomUUID(), projectId,
    title: prompt.trim().split(/\r?\n/, 1)[0].slice(0, 64) || "新创作", origin: "direct" });
  return { threadId: thread.id, parentNodeId: null, continuationRequestId: null };
}

async function startLibraryVideo(request: ComposerLocalVideoRequest, target?: string) {
  const projectId = requireProject(target);
  const controller = canvasWorkflowController(projectId);
  await controller.load();
  if (controller.error) throw new Error(controller.error);
  const point = await placement(projectId);
  point.y = Math.max(point.y, ...controller.document.nodes.map(node => node.y + 440));
  return startComposerLocalVideo(controller, request, point);
}

async function startLibraryChat(request: ChatComposeRequest, draftJson: string, target?: string) {
  const projectId = requireProject(target);
  const state = useStore.getState();
  const video = parseCreativeComposerState(draftJson).drafts.video?.generation;
  await useLocalChatStore.getState().send({ projectId, text: request.prompt, provider: request.provider,
    referenceAssetIds: request.references.map(asset => asset.id),
    cardDefaults: { provider: state.activeGenProvider || state.defaultProvider, videoChannel: video?.videoChannel ?? "jimeng", videoOptions: { ...(video?.videoOptions ?? DEFAULT_VIDEO_OPTIONS) } },
    placement: { ...await placement(projectId), width: 320, height: 190, zIndex: Date.now() % 1000000 } });
}

function LibraryProjectPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const projects = useStore(state => state.projects);
  const availableProjects = projects.filter(project => !project.provisional && !project.archived_at);
  const missingSelection = value && !availableProjects.some(project => project.id === value);

  return <div className="library-composer-target">
      <Folder size={14} aria-hidden/>
      <TacticalSelect aria-label="选择项目" menuClassName="library-project-menu" value={value} onValueChange={onChange}>
        <option value="">选择项目</option>
        {missingSelection && <option value={value}>项目已不可用，请重新选择</option>}
        {availableProjects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </TacticalSelect>
    </div>;
}

function openChat(id: string) {
  const chat = useLocalChatStore.getState().summaries[id];
  if (chat) useStore.setState({ creativeNavigation: { projectId: chat.projectId, threadId: chat.threadId, nodeId: chat.nodeId } });
}

/** The library draft and destination are independent of the visible project route. */
export function LibraryComposer({ onLocalVideoStarted, onOpenLibrary }: {
  onLocalVideoStarted?: (projectId: string, nodeId: string) => void;
  onOpenLibrary?: () => void;
}) {
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [preparedProjectId, setPreparedProjectId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const { draftJson, draft, draftRevision, flush, mounted, saveDraft, clearSent } = useLibraryDraft();
  const historyProjectId = selectedProjectId || preparedProjectId;
  async function prepareProject() {
    const target = selectedProjectId || null;
    const id = await prepareLibraryProject(target, () => mounted.current);
    if (!target && mounted.current) setPreparedProjectId(id);
    return id;
  }
  return <section className="library-composer" aria-label="素材库创作">
    <CreativeComposer key={draftRevision} projectId={selectedProjectId || undefined} draftJson={draftJson}
      header={<LibraryProjectPicker value={selectedProjectId} onChange={id => { setSelectedProjectId(id); setHistoryOpen(false); }}/>}
      onDraftChange={saveDraft} registerDraftFlush={value => { flush.current = value; }} prepareProject={prepareProject}
      onOpenLibrary={onOpenLibrary}
      resolveCreativeThread={(_parent, prompt, _revision, _continuation, _parentNode, target) => startLibraryThread(prompt, target)}
      onGenerateLocalVideo={async (request, target) => {
        const projectId = requireProject(target);
        const node = await startLibraryVideo(request, projectId);
        onLocalVideoStarted?.(projectId, node.id);
      }}
      onSendChat={(request, target) => startLibraryChat(request, draft.current, target)}
      onChatDraftSent={clearSent}
      onOpenChatHistory={() => setHistoryOpen(value => !value)} chatHistoryOpen={historyOpen}
    />
    {historyOpen && <div className="library-composer-history">
      {historyProjectId ? <LocalChatHistory projectId={historyProjectId} onClose={() => setHistoryOpen(false)} onOpen={openChat}/> : <span>还没有对话</span>}
    </div>}
  </section>;
}
