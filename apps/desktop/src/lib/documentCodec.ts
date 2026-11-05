import { createSlateEditor, createSlatePlugin } from "platejs";
import { BaseBasicBlocksPlugin, BaseBasicMarksPlugin } from "@platejs/basic-nodes";
import { BaseListPlugin } from "@platejs/list";
import { BaseCodeBlockPlugin, BaseCodeLinePlugin, BaseCodeSyntaxPlugin } from '@platejs/code-block';
import { BaseTablePlugin, BaseTableRowPlugin, BaseTableCellPlugin, BaseTableCellHeaderPlugin } from '@platejs/table';
import { BaseLinkPlugin } from '@platejs/link';
import { BaseColumnPlugin, BaseColumnItemPlugin } from '@platejs/layout';
import { BaseCalloutPlugin } from '@platejs/callout';
import { BaseTogglePlugin } from '@platejs/toggle';
import { BaseFootnoteDefinitionPlugin, BaseFootnoteReferencePlugin } from '@platejs/footnote';
import { BaseDatePlugin } from '@platejs/date';
import { BaseMentionPlugin } from '@platejs/mention';
import { BaseImagePlugin, BaseAudioPlugin, BaseVideoPlugin } from "@platejs/media";
import { MarkdownPlugin, deserializeMd, markdownToAstProcessor, serializeMd, remarkMdx } from "@platejs/markdown";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkMath from 'remark-math';
import { readDocumentState, writeDocumentState } from './documentState.ts';
import { documentMediaMarkup } from './documentProjection.ts';
import type { DocumentBlock, DocumentText, DocumentValue } from "./documentTypes.ts";

const codec = createSlateEditor({ plugins: [BaseBasicBlocksPlugin, BaseBasicMarksPlugin, BaseListPlugin, BaseImagePlugin, BaseAudioPlugin, BaseVideoPlugin,
  BaseCodeBlockPlugin, BaseCodeLinePlugin, BaseCodeSyntaxPlugin, BaseTablePlugin, BaseTableRowPlugin, BaseTableCellPlugin, BaseTableCellHeaderPlugin,
  BaseLinkPlugin, BaseColumnPlugin, BaseColumnItemPlugin, BaseCalloutPlugin, BaseTogglePlugin,
  createSlatePlugin({ key: 'document_media', node: { isElement: true, isVoid: true } }),
  // The public math base entry imports KaTeX CSS; the codec only needs its node schema.
  createSlatePlugin({ key: 'equation', node: { isElement: true, isVoid: true } }),
  createSlatePlugin({ key: 'inline_equation', node: { isElement: true, isVoid: true, isInline: true } }),
  BaseFootnoteDefinitionPlugin, BaseFootnoteReferencePlugin, BaseDatePlugin, BaseMentionPlugin, MarkdownPlugin.configure({ options: { remarkPlugins: [remarkGfm, remarkMath, remarkMdx] } })] });
const supported = new Set(["paragraph", "heading", "blockquote", "list", "listItem", "text", "strong", "emphasis", "inlineCode", "break", "thematicBreak", "delete", "link", "code", "table", "tableRow", "tableCell", "math", "inlineMath", "footnoteReference", "footnoteDefinition"]);
const parseOptions = { withoutMdx: true, remarkPlugins: [remarkGfm, remarkFrontmatter, remarkMath],
  rules: { text: { deserialize: (node: { value: string }, marks: Record<string, unknown>) => ({ ...marks, text: node.value.replace(/\r?\n/g, " ") }) } },
};

export function createEmptyDocument(): DocumentValue {
  return [{ id: crypto.randomUUID(), type: "p", children: [{ text: "" }] }];
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }

function normalizeNode(node: unknown): DocumentBlock | DocumentText {
  if (!isRecord(node)) return { text: '' };
  if (typeof node.text === 'string') return { ...node, text: node.text };
  return { ...node, id: typeof node.id === 'string' ? node.id : crypto.randomUUID(), type: typeof node.type === 'string' ? node.type : 'p',
    children: Array.isArray(node.children) && node.children.length ? node.children.map(normalizeNode) : [{ text: '' }] };
}
/** Normalize the editor boundary, including ids on nodes newly created by Plate. */
export function normalizeDocument(value: unknown): DocumentValue {
  if (!Array.isArray(value)) return createEmptyDocument();
  const result = value.map(normalizeNode).filter((node): node is DocumentBlock => typeof node.type === 'string' && Array.isArray(node.children));
  const document: DocumentValue = result.length ? result : createEmptyDocument();
  if ('discussions' in value) document.discussions = (value as DocumentValue).discussions;
  return document;
}
function safeListItem(node: Record<string, unknown>): boolean {
  // A paragraph followed by nested lists maps to Plate's flat indent model.
  return Array.isArray(node.children) && node.children.every((child, index) => isRecord(child) && child.type === (index === 0 ? 'paragraph' : 'list'));
}
function safeSyntax(node: unknown): boolean {
  if (!isRecord(node) || !supported.has(String(node.type))) return false;
  if (node.type === 'list' && node.spread) return false;
  if (node.type === 'listItem' && !safeListItem(node)) return false;
  return !Array.isArray(node.children) || node.children.every(safeSyntax);
}

function rawBlock(source: string): DocumentBlock {
  return { id: crypto.randomUUID(), type: "raw", children: [{ text: source }] };
}

function referenceBlock(type: string, assetId: string, caption: string, sourcePath?: string): DocumentBlock {
  return { id: crypto.randomUUID(), type, assetId, caption, sourcePath, children: [{ text: "" }] };
}

type MarkdownNode = ReturnType<typeof markdownToAstProcessor>['children'][number];
function parseReference(node: MarkdownNode, text: string): DocumentBlock | undefined {
  const media = /^<(img|audio|video) data-bowerbird-asset="([^"]*)" data-caption="([^"]*)"(?: data-source="([^"]*)")? \/>$/.exec(text.trim());
  if (media) return referenceBlock(media[1], decodeURIComponent(media[2]), decodeURIComponent(media[3]), media[4] ? decodeURIComponent(media[4]) : undefined);
  const image = node.type === 'paragraph' && node.children.length === 1 && node.children[0].type === 'image' ? node.children[0] : undefined;
  if (image?.url.startsWith('bowerbird-asset:')) return referenceBlock('img', decodeURIComponent(image.url.slice(16)), image.alt ?? '');
}
function originalNodeText(node: MarkdownNode, source: string): string {
  const position = 'position' in node ? node.position : undefined;
  return source.slice(position?.start.offset, position?.end.offset);
}
function parseNode(node: MarkdownNode, source: string): DocumentValue {
  const text = originalNodeText(node, source);
  try {
    const media = parseReference(node, text);
    if (media) return [media];
  } catch { return [rawBlock(text)]; }
  return safeSyntax(node) ? normalizeDocument(deserializeMd(codec, text, parseOptions)) : [rawBlock(text)];
}
export function parseMarkdown(source: string): DocumentValue {
  const stored = readDocumentState(source);
  if (stored.value) return stored.value;
  const ast = markdownToAstProcessor(codec, stored.source, parseOptions);
  const blocks = ast.children.flatMap(node => parseNode(node, stored.source));
  return blocks.length ? blocks : createEmptyDocument();
}

function textOf(block: DocumentBlock): string {
  return block.children.map((node) => typeof node.text === "string" ? node.text : textOf(node as DocumentBlock)).join("");
}
function mediaMarkup(block: DocumentBlock) {
  const caption = typeof block.caption === 'string' ? block.caption : block.caption?.map(child => child.text).join('') ?? '';
  return documentMediaMarkup({ kind: block.type === 'img' ? 'image' : block.type as 'audio' | 'video', assetId: block.assetId ?? '', caption, sourcePath: block.sourcePath });
}
function diagramSource(node: DocumentBlock): DocumentBlock {
  const data = isRecord(node.data) ? node.data : {};
  return { id: node.id, type: 'code_block', lang: String(data.drawingType ?? '').toLowerCase(), children: String(data.code ?? '').split('\n').map((text, index) => ({ id: node.id + ':' + index, type: 'code_line', children: [{ text }] })) };
}
function attachmentSource(node: DocumentBlock): DocumentBlock {
  return { id: node.id, type: 'p', children: [{ id: node.id + ':link', type: 'a', url: node.attachmentId ? 'bowerbird-attachment:' + node.attachmentId : node.url, children: [{ text: String(node.name ?? '附件') }] }] };
}
function serializableNode(node: DocumentBlock): DocumentBlock {
  if (node.type === 'code_drawing') return diagramSource(node);
  if (node.type === 'excalidraw') return { id: node.id, type: 'p', children: [{ text: '［绘图］' }] };
  if (node.type === 'file') return attachmentSource(node);
  if (node.assetId && ['img', 'audio', 'video'].includes(node.type)) return { ...node, type: 'document_media', markup: mediaMarkup(node) };
  if (node.attachmentId) return { ...node, url: 'bowerbird-attachment:' + node.attachmentId };
  return { ...node, children: node.children.map(child => typeof child.text === 'string' ? child : serializableNode(child as DocumentBlock)) };
}
function serializableNodes(nodes: DocumentValue): DocumentValue { return nodes.map(serializableNode); }

export function serializeMarkdown(value: DocumentValue): string {
  const pieces: string[] = [];
  let ordinary: DocumentValue = [];
  const flush = () => {
    if (ordinary.length) pieces.push(serializeMd(codec, { value: serializableNodes(ordinary), rules: { document_media: { serialize: node => ({ type: 'html', value: String(node.markup) }) } } }).trimEnd());
    ordinary = [];
  };
  for (const block of value) {
    if (block.type === "raw") { flush(); pieces.push(textOf(block)); continue; }
    if (!["img", "audio", "video"].includes(block.type)) { ordinary.push(block); continue; }
    flush();
    if (!block.assetId && typeof block.url === "string") { pieces.push(block.url); continue; }
    pieces.push(mediaMarkup(block));
  }
  flush();
  return writeDocumentState(pieces.join("\n\n") + "\n", value);
}
