import { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useRef } from "react";
import { Plate, PlateContent, PlateElement, createPlatePlugin, usePlateEditor, type PlateElementProps } from "platejs/react";
import type { Value } from "platejs";
import { BasicBlocksPlugin, BasicMarksPlugin } from "@platejs/basic-nodes/react";
import { ListPlugin } from "@platejs/list/react";
import { AudioPlugin, ImagePlugin, VideoPlugin } from "@platejs/media/react";
import { Bold, Italic, List, Quote, Redo2, Undo2 } from "lucide-react";
import type { DocumentMedia, DocumentValue } from "../lib/documentTypes";
import { normalizeDocument } from "../lib/documentCodec";
import { getDragAssets } from "../lib/dragPayload";
import { AudioWaveform } from "./AudioWaveform";

export interface TextPlateInsertion { insert(media: DocumentMedia[]): void; cancel(): void }
export interface TextPlateHandle { insertMedia(media: DocumentMedia[]): void; reserveInsertion(): TextPlateInsertion }
interface Props {
  value: DocumentValue;
  media: DocumentMedia[];
  onChange(value: DocumentValue): void;
  onDropAssets(ids: string[]): Promise<DocumentMedia[]>;
  onRejectedPaste(): void;
}
const MediaContext = createContext<DocumentMedia[]>([]);
function plateValue(value: DocumentValue): Value { return value; }

function DocumentElement(props: PlateElementProps) {
  const { element, editor, children } = props;
  const media = useContext(MediaContext).find(item => item.asset.id === element.assetId);
  const expectedKind = element.type === "img" ? "image" : element.type;
  const linked = media?.kind === expectedKind ? media : undefined;
  const path = editor.api.findPath(element);
  const caption = typeof element.caption === "string" ? element.caption : "";
  let content = children;
  if (/^h[1-6]$/.test(element.type)) {
    const Heading = element.type as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
    content = <Heading>{children}</Heading>;
  } else if (element.type === "blockquote") content = <blockquote>{children}</blockquote>;
  else if (element.type === "raw") content = <pre className="text-document-raw" title="保留的源码">{children}</pre>;
  else if (element.type === "hr") content = <><hr />{children}</>;
  if (["img", "audio", "video"].includes(element.type)) content = <>
    <figure contentEditable={false}>
      {!linked ? <div className="text-document-missing">素材未连接，请重新插入原文件。</div>
        : linked.kind === "image" ? <img src={linked.url} alt={caption || linked.asset.name} loading="lazy" decoding="async" draggable={false} />
        : linked.kind === "audio" ? <AudioWaveform assetId={linked.asset.id} path={linked.path} name={linked.asset.name} version={linked.asset.file_mtime ?? 0} duration={linked.asset.duration} />
        : <video src={linked.url} controls preload="none" />}
      <input aria-label="素材说明" value={caption} placeholder="添加说明…" onChange={event => { if (path) editor.tf.setNodes({ caption: event.target.value }, { at: path }); }} />
    </figure>{children}
  </>;
  return <PlateElement {...props} className="text-document-block" data-document-block={element.id}>{content}</PlateElement>;
}

export const TextPlateEditor = forwardRef<TextPlateHandle, Props>(function TextPlateEditor({ value, media, onChange, onDropAssets, onRejectedPaste }, ref) {
  const editor = usePlateEditor({
    plugins: [BasicBlocksPlugin, BasicMarksPlugin, ListPlugin, ImagePlugin.configure({ options: { disableUploadInsert: true, disableEmbedInsert: true } }), AudioPlugin, VideoPlugin, createPlatePlugin({ key: "raw", node: { isElement: true } })],
    value: plateValue(value),
    override: { components: Object.fromEntries(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "hr", "img", "audio", "video", "raw"].map(key => [key, DocumentElement])) },
  });
  const emitted = useRef(value), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (value !== emitted.current) { emitted.current = value; editor.tf.setValue(plateValue(value)); } }, [editor, value]);
  function insertMedia(items: DocumentMedia[]) {
    for (const item of items) editor.tf.insertNodes({ id: crypto.randomUUID(), type: item.kind === "image" ? "img" : item.kind,
      assetId: item.asset.id, sourcePath: item.path, caption: "", children: [{ text: "" }] });
    editor.tf.focus();
  }
  function reserveInsertion(): TextPlateInsertion {
    const end = editor.api.end([]);
    const selection = editor.selection ?? (end ? { anchor: end, focus: end } : null);
    if (!selection) return { insert() {}, cancel() {} };
    const bookmark = editor.api.rangeRef(selection, { affinity: "forward" });
    let used = false;
    const cancel = () => { if (!used) { used = true; bookmark.unref(); } };
    return { cancel, insert(items) {
      if (used) return;
      const range = bookmark.current;
      cancel();
      if (!mounted.current || !range) return;
      editor.tf.select(range); insertMedia(items);
    } };
  }
  useImperativeHandle(ref, () => ({ insertMedia, reserveInsertion }));
  return <MediaContext.Provider value={media}><Plate editor={editor} onValueChange={({ value: changed }) => {
    const next = normalizeDocument(changed); emitted.current = next; onChange(next);
  }}>
    <div className="text-document-format" role="toolbar" aria-label="文字格式" onMouseDown={event => event.preventDefault()}>
      <button aria-label="撤销" title="撤销" onClick={() => editor.tf.undo()}><Undo2 size={14}/></button>
      <button aria-label="重做" title="重做" onClick={() => editor.tf.redo()}><Redo2 size={14}/></button>
      <button aria-label="标题" title="标题" onClick={() => { editor.tf.toggleBlock("h2"); editor.tf.focus(); }}>H₂</button>
      <button aria-label="加粗" title="加粗" onClick={() => { editor.tf.toggleMark("bold"); editor.tf.focus(); }}><Bold size={14}/></button>
      <button aria-label="斜体" title="斜体" onClick={() => { editor.tf.toggleMark("italic"); editor.tf.focus(); }}><Italic size={14}/></button>
      <button aria-label="列表" title="列表" onClick={() => { editor.tf.setNodes({ listStyleType: "disc", indent: 1 }); editor.tf.focus(); }}><List size={14}/></button>
      <button aria-label="引用" title="引用" onClick={() => { editor.tf.toggleBlock("blockquote"); editor.tf.focus(); }}><Quote size={14}/></button>
    </div>
    <PlateContent className="text-document-body" aria-label="文档正文" spellCheck={false} placeholder="开始写作…"
      onPaste={event => { if (event.clipboardData.files.length || /<(?:img|audio|video)\b/i.test(event.clipboardData.getData("text/html"))) { event.preventDefault(); onRejectedPaste(); } }}
      onDragOver={event => { if (getDragAssets()?.length) event.preventDefault(); }}
      onDrop={event => {
        const ids = getDragAssets();
        if (!ids?.length) { if (event.dataTransfer.files.length) { event.preventDefault(); onRejectedPaste(); } return; }
        event.preventDefault(); event.stopPropagation();
        const range = editor.api.findEventRange(event);
        if (range) editor.tf.select(range);
        const insertion = reserveInsertion();
        void onDropAssets(ids).then(insertion.insert, insertion.cancel);
      }} />
  </Plate></MediaContext.Provider>;
});
