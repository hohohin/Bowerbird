import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUpRight, Check, ChevronDown, ChevronRight, CircleHelp, Folder, FolderOpen, Image, Link2, ListTree, MoreHorizontal, Moon, MoveRight, Pencil, Play, Plus, RefreshCw, Sun, Trash2, Unlink, X } from 'lucide-react';
import { LibrarySelectionMark } from '../../../src/components/LibrarySelectionMark';
import { masonryGeometry } from '../../../src/lib/catalogVirtualLayout';
import { createState, descendants, folderPath, entriesIn, addReference, renameEntry, removeEntry, newFolder, renameFolder, moveFolder, deleteFolder, disconnectRoot, moveEntries, reconnect, connectDemo, type State, type Entry } from './model';
import '../../../src/styles.css';
import '../../../src/components/LocalFileWorkspace.css';
import '../../../src/components/CategorizedLibrary.css';
import '../../../src/components/LibraryTactical.css';
import '../../../src/components/IndustrialTheme.css';
import './preview.css';

type Menu = { kind: 'folder'; id: string; x: number; y: number } | { kind: 'entry'; ids: string[]; x: number; y: number } | { kind: 'media'; x: number; y: number };
type Dialog = { kind: 'connect' } | { kind: 'new'; parent: string | null } | { kind: 'rename-folder'; id: string } | { kind: 'rename-entry'; id: string }
  | { kind: 'move-folder' | 'delete-folder'; id: string }
  | { kind: 'destination'; action: 'reference' | 'move'; ids: string[] } | { kind: 'delete'; ids: string[] } | { kind: 'disconnect'; id: string } | { kind: 'reconnect'; id: string } | { kind: 'inspect'; id: string; detail: boolean };
const icon = { size: 15, strokeWidth: 1.5, 'aria-hidden': true as const };
function Button({ label, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label?: string }) {
  return <button type="button" {...props} aria-label={label ?? props['aria-label']} title={props.title ?? label}>{children}</button>;
}
function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => [...ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,[tabindex="0"]')].filter(e => e.getClientRects().length);
    (ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? focusable()[0])?.focus({ preventScroll: true });
    function key(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
      if (e.key !== 'Tab') return;
      const items = focusable(), first = items[0], last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <div className="connection-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={`connection-modal app-modal${wide ? ' is-wide' : ''}`}>
      <header><h2>{title}</h2><Button label="关闭弹窗" onClick={onClose}><X {...icon}/></Button></header>{children}
    </div>
  </div>;
}

function App() {
  const [state, setState] = useState<State>(createState);
  const [active, setActive] = useState(() => state.folders[0].id);
  const [expanded, setExpanded] = useState(() => new Set(state.folders.filter(f => !f.parentId).map(f => f.id)));
  const [view, setView] = useState<'all' | 'tags' | 'collections'>('collections');
  const [tag, setTag] = useState('');
  const [media, setMedia] = useState<'all' | 'image' | 'video'>('all');
  const [selected, setSelected] = useState(new Set<string>());
  const [selecting, setSelecting] = useState(false);
  const anchor = useRef<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [toast, setToast] = useState('');
  const [loading, setLoading] = useState(false);
  const [theme, setTheme] = useState(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark');
  const [platform, setPlatform] = useState<'windows' | 'mac'>('windows');
  const [cardWidth, setCardWidth] = useState(220);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const timer = useRef<number>();
  const gallery = useRef<HTMLDivElement>(null);
  const tree = useRef<HTMLElement>(null);
  const pendingFolder = useRef<string | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const roots = state.folders.filter(f => !f.parentId);
  const allTags = [...new Set(state.assets.flatMap(a => a.tags))];
  const [gallerySize, setGallerySize] = useState({ width: 900, height: 600 });
  const sections = useMemo(() => {
    const assets = new Map(state.assets.map(asset => [asset.id, asset]));
    const matches = (entry: Entry) => {
      const asset = assets.get(entry.assetId)!;
      return (media === 'all' || asset.kind === media) && (view !== 'tags' || !tag || asset.tags.includes(tag));
    };
    const order = state.folders.filter(f => !f.parentId).flatMap(f => [f.id, ...descendants(state, f.id)]);
    const groups = view === 'collections' ? order.map(id => ({ id, name: state.folders.find(f => f.id === id)!.name, entries: entriesIn(state, id, false).filter(matches) }))
      : [{ id: view, name: view === 'tags' ? tag || '全部标签' : '全部素材', entries: state.entries.filter((entry, index, all) => all.findIndex(other => other.assetId === entry.assetId) === index).filter(matches) }];
    let top = 0;
    return groups.map(group => {
      const geometry = masonryGeometry(group.entries.map(entry => assets.get(entry.assetId)!), gallerySize.width, cardWidth);
      const folder = state.folders.find(f => f.id === group.id);
      const offline = !!folder && !state.roots[folder.rootId]?.available;
      const height = (view === 'collections' ? 56 : 0) + (group.entries.length ? geometry.height : 96) + (offline ? 44 : 0);
      const section = { ...group, geometry, offline, rootId: folder?.rootId, top, height };
      top += height;
      return section;
    });
  }, [state, view, tag, media, gallerySize.width, cardWidth]);
  const visible = sections.flatMap(section => section.entries);
  const asPath = (value: string) => platform === 'windows' ? value.replaceAll('/', '\\') : value.replace(/^[A-Za-z]:[\\/]/, '/Volumes/素材/').replaceAll('\\', '/');
  const locationOf = (folderId: string) => {
    const f = state.folders.find(f => f.id === folderId);
    return f ? `${asPath(state.roots[f.rootId]?.path ?? '')}${platform === 'windows' ? '\\' : '/'}${folderPath(state, f.id).slice(1).join(platform === 'windows' ? '\\' : '/')}`.replace(/[\\/]$/, '') : '原文件位置不可用';
  };
  function available(e: Entry) {
    const a = state.assets.find(a => a.id === e.assetId);
    const original = state.entries.find(item => item.assetId === e.assetId && !item.reference);
    const folder = state.folders.find(f => f.id === original?.folderId);
    return !!a?.available && (!folder || state.roots[folder.rootId]?.available !== false);
  }
  function announce(message: string) { setToast(message); }
  function navigate(id: string) {
    setActive(id); setSelected(new Set()); setSelecting(false); setMenu(null); setSidebarOpen(false);
    const section = sections.find(section => section.id === id);
    if (section && view === 'collections') gallery.current?.scrollTo({ top: section.top });
    else pendingFolder.current = id;
  }
  function switchView(next: typeof view) { setView(next); setSelected(new Set()); setSelecting(false); setMenu(null); }
  function toggleFolder(id: string) { setExpanded(old => { const next = new Set(old); next.has(id) ? next.delete(id) : next.add(id); return next; }); }
  function operate(action: (current: State) => State, message: string) {
    try {
      const next = action(state); setState(next);
      const added = next.folders.find(f => !state.folders.some(previous => previous.id === f.id));
      if (added) {
        pendingFolder.current = added.id; setActive(added.id);
        setExpanded(old => new Set([...old, ...next.folders.filter(f => descendants(next, f.id).includes(added.id)).map(f => f.id)]));
      } else if (!next.folders.some(f => f.id === active)) setActive(next.folders[0]?.id ?? '');
      setSelected(new Set()); setSelecting(false); setDialog(null); setMenu(null); announce(message);
    } catch (error) { announce(error instanceof Error ? error.message : '操作未完成，请重试'); }
  }
  function refresh() {
    if (loading) return;
    setLoading(true); window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { setLoading(false); announce('已检查文件夹，没有新变化'); }, 650);
  }
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 3200); return () => clearTimeout(id); }, [toast]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useLayoutEffect(() => { const element = gallery.current!; const observer = new ResizeObserver(() => setGallerySize({ width: element.clientWidth - 32, height: element.clientHeight })); observer.observe(element); return () => observer.disconnect(); }, []);
  useLayoutEffect(() => {
    if (view !== 'collections') { gallery.current?.scrollTo({ top: 0 }); return; }
    const section = sections.find(section => section.id === (pendingFolder.current ?? activeRef.current)) ?? sections[0];
    pendingFolder.current = null;
    if (section) { gallery.current?.scrollTo({ top: section.top }); setActive(section.id); }
  }, [sections, view]);
  function trackSection() {
    if (view !== 'collections' || dialog) return;
    const top = gallery.current?.scrollTop ?? 0;
    const section = sections.findLast(section => section.top <= top + 1) ?? sections[0];
    if (section) setActive(section.id);
  }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (dialog || target.closest('input,textarea,[contenteditable="true"]')) return;
      if (event.key === 'Escape') { setMenu(null); setSelected(new Set()); setSelecting(false); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && gallery.current?.contains(target)) {
        event.preventDefault(); setSelected(new Set(visible.map(e => e.id))); setSelecting(true);
      }
    };
    document.addEventListener('keydown', handler); return () => document.removeEventListener('keydown', handler);
  }, [dialog, visible]);
  const visibleFolders: string[] = [];
  function appendTree(parent: string | null) { state.folders.filter(f => f.parentId === parent).forEach(f => { visibleFolders.push(f.id); if (expanded.has(f.id)) appendTree(f.id); }); }
  appendTree(null);
  function treeKey(e: React.KeyboardEvent, id: string) {
    const f = state.folders.find(f => f.id === id)!;
    const children = state.folders.filter(c => c.parentId === id);
    let destination: string | undefined;
    if (e.key === 'ArrowDown') destination = visibleFolders[Math.min(visibleFolders.length - 1, visibleFolders.indexOf(id) + 1)];
    else if (e.key === 'ArrowUp') destination = visibleFolders[Math.max(0, visibleFolders.indexOf(id) - 1)];
    else if (e.key === 'Home') destination = visibleFolders[0];
    else if (e.key === 'End') destination = visibleFolders.at(-1);
    else if (e.key === 'ArrowRight') { if (!expanded.has(id) && children.length) toggleFolder(id); else destination = children[0]?.id; }
    else if (e.key === 'ArrowLeft') { if (expanded.has(id) && children.length) toggleFolder(id); else destination = f.parentId ?? undefined; }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(id); return; }
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ kind: 'folder', id, x: r.right - 10, y: r.top + 20 }); return; }
    else return;
    e.preventDefault(); if (destination) tree.current?.querySelector<HTMLElement>(`[data-folder="${destination}"]`)?.focus();
  }
  function folderNodes(parent: string | null, depth = 0): ReactNode {
    return state.folders.filter(f => f.parentId === parent).map(f => {
      const children = state.folders.some(c => c.parentId === f.id), online = state.roots[f.rootId]?.available;
      return <div role="none" key={f.id}>
        <div role="treeitem" data-folder={f.id} aria-label={f.name} aria-selected={active === f.id} aria-expanded={children ? expanded.has(f.id) : undefined} aria-level={depth + 1}
          tabIndex={active === f.id || (!visibleFolders.includes(active) && f.id === roots[0]?.id) ? 0 : -1}
          className={`connection-tree-row${active === f.id ? ' is-active' : ''}${!online ? ' is-offline' : ''}${dragTarget === f.id ? ' is-drop-target' : ''}`}
          style={{ paddingLeft: 13 + depth * 17 }} title={locationOf(f.id)} onKeyDown={e => treeKey(e, f.id)} onClick={() => navigate(f.id)}
          onContextMenu={e => { e.preventDefault(); setMenu({ kind: 'folder', id: f.id, x: e.clientX, y: e.clientY }); }}
          onDragOver={e => { if (online && e.dataTransfer.types.includes('application/x-bowerbird-preview-entries')) { e.preventDefault(); e.dataTransfer.dropEffect = 'link'; setDragTarget(f.id); } }}
          onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragTarget(null); }}
          onDrop={e => { e.preventDefault(); setDragTarget(null); try { const ids = JSON.parse(e.dataTransfer.getData('application/x-bowerbird-preview-entries')) as string[]; operate(s => addReference(s, ids, f.id), `已添加到「${f.name}」，原文件保持原位`); } catch { announce('请从素材区拖入素材'); } }}>
          <Button className={`tree-toggle${children ? '' : ' no-children'}`} label={`${expanded.has(f.id) ? '折叠' : '展开'}${f.name}`} tabIndex={-1} onClick={e => { e.stopPropagation(); toggleFolder(f.id); }}><ChevronRight size={12} aria-hidden="true" className={expanded.has(f.id) ? 'rotated' : ''}/></Button>
          {expanded.has(f.id) ? <FolderOpen {...icon}/> : <Folder {...icon}/>}<span>{f.name}</span>{!online && <Unlink size={12} aria-label="连接不可用"/>}
          <Button label={`在${f.name}中新建集合`} title="新建集合" className="tree-add" disabled={!online} onKeyDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setDialog({ kind: 'new', parent: f.id }); }}><Plus {...icon}/></Button>
          <Button label={`${f.name}的操作`} className="tree-more" tabIndex={-1} onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ kind: 'folder', id: f.id, x: r.left, y: r.bottom }); }}><MoreHorizontal {...icon}/></Button>
        </div>
        {children && expanded.has(f.id) && <div role="group">{folderNodes(f.id, depth + 1)}</div>}
      </div>;
    });
  }
  function select(e: React.MouseEvent, entry: Entry) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || selecting) {
      setSelecting(true);
      if (e.shiftKey && anchor.current) {
        const start = visible.findIndex(v => v.id === anchor.current), end = visible.findIndex(v => v.id === entry.id);
        setSelected(old => new Set([...old, ...visible.slice(Math.min(start, end), Math.max(start, end) + 1).map(v => v.id)]));
      } else { setSelected(old => { const next = new Set(old); next.has(entry.id) ? next.delete(entry.id) : next.add(entry.id); return next; }); anchor.current = entry.id; }
    } else setDialog({ kind: 'inspect', id: entry.id, detail: false });
  }
  return <div className="connection-study">
    <a className="connection-skip" href="#connection-gallery">跳至素材</a>
    <div className="connection-app library-tactical">
      <header className="connection-topbar">
        <div className="connection-brand" aria-label="Bowerbird"><span className="brand-pixel" aria-hidden="true"/><span>BOWERBIRD</span></div>
        <Button className="connection-primary" onClick={() => setDialog({ kind: 'connect' })}><Link2 {...icon}/>建立连接</Button>
        <div className="connection-tabs" role="tablist" aria-label="素材视图">{(['all', 'tags', 'collections'] as const).map((v, index, all) => <button type="button" role="tab" aria-selected={view === v} tabIndex={view === v ? 0 : -1} key={v} onClick={() => switchView(v)} onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const next = all[(index + (e.key === 'ArrowRight' ? 1 : 2)) % 3]; switchView(next); (e.currentTarget.parentElement!.children[all.indexOf(next)] as HTMLElement).focus(); } }}>{v === 'all' ? '全部' : v === 'tags' ? '标签分类' : '集合分类'}</button>)}</div>
        <div className="connection-top-actions"><Button label={theme === 'dark' ? '切换浅色主题' : '切换深色主题'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun {...icon}/> : <Moon {...icon}/>}</Button><Button label="预览说明" onClick={() => announce('使用示例目录。可建立连接、展开目录、添加分身和重新定位；不读写本机文件。')}><CircleHelp {...icon}/></Button></div>
      </header>
      <div className="connection-workspace">
        {view !== 'all' && <aside className={`connection-sidebar${sidebarOpen ? ' is-open' : ''}`}>
          <header><span>{view === 'tags' ? '标签' : '集合'}</span>{view === 'collections' && <Button label="新建集合" onClick={() => setDialog({ kind: 'new', parent: null })}><Plus {...icon}/></Button>}<Button className="sidebar-close" label="收起侧栏" onClick={() => setSidebarOpen(false)}><X {...icon}/></Button></header>
          {view === 'collections' ? <nav ref={tree} className="connection-tree" role="tree" aria-label="已连接的文件夹">{folderNodes(null)}</nav>
            : <nav className="connection-tag-list" aria-label="分类标签"><Button aria-pressed={!tag} onClick={() => setTag('')}>全部标签</Button>{allTags.map(name => <Button key={name} aria-pressed={tag === name} onClick={() => setTag(name)}>{name}<span>{state.assets.filter(a => a.tags.includes(name)).length}</span></Button>)}</nav>}
        </aside>}
        {sidebarOpen && <button className="connection-sidebar-shade" aria-label="关闭目录侧栏" onClick={() => setSidebarOpen(false)}/>}
        <main className="connection-main">
          <div className="connection-gallery-toolbar">
            {view !== 'all' && <Button className="sidebar-opener" label="展开目录侧栏" onClick={() => setSidebarOpen(true)}><ListTree {...icon}/></Button>}
            {view === 'collections' ? <div className="connection-toolbar-space"/> : <nav className="connection-breadcrumb" aria-label="当前位置"><span>{view === 'tags' ? tag || '全部标签' : '全部素材'}</span></nav>}
            <div className="connection-scope-controls">
              <Button label="筛选素材类型" aria-expanded={menu?.kind === 'media'} onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setMenu(menu?.kind === 'media' ? null : { kind: 'media', x: r.left, y: r.bottom + 5 }); }}>{media === 'all' ? '图片与视频' : media === 'image' ? '图片' : '视频'}<ChevronDown size={12} aria-hidden="true"/></Button>
              <Button label="刷新文件夹" disabled={loading} onClick={refresh}><RefreshCw {...icon} className={loading ? 'is-spinning' : ''}/></Button>
              {view === 'collections' && <Button aria-pressed={selecting} onClick={() => { setSelecting(!selecting); setSelected(new Set()); }}>{selecting ? '完成选择' : '选择'}</Button>}
            </div>
          </div>
          {view !== 'collections' && <div className="connection-count-row"><span aria-live="polite" data-result-count={visible.length}>{visible.length} 项</span><Button aria-pressed={selecting} onClick={() => { setSelecting(!selecting); setSelected(new Set()); }}>{selecting ? '完成选择' : '选择'}</Button></div>}
          <div ref={gallery} id="connection-gallery" tabIndex={0} className="connection-gallery" aria-label="集合素材" onScroll={trackSection}>
            {sections.map((section, sectionIndex) => <section key={section.id} data-section={view === 'collections' ? section.id : undefined} aria-label={section.name} className="connection-section" style={{ minHeight: view === 'collections' && sectionIndex === sections.length - 1 ? Math.max(section.height, gallerySize.height) : section.height }}>
              {view === 'collections' && <h3 className={`catalog-section-heading${active === section.id ? ' is-pinned' : ''}`}><span className="catalog-section-title library-floating-surface" data-current={active === section.id} title={folderPath(state, section.id).join(' / ')}>{section.name}<span className="connection-section-count" data-section-count={section.entries.length} data-result-count={active === section.id ? section.entries.length : undefined}>{section.entries.length} 项</span></span></h3>}
              {section.offline && <div className="connection-unavailable"><Unlink {...icon}/><span>文件夹暂不可用</span><Button onClick={() => { navigate(section.id); setDialog({ kind: 'reconnect', id: section.rootId! }); }}>重新定位<ArrowUpRight size={13}/></Button></div>}
              {!section.entries.length ? <div className="connection-section-empty">{view === 'collections' ? '暂无素材' : '没有素材'}</div> : <div className="connection-masonry" style={{ height: section.geometry.height }}>
                {section.entries.map((entry, index) => { const asset = state.assets.find(a => a.id === entry.assetId)!, cell = section.geometry.cells[index], online = available(entry); return <button type="button" key={entry.id} className={`connection-media-card folder-media-card${selected.has(entry.id) ? ' is-selected' : ''}${online ? '' : ' is-missing'}`} data-entry={entry.id} data-asset={entry.assetId} data-reference={entry.reference || undefined} aria-label={`${entry.name}${entry.reference ? '，分身' : ''}${online ? '' : '，原文件失联'}`} aria-pressed={selected.has(entry.id)} title={`${entry.name}\n${locationOf(entry.folderId)}${entry.reference ? '\n分身 · 原文件保持原位' : ''}`} style={{ width: cell.width, height: cell.height, transform: `translate3d(${cell.left}px,${cell.top}px,0)` }}
                  draggable={online} onDragStart={e => { const ids = selected.has(entry.id) ? [...selected] : [entry.id]; e.dataTransfer.setData('application/x-bowerbird-preview-entries', JSON.stringify(ids)); e.dataTransfer.effectAllowed = 'linkMove'; }} onDragEnd={() => setDragTarget(null)}
                  onClick={e => select(e, entry)} onContextMenu={e => { e.preventDefault(); setMenu({ kind: 'entry', ids: selected.has(entry.id) ? [...selected] : [entry.id], x: e.clientX, y: e.clientY }); }} onKeyDown={e => { if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ kind: 'entry', ids: [entry.id], x: r.left + 20, y: r.top + 25 }); } }}>
                  <span className="folder-media-preview" style={{ aspectRatio: `${asset.width}/${asset.height}` }}><img src={asset.src} alt="" loading="lazy" decoding="async" draggable={false}/>{asset.kind === 'video' && <span className="connection-video"><Play size={11} fill="currentColor" aria-hidden="true"/>视频</span>}{entry.reference && <span className="connection-reference" title="素材分身"><Link2 size={13} aria-hidden="true"/></span>}{!online && <span className="connection-missing"><Unlink size={18} aria-hidden="true"/><span>原文件失联</span></span>}</span>
                  <LibrarySelectionMark selected={selected.has(entry.id)} previewKey={asset.src}/>
                </button>; })}
              </div>}
            </section>)}
          </div>
          {selected.size > 0 && <div className="connection-selection"><span>已选 {selected.size} 项</span><Button onClick={() => setDialog({ kind: 'destination', action: 'reference', ids: [...selected] })}><Link2 {...icon}/>添加到集合</Button><Button onClick={() => setDialog({ kind: 'delete', ids: [...selected] })}><Trash2 {...icon}/>移除</Button><Button label="取消选择" onClick={() => { setSelected(new Set()); setSelecting(false); }}><X {...icon}/></Button></div>}
          <div className="connection-size"><Image size={12} aria-hidden="true"/><input type="range" aria-label="素材缩略图大小" min="140" max="360" step="10" value={cardWidth} onChange={e => setCardWidth(Number(e.target.value))}/><Image size={17} aria-hidden="true"/></div>
        </main>
      </div>
    </div>
    <footer className="connection-study-bar"><span><i aria-hidden="true"/>交互预览 · 示例目录</span><div><Button aria-pressed={platform === 'windows'} onClick={() => setPlatform('windows')}>Windows</Button><Button aria-pressed={platform === 'mac'} onClick={() => setPlatform('mac')}>macOS</Button><span className="study-separator"/><Button onClick={() => { const s = createState(); setState(s); setActive(s.folders[0].id); setExpanded(new Set(s.folders.filter(f => !f.parentId).map(f => f.id))); pendingFolder.current = s.folders[0].id; switchView('collections'); setMedia('all'); setDialog(null); announce('示例已重置'); }}>重置预览</Button></div></footer>
    {toast && <div className="connection-toast" role="status"><Check {...icon}/>{toast}</div>}
    {menu && <Context state={state} menu={menu} media={media} onClose={() => setMenu(null)} onMedia={m => { setMedia(m); setMenu(null); }} onDialog={d => { setMenu(null); setDialog(d); }} onSelect={ids => { setSelected(new Set(ids)); setSelecting(true); setMenu(null); }}/>}
    {dialog && <DialogContent key={`${dialog.kind}:${'id' in dialog ? dialog.id : ''}`} state={state} dialog={dialog} platform={platform} locationOf={locationOf} onClose={() => setDialog(null)} onChange={setDialog} onApply={operate} onConnect={() => { const next = connectDemo(state), added = next.folders.find(f => !f.parentId && !state.folders.some(old => old.id === f.id)) ?? next.folders.find(f => f.name === '旅行采风'); setState(next); if (added) { navigate(added.id); setExpanded(old => new Set([...old, added.id])); } setView('collections'); setDialog(null); setLoading(true); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => { setLoading(false); announce('已建立连接，原文件保持原位'); }, 650); }}/>}
  </div>;
}

function Context({ state, menu, media, onClose, onMedia, onDialog, onSelect }: { state: State; menu: Menu; media: string; onClose: () => void; onMedia: (m: 'all' | 'image' | 'video') => void; onDialog: (d: Dialog) => void; onSelect: (ids: string[]) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const r = ref.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(menu.x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(menu.y, innerHeight - r.height - 36)) });
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const row = (text: string, action: () => void, symbol: ReactNode, danger = false) => <button type="button" role="menuitem" className={danger ? 'is-danger' : ''} onClick={action}>{symbol}<span>{text}</span></button>;
  const f = menu.kind === 'folder' ? state.folders.find(f => f.id === menu.id)! : null;
  const targets = menu.kind === 'entry' ? state.entries.filter(e => menu.ids.includes(e.id)) : [];
  const onlyReferences = targets.length > 0 && targets.every(e => e.reference);
  return <><div className="connection-menu-shade" onClick={onClose}/><div ref={ref} role="menu" className="connection-menu" style={position} onKeyDown={e => {
    const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>('button')], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); buttons[(index + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
  }}>
    {menu.kind === 'media' ? (['all', 'image', 'video'] as const).map(m => <button type="button" key={m} role="menuitemradio" aria-checked={media === m} onClick={() => onMedia(m)}>{m === 'video' ? <Play {...icon}/> : <Image {...icon}/>}<span>{m === 'all' ? '图片与视频' : m === 'image' ? '图片' : '视频'}</span>{media === m && <Check size={13}/>}</button>)
      : f ? <>{state.roots[f.rootId]?.available ? <>{row('重命名文件夹', () => onDialog({ kind: 'rename-folder', id: f.id }), <Pencil {...icon}/>)}{row('移动文件夹', () => onDialog({ kind: 'move-folder', id: f.id }), <MoveRight {...icon}/>)}<hr/>{row('文件夹移到回收站', () => onDialog({ kind: 'delete-folder', id: f.id }), <Trash2 {...icon}/>, true)}</> : row('重新定位', () => onDialog({ kind: 'reconnect', id: f.rootId }), <Link2 {...icon}/>)}{!f.parentId && <><hr/>{row('断开连接', () => onDialog({ kind: 'disconnect', id: f.id }), <Unlink {...icon}/>)}</>}</>
        : menu.kind === 'entry' && <>{targets.length === 1 && row('查看详情', () => onDialog({ kind: 'inspect', id: targets[0].id, detail: true }), <Image {...icon}/>)}{row('选择素材', () => onSelect(menu.ids), <Check {...icon}/>)}<hr/>{row('添加到集合', () => onDialog({ kind: 'destination', action: 'reference', ids: menu.ids }), <Link2 {...icon}/>)}{row(onlyReferences ? '移动分身' : '移动到文件夹', () => onDialog({ kind: 'destination', action: 'move', ids: menu.ids }), <MoveRight {...icon}/>)}{targets.length === 1 && row(onlyReferences ? '重命名分身' : '重命名原文件', () => onDialog({ kind: 'rename-entry', id: targets[0].id }), <Pencil {...icon}/>)}<hr/>{row(onlyReferences ? '删除分身' : '移到回收站', () => onDialog({ kind: 'delete', ids: menu.ids }), <Trash2 {...icon}/>, true)}</>}
  </div></>;
}

function DialogContent({ state, dialog, platform, locationOf, onClose, onChange, onApply, onConnect }: { state: State; dialog: Dialog; platform: 'windows' | 'mac'; locationOf: (id: string) => string; onClose: () => void; onChange: (d: Dialog) => void; onApply: (action: (s: State) => State, message: string) => void; onConnect: () => void }) {
  const targetFolder = 'id' in dialog ? state.folders.find(f => f.id === dialog.id) : null;
  const targetEntry = 'id' in dialog ? state.entries.find(e => e.id === dialog.id) : null;
  const asset = targetEntry ? state.assets.find(a => a.id === targetEntry.assetId) : null;
  const original = asset ? state.entries.find(e => e.assetId === asset.id && !e.reference) : null;
  const [name, setName] = useState(targetFolder?.name ?? targetEntry?.name.replace(/\.bowerbird$/, '') ?? '');
  const [error, setError] = useState('');
  const excludedFolders = dialog.kind === 'move-folder' ? new Set([dialog.id, ...descendants(state, dialog.id)]) : new Set<string>();
  const destinations = state.folders.filter(f => state.roots[f.rootId]?.available && !excludedFolders.has(f.id));
  const [destination, setDestination] = useState(destinations.find(f => f.name === '春季提案')?.id ?? destinations[0]?.id ?? '');
  const [chosen, setChosen] = useState('旅行采风');
  const [base, setBase] = useState(platform === 'windows' ? 'D:\\素材' : '/Users/demo/Pictures');
  function saveName(e: React.FormEvent) {
    e.preventDefault(); const value = name.trim();
    if (!value || /[<>:"/\\|?*]/.test(value)) { setError('请输入有效名称，不包含路径分隔符或特殊字符。'); return; }
    if (dialog.kind === 'new') onApply(s => { const next = newFolder(s, dialog.parent, value); const added = next.folders.find(f => !s.folders.some(old => old.id === f.id)); if (!dialog.parent && added) next.roots[added.id].path = `${base}${platform === 'windows' ? '\\' : '/'}${value}`; return next; }, `已创建文件夹「${value}」`);
    else if (dialog.kind === 'rename-folder') onApply(s => renameFolder(s, dialog.id, value), '已重命名文件夹，素材引用保持');
    else if (dialog.kind === 'rename-entry') onApply(s => renameEntry(s, dialog.id, value), targetEntry?.reference ? '已重命名分身，原文件保持原名' : '已重命名原文件，素材引用保持');
  }
  if (dialog.kind === 'connect') return <Modal title="建立连接" onClose={onClose}><div className="connection-modal-body"><div className="connection-picker-address"><FolderOpen {...icon}/>{base}</div><div className="connection-connect-choices" role="radiogroup" aria-label="选择示例文件夹">{['旅行采风', '品牌素材', '项目参考'].map(value => <Button key={value} role="radio" aria-checked={chosen === value} onClick={() => setChosen(value)}><Folder {...icon}/><span>{value}</span>{chosen === value && <Check {...icon}/>}</Button>)}</div><p className="connection-note">连接文件夹及其子文件夹，原文件保持原位。</p></div><footer><Button onClick={onClose}>取消</Button><Button className="connection-primary" onClick={() => { if (chosen === '旅行采风') onConnect(); else onApply(s => s, `「${chosen}」已连接`); }}><Link2 {...icon}/>建立连接</Button></footer></Modal>;
  if (dialog.kind === 'new' || dialog.kind === 'rename-folder' || dialog.kind === 'rename-entry') return <Modal title={dialog.kind === 'new' ? '新建集合' : dialog.kind === 'rename-folder' ? '重命名文件夹' : targetEntry?.reference ? '重命名分身' : '重命名原文件'} onClose={onClose}><form onSubmit={saveName}><div className="connection-modal-body"><label className="connection-field">名称<input data-autofocus value={name} maxLength={100} onChange={e => { setName(e.target.value); setError(''); }}/></label>{dialog.kind === 'new' && !dialog.parent ? <label className="connection-field">保存位置<input value={base} onChange={e => setBase(e.target.value)}/></label> : <div className="connection-location"><Folder size={14}/><span>{dialog.kind === 'new' ? locationOf(dialog.parent!) : locationOf(targetFolder?.id ?? targetEntry!.folderId)}</span></div>}{dialog.kind === 'new' && <p className="connection-note">将在此位置创建真实文件夹。</p>}{error && <p role="alert" className="connection-error">{error}</p>}</div><footer><Button onClick={onClose}>取消</Button><button type="submit" className="connection-primary">{dialog.kind === 'new' ? '创建' : '保存'}</button></footer></form></Modal>;
  if (dialog.kind === 'move-folder') return <Modal title="移动文件夹" onClose={onClose}><div className="connection-modal-body"><div className="connection-destination-list" role="radiogroup" aria-label="目标集合">{destinations.map(f => <Button key={f.id} role="radio" aria-checked={destination === f.id} style={{ paddingLeft: 12 + (folderPath(state, f.id).length - 1) * 17 }} onClick={() => setDestination(f.id)}><Folder {...icon}/><span>{f.name}</span>{destination === f.id && <Check {...icon}/>}</Button>)}</div><div className="connection-location"><Folder size={14}/><span>{locationOf(destination)}</span></div><p className="connection-note">移动「{targetFolder?.name}」及其全部内容，素材身份和创作资料保持。</p></div><footer><Button onClick={onClose}>取消</Button><Button className="connection-primary" disabled={!destination} onClick={() => onApply(s => moveFolder(s, dialog.id, destination), '文件夹已移动，素材身份保持')}>移动</Button></footer></Modal>;
  if (dialog.kind === 'delete-folder') return <Modal title="文件夹移到回收站" onClose={onClose}><div className="connection-modal-body"><p>将「{targetFolder?.name}」及其全部内容移到回收站？</p><p className="connection-note">其中原文件的其他分身将显示失联。创作资料保留。</p><div className="connection-location"><Folder {...icon}/><span>{locationOf(dialog.id)}</span></div></div><footer><Button onClick={onClose}>取消</Button><Button className="connection-danger" onClick={() => onApply(s => deleteFolder(s, dialog.id), '文件夹已移到回收站，创作资料保留')}>移到回收站</Button></footer></Modal>;
  if (dialog.kind === 'destination') {
    const movingOriginal = dialog.action === 'move' && state.entries.some(e => dialog.ids.includes(e.id) && !e.reference);
    return <Modal title={dialog.action === 'reference' ? '添加到集合' : movingOriginal ? '移动到文件夹' : '移动分身'} onClose={onClose}><div className="connection-modal-body"><div className="connection-destination-list" role="radiogroup" aria-label="目标集合">{state.folders.filter(f => state.roots[f.rootId]?.available).map(f => <Button key={f.id} role="radio" aria-checked={destination === f.id} style={{ paddingLeft: 12 + (folderPath(state, f.id).length - 1) * 17 }} onClick={() => setDestination(f.id)}><Folder {...icon}/><span>{f.name}</span>{destination === f.id && <Check {...icon}/>}</Button>)}</div><div className="connection-location"><Folder size={14}/><span>{locationOf(destination)}</span></div><p className="connection-note">{dialog.action === 'reference' ? '在目标文件夹创建分身，原文件保持原位。' : movingOriginal ? '将移动原文件，已有标签、分析和画板引用保持。' : '只移动分身，原文件保持原位。'}</p></div><footer><span>{dialog.ids.length} 项</span><Button onClick={onClose}>取消</Button><Button className="connection-primary" disabled={!destination} onClick={() => onApply(s => dialog.action === 'reference' ? addReference(s, dialog.ids, destination) : moveEntries(s, dialog.ids, destination), dialog.action === 'reference' ? '已添加分身，原文件保持原位' : '移动已完成，素材身份保持')}>{dialog.action === 'reference' ? '添加' : '移动'}</Button></footer></Modal>;
  }
  if (dialog.kind === 'delete') {
    const items = state.entries.filter(e => dialog.ids.includes(e.id)), references = items.filter(e => e.reference).length, originals = items.length - references;
    return <Modal title={originals ? '移到回收站' : '删除分身'} onClose={onClose}><div className="connection-modal-body"><p>{originals ? `将 ${originals} 个原文件${references ? `和 ${references} 个分身` : ''}移到回收站？` : `删除 ${references} 个分身？`}</p><p className="connection-note">{originals ? '原文件的其他分身将显示失联，创作资料保留。' : '原文件、标签、分析和其他集合中的引用保留。'}</p><div className="connection-delete-list">{items.slice(0, 5).map(e => <div key={e.id}>{e.reference ? <Link2 {...icon}/> : <Image {...icon}/>}<span>{e.name}</span></div>)}</div></div><footer><Button onClick={onClose}>取消</Button><Button className="connection-danger" onClick={() => onApply(s => dialog.ids.reduce((next, id) => removeEntry(next, id), s), originals ? '已移到回收站，创作资料保留' : '已删除分身，原文件保留')}>{originals ? '移到回收站' : '删除分身'}</Button></footer></Modal>;
  }
  if (dialog.kind === 'disconnect') return <Modal title="断开连接" onClose={onClose}><div className="connection-modal-body"><p>断开「{targetFolder?.name}」？</p><p className="connection-note">原文件和创作资料保留。之后可以重新建立连接。</p><div className="connection-location"><Folder {...icon}/><span>{locationOf(dialog.id)}</span></div></div><footer><Button onClick={onClose}>取消</Button><Button className="connection-primary" onClick={() => onApply(s => disconnectRoot(s, dialog.id), '已断开连接，原文件保留')}>断开连接</Button></footer></Modal>;
  if (dialog.kind === 'reconnect') return <Modal title="重新定位文件夹" onClose={onClose}><div className="connection-modal-body"><p>{targetFolder?.name}</p><label className="connection-field">新位置<input data-autofocus value={base} onChange={e => setBase(e.target.value)}/></label><p className="connection-note">重新连接同一目录，保留标签、分析和画板引用。</p></div><footer><Button onClick={onClose}>取消</Button><Button className="connection-primary" onClick={() => onApply(s => { const next = reconnect(s, dialog.id); next.roots[dialog.id].path = base; return next; }, '已重新连接，素材身份保持')}>连接此位置</Button></footer></Modal>;
  if (dialog.kind === 'inspect' && targetEntry && asset) return <Modal title={targetEntry.name} onClose={onClose} wide><div className="connection-inspect"><div className="connection-inspect-image"><img src={asset.src} alt={asset.name}/>{asset.kind === 'video' && <span><Play size={20}/>视频封面</span>}</div><aside>{targetEntry.reference && <div className="connection-inspect-reference"><Link2 {...icon}/>素材分身</div>}<dl><dt>类型</dt><dd>{asset.kind === 'video' ? '视频' : '图片'} · {asset.width} × {asset.height}</dd><dt>所在集合</dt><dd>{folderPath(state, targetEntry.folderId).join(' / ')}</dd><dt>{targetEntry.reference ? '原文件位置' : '文件位置'}</dt><dd>{original ? `${locationOf(original.folderId)}${platform === 'windows' ? '\\' : '/'}${asset.name}` : '原文件暂不可用'}</dd></dl><div className="connection-inspect-tags">{asset.tags.map(tag => <span key={tag}>{tag}</span>)}</div><Button className="connection-primary" onClick={() => onChange({ kind: 'destination', action: 'reference', ids: [targetEntry.id] })}><Link2 {...icon}/>添加到集合</Button></aside></div></Modal>;
  return null;
}

createRoot(document.getElementById('root')!).render(<App/>);
