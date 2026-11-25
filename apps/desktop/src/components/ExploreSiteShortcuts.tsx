import { ArrowDown, ArrowUp, SlidersHorizontal } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { EXPLORER_SITES } from "../lib/explorer";
import { normalizeSourceAddress } from "../lib/sourceDiscovery";
import { SourceBrowserPopover } from "./SourceBrowserPopover";

const SHORTCUTS_KEY = "bowerbird.explorer.shortcuts";
type Site = { name: string; url: string };

function readShortcuts(): Site[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(SHORTCUTS_KEY) ?? "null");
    if (Array.isArray(saved)) {
      const sites = new Map<string, Site>();
      for (const entry of saved) {
        const name = typeof entry?.name === "string" ? entry.name.trim().slice(0, 32) : "";
        const url = typeof entry?.url === "string" ? normalizeSourceAddress(entry.url) : null;
        if (name && url && !sites.has(url)) sites.set(url, { name, url });
      }
      return [...sites.values()];
    }
  } catch { /* Storage may be unavailable or invalid. */ }
  return [...EXPLORER_SITES];
}

export function ExploreSiteShortcuts({ url, visible, onNavigate, children }: {
  url: string; visible: boolean; onNavigate: (url: string) => void; children: ReactNode;
}) {
  const editorId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [sites, setSites] = useState(readShortcuts);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!visible) setEditing(false); }, [visible]);

  function update(next: Site[]) {
    setSites(next);
    try { localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(next)); } catch { /* Keep changes for this session. */ }
  }

  return <nav className="explore-sites" aria-label="探索网站">
    <div className="explore-site-links">
      {sites.map(site => <button key={site.url} type="button" title={site.name}
        aria-current={site.url === url ? "page" : undefined} onClick={() => onNavigate(site.url)}>{site.name}</button>)}
    </div>
    <button ref={button} type="button" className="explore-manage-sites" aria-label="管理快捷站点" title="管理快捷站点"
      aria-haspopup="dialog" aria-controls={editing ? editorId : undefined} aria-expanded={editing}
      onClick={() => setEditing(value => !value)}>
      <SlidersHorizontal size={14} aria-hidden />
    </button>
    {children}
    {visible && editing && <SourceBrowserPopover id={editorId} button={button} title="快捷站点" onClose={() => setEditing(false)}>
      <EditShortcuts id={editorId} sites={sites} onChange={update} />
    </SourceBrowserPopover>}
  </nav>;
}

function EditShortcuts({ id, sites, onChange }: { id: string; sites: Site[]; onChange: (sites: Site[]) => void }) {
  const nameInput = useRef<HTMLInputElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");

  function move(index: number, to: number) {
    const next = [...sites];
    [next[index], next[to]] = [next[to], next[index]];
    onChange(next);
    requestAnimationFrame(() => document.getElementById(`${id}-site-${to}`)
      ?.querySelector<HTMLButtonElement>("button:enabled")?.focus({ preventScroll: true }));
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = nameInput.current?.value.trim() ?? "";
    const url = normalizeSourceAddress(urlInput.current?.value ?? "");
    if (!name || !url || sites.some(site => site.url === url)) {
      setError(!name ? "请输入站点名称。" : !url ? "请输入有效的 HTTP 或 HTTPS 网页地址。" : "该网址已在快捷站点中。");
      (name ? urlInput : nameInput).current?.focus();
      return;
    }
    onChange([...sites, { name, url }]);
    setError("");
    form.reset();
    nameInput.current?.focus();
  }

  return <div className="explore-shortcut-editor">
    <ul className="explore-shortcut-rows">
      {sites.map((site, index) => <li key={site.url} id={`${id}-site-${index}`}>
        <div className="explore-shortcut-name"><strong>{site.name}</strong><small>{new URL(site.url).hostname}</small></div>
        <button type="button" title="上移" aria-label={`上移 ${site.name}`} disabled={index === 0} onClick={() => move(index, index - 1)}>
          <ArrowUp size={14} aria-hidden />
        </button>
        <button type="button" title="下移" aria-label={`下移 ${site.name}`} disabled={index === sites.length - 1} onClick={() => move(index, index + 1)}>
          <ArrowDown size={14} aria-hidden />
        </button>
        <button type="button" aria-label={`移除 ${site.name}`} onClick={() => {
          onChange(sites.filter(item => item.url !== site.url));
          nameInput.current?.focus();
        }}>移除</button>
      </li>)}
    </ul>
    <form className="explore-shortcut-form" onSubmit={add} onChange={() => { if (error) setError(""); }}>
      <label>站点名称<input ref={nameInput} maxLength={32} required /></label>
      <label>站点地址<input ref={urlInput} placeholder="https://example.com" required spellCheck={false} /></label>
      {error && <p role="alert">{error}</p>}
      <button type="submit">添加站点</button>
    </form>
    <button type="button" className="explore-shortcut-reset" onClick={() => { setError(""); onChange([...EXPLORER_SITES]); }}>
      恢复默认
    </button>
  </div>;
}
