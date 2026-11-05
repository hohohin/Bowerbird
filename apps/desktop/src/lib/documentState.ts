import type { DocumentBlock, DocumentComment, DocumentDiscussion, DocumentValue } from './documentTypes.ts';

const footer = /\r?\n\r?\n<!-- bowerbird-document:1:([A-Za-z0-9+/=]+) -->\s*$/;
function canonical(source: string) { return source.replace(/\r\n?/g, '\n').trimEnd() + '\n'; }
function fingerprint(source: string) {
  let hash = 2166136261;
  for (const character of canonical(source)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid document object');
  return value as Record<string, unknown>;
}
function isBlock(value: unknown, requireIds: boolean): boolean {
  const node = record(value);
  return typeof node.type === 'string' && (!requireIds || typeof node.id === 'string') && Array.isArray(node.children) && node.children.length > 0;
}
function isValue(value: unknown, requireIds = true): value is DocumentValue {
  let count = 0;
  function valid(node: unknown, depth: number): boolean {
    if (++count > 100000 || depth > 128) return false;
    const item = record(node);
    if (typeof item.text === 'string') return !item.children;
    return isBlock(node, requireIds) && (item.children as unknown[]).every(child => valid(child, depth + 1));
  }
  return Array.isArray(value) && value.length > 0 && value.every(node => isBlock(node, requireIds) && valid(node, 0));
}
function requiredField<Kind extends 'string' | 'boolean'>(item: Record<string, unknown>, key: string, kind: Kind): { string: string; boolean: boolean }[Kind] {
  if (typeof item[key] !== kind) throw new Error('Invalid discussion field');
  return item[key] as { string: string; boolean: boolean }[Kind];
}
function dateFromJson(value: unknown): Date {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid discussion date');
  return new Date(value);
}
function commentFromJson(value: unknown): DocumentComment {
  const item = record(value);
  if (!isValue(item.contentRich, false)) throw new Error('Invalid comment content');
  return { id: requiredField(item, 'id', 'string'), discussionId: requiredField(item, 'discussionId', 'string'), userId: requiredField(item, 'userId', 'string'),
    isEdited: requiredField(item, 'isEdited', 'boolean'), createdAt: dateFromJson(item.createdAt), contentRich: item.contentRich };
}
function discussionFromJson(value: unknown): DocumentDiscussion {
  const item = record(value);
  if (!Array.isArray(item.comments)) throw new Error('Invalid discussion comments');
  return { id: requiredField(item, 'id', 'string'), userId: requiredField(item, 'userId', 'string'), isResolved: requiredField(item, 'isResolved', 'boolean'),
    createdAt: dateFromJson(item.createdAt), comments: item.comments.map(commentFromJson),
    ...(typeof item.documentContent === 'string' ? { documentContent: item.documentContent } : {}) };
}
function discussionsFromJson(input: unknown): DocumentDiscussion[] | undefined {
  if (input === undefined) return;
  if (!Array.isArray(input)) throw new Error('Invalid discussions');
  return input.map(discussionFromJson);
}
/** The readable Markdown remains authoritative if another editor changes it. */
export function readDocumentState(source: string): { source: string; value?: DocumentValue } {
  const match = footer.exec(source);
  if (!match) return { source };
  try {
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(match[1]), character => character.charCodeAt(0)));
    const state = JSON.parse(decoded);
    if (!state || typeof state.hash !== 'string' || !isValue(state.value)) return { source };
    const discussions = discussionsFromJson(state.discussions);
    if (discussions) state.value.discussions = discussions;
    const readable = canonical(source.slice(0, match.index));
    return { source: readable, ...(state.hash === fingerprint(readable) ? { value: state.value } : {}) };
  } catch { return { source }; }
}
const simpleTypes = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'hr', 'raw', 'img', 'audio', 'video']);
const simpleProperties = new Set(['id', 'type', 'text', 'children', 'bold', 'italic', 'code', 'strikethrough', 'listStyleType', 'indent', 'checked', 'start', 'assetId', 'sourcePath', 'caption']);
function needsState(node: DocumentBlock | Record<string, unknown>): boolean {
  if (Array.isArray(node.caption)) return true;
  if (typeof node.type === 'string' && !simpleTypes.has(node.type)) return true;
  if (Object.keys(node).some(key => !simpleProperties.has(key) && !(key === 'url' && node.assetId))) return true;
  return Array.isArray(node.children) && node.children.some(needsState);
}
export function writeDocumentState(source: string, value: DocumentValue): string {
  if (!value.discussions?.length && !value.some(needsState)) return source;
  const payload = JSON.stringify({ hash: fingerprint(source), value, discussions: value.discussions }, (key, item) => item && typeof item === 'object' && (item.assetId || item.attachmentId) ? Object.fromEntries(Object.entries(item).filter(([property]) => property !== 'url')) : key === 'placeholderId' ? undefined : item);
  const encoded = btoa(Array.from(new TextEncoder().encode(payload), byte => String.fromCharCode(byte)).join(''));
  return canonical(source) + `\n<!-- bowerbird-document:1:${encoded} -->\n`;
}
