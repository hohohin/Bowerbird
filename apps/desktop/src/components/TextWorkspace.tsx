import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowUp, ChevronDown, FileText, Folder, PanelLeft } from "lucide-react";
import { api } from "../lib/api";
import type { DocumentMedia, DocumentValue, TextDocumentDestination, TextWorkspaceDocument } from "../lib/documentTypes";
import { connectedRows, folderConnections, type FolderConnection } from "../lib/folderConnections";
import { documentMedia, documentReferenceIds, textDocuments } from "../lib/textDocuments";
import { textWorkspaceRequestId } from "../lib/textWorkspaceSave";
import type { Asset, Project } from "../lib/types";
import { userErrorMessage } from "../lib/userError";
import { TextPlateEditor, type TextPlateHandle } from "./TextPlateEditor";
import { TextWorkspaceLibrary } from "./TextWorkspaceLibrary";
import { PortalTargetContext } from "../lib/portalTarget";
import "./TextDocumentEditor.css";
import "./TextWorkspace.css";
import { useRecentTextDocument } from "./useRecentTextDocument";
import { RecentTextDocuments, TextAutosaveStatus } from "./RecentTextDocuments";
import type { TextDocumentOrigin } from "../lib/recentTextDocuments";

interface Props {
  initialDocument: TextWorkspaceDocument;
  projectId?: string;
  origin?: TextDocumentOrigin;
  onChange?(document: TextWorkspaceDocument, context: { isSourceDocument: boolean }): void;
  onClose(document: TextWorkspaceDocument): void;
  onAddToComposer(document: TextWorkspaceDocument, context: { isSourceDocument: boolean }): void | Promise<void>;
}

interface DestinationOption { id: string; label: string; title: string; depth: number; available: boolean; destination: TextDocumentDestination }
function collectionOptions(folders: FolderConnection[]): DestinationOption[] {
  return connectedRows(folders).map(({ item, depth }) => ({ id: item.id, label: item.name, title: item.available ? item.path : "此集合未连接", available: item.available, depth, destination: { kind: "collection", folderId: item.id } }));
}
function projectOptions(projects: Project[], projectId?: string): DestinationOption[] {
  return projects.filter(item => !item.provisional && !item.archived_at).sort((a, b) => Number(b.id === projectId) - Number(a.id === projectId))
    .map(item => ({ id: item.id, label: item.name, title: item.name, depth: 0, available: true, destination: { kind: "project", projectId: item.id } }));
}
function useDestinations(kind: "collection" | "project", projectId?: string) {
  const [options, setOptions] = useState<DestinationOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const request = kind === "collection" ? folderConnections.list().then(items => { if (live) setOptions(collectionOptions(items)); })
      : api.listProjects().then(items => { if (live) setOptions(projectOptions(items, projectId)); });
    void request.catch(reason => { if (live) setError(userErrorMessage(reason, "保存位置暂时无法读取，请重试。")); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [kind, projectId]);
  return { options, loading, error };
}
function SaveDestinations({ kind, projectId, busy, onSelect }: { kind: "collection" | "project"; projectId?: string; busy: boolean; onSelect(destination: TextDocumentDestination, label: string): void }) {
  const { options, loading, error } = useDestinations(kind, projectId);
  return <div className="text-workspace-destinations" role="group" aria-label={kind === "collection" ? "选择集合" : "选择项目"}>
    {loading && <p role="status">正在读取…</p>}{error && <p role="alert">{error}</p>}
    {options.map(option => <button key={option.id} disabled={busy || !option.available} title={option.title} style={{ paddingLeft: 10 + option.depth * 14 }} onClick={() => onSelect(option.destination, option.label)}><Folder size={14}/>{option.label}</button>)}
    {!loading && !error && !options.length && <p>{kind === "collection" ? "请先在素材库建立集合连接。" : "请先创建项目。"}</p>}
  </div>;
}

function useWorkspaceMedia(value: DocumentValue, mounted: { current: boolean }, setNotice: (text: string) => void) {
  const [media, setMedia] = useState<DocumentMedia[]>([]);
  async function resolveMedia(ids: string[]) {
    const assets = ids.length ? await api.getAssetsByIds(ids) : [];
    const items = assets.map(documentMedia).filter((item): item is DocumentMedia => item !== null);
    if (mounted.current) setMedia(previous => [...previous.filter(item => !items.some(next => next.asset.id === item.asset.id)), ...items]);
    return items;
  }
  const ids = JSON.stringify(documentReferenceIds(value));
  useEffect(() => { void resolveMedia(JSON.parse(ids)).catch(() => { if (mounted.current) setNotice("部分参考素材暂不可用，原引用已保留。"); }); }, [ids]);
  return { media, resolveMedia };
}

function useWorkspaceFocus(panel: { current: HTMLDivElement | null }, mounted: { current: boolean }) {
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = [...document.body.children].filter((element): element is HTMLElement => element instanceof HTMLElement && !element.contains(panel.current));
    const inert = background.map(element => element.inert);
    background.forEach(element => { element.inert = true; });
    panel.current?.focus();
    return () => { mounted.current = false; background.forEach((element, index) => { element.inert = inert[index]; }); previous?.focus(); };
  }, []);
}

interface WorkspaceActivity {
  current: { current: TextWorkspaceDocument }; mounted: { current: boolean }; pending: { current: boolean };
  setBusy(value: boolean): void; setError(value: string): void; setNotice(value: string): void;
}
function beginActivity(activity: WorkspaceActivity) {
  if (activity.pending.current) return false;
  activity.pending.current = true; activity.setBusy(true); activity.setError(""); activity.setNotice("");
  return true;
}
function finishActivity(activity: WorkspaceActivity) {
  activity.pending.current = false;
  if (activity.mounted.current) activity.setBusy(false);
}
function savedMessage(current: TextWorkspaceDocument, snapshot: TextWorkspaceDocument, destination: TextDocumentDestination, label: string) {
  const changed = current.markdown !== snapshot.markdown || current.title !== snapshot.title;
  return `已保存到${destination.kind === "collection" ? "集合" : "项目"}「${label}」${changed ? "，新的更改仍保留在编辑器。" : ""}`;
}
async function saveWorkspace(activity: WorkspaceActivity, destination: TextDocumentDestination, label: string) {
  if (!beginActivity(activity)) return;
  const snapshot = { ...activity.current.current, title: activity.current.current.title.trim() || "未命名文本" };
  try {
    const requestId = await textWorkspaceRequestId(snapshot, destination);
    await textDocuments.create({ requestId, title: snapshot.title, text: snapshot.markdown, destination });
    if (activity.mounted.current) activity.setNotice(savedMessage(activity.current.current, snapshot, destination, label));
  } catch (reason) { if (activity.mounted.current) activity.setError(userErrorMessage(reason, "保存未完成，草稿已保留，请重试。")); }
  finally { finishActivity(activity); }
}
async function addWorkspace(activity: WorkspaceActivity, onAddToComposer: (document: TextWorkspaceDocument) => void | Promise<void>) {
  if (!beginActivity(activity)) return;
  try { await onAddToComposer(activity.current.current); }
  catch (reason) { if (activity.mounted.current) activity.setError(userErrorMessage(reason, "内容暂时无法添加，草稿已保留，请重试。")); }
  finally { finishActivity(activity); }
}
async function insertWorkspaceAsset(activity: WorkspaceActivity, plate: TextPlateHandle | null, resolveMedia: (ids: string[]) => Promise<DocumentMedia[]>, asset: Asset) {
  const insertion = plate?.reserveInsertion();
  try { const items = await resolveMedia([asset.id]); if (!items.length) throw new Error("素材已不可用，请刷新素材库后重试。"); if (activity.mounted.current) insertion?.insert(items); }
  catch (reason) { if (activity.mounted.current) activity.setError(userErrorMessage(reason, "素材暂时无法插入，请重试。")); }
  finally { insertion?.cancel(); }
}
function trapWorkspaceFocus(event: React.KeyboardEvent, panel: HTMLDivElement) {
  const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,[contenteditable="true"],[tabindex="0"]')].filter(element => (element.isContentEditable || element.tabIndex >= 0) && element.getClientRects().length);
  const last = controls[controls.length - 1], target = event.shiftKey ? last : controls[0];
  if (document.activeElement === (event.shiftKey ? controls[0] : last) || document.activeElement === panel) { event.preventDefault(); target?.focus(); }
}
function workspaceKeyDown(event: React.KeyboardEvent, panel: HTMLDivElement, close: () => void) {
  if (event.defaultPrevented || (event.target as Element).closest('[role="dialog"], [role="menu"]') !== panel) return;
  if (event.nativeEvent.isComposing) return;
  if (!(event.target as Element).closest(".text-workspace-library")) event.stopPropagation();
  if (event.key === "Escape") { event.preventDefault(); close(); }
  if (event.key === "Tab") trapWorkspaceFocus(event, panel);
}

function WorkspaceActions({ projectId, busy, menu, setMenu, save, add }: {
  projectId?: string; busy: boolean; menu: "collection" | "project" | null;
  setMenu(kind: "collection" | "project" | null): void;
  save(destination: TextDocumentDestination, label: string): void; add(): void;
}) {
  return <div className="text-workspace-actions">{([['collection', '保存到集合'], ['project', '保存到项目']] as const).map(([kind, label]) => <div className="text-workspace-action" key={kind}><button disabled={busy} aria-expanded={menu === kind} onClick={() => setMenu(menu === kind ? null : kind)}>{label}<ChevronDown size={12}/></button>{menu === kind && <SaveDestinations kind={kind} projectId={projectId} busy={busy} onSelect={save}/>}</div>)}<button className="text-workspace-primary" disabled={busy} onClick={add}>添加到生成对话框<ArrowUp size={14}/></button></div>;
}

function useToolbarHeight(panel: { current: HTMLDivElement | null }, ready: boolean) {
  useEffect(() => {
    const toolbar = panel.current?.querySelector('.text-plate-toolbar');
    if (!toolbar) return;
    const measure = () => panel.current?.style.setProperty('--text-toolbar-height', `${toolbar.getBoundingClientRect().height}px`);
    const observer = new ResizeObserver(measure); observer.observe(toolbar); measure();
    return () => observer.disconnect();
  }, [panel, ready]);
}

export function TextWorkspace({ initialDocument, projectId, origin, onChange, onClose, onAddToComposer }: Props) {
  const document = useRecentTextDocument(initialDocument, origin, onChange);
  const [library, setLibrary] = useState(true), [menu, setMenu] = useState<"collection" | "project" | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [portalTarget, setPortalTarget] = useState<HTMLDivElement | null>(null);
  const mounted = useRef(true), pending = useRef(false), panel = useRef<HTMLDivElement>(null), plate = useRef<TextPlateHandle>(null);
  useEffect(() => {
    setPortalTarget(panel.current);

  }, []);
  useWorkspaceFocus(panel, mounted);
  useToolbarHeight(panel, document.ready);
  const { media, resolveMedia } = useWorkspaceMedia(document.value, mounted, setNotice);
  const activity = { current: document.current, mounted, pending, setBusy, setError, setNotice };
  const close = () => { if (!document.ready) { onClose(initialDocument); return; } void document.flush().then(() => onClose(document.bound.current.document)).catch(() => {}); };
  const closeTop = () => { if (menu) setMenu(null); else close(); };
  const insertAsset = (asset: Asset) => { void insertWorkspaceAsset(activity, plate.current, resolveMedia, asset); };
  const save = (destination: TextDocumentDestination, label: string) => { setMenu(null); void saveWorkspace(activity, destination, label); };
  const add = () => void addWorkspace(activity, async next => {
    await document.flush();
    if (next !== document.current.current) throw new Error("文本已有新的更改，请再次添加；当前内容已保留。");
    await onAddToComposer(next, { isSourceDocument: document.isSourceDocument() });
  });
  const { draft, value, update, changeValue } = document;
  const keyDown = (event: React.KeyboardEvent) => workspaceKeyDown(event, panel.current!, closeTop);
  return createPortal(<div className="text-workspace" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="文本编辑器" onKeyDown={keyDown} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <PortalTargetContext.Provider value={portalTarget}>

    {(error || document.error) && <div className="text-workspace-feedback is-error" role="alert">{error || document.error}{document.error && <><button onClick={() => void document.retry()?.catch(() => {})}>重试自动保存</button>{document.ready && <button onClick={() => void document.copy()}>另存草稿</button>}</>}</div>}{notice && <div className="text-workspace-feedback" role="status">{notice}</div>}
    <div className={`text-workspace-layout canvas-workspace canvas-tactical${library ? "" : " is-source-collapsed"}`}><TextWorkspaceLibrary open={library} projectId={projectId} onInsert={insertAsset} onClose={() => setLibrary(false)} onNavigate={close} onReusePrompt={text => plate.current?.insertMarkdown(text)}/>
      <main className="text-workspace-writing">
        <section className="text-document-editor">{document.ready ? <TextPlateEditor key={draft.id} ref={plate} agent={{ projectId }} value={value} media={media} onChange={changeValue} onDropAssets={resolveMedia}
          toolbarStart={<div className="text-workspace-name"><button className="text-workspace-icon" aria-label="返回" title="返回" onClick={close}><ArrowLeft size={18}/></button><FileText size={16}/><input aria-label="文档名称" title="重命名文档" value={draft.title} placeholder="空白文档" onChange={event => update({ ...draft, title: event.target.value })}/><TextAutosaveStatus status={document.status}/><RecentTextDocuments currentId={draft.id} disabled={busy} beforeOpen={document.flush} onChoose={id => { setMenu(null); setError(""); setNotice(""); void document.choose(id); }}/>{!library && <button className="text-workspace-icon" aria-label="打开素材库" title="打开素材库" onClick={() => setLibrary(true)}><PanelLeft size={16}/></button>}</div>}
          toolbarEnd={<WorkspaceActions projectId={projectId} busy={busy} menu={menu} setMenu={setMenu} save={save} add={add}/>}/> : <div><button onClick={close}>返回</button><p role="status">{document.error ? "文档暂时无法打开，请重试。" : "正在打开文档…"}</p></div>}</section>
      </main>
    </div>
    </PortalTargetContext.Provider>
  </div>, window.document.body);
}
