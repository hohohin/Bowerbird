import { createPlatePlugin } from "platejs/react";
import { toggleList } from "@platejs/list";

/** Use Plate's matching/selection transforms; raw Markdown blocks stay literal. */
export const TextInputRules = createPlatePlugin({
  key: "documentInputRules",
  inputRules: ({ rule }) => {
    const blocks = [
      ...[1, 2, 3, 4, 5, 6].map(level => rule.blockStart({ trigger: " ", match: "#".repeat(level), node: `h${level}` })),
      rule.blockStart({ trigger: " ", match: ">", node: "blockquote", mode: "wrap" }),
      ...["disc", "decimal"].map(listStyleType => rule.blockStart({
        trigger: " ", match: listStyleType === "disc" ? /^[-+*]$/ : /^1[.)]$/,
        apply: ({ editor }, { range }) => {
          editor.tf.delete({ at: range });
          toggleList(editor, { listStyleType });
        },
      })),
    ].map(input => ({ ...input, enabled: ({ editor, getBlockEntry }) => !editor.api.isComposing() && getBlockEntry()?.[0].type === "p" && !getBlockEntry()?.[0].listStyleType,
      apply: (context, match) => context.editor.tf.withNewBatch(() => input.apply(context, match)),
    } satisfies typeof input));
    const marks = [["**", "bold"], ["__", "bold"], ["*", "italic"], ["_", "italic"], ["`", "code"]].map(([delimiter, mark]) => {
      const input = rule.mark({ start: delimiter, end: delimiter.slice(0, -1), trigger: delimiter.slice(-1), mark });
      return { ...input, enabled: ({ editor, getBlockEntry }) => !editor.api.isComposing() && getBlockEntry()?.[0].type !== "raw" && !editor.api.marks()?.code,
        apply: (context, match) => context.editor.tf.withNewBatch(() => input.apply(context, match)),
      } satisfies typeof input;
    });
    return [...blocks, ...marks];
  },
});
