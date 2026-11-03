import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { CreationEditorDraft } from "./creation/useCreationEditor";
import type { CreativePromptLoad } from "../lib/creativeLaunch";
import type { TextWorkspaceDocument } from "../lib/documentTypes";
import { creationDraftToDocument, documentToPromptLoad } from "../lib/documentComposer";
import "./TextWorkspaceLauncher.css";

const TextWorkspace = lazy(() => import("./TextWorkspace").then(module => ({ default: module.TextWorkspace })));
interface WorkspaceDraft { sourceDoc: string; document: TextWorkspaceDocument }
const drafts = new Map<string, WorkspaceDraft>();
function parseDraft(value: unknown): WorkspaceDraft | undefined {
  if (!value || typeof value !== "object") return;
  const draft = value as Partial<WorkspaceDraft>;
  if (typeof draft.sourceDoc === "string" && typeof draft.document?.title === "string" && typeof draft.document?.markdown === "string") return draft as WorkspaceDraft;
}
function readDraft(key: string): WorkspaceDraft | undefined {
  const saved = drafts.get(key);
  if (saved) return saved;
  try {
    return parseDraft(JSON.parse(sessionStorage.getItem(key) ?? "null"));
  } catch { /* Session storage is optional; the composer remains the source. */ }
}

function assertSource(getDraft: () => CreationEditorDraft, sourceDoc: string) {
  if (JSON.stringify(getDraft().doc) !== sourceDoc) throw new Error("生成对话框已发生变化，请先返回核对，编辑内容已保留。");
}
async function applyDocument(document: TextWorkspaceDocument, sourceDoc: string, getDraft: () => CreationEditorDraft, loadPrompt: (request: CreativePromptLoad) => boolean, isCurrent: () => boolean) {
  assertSource(getDraft, sourceDoc);
  if (document.markdown === creationDraftToDocument(getDraft()).markdown) return true;
  const request = await documentToPromptLoad(document, getDraft().doc);
  if (!isCurrent()) return false;
  assertSource(getDraft, sourceDoc);
  if (!request.prompt.trim()) throw new Error("请先填写文本或添加素材。");
  if (!loadPrompt(request)) throw new Error("生成对话框暂不可用，编辑内容已保留。");
  return true;
}
function remember(key: string, draft: WorkspaceDraft) {
  drafts.set(key, draft);
  try { sessionStorage.setItem(key, JSON.stringify(draft)); } catch { /* Keep the in-session copy. */ }
}

export function useTextWorkspace({ scopeKey, projectId, getDraft, loadPrompt, focus }: {
  scopeKey: string; projectId?: string; getDraft(): CreationEditorDraft; loadPrompt(request: CreativePromptLoad): boolean; focus(): void;
}) {
  const [active, setActive] = useState<WorkspaceDraft | null>(null);
  const session = useRef(0);
  const revision = useRef(0);
  const key = `bowerbird.text-workspace.${scopeKey}`;
  useEffect(() => { setActive(null); return () => { session.current++; }; }, [scopeKey]);
  function openEditor() {
    const draft = getDraft(), sourceDoc = JSON.stringify(draft.doc), saved = readDraft(key);
    const next = saved?.sourceDoc === sourceDoc ? saved : { sourceDoc, document: creationDraftToDocument(draft) };
    session.current++; setActive(next);
  }
  function change(document: TextWorkspaceDocument) {
    revision.current++;
    if (active) remember(key, { sourceDoc: active.sourceDoc, document });
  }
  function close(document: TextWorkspaceDocument) { change(document); session.current++; setActive(null); focus(); }
  async function add(document: TextWorkspaceDocument) {
    if (!active) return;
    const requestSession = session.current, requestRevision = revision.current;
    const applied = await applyDocument(document, active.sourceDoc, getDraft, loadPrompt, () => {
      if (requestSession !== session.current) return false;
      if (requestRevision !== revision.current) throw new Error("文本已有新的更改，请再次添加；当前内容已保留。");
      return true;
    });
    if (!applied) return;
    remember(key, { sourceDoc: JSON.stringify(getDraft().doc), document });
    session.current++; setActive(null); focus();
  }
  return { openEditor, workspace: active ? <Suspense fallback={null}><TextWorkspace initialDocument={active.document} projectId={projectId} onChange={change} onClose={close} onAddToComposer={add}/></Suspense> : null };
}
