import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Plus, RotateCcw, Save } from "lucide-react";
import type { Asset } from "../lib/types";
import type { DocumentMedia, DocumentValue } from "../lib/documentTypes";
import { api } from "../lib/api";
import { parseMarkdown, serializeMarkdown } from "../lib/documentCodec";
import { documentMedia, documentReferenceIds, textDocuments } from "../lib/textDocuments";
import { finishTextDocumentSave, getTextDocumentDraft, keepTextDocumentDraft, subscribeTextDocumentDraft, type TextDocumentDraft } from "../lib/textDocumentDrafts";
import { userErrorMessage } from "../lib/userError";
import { TextPlateEditor, type TextPlateHandle } from "./TextPlateEditor";
import "./TextDocumentEditor.css";

interface Props { asset: Asset; onSaved?(): void; onDirtyChange?(dirty: boolean): void }

export function TextDocumentEditor({ asset, onSaved, onDirtyChange }: Props) {
  return <DocumentSession key={`${asset.id}:${asset.store_path ?? asset.origin_path}`} asset={asset} onSaved={onSaved} onDirtyChange={onDirtyChange}/>;
}

function DocumentSession({ asset, onSaved, onDirtyChange }: Props) {
  const key = `${asset.id}:${asset.store_path ?? asset.origin_path ?? ""}`;
  const [draft, setDraft] = useState<TextDocumentDraft | null>(null);
  const [value, setValue] = useState<DocumentValue>([]);
  const [media, setMedia] = useState<DocumentMedia[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false), [inserting, setInserting] = useState(false);
  const current = useRef(draft), mounted = useRef(true), plate = useRef<TextPlateHandle>(null);
  const canonical = useRef("");
  const readEpoch = useRef(0), mediaEpoch = useRef(0);
  const dirty = !!draft && draft.text !== draft.base.text;

  function replace(next: TextDocumentDraft) {
    readEpoch.current++;
    current.current = next; setDraft(next);
    if (!keepTextDocumentDraft(key, next)) setNotice("草稿已保留在内存，请保存原文件后再退出应用。");
  }
  function hydrateMedia(nextValue: DocumentValue) {
    const ticket = ++mediaEpoch.current;
    void resolveMedia(documentReferenceIds(nextValue)).then(items => {
      if (mounted.current && ticket === mediaEpoch.current) setMedia(previous => [...previous.filter(item => !items.some(next => next.asset.id === item.asset.id)), ...items]);
    }).catch(() => { if (mounted.current && ticket === mediaEpoch.current) setNotice("部分参考素材暂不可用，原引用已保留。"); });
  }
  async function resolveMedia(ids: string[]) {
    if (!ids.length) return [];
    const assets = await api.getAssetsByIds(ids);
    return assets.map(documentMedia).filter((item): item is DocumentMedia => item !== null);
  }
  function loadDraft(next: TextDocumentDraft) {
    const nextValue = next.base.format === "markdown" ? parseMarkdown(next.text) : [];
    canonical.current = next.base.format === "markdown" ? serializeMarkdown(nextValue) : next.text;
    setValue(nextValue); replace(next);
    hydrateMedia(nextValue);
  }
  useEffect(() => {
    mounted.current = true;
    const ticket = ++readEpoch.current;
    const unsubscribe = subscribeTextDocumentDraft(key, next => {
      if (!mounted.current) return;
      if (current.current?.text !== next.text) loadDraft(next);
      else replace(next);
    });
    const cached = getTextDocumentDraft(key);
    if (cached) { loadDraft(cached); setNotice("已恢复未保存的草稿。"); }
    else void textDocuments.read(asset.id).then(base => {
      if (mounted.current && ticket === readEpoch.current) loadDraft({ base, text: base.text, mode: "body" });
    }).catch(reason => { if (mounted.current && ticket === readEpoch.current) setError(userErrorMessage(reason, "文本暂时无法打开，请检查文件后重试。")); });
    return () => { mounted.current = false; readEpoch.current++; mediaEpoch.current++; unsubscribe(); };
  }, [key, asset.id]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  function changeText(text: string) { if (current.current) replace({ ...current.current, text }); }
  function changeValue(next: DocumentValue) {
    setValue(next);
    const text = serializeMarkdown(next);
    if (text !== canonical.current) { canonical.current = text; changeText(text); }
  }
  function switchMode(mode: "body" | "source") {
    if (!draft || draft.mode === mode) return;
    try {
      if (mode === "body") {
        const next = parseMarkdown(draft.text); setValue(next); canonical.current = serializeMarkdown(next);
        hydrateMedia(next);
      }
      replace({ ...draft, mode }); setError("");
    } catch { setError("源码暂时无法转换，请检查格式；内容仍保留在编辑区。"); }
  }
  async function save() {
    const start = current.current;
    if (!start || saving || start.text === start.base.text) return;
    setSaving(true); setError("");
    try {
      const result = await textDocuments.save(asset.id, start.base.version, start.text);
      const next = finishTextDocumentSave(key, start, result);
      if (mounted.current && next) { current.current = next; setDraft(next); setNotice(next.text === next.base.text ? "已保存" : "已保存提交的内容，仍有新的更改。"); onSaved?.(); }
    } catch (reason) {
      if (mounted.current) setError(userErrorMessage(reason, "保存未完成，草稿已保留，请检查原文件后重试。"));
    } finally { if (mounted.current) setSaving(false); }
  }
  async function reload() {
    if (saving || (dirty && !window.confirm("重新读取会放弃当前未保存的更改，是否继续？"))) return;
    const ticket = ++readEpoch.current;
    try { const base = await textDocuments.read(asset.id); if (mounted.current && ticket === readEpoch.current) { loadDraft({ base, text: base.text, mode: draft?.mode ?? "body" }); setError(""); setNotice(""); } }
    catch (reason) { if (mounted.current && ticket === readEpoch.current) setError(userErrorMessage(reason, "原文件暂时无法读取，请稍后重试。")); }
  }
  async function attachAssets(ids: string[]): Promise<DocumentMedia[]> {
    try { const items = await resolveMedia(ids); if (!mounted.current) return []; setMedia(previous => [...previous.filter(item => !items.some(next => next.asset.id === item.asset.id)), ...items]); return items; }
    catch (reason) { if (mounted.current) setError(userErrorMessage(reason, "素材暂时无法插入，请重试。")); return []; }
  }
  async function insertFiles() {
    if (inserting) return;
    setInserting(true);
    try {
      const selected = await open({ multiple: true, directory: false, filters: [{ name: "图片、音频和视频", extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "wav", "mp3", "flac", "m4a", "ogg", "mp4", "mov", "webm", "m4v", "mkv"] }] });
      if (!selected || !mounted.current) return;
      const paths = typeof selected === "string" ? [selected] : selected;
      const inserted = await api.importFiles(paths);
      if (!mounted.current) return;
      const items = await attachAssets(inserted.map(item => item.id));
      if (mounted.current) plate.current?.insertMedia(items);
    } catch (reason) { if (mounted.current) setError(userErrorMessage(reason, "素材暂时无法插入，请检查原文件后重试。")); }
    finally { if (mounted.current) setInserting(false); }
  }

  return <section className="text-document-editor" data-text-document-editor onKeyDown={event => {
    event.stopPropagation();
    if (!event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
  }}>
    <div className="text-document-toolbar">
      {draft?.base.format === "markdown" && <div className="text-document-modes"><button aria-pressed={draft.mode === "body"} onClick={() => switchMode("body")}>正文</button><button aria-pressed={draft.mode === "source"} onClick={() => switchMode("source")}>源码</button></div>}
      {draft?.base.format === "markdown" && <button title="插入已有素材的原文件引用" disabled={draft.mode !== "body" || inserting} onClick={() => void insertFiles()}><Plus size={14}/>插入素材</button>}
      <span className="text-document-save-state">{dirty ? "未保存" : ""}</span>
      <button aria-label="重新读取原文件" title="重新读取原文件" disabled={saving} onClick={() => void reload()}><RotateCcw size={14}/></button>
      <button disabled={!dirty || saving} onClick={() => void save()}><Save size={14}/>{saving ? "保存中…" : "保存"}</button>
    </div>
    {error && <div className="text-document-error" role="alert">{error}</div>}
    {notice && <div className="text-document-notice" role="status">{notice}</div>}
    {!draft ? <div className="text-document-loading">{error ? "" : "正在读取文本…"}</div> : draft.base.format === "text" ? <textarea className="text-document-source is-plain" aria-label="文本内容" value={draft.text} onChange={event => changeText(event.target.value)} />
      : draft.mode === "source" ? <textarea className="text-document-source" aria-label="Markdown 源码" value={draft.text} spellCheck={false} onChange={event => changeText(event.target.value)} />
      : <TextPlateEditor ref={plate} value={value} media={media} onChange={changeValue} onDropAssets={attachAssets} onRejectedPaste={() => setNotice("请使用插入素材选择原文件，已有文件只建立引用。")} />}
  </section>;
}
