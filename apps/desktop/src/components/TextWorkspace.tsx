import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ArrowLeft, ArrowUp, ChevronDown, FileText, Folder, Music, PanelLeft, Search, Video } from "lucide-react";
import { api } from "../lib/api";
import { parseMarkdown, serializeMarkdown } from "../lib/documentCodec";
import type { DocumentMedia, DocumentValue, TextDocumentDestination, TextWorkspaceDocument } from "../lib/documentTypes";
import { connectedRows, folderConnections, type FolderConnection } from "../lib/folderConnections";
import { materialCatalog } from "../lib/materialCatalog";
import type { LibraryMedia } from "../lib/localFileMode";
import { documentMedia, documentReferenceIds, textDocuments } from "../lib/textDocuments";
import { textWorkspaceRequestId } from "../lib/textWorkspaceSave";
import type { Asset, Project } from "../lib/types";
import { userErrorMessage } from "../lib/userError";
import { TextPlateEditor, type TextPlateHandle } from "./TextPlateEditor";
import "./TextDocumentEditor.css";
import "./TextWorkspace.css";

interface Props {
  initialDocument: TextWorkspaceDocument;
  projectId?: string;
  onChange?(document: TextWorkspaceDocument): void;
  onClose(document: TextWorkspaceDocument): void;
  onAddToComposer(document: TextWorkspaceDocument): void | Promise<void>;
}

function useLibraryPage() {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<LibraryMedia>("images");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setLoading(true); setError("");
    const timer = setTimeout(() => {
      void materialCatalog.page({ kind: "all", id: null, projectId: null, media: kind, query, generated: null, color: null }, offset, 60).then(items => {
        if (!live) return;
        setAssets(previous => offset ? [...previous, ...items] : items); setMore(items.length === 60);
      }).catch(reason => { if (live) setError(userErrorMessage(reason, "素材库暂时无法读取，请稍后重试。")); })
        .finally(() => { if (live) setLoading(false); });
    }, 160);
    return () => { live = false; clearTimeout(timer); };
  }, [kind, query, offset]);
  return { query, setQuery, kind, setKind, assets, offset, setOffset, more, loading, error };
}

function LibraryAsset({ asset, onInsert }: { asset: Asset; onInsert(asset: Asset): void }) {
  const item = documentMedia(asset);
  if (!item) return null;
  return <button className="text-workspace-asset" aria-label={`插入${asset.name}`} title={`双击插入${asset.name}`} onMouseDown={event => event.preventDefault()} onDoubleClick={() => onInsert(asset)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); onInsert(asset); } }}>
    {item.kind === "image" ? <img src={convertFileSrc(asset.thumb_path || item.path)} alt={asset.name} loading="lazy" draggable={false}/> : <span className="text-workspace-media-icon">{item.kind === "video" ? <Video size={25}/> : <Music size={25}/>}</span>}<span>{asset.name}</span>
  </button>;
}

function WorkspaceLibrary({ onInsert, onClose }: { onInsert(asset: Asset): void; onClose(): void }) {
  const { query, setQuery, kind, setKind, assets, offset, setOffset, more, loading, error } = useLibraryPage();
  return <aside className="text-workspace-library" aria-label="素材库">
    <div className="text-workspace-library-title"><span>素材库</span><button className="text-workspace-icon" aria-label="收起素材库" title="收起素材库" onClick={onClose}><PanelLeft size={16}/></button></div>
    <label className="text-workspace-search"><Search size={14}/><input aria-label="搜索素材" placeholder="搜索素材" value={query} onChange={event => { setQuery(event.target.value); setOffset(0); }}/></label>
    <div className="text-workspace-media-tabs">{([['images', '图片'], ['videos', '视频'], ['audios', '音频']] as const).map(([id, label]) => <button key={id} aria-pressed={kind === id} onClick={() => { setKind(id); setOffset(0); }}>{label}</button>)}</div>
    <div className="text-workspace-library-scroll">
      {error && <p role="alert">{error}</p>}
      <div className="text-workspace-assets">{assets.map(asset => <LibraryAsset key={asset.id} asset={asset} onInsert={onInsert}/>)}</div>
      {!loading && !assets.length && !error && <p className="text-workspace-empty">暂无素材</p>}
      {loading ? <p className="text-workspace-empty" role="status">正在读取…</p> : more && <button className="text-workspace-more" onClick={() => setOffset(offset + 60)}>加载更多</button>}
    </div>
  </aside>;
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

function useWorkspaceDraft(initialDocument: TextWorkspaceDocument, onChange: Props["onChange"]) {
  const [draft, setDraft] = useState(initialDocument);
  const [value, setValue] = useState(() => parseMarkdown(initialDocument.markdown));
  const [mode, setMode] = useState<"body" | "source">("body");
  const current = useRef(initialDocument), changed = useRef(onChange); changed.current = onChange;
  function update(next: TextWorkspaceDocument) { current.current = next; setDraft(next); changed.current?.(next); }
  function changeValue(next: DocumentValue) { setValue(next); update({ ...current.current, markdown: serializeMarkdown(next) }); }
  function switchMode(next: "body" | "source") {
    if (next === mode) return;
    if (next === "body") setValue(parseMarkdown(current.current.markdown));
    setMode(next);
  }
  return { draft, value, current, mode, update, changeValue, switchMode };
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
async function addWorkspace(activity: WorkspaceActivity, onAddToComposer: Props["onAddToComposer"]) {
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
  const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,[contenteditable="true"],[tabindex="0"]')].filter(element => element.getClientRects().length);
  const last = controls[controls.length - 1], target = event.shiftKey ? last : controls[0];
  if (document.activeElement === (event.shiftKey ? controls[0] : last) || document.activeElement === panel) { event.preventDefault(); target?.focus(); }
}
function workspaceKeyDown(event: React.KeyboardEvent, panel: HTMLDivElement, close: () => void) {
  event.stopPropagation();
  if (event.nativeEvent.isComposing) return;
  if (event.key === "Escape") { event.preventDefault(); close(); }
  if (event.key === "Tab") trapWorkspaceFocus(event, panel);
}

function WorkspaceHeader({ draft, update, close, projectId, busy, menu, setMenu, save, add }: {
  draft: TextWorkspaceDocument; update(value: TextWorkspaceDocument): void; close(): void; projectId?: string; busy: boolean;
  menu: "collection" | "project" | null; setMenu(kind: "collection" | "project" | null): void;
  save(destination: TextDocumentDestination, label: string): void; add(): void;
}) {
  return <header className="text-workspace-header"><div className="text-workspace-name"><button className="text-workspace-icon" aria-label="返回" title="返回" onClick={close}><ArrowLeft size={18}/></button><FileText size={17}/><input aria-label="文档名称" value={draft.title} placeholder="未命名文本" onChange={event => update({ ...draft, title: event.target.value })}/></div>
    <div className="text-workspace-actions">{([['collection', '保存到集合'], ['project', '保存到项目']] as const).map(([kind, label]) => <div className="text-workspace-action" key={kind}><button disabled={busy} aria-expanded={menu === kind} onClick={() => setMenu(menu === kind ? null : kind)}>{label}<ChevronDown size={12}/></button>{menu === kind && <SaveDestinations kind={kind} projectId={projectId} busy={busy} onSelect={save}/>}</div>)}<button className="text-workspace-primary" disabled={busy} onClick={add}>添加到生成对话框<ArrowUp size={14}/></button></div>
  </header>;
}

export function TextWorkspace({ initialDocument, projectId, onChange, onClose, onAddToComposer }: Props) {
  const document = useWorkspaceDraft(initialDocument, onChange);
  const [library, setLibrary] = useState(true), [menu, setMenu] = useState<"collection" | "project" | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const mounted = useRef(true), pending = useRef(false), panel = useRef<HTMLDivElement>(null), plate = useRef<TextPlateHandle>(null);
  useWorkspaceFocus(panel, mounted);
  const { media, resolveMedia } = useWorkspaceMedia(document.value, mounted, setNotice);
  const activity = { current: document.current, mounted, pending, setBusy, setError, setNotice };
  const close = () => onClose(document.current.current);
  const closeTop = () => { if (menu) setMenu(null); else close(); };
  const insertAsset = (asset: Asset) => { if (document.mode === "body") void insertWorkspaceAsset(activity, plate.current, resolveMedia, asset); else setNotice("切换到正文后插入素材。"); };
  const save = (destination: TextDocumentDestination, label: string) => { setMenu(null); void saveWorkspace(activity, destination, label); };
  const { draft, value, mode, update, changeValue, switchMode } = document;
  const keyDown = (event: React.KeyboardEvent) => workspaceKeyDown(event, panel.current!, closeTop);
  return createPortal(<div className="text-workspace" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="文本编辑器" onKeyDown={keyDown} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <WorkspaceHeader draft={draft} update={update} close={close} projectId={projectId} busy={busy} menu={menu} setMenu={setMenu} save={save} add={() => void addWorkspace(activity, onAddToComposer)}/>
    {error && <div className="text-workspace-feedback is-error" role="alert">{error}</div>}{notice && <div className="text-workspace-feedback" role="status">{notice}</div>}
    <div className={`text-workspace-layout${library ? "" : " is-library-closed"}`}>{library && <WorkspaceLibrary onInsert={asset => void insertAsset(asset)} onClose={() => setLibrary(false)}/>}
      <main className="text-workspace-writing"><div className="text-workspace-controls">{!library && <button className="text-workspace-icon" aria-label="打开素材库" title="打开素材库" onMouseDown={event => event.preventDefault()} onClick={() => setLibrary(true)}><PanelLeft size={16}/></button>}<div><button aria-pressed={mode === "body"} onClick={() => switchMode("body")}>正文</button><button aria-pressed={mode === "source"} onClick={() => switchMode("source")}>源码</button></div></div>
        <section className="text-document-editor">{mode === "body" ? <TextPlateEditor ref={plate} value={value} media={media} onChange={changeValue} onDropAssets={resolveMedia} onRejectedPaste={() => setNotice("请从素材库插入已连接的素材。")} /> : <textarea className="text-document-source" aria-label="Markdown 源码" spellCheck={false} value={draft.markdown} onChange={event => update({ ...document.current.current, markdown: event.target.value })}/>}</section>
      </main>
    </div>
  </div>, window.document.body);
}
