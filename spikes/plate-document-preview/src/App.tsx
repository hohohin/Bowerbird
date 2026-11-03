import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ArrowLeft, ArrowUpRight, AudioLines, Bold, Check, ChevronDown, ChevronRight, Code2, FileText, FolderOpen, Image, Italic, List, MessageSquare, Moon, Plus, Quote, Redo2, Search, Send, Sparkles, Sun, Undo2, Video, X } from 'lucide-react';
import { PlateDocumentEditor, type DocumentEditorHandle } from './PlateDocumentEditor';
import { parseMarkdown, serializeMarkdown } from './documentCodec';
import { initialAssets, initialDocuments, type PreviewDocument } from './fixtures';
import { createHandoff, type DocumentHandoff } from './handoff';
import { TARGET_LABELS, type DocumentValue, type DraftTarget, type PreviewAsset } from './domain';
import { SampleAudio } from './SampleAudio';

const targetIcons = { chat: MessageSquare, agent: Sparkles, image: Image, video: Video };
const kindNames = { image: '图片', audio: '音频', video: '视频' };
interface PreviewDraft extends DocumentHandoff { prepared: boolean }

function AssetThumbnail({ asset }: { asset: PreviewAsset }) {
  if (asset.kind === 'image') return <img src={asset.url} alt="" loading="lazy" draggable={false} />;
  const Icon = asset.kind === 'audio' ? AudioLines : Video;
  return <span className={`media-placeholder ${asset.kind}`}><Icon size={24} strokeWidth={1.3} aria-hidden="true" /></span>;
}

function DraftPanel({ draft, onClose, onChange }: { draft: PreviewDraft; onClose(): void; onChange(draft: PreviewDraft): void }) {
  const { text, prepared, projectId: project } = draft;
  const Icon = targetIcons[draft.target];
  return <aside className="draft-panel" aria-label="转发草稿">
    <header className="panel-header"><span><Icon size={17} aria-hidden="true" />{TARGET_LABELS[draft.target]}</span><button className="icon-button" aria-label="关闭转发草稿" onClick={onClose}><X size={17} /></button></header>
    <div className="draft-body">
      <label className="field-label" htmlFor="target-project">项目</label>
      <select id="target-project" value={project} onChange={event => onChange({ ...draft, projectId: event.target.value, prepared: false })} disabled={prepared}>
        <option value="flower-project">花间 · 秋日短片</option><option value="portrait-project">人物光线研究</option>
      </select>
      <div className="draft-meta"><span>{prepared ? '待发送' : '新草稿'}</span><span>{draft.references.length} 个参考素材</span></div>
      <textarea aria-label="草稿内容" value={text} onChange={event => onChange({ ...draft, text: event.target.value, prepared: false })} />
      <div className="draft-references">
        {draft.references.map(reference => <div key={reference.asset.id} className={`reference-row ${reference.supported ? '' : 'unsupported'}`}>
          <AssetThumbnail asset={reference.asset} />
          <div><strong>@{reference.label}</strong><span title={reference.asset.name}>{reference.asset.name}</span>{!reference.supported && <small>当前模型不支持，发送前需处理</small>}</div>
          {reference.supported && <Check size={14} aria-label="可作为参考" />}
        </div>)}
        {draft.missing.map(reference => <div className="missing-reference" key={reference.blockId}>素材未连接：{reference.name}</div>)}
      </div>
      {draft.unsupported.length > 0 && <p className="compatibility-note">这些附件会保留在草稿中，本次不能作为模型输入。</p>}
    </div>
    <footer className="draft-footer">
      {prepared ? <><span className="prepared-status" role="status"><Check size={15} />草稿已准备 · 仅预览</span><button disabled title="本预览不发送请求或执行生成">{draft.target === 'chat' ? '发送' : '运行'}<ArrowUpRight size={15} /></button></>
        : <><span>带入后，由你发送或生成</span><button className="primary-button" disabled={draft.missing.length > 0 || !text.trim()} onClick={() => onChange({ ...draft, prepared: true })}>带入草稿<ArrowUpRight size={15} /></button></>}
    </footer>
  </aside>;
}

export function App() {
  const [documents, setDocuments] = useState<PreviewDocument[]>(() => structuredClone(initialDocuments));
  const [activeId, setActiveId] = useState(initialDocuments[0].id);
  const [assets, setAssets] = useState(initialAssets);
  const [mode, setMode] = useState<'body' | 'source'>('body');
  const [source, setSource] = useState('');
  const [sourceDirty, setSourceDirty] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [theme, setTheme] = useState('dark');
  const [menuOpen, setMenuOpen] = useState(false);
  const [drafts, setDrafts] = useState<PreviewDraft[]>([]);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [libraryOpen, setLibraryOpen] = useState(true);
  const editor = useRef<DocumentEditorHandle>(null);
  const mediaInput = useRef<HTMLInputElement>(null), documentInput = useRef<HTMLInputElement>(null);
  const objectUrls = useRef<string[]>([]);
  const menuHost = useRef<HTMLDivElement>(null);
  const active = documents.find(document => document.id === activeId)!;
  const draft = drafts.find(draft => draft.requestId === activeDraftId);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => () => { objectUrls.current.forEach(url => URL.revokeObjectURL(url)); }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !menuHost.current?.contains(event.target)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape); };
  }, [menuOpen]);

  function updateValue(value: DocumentValue, id = activeId) {
    setDocuments(previous => previous.map(document => document.id === id ? { ...document, value, revision: document.revision + 1 } : document));
  }
  function currentValue(): DocumentValue {
    if (active.kind === 'text') return active.value;
    return mode === 'source' && sourceDirty ? parseMarkdown(source, assets) : active.value;
  }
  function commitSource() {
    if (mode !== 'source' || !sourceDirty) return active.value;
    const value = currentValue(); updateValue(value); setSourceDirty(false); return value;
  }
  function switchMode(next: 'body' | 'source') {
    if (next === mode) return;
    try {
      if (next === 'source') setSource(serializeMarkdown(active.value));
      else commitSource();
      setMode(next); setSelected([]); setError('');
    } catch { setError('源码暂时无法转换，请保留内容并检查格式。'); }
  }
  function openDocument(id: string) {
    try { commitSource(); } catch { setError('请先修正当前源码，再切换文档。'); return; }
    setActiveId(id); setMode('body'); setSelected([]); setError(''); setSourceDirty(false);
  }
  function save() {
    try {
      const value = currentValue();
      setDocuments(previous => previous.map(document => document.id === activeId ? {
        ...document, value, revision: document.revision + Number(sourceDirty), savedRevision: document.revision + Number(sourceDirty),
      } : document));
      setSourceDirty(false); setError(''); setNotice('预览草稿已保留在本页，原文件未改动。');
    } catch { setError('源码暂时无法转换，内容仍保留在编辑区。'); }
  }
  function createDocument() {
    const id = crypto.randomUUID();
    const next: PreviewDocument = { id, name: '未命名文档.md', kind: 'markdown', revision: 1, savedRevision: 0,
      value: [{ id: crypto.randomUUID(), type: 'p', children: [{ text: '' }] }] };
    try { commitSource(); } catch { setError('请先修正当前源码，再新建文档。'); return; }
    setDocuments(previous => [...previous, next]); setActiveId(id); setMode('body'); setSourceDirty(false); setSelected([]);
  }
  function convertText() {
    const id = crypto.randomUUID();
    setDocuments(previous => [...previous, { ...active, id, name: active.name.replace(/\.txt$/i, '.md'), kind: 'markdown', savedRevision: 0, value: structuredClone(active.value) }]);
    setActiveId(id); setMode('body'); setSelected([]); setNotice('已新建 Markdown 草稿，原文本保留。');
  }
  function insertAsset(asset: PreviewAsset) {
    if (active.kind === 'text') { setNotice('请先转为 Markdown 草稿，再插入媒体。'); return; }
    if (mode === 'source') { setNotice('切换到正文后，可在光标位置插入素材。'); return; }
    editor.current?.insertAsset(asset);
  }
  async function addFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []); event.target.value = '';
    const added: PreviewAsset[] = [];
    for (const file of files) {
      const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('video/') ? 'video' : null;
      if (!kind || (kind === 'image' && file.type === 'image/svg+xml')) { setNotice('请选择图片、音频或视频文件。'); continue; }
      const url = URL.createObjectURL(file); objectUrls.current.push(url);
      added.push({ id: crypto.randomUUID(), name: file.name, kind, url });
    }
    setAssets(previous => [...previous, ...added]);
    if (added.length) setNotice(`已连接 ${added.length} 个预览素材，点击左侧素材即可插入。`);
  }
  async function openFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []); event.target.value = '';
    try { commitSource(); } catch { setError('请先修正当前源码，再打开文件。'); return; }
    const added: PreviewDocument[] = [];
    for (const file of files) {
      if (file.size > 2 * 1024 * 1024) { setNotice('此预览暂只打开 2 MB 以内的文本文件。'); continue; }
      try {
        const text = await file.text(); const kind = /\.txt$/i.test(file.name) ? 'text' : 'markdown';
        added.push({ id: crypto.randomUUID(), name: file.name, kind, revision: 1, savedRevision: 1,
          value: kind === 'text' ? [{ id: crypto.randomUUID(), type: 'p', children: [{ text }] }] : parseMarkdown(text, assets) });
      } catch { setError('文件暂时无法读取，原文件没有改动。'); }
    }
    if (added.length) {
      setDocuments(previous => [...previous, ...added]); setActiveId(added[0].id); setMode('body'); setSourceDirty(false); setSelected([]);
    }
  }
  function forward(target: DraftTarget) {
    try {
      const value = currentValue();
      const next = createHandoff({ requestId: crypto.randomUUID(), projectId: 'flower-project', target,
        sourceDocumentAssetId: activeId, sourceRevision: String(active.revision + Number(sourceDirty)), value, assets,
        selectedBlockIds: selected.length ? selected : undefined });
      setDrafts(previous => [...previous, { ...next, prepared: false }]); setActiveDraftId(next.requestId); setMenuOpen(false); setError('');
    } catch { setError('请先检查源码格式，再转发内容。'); }
  }

  return <div className={`workspace ${libraryOpen ? '' : 'library-collapsed'}`} onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!event.nativeEvent.isComposing) save(); }
    if (event.key === 'Escape') { setMenuOpen(false); if (!event.nativeEvent.isComposing) setActiveDraftId(null); }
  }}>
    <a className="skip-link" href="#document-content">跳到文档</a>
    <header className="app-bar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">b</span><span>Bowerbird</span><span className="preview-badge">预览</span></div>
      <div className="home-navigation"><span aria-current="page">素材库</span><span className="inactive">项目</span></div>
      <div className="app-actions"><button className="icon-button" aria-label="切换深浅主题" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button><span className="avatar">H</span></div>
    </header>
    <div className="work-area">
      <aside className="library-sidebar" aria-label="素材库">
        <div className="sidebar-heading"><span>文档</span><div><button className="icon-button" title="打开文本文件" aria-label="打开文本文件" onClick={() => documentInput.current?.click()}><FolderOpen size={16} /></button><button className="icon-button" title="新建文档" aria-label="新建文档" onClick={createDocument}><Plus size={16} /></button></div></div>
        <label className="search-box"><Search size={14} aria-hidden="true" /><input aria-label="搜索文档和素材" placeholder="搜索" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <nav className="document-list" aria-label="文档列表">{documents.filter(document => document.name.includes(query)).map(document => <button key={document.id} aria-label={document.name} onClick={() => openDocument(document.id)} aria-current={document.id === activeId ? 'page' : undefined}><FileText size={15} aria-hidden="true" /><span title={document.name}>{document.name}</span>{document.savedRevision !== document.revision && <span className="unsaved-dot" title="有未保存的预览更改" />}</button>)}</nav>
        <div className="sidebar-heading media-heading"><span>素材</span><button className="icon-button" title="连接媒体文件" aria-label="连接媒体文件" onClick={() => mediaInput.current?.click()}><Plus size={16} /></button></div>
        <div className="media-library">{assets.filter(asset => asset.name.includes(query)).map(asset => <button className="asset-tile" key={asset.id} aria-label={`插入 ${asset.name}`} title={`${asset.name} · 点击或拖入文档`} onClick={() => insertAsset(asset)} draggable onDragStart={event => { event.dataTransfer.setData('application/x-bowerbird-preview-asset', asset.id); event.dataTransfer.effectAllowed = 'copy'; }}><AssetThumbnail asset={asset} /><span className="asset-kind">{kindNames[asset.kind]}</span><span className="asset-name">{asset.name}</span></button>)}</div>
        <div className="sidebar-foot"><FolderOpen size={13} />本机素材</div>
      </aside>
      <main className="document-workspace">
        <header className="document-header">
          <div className="document-location"><button className="icon-button" onClick={() => setLibraryOpen(!libraryOpen)} aria-label={libraryOpen ? '收起素材栏' : '展开素材栏'}>{libraryOpen ? <ArrowLeft size={16} /> : <ChevronRight size={16} />}</button><FileText size={15} aria-hidden="true" /><span title={active.name}>{active.name}</span>{(active.savedRevision !== active.revision || sourceDirty) && <span className="unsaved-dot" />}</div>
          <div className="document-actions">
            {active.kind === 'markdown' && <div className="mode-switch" aria-label="编辑方式"><button onClick={() => switchMode('body')} aria-pressed={mode === 'body'}>正文</button><button onClick={() => switchMode('source')} aria-pressed={mode === 'source'}>源码</button></div>}
            <button onClick={save} title="保存预览草稿；不写入原文件">保存</button>
            <div className="forward-host" ref={menuHost}><button className="primary-button" aria-expanded={menuOpen} aria-haspopup="true" onClick={() => setMenuOpen(!menuOpen)}><Send size={14} />转发<ChevronDown size={13} /></button>{menuOpen && <div className="forward-menu" aria-label="转发目标">{(Object.keys(TARGET_LABELS) as DraftTarget[]).map(target => { const Icon = targetIcons[target]; return <button key={target} onClick={() => forward(target)}><Icon size={16} />{TARGET_LABELS[target]}<ArrowUpRight size={13} /></button>; })}</div>}</div>
          </div>
        </header>
        <div className="format-bar">
          {active.kind === 'text' ? <><span>纯文本</span><button onClick={convertText}>转为 Markdown 草稿<ArrowUpRight size={14} /></button></> : <>
            <div className="format-group"><button title="撤销" aria-label="撤销" disabled={mode === 'source'} onClick={() => editor.current?.undo()}><Undo2 size={16} /></button><button title="重做" aria-label="重做" disabled={mode === 'source'} onClick={() => editor.current?.redo()}><Redo2 size={16} /></button></div>
            <div className="format-group"><button aria-label="插入标题" disabled={mode === 'source'} onClick={() => editor.current?.insertBlock('h2')}>H₂</button><button aria-label="加粗" disabled={mode === 'source'} onMouseDown={event => event.preventDefault()} onClick={() => editor.current?.toggleMark('bold')}><Bold size={16} /></button><button aria-label="斜体" disabled={mode === 'source'} onMouseDown={event => event.preventDefault()} onClick={() => editor.current?.toggleMark('italic')}><Italic size={16} /></button><button aria-label="插入列表" disabled={mode === 'source'} onClick={() => editor.current?.insertBlock('ul')}><List size={16} /></button><button aria-label="插入引用" disabled={mode === 'source'} onClick={() => editor.current?.insertBlock('blockquote')}><Quote size={16} /></button><button aria-label="行内代码" disabled={mode === 'source'} onMouseDown={event => event.preventDefault()} onClick={() => editor.current?.toggleMark('code')}><Code2 size={16} /></button></div>
            <button className="insert-media" disabled={mode === 'source'} onClick={() => mediaInput.current?.click()}><Plus size={15} />插入素材</button>
            {selected.length > 0 && <button className="selection-state" onClick={() => setSelected([])}>{selected.length} 段已选中<X size={13} /></button>}
          </>}
        </div>
        {error && <div className="editor-error" role="alert">{error}<button aria-label="关闭提示" onClick={() => setError('')}><X size={14} /></button></div>}
        <div id="document-content" className="document-scroll" tabIndex={-1}>
          {active.kind === 'text' ? <textarea className="source-editor plain-editor" aria-label="纯文本内容" value={String(active.value[0]?.children.map(child => 'text' in child ? child.text : '').join('') ?? '')} onChange={event => updateValue([{ id: 'plain', type: 'p', children: [{ text: event.target.value }] }])} />
            : mode === 'source' ? <textarea className="source-editor" aria-label="Markdown 源码" spellCheck={false} value={source} onChange={event => { setSource(event.target.value); setSourceDirty(true); }} />
            : <div className="document-paper"><PlateDocumentEditor key={activeId} ref={editor} value={active.value} onChange={updateValue} assets={assets} selectedBlockIds={selected} onSelectionChange={setSelected} renderAudio={asset => <SampleAudio asset={asset} />} /></div>}
        </div>
        <footer className="document-footer"><span>{mode === 'source' ? 'Markdown' : active.kind === 'text' ? 'TXT' : 'Markdown 文档'}</span>{drafts.length > 0 && <select aria-label="已有草稿" value={activeDraftId ?? ''} onChange={event => setActiveDraftId(event.target.value || null)}><option value="">草稿（{drafts.length}）</option>{drafts.map((draft, index) => <option key={draft.requestId} value={draft.requestId}>{index + 1} · {TARGET_LABELS[draft.target]}</option>)}</select>}<span>{selected.length ? `将转发选中的 ${selected.length} 段` : '转发整篇文档'}</span></footer>
      </main>
      {draft && <DraftPanel key={draft.requestId} draft={draft} onClose={() => setActiveDraftId(null)} onChange={next => setDrafts(previous => previous.map(draft => draft.requestId === next.requestId ? next : draft))} />}
    </div>
    {notice && <div className="toast" role="status">{notice}</div>}
    <input hidden ref={mediaInput} type="file" accept="image/*,audio/*,video/*" multiple onChange={addFiles} aria-label="选择媒体文件" />
    <input hidden ref={documentInput} type="file" accept=".md,.markdown,.txt" multiple onChange={openFiles} aria-label="选择文本文件" />
  </div>;
}
