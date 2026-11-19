import type { PlateEditor } from "platejs/react";
import { getListChildren } from "@platejs/list";

export function readTextSelection(editor: PlateEditor) {
  const dom = window.getSelection();
  return dom?.rangeCount ? editor.api.toSlateRange(dom, { exactMatch: false, suppressThrow: true }) : editor.selection;
}

/** Reuse the empty body paragraph at the end; other blocks get a new body row. */
export function focusTextTail(editor: PlateEditor) {
  const last = editor.children[editor.children.length - 1];
  if (!last || editor.api.isVoid(last) || !editor.api.isEmpty(last)) {
    editor.tf.withNewBatch(() => editor.tf.insertNodes(
      { type: "p", id: crypto.randomUUID(), children: [{ text: "" }] },
      { at: [editor.children.length], select: true },
    ));
  }
  editor.tf.focus({ at: editor.api.end([]) });
}

export function insertAfterTextBlock(editor: PlateEditor, index: number) {
  const count = 1 + getListChildren(editor, [editor.children[index], [index]]).length;
  editor.tf.withNewBatch(() => editor.tf.insertNodes(
    { type: "p", id: crypto.randomUUID(), children: [{ text: "" }] },
    { at: [index + count], select: true },
  ));
}
