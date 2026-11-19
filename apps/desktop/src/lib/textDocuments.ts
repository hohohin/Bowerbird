import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Asset } from "./types";
import type { CreateTextDocumentInput, CreatedTextDocument, DocumentMedia, DocumentValue, TextDocumentSnapshot } from "./documentTypes";
import { isAudioAsset } from "./audioMedia";
import { isVideoPath } from "./videoGeneration";

export const textDocuments = {
  create: (input: CreateTextDocumentInput) => invoke<CreatedTextDocument>("create_text_document", { input }),
  preview: (assetId: string) => invoke<TextDocumentSnapshot>("read_text_document", { assetId, previewOnly: true }),
  read: async (assetId: string): Promise<TextDocumentSnapshot> => {
    const { docxData, ...document } = await invoke<TextDocumentSnapshot & { docxData?: string }>("read_text_document", { assetId });
    if (document.format !== "docx") return document;
    if (!docxData) throw new Error("Word 文档内容不完整，请重新打开");
    const { readDocx } = await import("./officeDocuments");
    return { ...document, text: await readDocx(docxData) };
  },
  save: async (assetId: string, expectedVersion: string, text: string, format?: TextDocumentSnapshot["format"]): Promise<TextDocumentSnapshot> => {
    if (format !== "docx") return invoke<TextDocumentSnapshot>("save_text_document", { assetId, expectedVersion, text });
    const { writeDocx } = await import("./officeDocuments");
    const result = await invoke<TextDocumentSnapshot>("save_docx_document", { assetId, expectedVersion, data: await writeDocx(text) });
    return { ...result, format: "docx", text };
  },
};

/** Canvas documents use Markdown; TXT punctuation must remain literal text. */
export async function textDocumentMarkdown(document: TextDocumentSnapshot): Promise<string> {
  if (document.format !== "text") return document.text;
  const { serializeMarkdown } = await import("./documentCodec");
  return serializeMarkdown(document.text.split(/\r\n|\n|\r/).map(text => ({
    id: crypto.randomUUID(), type: "p", children: [{ text }],
  })));
}

export function documentMedia(asset: Asset): DocumentMedia | null {
  const path = asset.store_path || asset.origin_path;
  if (!path) return null;
  const kind = isAudioAsset(asset) ? "audio" : isVideoPath(path) ? "video"
    : /\.(png|jpe?g|webp|gif|avif|bmp|tiff?|heic)(?:[?#].*)?$/i.test(path) ? "image" : null;
  return kind ? { asset, path, kind, url: convertFileSrc(path) } : null;
}

export function documentReferenceIds(value: DocumentValue): string[] {
  const ids = new Set<string>();
  const visit = (nodes: DocumentValue) => nodes.forEach(node => {
    if (node.assetId) ids.add(node.assetId);
    visit(node.children.filter((child): child is DocumentValue[number] => typeof child.type === "string" && Array.isArray(child.children)));
  });
  visit(value); return [...ids];
}
