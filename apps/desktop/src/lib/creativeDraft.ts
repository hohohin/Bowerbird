import type { PromptedAsset } from "./types";
import type { CreationEditorDraft } from "../components/creation/useCreationEditor";

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
  const composer = parseCreativeComposerDraft(draftJson);
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
