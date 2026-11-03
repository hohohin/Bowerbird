import { createContext, useContext, useState, type DragEvent, type MutableRefObject } from "react";
import { GripVertical } from "lucide-react";
import { useEditorSelector, type PlateElementProps } from "platejs/react";
import { ContextMenu } from "./ContextMenu";
import { TextAgentContext } from "./TextAgent";

export const BlockDragContext = createContext<MutableRefObject<string | null>>({ current: null });
const blockMime = "application/x-bowerbird-document-block";
export function useBlockDrop({ editor, element }: PlateElementProps) {
  const drag = useContext(BlockDragContext);
  return {
    onDragOver(event: DragEvent) {
      if (!drag.current || !event.dataTransfer.types.includes(blockMime)) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
    },
    onDrop(event: DragEvent) {
      if (!drag.current || !event.dataTransfer.types.includes(blockMime)) return;
      event.preventDefault(); event.stopPropagation();
      const from = editor.children.findIndex(node => node.id === drag.current);
      const path = editor.api.findPath(element);
      drag.current = null;
      if (from < 0 || !path || path.length !== 1) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const slot = path[0] + Number(event.clientY > rect.top + rect.height / 2);
      const to = slot - Number(from < slot);
      if (to !== from) editor.tf.moveNodes({ at: [from], to: [to] });
      editor.tf.focus();
    },
  };
}
export function TextBlockActions({ editor, element }: PlateElementProps) {
  const drag = useContext(BlockDragContext);
  const openAgent = useContext(TextAgentContext);
  const active = useEditorSelector(editor => !!editor.selection && editor.children[editor.selection.focus.path[0]]?.id === element.id, [element.id]);
  const [menu, setMenu] = useState<{x:number;y:number} | null>(null);
  function action(kind: "copy" | "delete" | "after") {
    const path = editor.api.findPath(element);
    setMenu(null);
    if (!path) return;
    if (kind === "delete") editor.tf.removeNodes({ at: path });
    else {
      const node = kind === "copy" ? { ...structuredClone(element), id: crypto.randomUUID() }
        : { type: "p", id: crypto.randomUUID(), children: [{ text: "" }] };
      editor.tf.insertNodes(node, { at: [path[0] + 1], select: true });
    }
    requestAnimationFrame(() => editor.tf.focus());
  }
  return <span contentEditable={false} className={`text-block-actions${active && openAgent ? " has-agent" : ""}`}>
    {active && openAgent && <button type="button" className="text-block-agent" onMouseDown={event => event.preventDefault()} onClick={event => openAgent(String(element.id), event.currentTarget.getBoundingClientRect())}>Agent</button>}
    <button type="button" tabIndex={-1} aria-label="段落操作" title="拖动排序 · 点击操作" draggable
      onDragStart={event => { drag.current = String(element.id); event.dataTransfer.setData(blockMime, String(element.id)); event.dataTransfer.effectAllowed = "move"; event.stopPropagation(); }}
      onDragEnd={() => { drag.current = null; }} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({x:rect.left,y:rect.bottom}); }}><GripVertical size={14}/></button>
    {menu && <ContextMenu {...menu} label="段落操作" onClose={() => setMenu(null)}>
      <button role="menuitem" className="app-context-item" onClick={() => action("after")}>下方插入段落</button>
      <button role="menuitem" className="app-context-item" onClick={() => action("copy")}>复制段落</button>
      <button role="menuitem" className="app-context-item is-danger" onClick={() => action("delete")}>删除段落</button>
    </ContextMenu>}
  </span>;
}
