import { NodeApi, type TElement } from "platejs";
import type { PlateEditor } from "platejs/react";
import { getListChildren } from "@platejs/list";

export function textBlockGroup(editor: PlateEditor, index: number): TElement[] {
  const node = editor.children[index];
  return [node, ...getListChildren(editor, [node, [index]]).map(([child]) => child)];
}

export function copyTextBlock(node: TElement): TElement {
  const copy = structuredClone(node);
  for (const [element] of NodeApi.elements(copy)) element.id = crypto.randomUUID();
  return copy;
}

export function readTextSelection(editor: PlateEditor) {
  const dom = window.getSelection();
  return dom?.rangeCount ? editor.api.toSlateRange(dom, { exactMatch: false, suppressThrow: true }) : editor.selection;
}

export function editTextBlock(editor: PlateEditor, index: number, kind: "copy" | "delete" | "after") {
  const group = textBlockGroup(editor, index);
  editor.tf.withNewBatch(() => editor.tf.withoutNormalizing(() => {
    if (kind === "delete") for (let offset = group.length - 1; offset >= 0; offset--) editor.tf.removeNodes({ at: [index + offset] });
    else {
      const nodes = kind === "copy" ? group.map(copyTextBlock) : [{ type: "p", id: crypto.randomUUID(), children: [{ text: "" }] }];
      editor.tf.insertNodes(nodes, { at: [index + group.length], select: true });
    }
  }));
}

/** A flat Plate list still moves as a parent and its indented children. */
export function moveTextBlock(editor: PlateEditor, from: number, slot: number) {
  const count = textBlockGroup(editor, from).length;
  if (slot >= from && slot <= from + count) return;
  const to = slot - (from < slot ? count : 0);
  const offsets = Array.from({ length: count }, (_, index) => index);
  if (to > from) offsets.reverse();
  editor.tf.withNewBatch(() => editor.tf.withoutNormalizing(() => {
    for (const offset of offsets) editor.tf.moveNodes({ at: [from + offset], to: [to + offset] });
  }));
}
