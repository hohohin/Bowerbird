import type { TextDocumentSnapshot } from "./documentTypes";
export interface TextDocumentDraft { base: TextDocumentSnapshot; text: string; mode: "body" | "source" }
const drafts = new Map<string, TextDocumentDraft>();
const versions = new Map<string, string>();
const listeners = new Map<string, Set<(draft: TextDocumentDraft) => void>>();
const captures = new Map<string, Set<() => void>>();
const prefix = "bowerbird:text-draft:";
const validBase = (value: unknown): value is TextDocumentSnapshot => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return ["assetId", "path", "text", "version"].every(key => typeof record[key] === "string")
    && (record.format === "markdown" || record.format === "text" || record.format === "docx");
};

export function getTextDocumentDraft(key: string): TextDocumentDraft | undefined {
  captures.get(key)?.forEach(capture => capture());
  if (drafts.has(key)) return drafts.get(key);
  if (typeof sessionStorage === "undefined") return undefined;
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(prefix + key) || "null");
    if (!stored || typeof stored !== "object") return undefined;
    const item = stored as Record<string, unknown>;
    if (!validBase(item.base) || typeof item.text !== "string" || (item.mode !== "body" && item.mode !== "source")) return undefined;
    const normalize = (path: string) => path.replace(/\\/g, "/");
    if (normalize(key) !== normalize(`${item.base.assetId}:${item.base.path}`)) return undefined;
    const draft: TextDocumentDraft = { base: item.base, text: item.text, mode: item.mode };
    drafts.set(key, draft); versions.set(key, draft.base.version); return draft;
  } catch { return undefined; }
}

/** Returns false only if durable session storage fails; memory always retains the draft. */
export function keepTextDocumentDraft(key: string, draft: TextDocumentDraft): boolean {
  versions.set(key, draft.base.version);
  const dirty = draft.text !== draft.base.text;
  if (dirty) drafts.set(key, draft); else drafts.delete(key);
  if (typeof sessionStorage === "undefined") return true;
  try {
    if (dirty) sessionStorage.setItem(prefix + key, JSON.stringify(draft));
    else sessionStorage.removeItem(prefix + key);
    return true;
  } catch { return false; }
}

export function acceptTextDocumentSave(current: TextDocumentDraft, submittedText: string, saved: TextDocumentSnapshot): TextDocumentDraft {
  return { ...current, base: saved, text: current.text === submittedText ? saved.text : current.text };
}

export function finishTextDocumentSave(key: string, submitted: TextDocumentDraft, saved: TextDocumentSnapshot): TextDocumentDraft | undefined {
  const latest = getTextDocumentDraft(key) ?? submitted;
  if ((versions.get(key) ?? latest.base.version) !== submitted.base.version) return undefined;
  const next = acceptTextDocumentSave(latest, submitted.text, saved);
  keepTextDocumentDraft(key, next);
  listeners.get(key)?.forEach(listener => listener(next));
  return next;
}

export function subscribeTextDocumentDraft(key: string, listener: (draft: TextDocumentDraft) => void, capture?: () => void): () => void {
  const group = listeners.get(key) ?? new Set(); group.add(listener); listeners.set(key, group);
  const pending = captures.get(key) ?? new Set<() => void>();
  if (capture) { pending.add(capture); captures.set(key, pending); }
  return () => {
    group.delete(listener); if (!group.size) listeners.delete(key);
    if (capture) pending.delete(capture);
    if (!pending.size) captures.delete(key);
  };
}

if (typeof window !== "undefined") window.addEventListener("beforeunload", event => {
  captures.forEach(group => group.forEach(capture => capture()));
  if (!drafts.size) return;
  event.preventDefault(); event.returnValue = "";
});
