import { useEffect, useId, useRef, useState } from "react";
import { Check, Folder as FolderIcon, Plus } from "lucide-react";
import { api } from "../lib/api";
import { materialCatalog } from "../lib/materialCatalog";
import { collectionRows } from "../lib/materialCatalogOrder";
import type { Folder } from "../lib/types";
import { ModalShell } from "./ModalShell";
import { OverlayScrollArea } from "./CollectionScrollArea";

export function CollectionEditorDialog({ collections, item, parentId, onClose, onSaved }: {
  collections: Folder[]; item?: Folder; parentId: string | null; onClose: () => void; onSaved: (id: string) => void;
}) {
  const [name, setName] = useState(item?.name ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const parent = item ? item.parent_id ?? null : parentId;
  const parentName = collections.find(collection => collection.id === parent)?.name;
  async function save() {
    if (lock.current || !name.trim()) return;
    lock.current = true; setBusy(true); setError("");
    try { const id = await materialCatalog.saveCollection(item?.id ?? null, name, parent); onSaved(id); onClose(); }
    catch (error) { setError(String(error)); }
    finally { lock.current = false; setBusy(false); }
  }
  return <ModalShell title={item ? "重命名集合" : "新建集合"} onClose={onClose} preventClose={busy}
    description={item ? "修改集合名称，保留原有层级和素材。" : parentName ? `在「${parentName}」中新建子集合。` : "新建顶层集合，用来整理素材。"}>
    <form className="catalog-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>集合名称<input data-modal-autofocus value={name} maxLength={100} onChange={e => setName(e.target.value)} disabled={busy} /></label>
      {error && <p role="alert">{error}</p>}
      <button className="app-button-accent" type="submit" disabled={busy || !name.trim()}>{busy ? "保存中…" : "保存"}</button>
    </form>
  </ModalShell>;
}

export function CollectionAssignDialog({ assetIds, onClose, onSaved }: { assetIds: string[]; onClose: () => void; onSaved?: () => void }) {
  const choiceName = useId();
  const [collections, setCollections] = useState<Folder[]>([]);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const created = useRef<string | null>(null);
  useEffect(() => {
    let alive = true; setLoading(true); setError("");
    api.listCollections().then(value => { if (alive) { setCollections(value); setSelected(collectionRows(value)[0]?.item.id ?? ""); } })
      .catch(error => { if (alive) setError(String(error)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [revision]);
  async function save() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      let id = selected || created.current;
      if (!id) { id = await materialCatalog.saveCollection(null, name, null); created.current = id; }
      await materialCatalog.members(id, assetIds);
      onSaved?.(); onClose();
    } catch (error) { setError(String(error)); }
    finally { lock.current = false; setBusy(false); }
  }
  return <ModalShell title="添加到集合" onClose={onClose} preventClose={busy} description={`将 ${assetIds.length} 项素材加入集合，保留现有集合归属和原文件。`}>
    <form className="catalog-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset className="collection-picker" disabled={loading || busy}>
        <legend>目标集合</legend>
        {collections.length > 0 && <OverlayScrollArea className="collection-picker-scroll" label="目标集合滚动条"
          viewportStyle={{ height: Math.min(collections.length * 40 + 8, 320), maxHeight: "35vh" }} viewportClassName="collection-picker-list">
          {collectionRows(collections).map(({ item, depth, path }) => <label key={item.id} className="collection-choice" data-selected={selected === item.id}
            title={path} style={{ paddingLeft: 12 + Math.min(depth, 8) * 16 }}>
            <input type="radio" name={choiceName} value={item.id} checked={selected === item.id} onChange={() => setSelected(item.id)} />
            <FolderIcon size={16} aria-hidden="true"/><span>{item.name}</span>
            {selected === item.id && <Check size={15} aria-hidden="true"/>}
          </label>)}
        </OverlayScrollArea>}
        {!loading && !collections.length && <p className="collection-picker-empty">还没有集合，可以新建一个。</p>}
        <label className="collection-choice collection-choice-new" data-selected={!selected}>
          <input type="radio" name={choiceName} value="" checked={!selected} onChange={() => setSelected("")} />
          <Plus size={16} aria-hidden="true"/><span>新建集合</span>{!selected && <Check size={15} aria-hidden="true"/>}
        </label>
      </fieldset>
      {!selected && <label>集合名称<input value={name} maxLength={100} disabled={busy || !!created.current} onChange={e => setName(e.target.value)} /></label>}
      {loading && <p role="status">正在读取集合…</p>}
      {error && <p role="alert">{error} <button type="button" disabled={busy} onClick={() => setRevision(v => v + 1)}>重新读取</button></p>}
      <button type="submit" className="app-button-accent" disabled={loading || busy || (!selected && !name.trim())}>{busy ? "添加中…" : "添加"}</button>
    </form>
  </ModalShell>;
}
