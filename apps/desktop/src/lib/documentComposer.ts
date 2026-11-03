import type { CreationEditorDraft } from "../components/creation/useCreationEditor";
import type { CreativeDocument, CreativePromptLoad } from "./creativeLaunch";
import type { TextWorkspaceDocument } from "./documentTypes";
import type { PromptedAsset } from "./types";
import { documentMediaMarkup, documentSegments, documentWorkflowValue } from "./documentProjection.ts";

interface ComposerNode { type?: string; text?: string; attrs?: Record<string, unknown>; content?: unknown[] }
function node(value: unknown): ComposerNode { return value && typeof value === "object" ? value as ComposerNode : {}; }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function keywordText(attrs: Record<string, unknown>, refs: PromptedAsset[]) {
  const owner = refs.find(asset => asset.id === attrs.assetId);
  const section = owner?.sections?.find(section => section.id === attrs.sectionId);
  return `【${section?.title ?? string(attrs.title)}】：${section?.body ?? string(attrs.body)}`;
}
function mediaMarkdown(attrs: Record<string, unknown>, refs: PromptedAsset[]): string {
  const assetId = string(attrs.assetId), asset = refs.find(asset => asset.id === assetId);
  const ext = asset?.ext ?? string(attrs.ext);
  const kind = /^(mp3|wav|flac|m4a|ogg)$/i.test(ext) ? "audio" : /^(mp4|mov|webm|m4v|avi|mkv)$/i.test(ext) ? "video" : "image";
  return `\n\n${documentMediaMarkup({ kind, assetId, caption: "", sourcePath: asset?.store_path ?? undefined })}\n\n`;
}
function inlineMarkdown(value: unknown, refs: PromptedAsset[]): string {
  const current = node(value), attrs = current.attrs ?? {};
  if (current.type === "text") return string(current.text);
  if (current.type === "keyword") return keywordText(attrs, refs);
  return current.type === "image" ? mediaMarkdown(attrs, refs) : "";
}
export function creationDraftToDocument(draft: CreationEditorDraft): TextWorkspaceDocument {
  const markdown = (node(draft.doc).content ?? []).map(paragraph => (node(paragraph).content ?? []).map(value => inlineMarkdown(value, draft.refs)).join("")).join("\n");
  const firstLine = markdown.split(/\r?\n/).find(line => line.trim() && !line.startsWith("<")) ?? "";
  return { title: firstLine.replace(/^#+\s*/, "").slice(0, 40) || "未命名文本", markdown };
}
function originalReferenceNodes(sourceDoc: unknown) {
  const instances = new Map<string, string>();
  for (const paragraph of node(sourceDoc).content ?? []) {
    for (const value of node(paragraph).content ?? []) {
      const current = node(value), attrs = current.attrs ?? {};
      if (current.type === "image" && attrs.canvasNodeId) instances.set(string(attrs.assetId), string(attrs.canvasNodeId));
    }
  }
  return instances;
}
function appendDocumentText(content: CreativeDocument["content"], text: string) {
  for (const [index, line] of text.split(/\r\n|\n|\r/).entries()) {
    if (index) content.push({ type: "paragraph", content: [] });
    if (line) content[content.length - 1].content.push({ type: "text", text: line });
  }
}
function creationDocument(markdown: string, assets: PromptedAsset[], instances: Map<string, string>): CreativeDocument {
  const content: CreativeDocument["content"] = [{ type: "paragraph", content: [] }];
  for (const segment of documentSegments(markdown)) {
    if ("text" in segment) { appendDocumentText(content, segment.text); continue; }
    const asset = assets.find(asset => asset.id === segment.media.assetId)!;
    content[content.length - 1].content.push({ type: "image", attrs: { assetId: asset.id, canvasNodeId: instances.get(asset.id) ?? null,
      name: asset.name, ext: asset.ext ?? null, thumb: asset.thumb_path ?? asset.store_path ?? null } });
    appendDocumentText(content, `${segment.media.caption ? `（${segment.media.caption}）` : ""}${segment.newline}`);
  }
  return { type: "doc", content };
}
export function documentPromptLoadFromAssets(document: TextWorkspaceDocument, assets: PromptedAsset[], sourceDoc?: unknown): CreativePromptLoad {
  const value = documentWorkflowValue(document.markdown);
  const refs = value.assetIds.map((id, index) => {
    const asset = assets.find(asset => asset.id === id);
    if (!asset?.store_path) throw new Error("文档中的素材已不可用，请重新连接后再添加到生成对话框");
    return { ...asset, referenceNames: [`图片${index + 1}`] };
  });
  const instances = originalReferenceNodes(sourceDoc);
  return { prompt: value.text, refs, dimRefs: [], referenceNodeIds: value.assetIds.map(id => instances.get(id) ?? null), document: creationDocument(document.markdown, refs, instances) };
}
export async function documentToPromptLoad(document: TextWorkspaceDocument, sourceDoc?: unknown): Promise<CreativePromptLoad> {
  const { api } = await import("./api");
  const ids = documentWorkflowValue(document.markdown).assetIds;
  const assets = await Promise.all(ids.map(id => api.getPromptedAsset(id)));
  return documentPromptLoadFromAssets(document, assets.filter((asset): asset is PromptedAsset => asset !== null), sourceDoc);
}
