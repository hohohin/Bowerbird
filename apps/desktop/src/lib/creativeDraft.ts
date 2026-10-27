import type { PromptedAsset } from "./types";
import type { CreationEditorDraft } from "../components/creation/useCreationEditor";

export type CreativeComposerMode = "image" | "video" | "chat";
export interface CreativeComposerState {
  mode: CreativeComposerMode;
  drafts: Partial<Record<CreativeComposerMode, CreationEditorDraft>>;
}

export function parseCreativeComposerState(draftJson: string): CreativeComposerState {
  const legacy = parseCreativeComposerDraft(draftJson);
  const fallbackMode = legacy?.generation?.media === "video" ? "video" : "image";
  try {
    const saved = JSON.parse(draftJson);
    const mode: CreativeComposerMode = ["image", "video", "chat"].includes(saved.mode) ? saved.mode : fallbackMode;
    const drafts: CreativeComposerState["drafts"] = {};
    for (const key of ["image", "video", "chat"] as const) {
      const draft = saved.modeDrafts?.[key];
      if (draft && Array.isArray(draft.refs) && draft.doc) drafts[key] = draft;
    }
    if (legacy && !drafts[mode]) drafts[mode] = legacy;
    return { mode, drafts };
  } catch { return { mode: fallbackMode, drafts: legacy ? { [fallbackMode]: legacy } : {} }; }
}

export function serializeCreativeComposerState(state: CreativeComposerState) {
  return JSON.stringify({ schema_version: 1, mode: state.mode, modeDrafts: state.drafts,
    composer: state.drafts[state.mode] ?? { doc: { type: "doc", content: [{ type: "paragraph" }] }, refs: [] } });
}

export function clearSentCreativeChatDraft(draftJson: string, sentDraftJson: string): string | null {
  const state = parseCreativeComposerState(draftJson);
  if (JSON.stringify(state.drafts.chat) !== sentDraftJson) return null;
  delete state.drafts.chat;
  return serializeCreativeComposerState(state);
}

export function parseCreativeComposerDraft(draftJson: string): CreationEditorDraft | null {
  try {
    const value = JSON.parse(draftJson) as {
      schema_version?: number;
      composer?: { doc?: unknown; refs?: PromptedAsset[]; generation?: CreationEditorDraft["generation"] };
    };
    if (value.schema_version !== 1 || !value.composer || !Array.isArray(value.composer.refs)) return null;
    return { doc: value.composer.doc, refs: value.composer.refs, ...(value.composer.generation ? { generation: value.composer.generation } : {}) };
  } catch {
    return null;
  }
}

export function serializeCreativeComposerDraft(composer: CreationEditorDraft) {
  return JSON.stringify({ schema_version: 1, composer });
}

export function isCreativeComposerDraftMeaningful(draftJson: string) {
  const state = parseCreativeComposerState(draftJson);
  return Object.values(state.drafts).some(isComposerMeaningful);
}

function isComposerMeaningful(composer: CreationEditorDraft | null) {
  if (!composer) return false;
  if (composer.refs.length > 0) return true;

  const text: string[] = [];
  let hasSemanticNode = false;
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as { type?: unknown; text?: unknown; content?: unknown };
    if (node.type === "text" && typeof node.text === "string") text.push(node.text);
    if (
      typeof node.type === "string"
      && !["doc", "paragraph", "text", "hard_break"].includes(node.type)
    ) {
      hasSemanticNode = true;
    }
    visit(node.content);
  };
  visit(composer.doc);

  if (hasSemanticNode) return true;
  const plainText = text.join("").trim();
  return plainText.length > 0 && plainText !== "请参考";
}
