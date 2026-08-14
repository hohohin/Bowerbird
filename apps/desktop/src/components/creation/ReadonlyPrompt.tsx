import { useEffect, useRef } from "react";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { Asset, PromptedAsset } from "../../lib/types";
import { parsePromptToDoc } from "./parse";

/** 用创作板同一套节点规则展示生成时的原始输入，但不开放编辑与节点交互。 */
export function ReadonlyPrompt({
  prompt,
  references,
}: {
  prompt: string;
  references: Asset[];
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren();
    const promptedReferences = references as PromptedAsset[];
    const assetById = new Map(promptedReferences.map((reference) => [reference.id, reference]));
    const doc = parsePromptToDoc(prompt, promptedReferences, assetById);
    const view = new EditorView(host, {
      state: EditorState.create({ doc }),
      editable: () => false,
      attributes: {
        "aria-label": "生成时的原始创作内容",
        "aria-readonly": "true",
      },
    });
    return () => {
      view.destroy();
      host.replaceChildren();
    };
  }, [prompt, references]);

  return <div ref={hostRef} className="creation-editor creation-editor-readonly" />;
}
