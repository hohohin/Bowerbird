import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, Image, Palette, Plus } from "lucide-react";
import { api } from "../lib/api";
import type { Asset, Folder } from "../lib/types";
import { ModalShell } from "./ModalShell";
import { MediaPreview } from "./MediaPreview";
import { useStore } from "../store";
import { notifyError, notifySuccess } from "../lib/notify";
import { CollectionScrollArea } from "./CollectionScrollArea";

/** 集合独立浏览，不写入首页素材、筛选或选中状态。 */
export function CollectionPanel({ folder, onClose }: { folder: Folder; onClose: () => void }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const preview = assets.find((asset) => asset.id === previewId);
  const [starting, setStarting] = useState(false);
  const [importing, setImporting] = useState(false);
  const importingRef = useRef(false);
  const [dragOver, setDragOver] = useState(false);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const busy = starting || importing;

  async function importFiles(files: File[], source: "clipboard" | "imported") {
    if (importingRef.current || starting || files.length === 0) return;
    importingRef.current = true;
    setImporting(true);
    setImportErrors([]);
    const failures: string[] = [];
    let imported = 0;
    for (const file of files) {
      let ingested = false;
      try {
        if (file.size > 50 * 1024 * 1024) throw new Error("图片不能超过 50 MB");
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error ?? new Error("无法读取文件"));
          reader.readAsDataURL(file);
        });
        const asset = await api.importImageBytes({ dataUrl, fileName: file.name || "clipboard.png", projectId: null, source });
        ingested = true;
        await api.moveAssetsToFolder([asset.id], folder.id);
        imported += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : typeof error === "string" ? error : "请重试";
        failures.push(`${file.name || "剪贴板图片"}：${ingested ? "已入素材库，但加入集合失败，" : "导入失败，"}${reason}`);
      }
    }
    importingRef.current = false;
    setImporting(false);
    setImportErrors(failures);
    setPreviewId(null);
    setRetry((value) => value + 1);
    if (imported) notifySuccess(`已导入 ${imported} 张素材到「${folder.name}」`);
  }
  function openProfile() {
    onClose();
    useStore.getState().openVisualProfile({ id: folder.id, name: folder.name });
  }
  async function addAssets() {
    setStarting(true);
    try {
      await useStore.getState().beginCollectionAdd(folder.id);
    } catch (error) {
      notifyError(error, "无法开始添加素材");
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    let alive = true;
    let revision = 0;
    let unlisten: (() => void) | undefined;
    async function refresh() {
      const request = ++revision;
      setLoading(true);
      setError(false);
      try {
        const result = await api.listLibraryView({ folderId: folder.id });
        if (alive && request === revision) setAssets(result.assets);
      } catch {
        if (alive && request === revision) setError(true);
      } finally {
        if (alive && request === revision) setLoading(false);
      }
    }
    void refresh();
    void listen("library://assets-changed", () => void refresh()).then((cleanup) => {
      if (alive) unlisten = cleanup;
      else cleanup();
    }).catch((error) => console.error("collection listener failed", error));
    return () => { alive = false; unlisten?.(); };
  }, [folder.id, retry]);

  return <ModalShell title={folder.name} width="lg" className={`collection-panel${dragOver ? " is-drag-over" : ""}`}
    preventClose={busy}
    panelProps={{
      onPasteCapture: (event) => {
        const target = event.target;
        if (target instanceof HTMLElement && target.closest('input, textarea, [contenteditable="true"]')) return;
        const files = Array.from(event.clipboardData.files);
        if (files.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        void importFiles(files, "clipboard");
      },
      onDragOver: (event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = busy ? "none" : "copy";
        if (!busy) setDragOver(true);
      },
      onDragLeave: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false);
      },
      onDrop: (event) => {
        event.preventDefault();
        event.stopPropagation();
        setDragOver(false);
        void importFiles(Array.from(event.dataTransfer.files), "imported");
      },
    }}
    headerActions={<>
      <span className="collection-import-hint">支持粘贴图片或拖入文件</span>
      <button type="button" className="collection-add-button" disabled={busy} onClick={() => void addAssets()}>
      <Plus size={14} />添加素材
    </button></>}
    description={<span className="flex items-center gap-2.5">
      <span>{importing ? "正在导入…" : loading ? "正在加载素材…" : error ? "素材加载失败" : `${assets.length} 张素材`}</span>
      <button type="button" className="collection-profile-button text-ink" disabled={busy} onClick={openProfile}><Palette size={14} />提炼视觉规范</button>
    </span>}
    onClose={onClose}>
    <CollectionScrollArea>
    {dragOver && <p className="collection-drop-hint" role="status">松手导入到「{folder.name}」</p>}
    {importErrors.length > 0 && <div role="alert" className="mb-3 text-xs text-red-500">
      {importErrors.map((message, index) => <p key={index}>{message}</p>)}
    </div>}
    {loading ? <p role="status" className="py-12 text-center text-sm text-muted">正在加载素材…</p>
      : error ? <div role="alert" className="py-12 text-center text-sm text-muted">
        <p>暂时无法加载集合素材，请重试。</p>
        <button type="button" className="mt-3 text-accent" onClick={() => setRetry((value) => value + 1)}>重新加载</button>
      </div>
      : preview ? <div>
        <button type="button" className="mb-3 flex items-center gap-2 text-sm text-muted" onClick={() => setPreviewId(null)}>
          <ArrowLeft size={14} />返回集合
        </button>
        <MediaPreview src={convertFileSrc(preview.store_path ?? preview.thumb_path ?? "")} alt={preview.name}
          className="mx-auto max-h-[58vh] max-w-full object-contain" />
        <p className="mt-3 break-words text-center text-sm">{preview.name}</p>
      </div>
      : assets.length === 0 ? <p className="py-12 text-center text-sm text-muted">这个集合还没有素材</p>
      : <div className="columns-2 gap-3 sm:columns-3 lg:columns-4">
        {assets.map((asset) => <button key={asset.id} type="button" aria-label={`预览 ${asset.name}`}
          className="mb-3 block w-full break-inside-avoid overflow-hidden rounded border border-edge bg-panel text-left hover:border-accent"
          onClick={() => setPreviewId(asset.id)}>
          {asset.thumb_path ? <img src={convertFileSrc(asset.thumb_path)} alt="" loading="lazy" draggable={false}
            className="w-full object-cover" style={{ aspectRatio: asset.width && asset.height ? `${asset.width} / ${asset.height}` : undefined }} />
            : <span className="flex h-32 items-center justify-center text-muted"><Image size={24} /></span>}
          <span className="block truncate px-2 py-2 text-xs">{asset.name}</span>
        </button>)}
      </div>}
    </CollectionScrollArea>
  </ModalShell>;
}
