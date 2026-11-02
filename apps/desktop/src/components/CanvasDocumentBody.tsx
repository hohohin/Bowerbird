import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { parseMarkdown } from "../lib/documentCodec";
import { documentMedia, documentReferenceIds } from "../lib/textDocuments";
import type { DocumentBlock, DocumentMedia } from "../lib/documentTypes";
import { CanvasImage } from "./CanvasImage";

function Inline({ block }: { block: DocumentBlock }) {
  return <>{block.children.map((child, index) => {
    let text: ReactNode = typeof child.text === "string" ? child.text : <Inline block={child as DocumentBlock} />;
    if (child.bold) text = <strong>{text}</strong>;
    if (child.italic) text = <em>{text}</em>;
    return <Fragment key={index}>{text}</Fragment>;
  })}</>;
}

export default function CanvasDocumentBody({ markdown }: { markdown: string }) {
  const value = useMemo(() => parseMarkdown(markdown), [markdown]);
  const [media, setMedia] = useState<DocumentMedia[]>([]);
  const referenceKey = documentReferenceIds(value).join("|");
  useEffect(() => {
    let current = true;
    setMedia([]);
    if (referenceKey) void api.getAssetsByIds(referenceKey.split("|")).then(assets => {
      if (current) setMedia(assets.map(documentMedia).filter((item): item is DocumentMedia => item !== null));
    }).catch(() => {});
    return () => { current = false; };
  }, [referenceKey]);
  return <>{value.map(block => {
    if (["img", "audio", "video"].includes(block.type)) {
      const item = media.find(item => item.asset.id === block.assetId);
      return <figure key={block.id}>{item?.kind === "image" ? <CanvasImage path={item.path} sourceWidth={item.asset.width} sourceHeight={item.asset.height} alt={block.caption || item.asset.name} draggable={false}/>
        : <span>{item?.asset.name ?? "素材引用"}</span>}{block.caption && <figcaption>{block.caption}</figcaption>}</figure>;
    }
    const Tag = /^h[1-6]$/.test(block.type) ? block.type as "h1" : block.type === "blockquote" ? "blockquote" : block.type === "raw" ? "pre" : "p";
    return <Tag key={block.id} className={block.listStyleType ? "is-list-item" : undefined}><Inline block={block}/></Tag>;
  })}</>;
}
