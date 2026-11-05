import { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useRef, type ReactNode } from "react";
import { Plate, PlateContent, PlateElement, createPlatePlugin, usePlateEditor, type PlateElementProps } from "platejs/react";
import type { Value } from "platejs";
import { BasicBlocksPlugin, BasicMarksPlugin } from "@platejs/basic-nodes/react";
import { ListPlugin } from "@platejs/list/react";
import { AudioPlugin, ImagePlugin, VideoPlugin } from "@platejs/media/react";
import { Redo2, Undo2 } from "lucide-react";
import type { DocumentMedia, DocumentValue } from "../lib/documentTypes";
import { normalizeDocument, parseMarkdown } from "../lib/documentCodec";
import { getDragAssets } from "../lib/dragPayload";
import { BlockDragContext, TextBlockActions, useBlockDrop } from "./TextBlockActions";
import { AudioWaveform } from "./AudioWaveform";
import { TextAgentScope } from "./TextAgent";
import { TextInputRules } from "./TextInputRules";
import { TextFormatButtons, TextSelectionToolbar } from "./TextFormatToolbar";

export interface TextPlateInsertion { insert(media: DocumentMedia[]): void; cancel(): void }
export interface TextPlateHandle { insertMedia(media: DocumentMedia[]): void; insertMarkdown(text: string): void; reserveInsertion(): TextPlateInsertion }
interface Props {
  agent?: { projectId?: string };
  toolbarStart?: ReactNode;
  toolbarEnd?: ReactNode;
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
  const drop = useBlockDrop(props);
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
  return <PlateElement {...props} className="text-document-block" attributes={{ ...props.attributes, ...drop }}><TextBlockActions {...props}/>{content}</PlateElement>;
}

export const TextPlateEditor = forwardRef<TextPlateHandle, Props>(function TextPlateEditor({ value, media, onChange, onDropAssets, onRejectedPaste, toolbarStart, toolbarEnd, agent }, ref) {
  const editor = usePlateEditor({
    plugins: [BasicBlocksPlugin, BasicMarksPlugin, ListPlugin, TextInputRules, ImagePlugin.configure({ options: { disableUploadInsert: true, disableEmbedInsert: true } }), AudioPlugin, VideoPlugin, createPlatePlugin({ key: "raw", node: { isElement: true } })],
    value: plateValue(value),
    override: { components: Object.fromEntries(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "hr", "img", "audio", "video", "raw"].map(key => [key, DocumentElement])) },
  });
  const blockDrag = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const emitted = useRef(value), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (value !== emitted.current) { emitted.current = value; editor.tf.setValue(plateValue(value)); } }, [editor, value]);
  function insertMedia(items: DocumentMedia[]) {
    if (!items.length) return;
    editor.tf.insertNodes([...items.map(item => ({ id: crypto.randomUUID(), type: item.kind === "image" ? "img" : item.kind,
      assetId: item.asset.id, sourcePath: item.path, caption: "", children: [{ text: "" }] })), { id: crypto.randomUUID(), type: "p", children: [{ text: "" }] }], { select: true });
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
  function insertMarkdown(text: string) { editor.tf.insertNodes(parseMarkdown(text), { select: true }); editor.tf.focus(); }
  useImperativeHandle(ref, () => ({ insertMedia, insertMarkdown, reserveInsertion }));
  const content = <>
    <div className="text-document-format" role="toolbar" aria-label="文字格式" onMouseDown={event => { if (!(event.target as Element).closest("input")) event.preventDefault(); }}>
      {toolbarStart}
      <button aria-label="撤销" title="撤销" onClick={() => editor.tf.undo()}><Undo2 size={14}/></button>
      <button aria-label="重做" title="重做" onClick={() => editor.tf.redo()}><Redo2 size={14}/></button>
      <TextFormatButtons/>
      {toolbarEnd}
    </div>
    <TextSelectionToolbar bodyRef={bodyRef}/>
    <PlateContent ref={bodyRef} className="text-document-body" aria-label="文档正文" spellCheck={false} placeholder="开始写作…"
      onKeyDown={event => {
        if (event.altKey && event.key === "Enter" && !event.nativeEvent.isComposing) {
          const anchor = window.getSelection()?.anchorNode;
          const block = anchor?.parentElement?.closest('[data-block-id]');
          const handle = block?.querySelector<HTMLButtonElement>('.text-block-actions button[aria-label="段落操作"]');
          if (handle) { event.preventDefault(); handle.click(); }
        }
      }}
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
  </>;
  return <BlockDragContext.Provider value={blockDrag}><MediaContext.Provider value={media}><Plate editor={editor} onValueChange={({ value: changed }) => {
    const next = normalizeDocument(changed); emitted.current = next; onChange(next);
  }}>{agent ? <TextAgentScope editor={editor} projectId={agent.projectId}>{content}</TextAgentScope> : content}</Plate></MediaContext.Provider></BlockDragContext.Provider>;
});
