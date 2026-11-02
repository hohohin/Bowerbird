// Isolated visual proposal. Only the existing Plate editor and document codec are production components.
// Collections, projects, composer and wires below are browser-local examples; no native IPC or model calls.
import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowLeft, ArrowUp, Check, ChevronDown, FileText, Folder, Image, Maximize2, Moon, PanelLeft, Plus, Search, Sun, X } from 'lucide-react';
import { TextPlateEditor, type TextPlateHandle } from '../../../src/components/TextPlateEditor';
import { parseMarkdown, serializeMarkdown } from '../../../src/lib/documentCodec';
import type { DocumentBlock, DocumentMedia, DocumentValue } from '../../../src/lib/documentTypes';
import '../../../src/components/TextDocumentEditor.css';
import '../../../src/components/IndustrialTheme.css';
import './preview.css';

const samples = Object.entries(import.meta.glob('../../../src-tauri/resources/samples/preset-*.webp', { eager: true, query: '?url', import: 'default' })).sort(([a], [b]) => a.localeCompare(b));
const media: DocumentMedia[] = samples.slice(0, 8).map(([path, url], index) => ({
  asset: { id: `review-image-${index}`, name: `画面参考 ${String(index + 1).padStart(2, '0')}`, ext: 'webp' }, kind: 'image', path, url: url as string,
}));
const initial = parseMarkdown('# 一封写给秋天的信\n\n## 01  开场 · 清晨\n\n窗外的光落在桌面上。她打开一本旧书，一张夹在书页里的车票滑落。\n\n**镜头**：从纸张的纹理缓慢拉远，露出窗边的人物。自然侧光，保留细微颗粒。\n\n> “有些地方，我们离开之后，才开始抵达。”\n\n## 02  转场 · 在路上\n\n- 远景：列车穿过秋天的山谷。\n- 特写：指尖轻触起雾的车窗。\n- 留白：风声，车轮声，没有配乐。\n\n');
initial.splice(4, 0, { id: 'opening-image', type: 'img', assetId: media[3].asset.id, sourcePath: media[3].path, caption: '人物与气氛参考', children: [{ text: '' }] });
type View = 'composer' | 'editor' | 'canvas';
type Saved = { id: string; title: string; value: DocumentValue; destination: string };
type Port = 'image' | 'text';
const clone = <T,>(value: T): T => structuredClone(value);
function Inline({ block }: { block: DocumentBlock }) {
  return <>{block.children.map((child, index) => {
    let text: ReactNode = typeof child.text === 'string' ? child.text : <Inline block={child as DocumentBlock} />;
    if (child.bold) text = <strong>{text}</strong>;
    if (child.italic) text = <em>{text}</em>;
    return <React.Fragment key={index}>{text}</React.Fragment>;
  })}</>;
}
function ReadDocument({ value }: { value: DocumentValue }) {
  return <div className="read-document">{value.map(block => {
    if (block.type === 'img') { const item = media.find(item => item.asset.id === block.assetId); return item && <figure key={block.id}><img src={item.url} alt={block.caption || item.asset.name} />{block.caption && <figcaption>{block.caption}</figcaption>}</figure>; }
    const Tag = /^h[1-6]$/.test(block.type) ? block.type as 'h1' : block.type === 'blockquote' ? 'blockquote' : 'p';
    return <Tag key={block.id} className={block.listStyleType ? 'list-item' : undefined}><Inline block={block} /></Tag>;
  })}</div>;
}
function App() {
  const [view, setView] = useState<View>(new URLSearchParams(location.search).get('view') === 'composer' ? 'composer' : 'editor');
  const [origin, setOrigin] = useState<View>('composer');
  const [value, setValue] = useState<DocumentValue>(() => clone(initial));
  const [composer, setComposer] = useState<DocumentValue>(() => clone(initial));
  const [title, setTitle] = useState('一封写给秋天的信');
  const [library, setLibrary] = useState(true);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'body' | 'source'>('body');
  const [source, setSource] = useState('');
  const [theme, setTheme] = useState('dark');
  const [menu, setMenu] = useState<'collection' | 'project' | null>(null);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [card, setCard] = useState<Saved>({ id: 'example-card', title: '一封写给秋天的信', value: clone(initial), destination: '秋日短片' });
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<Port | null>(null);
  const [connected, setConnected] = useState({ image: false, text: false });
  const [inspect, setInspect] = useState(false);
  const [composerMode, setComposerMode] = useState('图片');
  const [wires, setWires] = useState<Record<Port, string>>({ image: '', text: '' });
  const stage = useRef<HTMLDivElement>(null);
  const plate = useRef<TextPlateHandle>(null);
  const outputButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 4200); return () => clearTimeout(timer); }, [notice]);
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const update = () => {
      const bounds = element.getBoundingClientRect();
      const paths = { image: '', text: '' };
      for (const port of ['image', 'text'] as const) {
        const start = element.querySelector(`.output.${port} i`)!.getBoundingClientRect();
        const end = element.querySelector(`.input.${port} i`)!.getBoundingClientRect();
        const x1 = start.x + start.width / 2 - bounds.x, y1 = start.y + start.height / 2 - bounds.y;
        const x2 = end.x + end.width / 2 - bounds.x, y2 = end.y + end.height / 2 - bounds.y;
        paths[port] = `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`;
      }
      setWires(paths);
    };
    update(); const observer = new ResizeObserver(update); observer.observe(element);
    return () => observer.disconnect();
  }, [view]);
  const current = () => mode === 'source' ? parseMarkdown(source) : value;
  function openEditor(from: View, next: DocumentValue) { setOrigin(from); setValue(clone(next)); setMode('body'); setView('editor'); setMenu(null); }
  function leaveEditor() { const next = current(); setValue(next); if (origin === 'canvas') setCard(previous => ({ ...previous, title, value: clone(next) })); setView(origin); }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (inspect) { setInspect(false); outputButton.current?.focus(); }
      else if (menu) setMenu(null);
      else if (pending) setPending(null);
      else if (view === 'editor') leaveEditor();
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });
  function insert(item: DocumentMedia) { if (mode === 'source') { setNotice('切换到正文后插入素材'); return; } plate.current?.insertMedia([item]); }
  function save(destination: string) {
    const next = { id: crypto.randomUUID(), title: title.trim() || '未命名文本', value: clone(current()), destination };
    if (menu === 'collection') setSaved(previous => [...previous, next]);
    else { setCard(next); setConnected({ image: false, text: false }); }
    setNotice(`已保存到示例${menu === 'collection' ? '集合' : '项目'}「${destination}」`); setMenu(null);
  }
  function fillComposer() { setComposer(clone(current())); setValue(current()); setView('composer'); setNotice('已添加到生成对话框'); }
  const cardImages = card.value.filter(block => block.type === 'img').map(block => media.find(item => item.asset.id === block.assetId)).filter((item): item is DocumentMedia => Boolean(item));
  const visibleMedia = media.filter(item => item.asset.name.includes(query));
  return <div className="review-app">
    <div className="review-strip"><span>交互预览 · 示例数据</span><nav aria-label="预览页面">{(['composer', 'editor', 'canvas'] as View[]).map((item, index) => <button key={item} aria-pressed={view === item} onClick={() => { if (view === 'editor') setValue(current()); setView(item); setMenu(null); }}>{['对话框', '文本编辑器', '画板'][index]}</button>)}</nav><button title="切换主题" aria-label="切换主题" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}</button></div>
    {view === 'editor' ? <>
      <header className="editor-header"><div className="document-name"><button className="icon" title="返回" aria-label="返回" onClick={leaveEditor}><ArrowLeft size={18}/></button><FileText size={17}/><input aria-label="文档名称" value={title} onChange={event => setTitle(event.target.value)} /></div>
        <div className="document-actions">
          {(['collection', 'project'] as const).map(kind => <div className="action-wrap" key={kind}><button aria-expanded={menu === kind} onClick={() => setMenu(menu === kind ? null : kind)}>{kind === 'collection' ? '保存到集合' : '保存到项目'}<ChevronDown size={12}/></button>
            {menu === kind && <div className="destination-menu" role="group" aria-label={kind === 'collection' ? '选择集合' : '选择项目'}>{(kind === 'collection' ? ['创作笔记', '常用提示词', '分镜脚本'] : ['秋日短片', '产品摄影']).map(destination => <button key={destination} onClick={() => save(destination)}><Folder size={15}/>{destination}</button>)}</div>}</div>)}
          <button className="primary" onClick={fillComposer}>添加到生成对话框<ArrowUp size={14}/></button>
        </div>
      </header>
      <div className={`editor-layout ${library ? '' : 'library-closed'}`}>
        {library && <aside className="material-library" aria-label="素材库"><div className="library-title"><span>素材库</span><button className="icon" aria-label="收起素材库" title="收起素材库" onClick={() => setLibrary(false)}><PanelLeft size={16}/></button></div><label className="search"><Search size={14}/><input aria-label="搜索素材" placeholder="搜索素材" value={query} onChange={event => setQuery(event.target.value)}/></label>
          <div className="library-scroll"><div className="collection-heading"><Folder size={14}/>画面参考<span>{visibleMedia.length}</span></div><div className="asset-grid">{visibleMedia.map(item => <button key={item.asset.id} className="asset" title={`双击插入${item.asset.name}`} aria-label={`插入${item.asset.name}`} onMouseDown={event => event.preventDefault()} onDoubleClick={() => insert(item)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); insert(item); } }}><img src={item.url} alt={item.asset.name}/><span>{item.asset.name}</span></button>)}</div>
          {saved.length > 0 && <><div className="collection-heading"><Folder size={14}/>创作文本<span>{saved.length}</span></div>{saved.map(item => <button className="saved-document" key={item.id} onClick={() => { setTitle(item.title); setValue(clone(item.value)); setMode('body'); }}><FileText size={17}/>{item.title}</button>)}</>}</div>
        </aside>}
        <main className="writing-surface"><div className="writing-controls">{!library && <button className="icon" aria-label="打开素材库" title="打开素材库" onMouseDown={event => event.preventDefault()} onClick={() => setLibrary(true)}><PanelLeft size={16}/></button>}<div className="mode-switch"><button aria-pressed={mode === 'body'} onClick={() => { if (mode === 'source') setValue(parseMarkdown(source)); setMode('body'); }}>正文</button><button aria-pressed={mode === 'source'} onClick={() => { if (mode === 'body') setSource(serializeMarkdown(value)); setMode('source'); }}>源码</button></div></div>
          <section className="text-document-editor">{mode === 'body' ? <TextPlateEditor ref={plate} value={value} media={media} onChange={setValue} onDropAssets={async ids => media.filter(item => ids.includes(item.asset.id))} onRejectedPaste={() => setNotice('从左侧素材库插入图片')} /> : <textarea className="text-document-source" aria-label="Markdown 源码" value={source} onChange={event => setSource(event.target.value)} spellCheck={false}/>}</section>
        </main>
      </div>
    </> : view === 'composer' ? <main className="composer-scene"><div className="workspace-heading"><Folder size={18}/>秋日短片</div><div className="composer-blank"><div className="blank-mark"/><FileText size={34}/></div><section className="composer-shell"><div className="composer-top"><div>{['图片', '视频', '对话'].map(item => <button key={item} aria-pressed={composerMode === item} onClick={() => setComposerMode(item)}>{item}</button>)}</div><button className="icon expand" title="放大编辑" aria-label="放大编辑" onClick={() => openEditor('composer', value)}><Maximize2 size={17}/></button></div><div className="composer-body" onDoubleClick={() => openEditor('composer', value)}><ReadDocument value={composer}/></div><div className="composer-bottom"><button className="icon" aria-label="添加素材" onClick={() => { setLibrary(true); openEditor('composer', value); }}><Plus size={18}/></button><span>{composerMode === '图片' ? 'Seedream 5.0' : composerMode === '视频' ? 'Seedance 2.5' : 'Codex'}<ChevronDown size={12}/></span><button className="send icon" aria-label="发送" onClick={() => setNotice('此预览不提交生成任务')}><ArrowUp size={17}/></button></div></section></main>
    : <main className="canvas-scene"><div className="workspace-heading"><Folder size={18}/>{card.destination}<button className="add-text" onClick={() => { setTitle('未命名文本'); openEditor('canvas', parseMarkdown('')); }}><Plus size={15}/><FileText size={15}/>文本</button></div>
      <div className="canvas-stage" ref={stage}><svg className="wires" aria-hidden="true">{connected.image && <path className="image-wire" d={wires.image}/>}{connected.text && <path className="text-wire" d={wires.text}/>}</svg>
        <article className="node text-node"><div className="node-title"><FileText size={16}/><span>{card.title}</span><button className="icon" aria-label="编辑文本卡片" title="放大编辑" onClick={() => { setTitle(card.title); openEditor('canvas', card.value); }}><Maximize2 size={15}/></button></div><div className="card-document" onDoubleClick={() => { setTitle(card.title); openEditor('canvas', card.value); }}><ReadDocument value={card.value}/></div>
          {(['image', 'text'] as Port[]).map((port, index) => <button key={port} className={`port output ${port} ${pending === port ? 'pending' : ''}`} style={{ top: 70 + index * 48 }} aria-label={`${port === 'image' ? '图片' : '文本'}输出`} aria-pressed={pending === port} title="点击输出，再点击生成卡片的对应输入；右键断开" onClick={() => setPending(port)} onContextMenu={event => { event.preventDefault(); setConnected(previous => ({ ...previous, [port]: false })); }}><span>{port === 'image' ? '图片' : '文本'}</span><i/></button>)}
        </article>
        <article className="node generation-node"><div className="node-title"><Image size={16}/><span>生成图片</span></div><div className="generation-parameters">Seedream 5.0<span>16:9</span></div><div className="generation-prompt">{connected.text && <span className="reference-chip"><FileText size={12}/>文本 1</span>}{connected.image && <span className="reference-chip"><Image size={12}/>图片 1</span>}根据剧本与参考图片，生成开场的第一个镜头。</div><div className="linked-input">{connected.text && <span><FileText size={14}/>{card.title}</span>}{connected.image && <div className="linked-images">{cardImages.map((item, index) => <img key={`${item.asset.id}-${index}`} src={item.url} alt={item.asset.name}/>)}</div>}{(connected.image || connected.text) && <button ref={outputButton} onClick={() => setInspect(true)}>查看输入</button>}</div><div className="node-footer"><span>1 张</span><button className="icon" aria-label="运行生成卡片" onClick={() => setNotice('此预览不提交生成任务')}><ArrowUp size={16}/></button></div>
          {(['image', 'text'] as Port[]).map((port, index) => <button key={port} className={`port input ${port} ${connected[port] ? 'connected' : ''}`} style={{ top: 70 + index * 48 }} aria-label={`${port === 'image' ? '图片' : '文本'}输入`} title="连接对应类型输出" onClick={() => { if (pending === port) { setConnected(previous => ({ ...previous, [port]: true })); setPending(null); } else setNotice(pending ? '请选择相同类型的输入口' : '先选择文本卡片的输出口'); }}><i/><span>{port === 'image' ? '图片' : '文本'}</span></button>)}
        </article>
      </div>
    </main>}
    {notice && <div className="notice" role="status"><Check size={15}/>{notice}</div>}
    {inspect && <div className="inspect-backdrop" onClick={() => { setInspect(false); outputButton.current?.focus(); }}><section className="inspect-panel" role="dialog" aria-modal="true" aria-label="生成卡片输入" onClick={event => event.stopPropagation()}><header><span>生成卡片输入</span><button autoFocus className="icon" aria-label="关闭输入预览" onClick={() => { setInspect(false); outputButton.current?.focus(); }} onKeyDown={event => { if (event.key === 'Tab') event.preventDefault(); }}><X size={17}/></button></header>{connected.text && <ReadDocument value={card.value}/>}<div className="inspect-images">{connected.image && !connected.text && cardImages.map((item, index) => <img key={index} src={item.url} alt={item.asset.name}/>)}</div></section></div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
