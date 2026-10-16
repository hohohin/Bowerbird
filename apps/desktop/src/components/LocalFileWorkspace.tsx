import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, ArrowUp, Folder, FolderOpen, Image, Play, RefreshCw, X } from "lucide-react";
import { externalFiles, type LocalDirectory, type LocalFileEntry } from "../lib/externalFiles";
import { folderClassification, type FolderClassification } from "../lib/folderClassification";
import { useLocalFileMode } from "../lib/localFileMode";
import { useMasonryLayout } from "../lib/useMasonryLayout";
import { useThumbnailPinch } from "../lib/useThumbnailPinch";
import { isVideoPath } from "../lib/videoGeneration";
import { prepareExplorerCanvasDrop } from "../lib/explorerCanvasDrop";
import { useStore } from "../store";
import { notifyError, notifySuccess } from "../lib/notify";
import { Lightbox } from "./Lightbox";
import { LocalClassificationDialog } from "./LocalClassificationDialog";
import { LocalFileBrowser } from "./LocalFileBrowser";
import { ModalShell } from "./ModalShell";
import { ThumbnailSizeSlider } from "./ThumbnailSizeSlider";
import "./LocalFileWorkspace.css";

const KEY = "bowerbird.localFiles.lastDirectory";
function lastPath() { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } }
function normalize(path: string) { return path.replace(/^\\\\\?\\UNC\\/i, "//").replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/$/, ""); }
function relative(root: string, path: string) {
  const base = normalize(root); const file = normalize(path);
  return file.startsWith(base + "/") ? file.slice(base.length + 1) : null;
}

function FileCard({ entry, selected, revision, labels, onSelect, onOpen }: {
  entry: LocalFileEntry; selected: boolean; revision: number; labels: string[];
  onSelect: (additive: boolean, range: boolean) => void; onOpen: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (entry.directory) return;
    let alive = true; setPreview(null);
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return;
      observer.disconnect();
      void externalFiles.preview(entry.path).then(path => { if (alive) setPreview(path); }).catch(() => {});
    }, { rootMargin: "120px" });
    if (ref.current) observer.observe(ref.current);
    return () => { alive = false; observer.disconnect(); };
  }, [entry.path, entry.directory, revision]);
  return <button ref={ref} type="button" className={`folder-media-card${selected ? " is-selected" : ""}`} aria-pressed={selected}
    aria-label={entry.directory ? `文件夹 ${entry.name}` : entry.name} title={entry.name}
    onClick={e => onSelect(e.ctrlKey || e.metaKey, e.shiftKey)} onDoubleClick={onOpen}
    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); onOpen(); } }}>
    <span className={`folder-media-preview${entry.directory ? " is-folder" : ""}`}>
      {entry.directory ? <Folder size={52} strokeWidth={1.3} /> : preview ? <img src={convertFileSrc(preview)} alt="" draggable={false} loading="lazy" /> : isVideoPath(entry.path) ? <Play size={32} /> : <Image size={32} />}
      {!entry.directory && isVideoPath(entry.path) && <span className="folder-media-kind"><Play size={11} />视频</span>}
    </span>
    <span className="folder-media-name">{entry.name}</span>
    {!!labels.length && <span className="folder-media-labels">{labels.map(name => `#${name}`).join(" · ")}</span>}
  </button>;
}

export function LocalFileWorkspace({ onClose, onCreateProject }: { onClose: () => void; onCreateProject: () => Promise<unknown> }) {
  const [directory, setDirectory] = useState<LocalDirectory | null>(null);
  const [pathInput, setPathInput] = useState(lastPath);
  const [history, setHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [classification, setClassification] = useState<FolderClassification | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [classifyOpen, setClassifyOpen] = useState(false);
  const [referencesOpen, setReferencesOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const busyRef = useRef(false);
  const sequence = useRef(0);
  const previewSequence = useRef(0);
  const alive = useRef(true);
  const [grid, setGrid] = useState<HTMLDivElement | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const query = useLocalFileMode(s => s.query);
  const width = useStore(s => s.libraryThumbnailWidth);
  const project = useStore(s => s.activeProjectId);
  const pinchRef = useThumbnailPinch("library");
  const pictures = useMemo(() => new Map(classification?.record.pictures.map(p => [p.path, p]) ?? []), [classification]);
  const labelNames = useMemo(() => new Map(classification?.record.labels.map(l => [l.id,l.name]) ?? []), [classification]);
  const entries = useMemo(() => (directory?.entries ?? []).filter(entry => {
    if (query && !entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) return false;
    if (!tag) return true;
    const path = classification && relative(classification.root, entry.path);
    return !entry.directory && !!path && !!pictures.get(path)?.tags.some(([id]) => id === tag);
  }), [directory, query, tag, classification, pictures]);
  useMasonryLayout(grid, width, entries);

  async function navigate(path?: string, back = false) {
    const version = ++sequence.current; ++previewSequence.current;
    setLoading(true); setError(""); setPreview(null); setSelected(new Set()); anchor.current = null;
    try {
      // One enumeration includes the whole current level; previews remain lazy.
      const result = await externalFiles.browseAll(path);
      if (!alive.current || version !== sequence.current) return;
      if (back) setHistory(h => h.slice(0,-1));
      else if (directory && directory.path !== result.path) setHistory(h => [...h,directory.path]);
      setDirectory(result); setPathInput(result.path); setTag(null); setClassification(null); setRevision(r => r+1);
      if (scroll.current) scroll.current.scrollTop = 0;
      try { localStorage.setItem(KEY,result.path); } catch { /* Session browsing remains available. */ }
      try {
        const next = await folderClassification.view(result.path);
        if (alive.current && version === sequence.current) setClassification(next);
      } catch (e) { if (alive.current && version === sequence.current) setError(String(e)); }
    } catch (e) { if (alive.current && version === sequence.current) setError(`无法打开文件夹：${String(e)}`); }
    finally { if (alive.current && version === sequence.current) setLoading(false); }
  }
  useEffect(() => {
    alive.current = true; void navigate(lastPath() || undefined);
    return () => { alive.current = false; sequence.current++; previewSequence.current++; };
  }, []);
  useEffect(() => {
    if (!directory || classifyOpen) return;
    let current = true;
    const reload = () => folderClassification.view(directory.path).then(value => {
      if (current) { setClassification(value); setTag(id => value.record.labels.some(l => l.id === id) ? id : null); }
    }).catch(() => {});
    void reload(); const timer = window.setInterval(() => void reload(), 3000);
    return () => { current = false; window.clearInterval(timer); };
  }, [directory?.path, classifyOpen]);
  async function choose() {
    try { const path = await open({ directory: true, multiple: false, defaultPath: directory?.path }); if (typeof path === "string") void navigate(path); }
    catch (e) { setError(String(e)); }
  }
  async function openEntry(entry: LocalFileEntry) {
    if (entry.directory) { void navigate(entry.path); return; }
    const version = ++previewSequence.current;
    try { const path = await externalFiles.media(entry.path); if (alive.current && version === previewSequence.current) setPreview(path); }
    catch (e) { if (alive.current && version === previewSequence.current) setError(String(e)); }
  }
  async function useSelected(copy: boolean) {
    if (busyRef.current) return;
    const files = (directory?.entries ?? []).filter(e => !e.directory && selected.has(e.path));
    if (!files.length) return;
    const destinationProject = useStore.getState().activeProjectId;
    busyRef.current = true; setWorking(true); setError("");
    try {
      const assets = [];
      for (const file of files) { const asset = await externalFiles.index(file.path); assets.push(copy ? await externalFiles.copy(asset.id) : asset); }
      if (!copy) {
        if (useStore.getState().activeProjectId !== destinationProject) throw new Error("项目已切换，请重新选择目标画板");
        if (!destinationProject) await onCreateProject();
        const id = useStore.getState().activeProjectId;
        if (!id) throw new Error("请先打开项目画板");
        onClose();
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const stage = document.querySelector<HTMLElement>(".canvas-stage:not(.is-view-hidden)");
        if (!stage) throw new Error("画板尚未就绪，请重试");
        const rect = stage.getBoundingClientRect();
        for (let i=0;i<assets.length;i++) {
          const put = prepareExplorerCanvasDrop(stage,id,rect.left+rect.width/2+i*24,rect.top+rect.height/2+i*24);
          if (!put) throw new Error("画板已切换，请重试");
          await put(assets[i]);
        }
      }
      notifySuccess(copy ? "已复制到素材库，原文件保留" : "已添加到画板，引用原文件");
    } catch (e) { notifyError(e,"处理所选文件失败"); }
    finally { busyRef.current = false; if (alive.current) setWorking(false); }
  }
  const selectedFiles = useMemo(() => new Set([...selected].flatMap(path => {
    const key = classification && relative(classification.root,path); const picture = key && pictures.get(key); return picture ? [picture.id] : [];
  })), [selected, classification, pictures]);
  const mediaSelected = directory?.entries.some(e => !e.directory && selected.has(e.path));
  return <section className="local-file-workspace" aria-label="本机文件" ref={pinchRef} aria-busy={loading}
    onKeyDown={e => {
      if (e.target instanceof Element && e.target.closest('input,textarea,[contenteditable="true"],[role="dialog"]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); e.stopPropagation(); setSelected(new Set(entries.map(entry => entry.path))); }
      if (e.altKey && e.key === "ArrowUp" && directory?.parent) { e.preventDefault(); void navigate(directory.parent); }
    }}>
    <div className="folder-navigation">
      <button aria-label="返回上次目录" title="返回" disabled={!history.length || loading} onClick={() => void navigate(history[history.length-1],true)}><ArrowLeft size={17}/></button>
      <button aria-label="上一级" title="上一级" disabled={!directory?.parent || loading} onClick={() => void navigate(directory?.parent ?? undefined)}><ArrowUp size={17}/></button>
      <button aria-label="选择文件夹" title="选择文件夹" onClick={() => void choose()}><FolderOpen size={17}/></button>
      <form onSubmit={e => {e.preventDefault();void navigate(pathInput.trim());}}><input aria-label="文件夹路径" placeholder="输入文件夹路径，按回车打开" value={pathInput} onChange={e => setPathInput(e.target.value)}/></form>
      <button aria-label="刷新文件夹" title="刷新" disabled={loading} onClick={() => void navigate(directory?.path)}><RefreshCw size={16}/></button>
      <button className="folder-return" onClick={onClose}><X size={15}/>{project ? "返回画板" : "返回素材库"}</button>
    </div>
    <div className="folder-scope-bar">
      <span>本机文件 · {directory?.entries.length ?? 0} 项 · 浏览不入库</span>
      <button disabled={!directory || loading} onClick={() => setClassifyOpen(true)}>自动分类此文件夹</button>
      <button onClick={() => setReferencesOpen(true)}>外部引用</button>
      <button disabled={!mediaSelected || working || loading} onClick={() => void useSelected(false)}>{project ? "添加到画板" : "新建画板并引用"}</button>
      <button disabled={!mediaSelected || working || loading} onClick={() => void useSelected(true)}>复制到素材库</button>
    </div>
    {classification && classification.record.labels.length > 0 && <div className="folder-tag-bar" aria-label="文件夹分类标签">
      <span title={classification.root}>分类范围：{normalize(classification.root).split("/").pop()}</span>
      <button aria-pressed={!tag} onClick={() => setTag(null)}>全部</button>
      {classification.record.labels.map(label => <button key={label.id} aria-pressed={tag===label.id} onClick={() => setTag(tag===label.id ? null : label.id)}>#{label.name}</button>)}
    </div>}
    {error && <p role="alert" className="folder-error">{error}</p>}
    <div ref={scroll} className="folder-scroller library-scroller">
      {loading && <p role="status">正在读取文件夹…</p>}
      {!loading && !entries.length && <p className="folder-empty">{query || tag ? "当前目录没有匹配的媒体。" : "此文件夹没有支持的图片、视频或子文件夹。"}</p>}
      <div ref={setGrid} className="folder-masonry" aria-label="目录内容">
        {entries.map(entry => <FileCard key={entry.path} entry={entry} selected={selected.has(entry.path)} revision={revision}
          labels={((classification && pictures.get(relative(classification.root,entry.path) ?? "")) || null)?.tags.map(([id]) => labelNames.get(id) ?? "").filter(Boolean) ?? []}
          onSelect={(additive, range) => {
            const start = entries.findIndex(item => item.path === anchor.current);
            if (range && start >= 0) { const end = entries.indexOf(entry); setSelected(new Set(entries.slice(Math.min(start,end),Math.max(start,end)+1).map(item => item.path))); }
            else { anchor.current = entry.path; setSelected(previous => { const next = new Set(additive ? previous : []); if (additive && next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; }); }
          }}
          onOpen={() => { if (!loading) void openEntry(entry); }} />)}
      </div>
    </div>
    <ThumbnailSizeSlider scope="library"/>
    {preview && <Lightbox images={[preview]} index={0} onIndexChange={() => {}} onClose={() => { ++previewSequence.current; setPreview(null); }}/>}
    {classifyOpen && directory && <LocalClassificationDialog folder={{ root: classification?.root ?? directory.path, recursive: classification?.record.recursive ?? false }} selectedFiles={selectedFiles}
      onFilter={setTag} onClose={() => setClassifyOpen(false)}/>}
    {referencesOpen && <ModalShell title="外部引用" width="lg" onClose={() => setReferencesOpen(false)}><LocalFileBrowser initialTab="references" onClose={() => setReferencesOpen(false)} onCreateProject={() => void onCreateProject()}/></ModalShell>}
  </section>;
}
