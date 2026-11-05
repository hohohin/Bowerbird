import { readDocumentState } from './documentState.ts';
export interface DocumentMediaReference { kind: "image" | "audio" | "video"; assetId: string; caption: string; sourcePath?: string }
export function documentMediaMarkup(ref: DocumentMediaReference): string { return `<${ref.kind === "image" ? "img" : ref.kind} data-bowerbird-asset="${encodeURIComponent(ref.assetId)}" data-caption="${encodeURIComponent(ref.caption)}"${ref.sourcePath ? ` data-source="${encodeURIComponent(ref.sourcePath)}"` : ""} />`; }
export type DocumentSegment = { text: string } | { media: DocumentMediaReference; newline: string };

function readMedia(line: string): DocumentMediaReference | undefined {
  const tag = /^<(img|audio|video) data-bowerbird-asset="([^"]+)" data-caption="([^"]*)"(?: data-source="([^"]*)")? \/>$/.exec(line);
  const legacy = /^!\[([^\]]*)\]\(bowerbird-asset:([^\s)]+)\)$/.exec(line);
  try {
    if (tag) return { kind: tag[1] === "img" ? "image" : tag[1] as "audio" | "video", assetId: decodeURIComponent(tag[2]), caption: decodeURIComponent(tag[3]), ...(tag[4] ? { sourcePath: decodeURIComponent(tag[4]) } : {}) };
    if (legacy) return { kind: "image", assetId: decodeURIComponent(legacy[2]), caption: legacy[1] };
  } catch { /* Invalid escapes remain literal source, as in the document editor. */ }
}

function nextFence(body: string, fence: string): string {
  const marker = /^ {0,3}(`{3,}|~{3,})/.exec(body)?.[1];
  if (!marker) return fence;
  if (!fence) return marker;
  return marker[0] === fence[0] && marker.length >= fence.length && body.trim() === marker ? "" : fence;
}
function frontmatterEnd(lines: string[]): number {
  if (lines[0]?.trim() !== "---") return -1;
  return lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)$/.test(line.trim()));
}
function mediaBlock(lines: string[], index: number, body: string): DocumentMediaReference | undefined {
  if (/^ {4}|^\t/.test(body) || lines[index - 1]?.trim() || lines[index + 1]?.trim()) return;
  return readMedia(body.trim());
}
/** Interpret only registered whole-block references; code examples and external URLs stay text. */
export function documentSegments(source: string): DocumentSegment[] {
  const stored = readDocumentState(source);
  source = stored.source;
  const segments: DocumentSegment[] = [];
  let text = "", fence = "";
  const lines = (source.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? []).filter(Boolean);
  const headerEnd = frontmatterEnd(lines);
  for (const [index, line] of lines.entries()) {
    const body = line.replace(/[\r\n]+$/, ""), previousFence = fence;
    fence = nextFence(body, fence);
    const media = index <= headerEnd || previousFence || fence ? undefined : stored.value ? readMedia(body.trim()) : mediaBlock(lines, index, body);
    if (!media) { text += line; continue; }
    if (text) { segments.push({ text }); text = ""; }
    segments.push({ media, newline: line.slice(body.length) });
  }
  if (text) segments.push({ text });
  return segments;
}

export function documentMediaReferences(source: string): DocumentMediaReference[] {
  return documentSegments(source).flatMap(segment => "media" in segment ? [segment.media] : []);
}

export function documentWorkflowValue(source: string) {
  const assetIds: string[] = [];
  const text = documentSegments(source).map(segment => {
    if ("text" in segment) return segment.text;
    const { assetId, caption } = segment.media;
    if (!assetIds.includes(assetId)) assetIds.push(assetId);
    return `@图片${assetIds.indexOf(assetId) + 1}${caption ? `（${caption}）` : ""}${segment.newline}`;
  }).join("");
  return { type: "text" as const, text, assetIds, imageRefs: assetIds.map((asset_id, index) => ({ asset_id, token: `@图片${index + 1}` })) };
}
