import { userErrorMessage } from "../lib/userError";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Check, Folder as FolderIcon, Plus } from "lucide-react";
import { api } from "../lib/api";
import { folderConnections, type ConnectionEntry, type FolderConnection } from "../lib/folderConnections";
import { assetOriginals, type AssetOriginal } from "../lib/assetOriginals";
import { fileWorkspace } from "../lib/fileWorkspace";
import { startFileTask, type FileTaskOmission } from "../lib/fileTasks";
import { collectionRows } from "../lib/materialCatalogOrder";
import type { Folder } from "../lib/types";
import { ModalShell } from "./ModalShell";
import { OverlayScrollArea } from "./CollectionScrollArea";
import { useStore } from "../store";
import { stopAudioPreview, stopAudioPreviewInFolder } from "../lib/audioPreview";

function FolderDestination({ name, fixedParent, location, onPick, disabled, onError }: {
  name: string; fixedParent?: string; location: string | null;
  onPick: (path: string) => void; disabled: boolean; onError: (message: string) => void;
}) {
  const [defaultRoot, setDefaultRoot] = useState("");
  useEffect(() => {
    if (fixedParent) return;
    let active = true;
    fileWorkspace.status().then(status => { if (active) setDefaultRoot(status.proposed_root); })
      .catch(reason => { if (active) onError(userErrorMessage(reason, "资料目录暂时无法读取，可更改父目录。")); });
    return () => { active = false; };
  }, [fixedParent, onError]);
  const base = fixedParent || location || defaultRoot;
  const display = base.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
  const destination = name.trim() && display
    ? display.replace(/[\\/]+$/, "") + (display.includes("\\") ? "\\" : "/") + name.trim() : display;
  async function pick() {
    try {
      const path = await api.pickFolder(base || undefined, "选择新文件夹的父目录");
      if (path) { onPick(path); onError(""); }
    } catch (reason) { onError(userErrorMessage(reason, "无法打开文件夹选择器，请重试。")); }
  }
  return <div>
    <p className="break-all text-xs text-muted">保存位置 {destination || "BowerbirdLibrary"}</p>
    {!fixedParent && <button type="button" className="app-modal-button" disabled={disabled} onClick={() => void pick()}>更改父目录</button>}
  </div>;
}

export function CollectionEditorDialog({ collections, item, parentId, projectId = null, onClose, onSaved }: {
  collections: Folder[]; item?: Folder; parentId: string | null; projectId?: string | null; onClose: () => void; onSaved: (id: string) => void;
}) {
  const [name, setName] = useState(item?.name ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [location, setLocation] = useState<string | null>(null);
  const parent = item ? item.parent_id ?? null : parentId;
  const parentFolder = collections.find(collection => collection.id === parent);
  const parentPath = parentFolder && "path" in parentFolder && typeof parentFolder.path === "string"
    ? parentFolder.path : parentFolder?.name;
  async function save() {
    if (lock.current || !name.trim()) return;
    lock.current = true; setBusy(true); setError("");
    try {
      let id = item?.id;
      if (id) {
        if (item && "path" in item && typeof item.path === "string") stopAudioPreviewInFolder(item.path);
        await folderConnections.renameFolder(id, name);
      }
      else {
        id = await folderConnections.create(parent, name, parent ? null : location, projectId);
      }
      onSaved(id); onClose();
    }
    catch (error) { setError(String(error)); }
    finally { lock.current = false; setBusy(false); }
  }
  return <ModalShell title={item ? "重命名文件夹" : "新建文件夹"} onClose={onClose} preventClose={busy}>
    <form className="catalog-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>文件夹名称<input data-modal-autofocus value={name} maxLength={100} onChange={e => setName(e.target.value)} disabled={busy} /></label>
      {!item && <FolderDestination name={name} fixedParent={parent ? parentPath || "选中的文件夹" : undefined}
        location={location} onPick={setLocation} disabled={busy} onError={setError}/>}
      {error && <p role="alert">{userErrorMessage(error, "文件夹未保存，请稍后重试。")}</p>}
      <button className="app-button-accent" type="submit" disabled={busy || !name.trim()}>{busy ? "保存中…" : "保存"}</button>
    </form>
  </ModalShell>;
}

function FolderChoices({ collections, selected, onSelect, children, disabled, choiceName }: {
  collections: FolderConnection[]; selected: string; onSelect: (id: string) => void;
  disabled: boolean; choiceName: string; children?: ReactNode;
}) {
  const byId = new Map(collections.map(item => [item.id, item]));
  return <fieldset className="collection-picker" disabled={disabled}>
    <legend>目标文件夹</legend>
    {collections.length > 0 && <OverlayScrollArea className="collection-picker-scroll" label="目标文件夹滚动条"
      viewportStyle={{ height: Math.min(collections.length * 40 + 8, 320), maxHeight: "35vh" }} viewportClassName="collection-picker-list">
      {collectionRows(collections).map(({ item, depth, path }) => <label key={item.id} className="collection-choice" data-selected={selected === item.id}
        title={path} style={{ paddingLeft: 12 + Math.min(depth, 8) * 16 }}>
        <input type="radio" name={choiceName} value={item.id} disabled={!byId.get(item.id)?.available} checked={selected === item.id} onChange={() => onSelect(item.id)} />
        <FolderIcon size={16} aria-hidden="true"/><span>{item.name}</span>
        {selected === item.id && <Check size={15} aria-hidden="true"/>}
      </label>)}
    </OverlayScrollArea>}
    {children}
  </fieldset>;
}

export function CollectionAssignDialog({ assetIds, onClose, onSaved }: { assetIds: string[]; onClose: () => void; onSaved?: () => void }) {
  const choiceName = useId();
  const [projectId] = useState(() => useStore.getState().activeProjectId);
  const [collections, setCollections] = useState<FolderConnection[]>([]);
  const [selected, setSelected] = useState("");
  const [location, setLocation] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const created = useRef<string | null>(null);
  useEffect(() => {
    let alive = true; setLoading(true); setError("");
    folderConnections.list().then(value => { if (alive) { setCollections(value); setSelected(collectionRows(value).find(row => value.find(folder => folder.id === row.item.id)?.available)?.item.id ?? ""); } })
      .catch(error => { if (alive) setError(String(error)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [revision]);
  async function save() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      let id = selected || created.current;
      if (!id) {
        id = await folderConnections.create(null, name, location, projectId); created.current = id;
      }
      await startFileTask({ kind: "add", ids: [...new Set(assetIds)], folderId: id }, "添加到文件夹");
      onSaved?.(); onClose();
    } catch (error) { setError(String(error)); }
    finally { lock.current = false; setBusy(false); }
  }
  return <ModalShell title="添加到文件夹" onClose={onClose} preventClose={busy} description="在目标文件夹创建分身，原文件保持原位。">
    <form className="catalog-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <FolderChoices collections={collections} selected={selected} onSelect={setSelected} disabled={loading || busy} choiceName={choiceName}>
        {!loading && !collections.length && <p className="collection-picker-empty">还没有文件夹，可以新建一个。</p>}
        <label className="collection-choice collection-choice-new" data-selected={!selected}>
          <input type="radio" name={choiceName} value="" checked={!selected} onChange={() => setSelected("")} />
          <Plus size={16} aria-hidden="true"/><span>新建文件夹</span>{!selected && <Check size={15} aria-hidden="true"/>}
        </label>
      </FolderChoices>
      {!selected && !loading && <>
        <label>文件夹名称<input value={name} maxLength={100} disabled={busy || !!created.current} onChange={e => setName(e.target.value)} /></label>
        <FolderDestination name={name} location={location} onPick={setLocation} disabled={busy || !!created.current} onError={setError}/>
      </>}
      {loading && <p role="status">正在读取文件夹…</p>}
      {error && <p role="alert">{userErrorMessage(error, "文件夹操作未完成，请重新读取后重试。")} <button type="button" disabled={busy} onClick={() => setRevision(v => v + 1)}>重新读取</button></p>}
      <button type="submit" className="app-button-accent" disabled={loading || busy || (!selected && !name.trim())}>{busy ? "添加中…" : "添加"}</button>
    </form>
  </ModalShell>;
}

export type MoveEntrySelection = { entryIds: string[]; entries?: ConnectionEntry[] };
type MoveSelection = { assetIds: string[] } | MoveEntrySelection;
type MovePreview = {
  originals: AssetOriginal[]; entries: ConnectionEntry[]; problems: FileTaskOmission[]; folders: FolderConnection[];
};

async function previewMove(selection: MoveSelection): Promise<MovePreview> {
  const folders = await folderConnections.list();
  const result: MovePreview = { folders, originals: [], entries: [], problems: [] };
  if ("entryIds" in selection) {
    const online = new Set(folders.filter(folder => folder.available).map(folder => folder.id));
    const byId = new Map(selection.entries?.map(entry => [entry.id, entry]));
    const ids = [...new Set(selection.entryIds)];
    const unread = ids.filter(id => !byId.get(id)?.version);
    if (unread.length) {
      for (const entry of await folderConnections.resolve(unread)) byId.set(entry.id, entry);
    }
    for (const id of ids) {
      const entry = byId.get(id);
      if (!entry) result.problems.push({ label: id, message: "待移动条目已不存在" });
      else if (!entry.version) result.problems.push({ label: entry.name, message: "缺少文件版本，请刷新后重新选择" });
      else if (!online.has(entry.folder_id) || (!entry.available && !entry.is_reference)) {
        result.problems.push({ label: entry.name, message: "源文件或所在文件夹暂不可用" });
      } else result.entries.push(entry);
    }
    return result;
  }
  const ids = [...new Set(selection.assetIds)];
  const byId = new Map((await assetOriginals.preview(ids)).map(entry => [entry.asset_id, entry]));
  const paths = new Set<string>();
  for (const id of ids) {
    const item = byId.get(id);
    if (!item || "error" in item) {
      result.problems.push({ label: id, message: item ? userErrorMessage(item.error, "无法读取原文件") : "找不到素材记录" });
    } else if (item.missing) {
      result.problems.push({ label: item.name, message: "原文件已不在登记位置" });
    } else if (!paths.has(item.path)) {
      paths.add(item.path); result.originals.push(item);
    }
  }
  return result;
}

export function CollectionMoveDialog({ selection, onClose, onSaved }: {
  selection: MoveSelection; onClose: () => void; onSaved?: () => void;
}) {
  const choiceName = useId(), lock = useRef(false);
  const [target, setTarget] = useState(""), [error, setError] = useState("");
  const [preview, setPreview] = useState<MovePreview | null>(null);
  const [attempt, setAttempt] = useState(0), [busy, setBusy] = useState(false);
  const assetIds = "assetIds" in selection ? selection.assetIds : undefined;
  const entryIds = "entryIds" in selection ? selection.entryIds : undefined;
  const entries = "entryIds" in selection ? selection.entries : undefined;
  useEffect(() => {
    let alive = true;
    setPreview(null); setError(""); setTarget("");
    previewMove(entryIds ? { entryIds, entries } : { assetIds: assetIds ?? [] })
      .then(value => { if (alive) setPreview(value); })
      .catch(reason => { if (alive) setError(userErrorMessage(reason, "无法读取所选文件，请重试。")); });
    return () => { alive = false; };
  }, [entries, entryIds, assetIds, attempt]);
  const count = preview ? preview.entries.length + preview.originals.length : 0;
  async function move() {
    if (lock.current || !preview || !target || !count) return;
    lock.current = true; setBusy(true); setError("");
    try {
      if (entryIds) {
        const versions: Record<string, string> = {};
        for (const entry of preview.entries) {
          if (entry.version) versions[entry.id] = entry.version;
          if (!entry.is_reference) stopAudioPreview(entry.asset_id);
        }
        await startFileTask({ kind: "move", ids: preview.entries.map(entry => entry.id), versions, folderId: target }, "移动至文件夹", preview.problems);
      } else {
        for (const original of preview.originals) stopAudioPreview(original.asset_id);
        await startFileTask({ kind: "moveoriginals", originals: preview.originals, folderId: target }, "移动至文件夹", preview.problems);
      }
      onSaved?.(); onClose();
    } catch (reason) { setError(userErrorMessage(reason, "移动任务未提交，请重试。")); }
    finally { lock.current = false; setBusy(false); }
  }
  return <ModalShell title="移动至文件夹" onClose={onClose} preventClose={busy} footer={<>
    <button type="button" className="app-modal-button" onClick={onClose} disabled={busy}>取消</button>
    <button type="button" className="app-button-accent" onClick={() => void move()} disabled={busy || !target || !count}>{busy ? "提交中…" : "移动至文件夹"}</button>
  </>}>
    <div className="catalog-form">
      {preview ? <>
        <FolderChoices choiceName={choiceName} collections={preview.folders} selected={target} onSelect={setTarget} disabled={busy}/>
        {!preview.folders.some(folder => folder.available) && <p>没有可用的目标文件夹，请先新建或连接文件夹。</p>}
        <p>{entryIds ? `将移动 ${count} 个文件条目，选中的分身只移动分身文件。` : `将把 ${count} 个原文件移动到所选文件夹，保留素材身份和创作资料。`}</p>
        {!!preview.problems.length && <div role="alert">以下 {preview.problems.length} 项将跳过：
          <ul>{preview.problems.map((item, index) => <li key={index}>{item.label}：{item.message}</li>)}</ul>
        </div>}
      </> : !error && <p role="status">正在读取所选文件…</p>}
      {error && <p role="alert">{error} <button type="button" disabled={busy} onClick={() => setAttempt(value => value + 1)}>重新读取</button></p>}
    </div>
  </ModalShell>;
}
