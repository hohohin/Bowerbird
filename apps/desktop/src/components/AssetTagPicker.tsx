import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Plus, Search, X } from "lucide-react";
import { api } from "../lib/api";
import { localClassification } from "../lib/localClassification";
import { userErrorMessage } from "../lib/userError";
import { useImeGuard } from "../lib/useImeGuard";
import type { AssetTag } from "../lib/types";
import { OverlayScrollArea } from "./CollectionScrollArea";
import { normalizeTagName, tagPickerColumns, type TagChoice } from "./assetTagPickerLogic";
import "./AssetTagPicker.css";

function TagPickerError({ error, retry }: { error: unknown; retry?: () => void }) {
  return <div role="alert" className="asset-tags-error">
    {userErrorMessage(error, retry ? "标签暂时无法读取，请重试" : "标签未能保存，请重试")}
    {retry && <button type="button" onClick={retry}>重试</button>}
  </div>;
}

export function AssetTagPicker({ assetId, tags, onChange }: { assetId: string; tags: AssetTag[]; onChange: (tags: AssetTag[]) => void }) {
  const [open, setOpen] = useState(false);
  const [labels, setLabels] = useState<TagChoice[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 640, maxHeight: 480 });
  const host = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const mounted = useRef(true), writing = useRef(false), readVersion = useRef(0);
  const ime = useImeGuard(), menuId = useId();
  const columns = useMemo(() => tagPickerColumns(labels, query, position.width >= 540 ? 3 : 2), [labels, query, position.width]);
  const selected = new Set(tags.map(tag => tag.name));
  const existing = labels.find(tag => normalizeTagName(tag.name) === normalizeTagName(query));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readVersion.current++; }; }, []);

  function close(restoreFocus = false) {
    setOpen(false); readVersion.current++;
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }
  async function load() {
    const version = ++readVersion.current;
    setLoading(true); setLoadFailed(false); setError("");
    try {
      const [all, assigned] = await Promise.all([localClassification.labels(), api.listAssetTags(assetId)]);
      if (!mounted.current || version !== readVersion.current) return;
      setLabels(all); onChange(assigned);
    } catch (cause) {
      console.error("Loading asset tags failed", cause);
      if (!mounted.current || version !== readVersion.current) return;
      setLoadFailed(true); setError(cause);
    } finally {
      if (mounted.current && version === readVersion.current) setLoading(false);
    }
  }
  function show() { setQuery(""); setOpen(true); if (!writing.current) void load(); }

  async function change(name: string, positive: boolean) {
    if (writing.current) return;
    writing.current = true; readVersion.current++; setBusy(true); setError("");
    try {
      // Resolve fresh identities before writing; never replace another tag's assignment.
      const all = await localClassification.labels();
      let choice: TagChoice | undefined = all.find(tag => normalizeTagName(tag.name) === normalizeTagName(name));
      if (!choice && positive) {
        const clean = name.trim().replace(/^#+\s*/, "");
        choice = { id: await localClassification.save(null, clean, "", true), name: clean };
        all.push({ ...choice, description: "", enabled: true, count: 0, has_examples: false });
      }
      if (mounted.current) setLabels(all);
      if (choice) await localClassification.example(choice.id, [assetId], positive);
      const assigned = await api.listAssetTags(assetId);
      if (!mounted.current) return;
      onChange(assigned);
      if (positive && normalizeTagName(query) === normalizeTagName(name)) setQuery("");
    } catch (cause) {
      console.error("Saving asset tag failed", cause);
      if (mounted.current) setError(cause);
    } finally {
      writing.current = false;
      if (mounted.current) { setBusy(false); setLoading(false); }
    }
  }

  const place = useCallback(() => {
    if (!menu.current || !trigger.current) return;
    const popup = menu.current, rect = trigger.current.getBoundingClientRect();
    const width = Math.min(640, window.innerWidth - 32);
    popup.style.width = `${width}px`;
    const below = window.innerHeight - rect.bottom - 22, above = rect.top - 22;
    const upwards = below < 360 && above > below;
    const maxHeight = Math.max(100, Math.min(480, upwards ? above : below, window.innerHeight - 32));
    popup.style.maxHeight = `${maxHeight}px`;
    const next = { width, maxHeight, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 20)),
      top: Math.max(12, Math.min(upwards ? rect.top - popup.offsetHeight - 10 : rect.bottom + 10, window.innerHeight - popup.offsetHeight - 20)) };
    setPosition(previous => Object.keys(next).every(key => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next);
  }, []);
  useLayoutEffect(() => { if (open) place(); }, [open, labels, query, error, loading, position.width, place]);
  useEffect(() => {
    if (!open) return;
    search.current?.focus({ preventScroll: true });
    function outside(event: Event) {
      if (!menu.current?.contains(event.target as Node) && !host.current?.contains(event.target as Node)) close();
    }
    function moved(event: Event) { if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) place(); }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    window.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    return () => {
      document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside);
      window.removeEventListener("scroll", moved, true); window.removeEventListener("resize", moved);
    };
  }, [open, place]);

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (ime.isComposing(event.nativeEvent)) return;
    if (event.key === "Escape") { event.preventDefault(); close(true); return; }
    const items = Array.from(menu.current?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not(:disabled)') ?? []);
    const index = items.indexOf(document.activeElement as HTMLInputElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); items[Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
    } else if (index >= 0 && (event.key === "Home" || event.key === "End")) {
      event.preventDefault(); items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (event.key === "Enter") {
      if (index >= 0) { event.preventDefault(); items[index].click(); }
      else if (event.target === search.current && normalizeTagName(query) && !loading && !loadFailed) {
        event.preventDefault(); void change(existing?.name ?? query, true);
      }
    } else if (event.key === "Tab") {
      const controls = Array.from(menu.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? []);
      if (event.target === controls[event.shiftKey ? 0 : controls.length - 1]) { event.preventDefault(); close(true); }
    }
  }

  return <div ref={host} className="asset-detail-card asset-tags">
    <div className="text-xs font-medium uppercase tracking-wide text-muted">标签</div>
    <div className="asset-tags-assigned">
      {tags.map(tag => <span key={tag.name} className={`asset-tags-chip${tag.origin === "manual" ? " is-manual" : ""}`}>
        <span># {tag.name}</span><button type="button" aria-label={`移除标签 ${tag.name}`} disabled={busy} onClick={() => void change(tag.name, false)}><X size={11} aria-hidden="true"/></button>
      </span>)}
    </div>
    <button ref={trigger} type="button" className="asset-tags-add" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => open ? close(true) : show()}><Plus size={13} aria-hidden="true"/>添加标签</button>
    {!open && !!error && <TagPickerError error={error}/>}
    {open && createPortal(<div ref={menu} id={menuId} role="dialog" aria-label="添加标签" aria-busy={busy || loading} className="app-popover asset-tag-picker" style={position}
      onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
      onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={keyDown}>
      <div className="asset-tag-picker-search"><Search size={15} aria-hidden="true"/>
        <input ref={search} value={query} onChange={event => setQuery(event.target.value)} aria-label="搜索或新建标签" placeholder="搜索或新建标签" maxLength={40}
          onCompositionStart={ime.onCompositionStart} onCompositionEnd={ime.onCompositionEnd}/>
        {query && <button type="button" aria-label="清除搜索" onClick={() => { setQuery(""); search.current?.focus(); }}><X size={14} aria-hidden="true"/></button>}
      </div>
      {!!error && <TagPickerError error={error} retry={loadFailed ? () => void load() : undefined}/>}
      {loading ? <div role="status" className="asset-tag-picker-status">正在读取标签…</div> : !loadFailed && <OverlayScrollArea className="asset-tag-picker-scroll" label="标签列表滚动条">
        {columns.some(column => column.length) ? <div className="asset-tag-picker-columns" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
          {columns.map((column, index) => <div className="asset-tag-picker-column" key={index}>{column.map(group => <section key={group.letter} aria-label={group.letter}>
            <h4 className="asset-tag-picker-letter">{group.letter}</h4>
            {group.tags.map(tag => <label key={tag.id} className="asset-tag-picker-option">
              <input type="checkbox" checked={selected.has(tag.name)} disabled={busy} onChange={event => void change(tag.name, event.target.checked)}/><span>{tag.name}</span>
            </label>)}
          </section>)}</div>)}
        </div> : <div className="asset-tag-picker-status">{query ? "没有匹配的标签" : "暂无标签"}</div>}
      </OverlayScrollArea>}
      {!existing && <div className="asset-tag-picker-footer"><button type="button" data-create disabled={busy || loading || loadFailed || !!query && !normalizeTagName(query)}
        onClick={() => normalizeTagName(query) ? void change(query, true) : search.current?.focus()}><Plus size={14} aria-hidden="true"/>
        {query.trim() ? `新建并添加“${query.trim()}”` : "新建标签"}</button></div>}
    </div>, document.body)}
  </div>;
}
