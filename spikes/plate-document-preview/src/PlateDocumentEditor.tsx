import { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useMemo, useRef, type ReactNode } from "react";
import { Plate, PlateContent, PlateElement, usePlateEditor, createPlatePlugin, type PlateElementProps } from "platejs/react";
import type { Value } from "platejs";
import { BasicBlocksPlugin, BasicMarksPlugin } from "@platejs/basic-nodes/react";
import { ListPlugin } from "@platejs/list/react";
import { AudioPlugin, ImagePlugin, VideoPlugin } from "@platejs/media/react";
import type { DocumentValue, PreviewAsset } from "./domain";
import { normalizeDocument } from "./documentCodec";
import "./editor.css";

export interface DocumentEditorHandle {
  insertAsset(asset: PreviewAsset): void;
  insertBlock(type: "p" | "h1" | "h2" | "blockquote" | "ul" | "ol"): void;
  toggleMark(mark: "bold" | "italic" | "code"): void;
  undo(): void;
  redo(): void;
  focus(): void;
}

interface EditorProps {
  value: DocumentValue;
  assets: PreviewAsset[];
  onChange(value: DocumentValue): void;
  selectedBlockIds?: string[];
  onSelectionChange?(blockIds: string[]): void;
  renderAudio?(asset: PreviewAsset): ReactNode;
}

const BlockContext = createContext<Pick<EditorProps, "assets" | "selectedBlockIds" | "onSelectionChange" | "renderAudio">>({ assets: [] });
function plateValue(value: DocumentValue): Value { return value; }

function BlockElement(props: PlateElementProps) {
  const { element, children, editor } = props;
  const { assets, selectedBlockIds = [], onSelectionChange, renderAudio } = useContext(BlockContext);
  const path = editor.api.findPath(element);
  const topLevel = path?.length === 1;
  const id = String(element.id ?? "");
  const selected = selectedBlockIds.includes(id);
  const media = ["img", "audio", "video"].includes(element.type);
  const asset = assets.find((item) => item.id === element.assetId);
  const url = asset?.url ?? "";
  const caption = typeof element.caption === "string" ? element.caption : "";
  const type = element.type;
  let content = children;
  if (type === "h1") content = <h1>{children}</h1>;
  else if (type === "h2") content = <h2>{children}</h2>;
  else if (type === "h3") content = <h3>{children}</h3>;
  else if (type === "blockquote") content = <blockquote>{children}</blockquote>;
  else if (type === "raw") content = <pre className="plate-raw" title="保留的源码">{children}</pre>;
  else if (type === "hr") content = <><hr />{children}</>;
  else if (element.listStyleType) content = <div className="plate-list-item" style={{ paddingLeft: `${Number(element.indent ?? 1) * 20}px` }}><span contentEditable={false} className="plate-list-marker">{element.listStyleType === "decimal" ? `${element.listStart ?? 1}.` : "•"}</span>{children}</div>;

  return <PlateElement {...props} className={`plate-block${selected ? " is-selected" : ""}${media ? " plate-media-block" : ""}`} data-block-id={id}>
    {topLevel && <span className="plate-block-selector" contentEditable={false}>
      <input type="checkbox" aria-label={`选择段落 ${(path?.[0] ?? 0) + 1}`} checked={selected}
        onMouseDown={(event) => event.preventDefault()}
        onChange={() => onSelectionChange?.(selected ? selectedBlockIds.filter((item) => item !== id) : [...selectedBlockIds, id])} />
    </span>}
    {media ? <>
      <figure contentEditable={false}>
        {!url ? <div className="plate-media-missing">素材未连接</div>
          : type === "img" ? <img src={url} alt={caption || asset?.name || "图片"} loading="lazy" decoding="async" draggable={false} />
          : type === "audio" && asset && renderAudio ? renderAudio(asset)
          : type === "audio" ? <audio src={url} controls preload="none" />
          : <video src={url} poster={asset?.thumbnail} controls preload="none" />}
        <input className="plate-media-caption" aria-label="素材说明" placeholder="添加说明…" value={caption}
          onChange={(event) => { if (path) editor.tf.setNodes({ caption: event.target.value }, { at: path }); }} />
      </figure>
      {children}
    </> : content}
  </PlateElement>;
}

export const PlateDocumentEditor = forwardRef<DocumentEditorHandle, EditorProps>(function PlateDocumentEditor({ value, assets, onChange, selectedBlockIds, onSelectionChange, renderAudio }, ref) {
  const editor = usePlateEditor({
    plugins: [BasicBlocksPlugin, BasicMarksPlugin, ListPlugin, ImagePlugin.configure({ options: { disableUploadInsert: true } }), AudioPlugin, VideoPlugin, createPlatePlugin({ key: "raw", node: { isElement: true } })],
    value: plateValue(value),
    override: { components: Object.fromEntries(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "hr", "img", "audio", "video", "raw"].map((key) => [key, BlockElement])) },
  });
  const emitted = useRef(value);
  useEffect(() => {
    if (value !== emitted.current) {
      emitted.current = value;
      editor.tf.setValue(plateValue(value));
    }
  }, [editor, value]);

  function insertAsset(asset: PreviewAsset) {
    editor.tf.insertNodes({ id: crypto.randomUUID(), type: asset.kind === "image" ? "img" : asset.kind, assetId: asset.id, url: asset.url, caption: "", children: [{ text: "" }] });
    editor.tf.focus();
  }
  useImperativeHandle(ref, () => ({
    insertAsset,
    insertBlock(type) {
      editor.tf.insertNodes({ id: crypto.randomUUID(), type: type === "ul" || type === "ol" ? "p" : type, ...(type === "ul" || type === "ol" ? { listStyleType: type === "ol" ? "decimal" : "disc", indent: 1 } : {}), children: [{ text: "" }] });
      editor.tf.focus();
    },
    toggleMark(mark) { editor.tf.toggleMark(mark); editor.tf.focus(); },
    undo() { editor.tf.undo(); },
    redo() { editor.tf.redo(); },
    focus() { editor.tf.focus(); },
  }));
  const context = useMemo(() => ({ assets, selectedBlockIds, onSelectionChange, renderAudio }), [assets, selectedBlockIds, onSelectionChange, renderAudio]);
  return <BlockContext.Provider value={context}>
    <Plate editor={editor} onValueChange={({ value: changed }) => {
      const next = normalizeDocument(changed);
      emitted.current = next;
      onChange(next);
    }}>
      <PlateContent className="plate-document-content" aria-label="文档正文" placeholder="开始写作…" spellCheck={false}
        onDragOver={(event) => { if (event.dataTransfer.types.includes("application/x-bowerbird-preview-asset")) event.preventDefault(); }}
        onDrop={(event) => {
          const assetId = event.dataTransfer.getData("application/x-bowerbird-preview-asset");
          const asset = assets.find((item) => item.id === assetId);
          if (!asset) return;
          event.preventDefault();
          const range = editor.api.findEventRange(event);
          if (range) editor.tf.select(range);
          insertAsset(asset);
        }}
        onPaste={(event) => {
          if (!event.clipboardData.files.length) return;
          event.preventDefault();
        }} />
    </Plate>
  </BlockContext.Provider>;
});
