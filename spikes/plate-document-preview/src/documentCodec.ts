import { createSlateEditor } from "platejs";
import { BaseBasicBlocksPlugin, BaseBasicMarksPlugin } from "@platejs/basic-nodes";
import { BaseListPlugin } from "@platejs/list";
import { BaseImagePlugin, BaseAudioPlugin, BaseVideoPlugin } from "@platejs/media";
import { MarkdownPlugin, deserializeMd, markdownToAstProcessor, serializeMd } from "@platejs/markdown";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import type { DocumentBlock, DocumentText, DocumentValue, PreviewAsset } from "./domain.ts";

const codec = createSlateEditor({ plugins: [BaseBasicBlocksPlugin, BaseBasicMarksPlugin, BaseListPlugin, BaseImagePlugin, BaseAudioPlugin, BaseVideoPlugin, MarkdownPlugin] });
const supported = new Set(["paragraph", "heading", "blockquote", "list", "listItem", "text", "strong", "emphasis", "inlineCode", "break", "thematicBreak"]);
const parseOptions = { withoutMdx: true, remarkPlugins: [remarkGfm, remarkFrontmatter] };

export function createEmptyDocument(): DocumentValue {
  return [{ id: crypto.randomUUID(), type: "p", children: [{ text: "" }] }];
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }

/** Normalize the editor boundary, including ids on nodes newly created by Plate. */
export function normalizeDocument(value: unknown): DocumentValue {
  if (!Array.isArray(value)) return createEmptyDocument();
  const visit = (node: unknown): DocumentBlock | DocumentText => {
    if (!isRecord(node)) return { text: "" };
    if (typeof node.text === "string") return { ...node, text: node.text };
    return {
      ...node,
      id: typeof node.id === "string" ? node.id : crypto.randomUUID(),
      type: typeof node.type === "string" ? node.type : "p",
      children: Array.isArray(node.children) && node.children.length ? node.children.map(visit) : [{ text: "" }],
    };
  };
  const result = value.map(visit).filter((node): node is DocumentBlock => typeof node.type === "string" && Array.isArray(node.children));
  return result.length ? result : createEmptyDocument();
}

function safeSyntax(node: unknown): boolean {
  if (!isRecord(node) || !supported.has(String(node.type))) return false;
  if (node.type === "list" && node.spread) return false;
  if (node.type === "listItem" && (typeof node.checked === "boolean" || !Array.isArray(node.children) || node.children.length !== 1)) return false;
  return !Array.isArray(node.children) || node.children.every(safeSyntax);
}

function rawBlock(source: string): DocumentBlock {
  return { id: crypto.randomUUID(), type: "raw", children: [{ text: source }] };
}

function referenceBlock(type: string, assetId: string, caption: string, assets: PreviewAsset[]): DocumentBlock {
  const asset = assets.find((item) => item.id === assetId && (item.kind === "image" ? "img" : item.kind) === type);
  return { id: crypto.randomUUID(), type, assetId, caption, url: asset?.url ?? "", children: [{ text: "" }] };
}

export function parseMarkdown(source: string, assets: PreviewAsset[] = []): DocumentValue {
  const ast = markdownToAstProcessor(codec, source, parseOptions);
  const blocks: DocumentValue = [];
  for (const node of ast.children) {
    const text = source.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? source.length);
    const media = /^<(audio|video) data-bowerbird-asset="([^"]*)" data-caption="([^"]*)" \/>$/.exec(text.trim());
    if (media) {
      try { blocks.push(referenceBlock(media[1], decodeURIComponent(media[2]), decodeURIComponent(media[3]), assets)); }
      catch { blocks.push(rawBlock(text)); }
      continue;
    }
    const image = node.type === "paragraph" && node.children.length === 1 && node.children[0].type === "image" ? node.children[0] : undefined;
    if (image?.url.startsWith("bowerbird-asset:")) {
      try { blocks.push(referenceBlock("img", decodeURIComponent(image.url.slice(16)), image.alt ?? "", assets)); }
      catch { blocks.push(rawBlock(text)); }
    } else if (safeSyntax(node)) {
      blocks.push(...normalizeDocument(deserializeMd(codec, text, parseOptions)));
    } else {
      blocks.push(rawBlock(text));
    }
  }
  return blocks.length ? blocks : createEmptyDocument();
}

function textOf(block: DocumentBlock): string {
  return block.children.map((node) => typeof node.text === "string" ? node.text : textOf(node as DocumentBlock)).join("");
}

export function serializeMarkdown(value: DocumentValue): string {
  const pieces: string[] = [];
  let ordinary: DocumentValue = [];
  const flush = () => { if (ordinary.length) pieces.push(serializeMd(codec, { value: ordinary }).trimEnd()); ordinary = []; };
  for (const block of value) {
    if (block.type === "raw") { flush(); pieces.push(textOf(block)); continue; }
    if (!["img", "audio", "video"].includes(block.type)) { ordinary.push(block); continue; }
    flush();
    const caption = block.caption ?? "";
    if (block.type === "img") {
      const url = block.assetId ? `bowerbird-asset:${encodeURIComponent(block.assetId)}` : block.url ?? "";
      pieces.push(`![${caption.replace(/[\\\[\]]/g, "\\$&")}](${url})`);
    } else {
      pieces.push(`<${block.type} data-bowerbird-asset="${encodeURIComponent(block.assetId ?? "")}" data-caption="${encodeURIComponent(caption)}" />`);
    }
  }
  flush();
  return pieces.join("\n\n") + "\n";
}
