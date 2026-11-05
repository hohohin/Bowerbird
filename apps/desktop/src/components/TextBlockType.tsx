import { useEffect, useState } from "react";
import { ElementApi, type TRange } from "platejs";
import { useEditorRef, useEditorSelector, type PlateEditor } from "platejs/react";
import { ChevronDown } from "lucide-react";
import { ContextMenu } from "./ContextMenu";
import { readTextSelection } from "./textBlockTransforms";

const types = [{ type: "p", label: "正文" }, ...[1, 2, 3, 4, 5, 6].map(level => ({ type: `h${level}`, label: `标题 ${level}` }))];
function changeType(editor: PlateEditor, type: string, range: TRange | null) {
  if (range) editor.tf.select(range);
  editor.tf.withNewBatch(() => editor.tf.setNodes({ type }, { match: node => ElementApi.isElement(node) && editor.api.isBlock(node) && !editor.api.isVoid(node) }));
  const at = editor.selection ?? undefined;
  requestAnimationFrame(() => editor.tf.focus({ at }));
}

export function TextBlockType() {
  const editor = useEditorRef();
  const type = useEditorSelector(editor => editor.api.block()?.[0].type, []);
  const [menu, setMenu] = useState<{ x: number; y: number; trigger: HTMLButtonElement; selection: ReturnType<typeof editor.api.rangeRef> } | null>(null);
  useEffect(() => () => { menu?.selection.unref(); }, [menu]);
  return <><button type="button" className="text-block-type" aria-label="段落类型" aria-haspopup="menu" aria-expanded={!!menu} onClick={event => {
    const rect = event.currentTarget.getBoundingClientRect();
    const range = readTextSelection(editor);
    if (range) setMenu({ x: rect.left, y: rect.bottom + 4, trigger: event.currentTarget, selection: editor.api.rangeRef(range) });
  }}>{types.find(item => item.type === type)?.label ?? "正文"}<ChevronDown size={12}/></button>
    {menu && <ContextMenu {...menu} label="段落类型" onClose={() => setMenu(null)}>{types.map(item => <button key={item.type} role="menuitemradio" aria-checked={type === item.type} className="app-context-item" onClick={() => {
      changeType(editor, item.type, menu.selection.current);
      setMenu(null);
    }}>{item.label}</button>)}</ContextMenu>}
  </>;
}
