import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ListChecks, Search, X } from "lucide-react";
import { useLibraryModeStore } from "../lib/libraryPane";
import { materialCatalog, type CatalogFilter } from "../lib/materialCatalog";
import { FileColorFilter } from "./FileColorFilter";
import { GeneratedImageFilter } from "./GeneratedImageFilter";
import { LibraryFloatingControls } from "./LibraryFloatingControls";
import { LibraryMediaSwitch } from "./LibraryMediaSwitch";

/** All library views share controls, overflow and bounded color preparation. */
export function LibraryCatalogControls({ filter, onColorChange, onColorsPrepared, onSearchStart, onStartSelection, children }: {
  filter: CatalogFilter; onColorChange: (color: string | null) => void;
  onColorsPrepared: () => void; onSearchStart: () => void; onStartSelection: () => void; children?: ReactNode;
}) {
  const mode = useLibraryModeStore();
  const generated = mode(state => state.generatedFilter);
  const query = mode(state => state.query);
  const [searchOpen, setSearchOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const searchId = useId();
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState({ pending: false, failed: 0 });
  const [retry, setRetry] = useState(0);
  const scope = JSON.stringify({ ...filter, color: null });
  const indexColors = filter.media === "images" && (open || !!filter.color);
  useEffect(() => {
    if (!indexColors) { setProgress({ pending: false, failed: 0 }); return; }
    let current = true;
    setProgress({ pending: true, failed: 0 });
    void (async () => {
      let after: string | null = null, failed = 0;
      try {
        do {
          const batch = await materialCatalog.prepareColors(JSON.parse(scope), after);
          if (!current) return;
          failed += batch.failed; after = batch.after;
          setProgress({ pending: batch.more, failed });
          if (batch.updated) onColorsPrepared();
          if (!batch.more) break;
        } while (current);
      } catch { if (current) setProgress({ pending: false, failed: failed + 1 }); }
    })();
    return () => { current = false; };
  }, [scope, indexColors, retry, onColorsPrepared]);
  useEffect(() => { if (searchOpen) input.current?.focus({ preventScroll: true }); }, [searchOpen]);
  return <><div className="library-keyword-search" data-library-search onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node)) setSearchOpen(false);
  }} onKeyDown={event => {
    if (event.key !== "Escape" || !searchOpen || event.nativeEvent.isComposing) return;
    event.preventDefault(); event.stopPropagation(); setSearchOpen(false); searchButton.current?.focus();
  }}>
    <button ref={searchButton} type="button" className="library-filter-trigger" aria-label="搜索素材" title={query || "搜索素材"}
      aria-controls={searchOpen ? searchId : undefined} aria-expanded={searchOpen} data-active={!!query.trim() || undefined}
      onClick={() => setSearchOpen(value => !value)}><Search size={14} aria-hidden="true"/></button>
    {searchOpen && <div id={searchId} className="library-keyword-search-panel">
      <input ref={input} type="search" aria-label="搜索素材" placeholder="搜索素材" value={query}
        onChange={event => {
          const value = event.target.value;
          if (value.trim() && !mode.getState().query.trim()) onSearchStart();
          mode.getState().setQuery(value);
        }}/>
      {query && <button type="button" aria-label="清空搜索" onMouseDown={event => event.preventDefault()} onClick={() => {
        mode.getState().setQuery(""); input.current?.focus({ preventScroll: true });
      }}><X size={14} aria-hidden="true"/></button>}
    </div>}
  </div><LibraryFloatingControls>
    <LibraryMediaSwitch/>
    {(filter.media === "all" || filter.media === "images" || filter.media === "videos") && <GeneratedImageFilter floating value={generated} onChange={mode.getState().setGeneratedFilter}/>}
    {filter.media === "images" && <FileColorFilter open={open} onOpenChange={setOpen} color={filter.color} onColorChange={onColorChange}
      palette={{ colors: new Map(), ...progress, retry: () => setRetry(value => value + 1) }}/>}
    {children}
    <button type="button" className="library-filter-trigger" aria-label="多选" title="多选" onClick={onStartSelection}><ListChecks size={14} aria-hidden="true"/></button>
  </LibraryFloatingControls></>;
}
