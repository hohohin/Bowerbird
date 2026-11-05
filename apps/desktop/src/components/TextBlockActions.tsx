import { createContext, useContext, useEffect, useState, type DragEvent, type MutableRefObject } from "react";
import { GripVertical } from "lucide-react";
import { useEditorSelector, type PlateElementProps, type PlateEditor } from "platejs/react";
import { ContextMenu } from "./ContextMenu";
import { TextAgentContext } from "./TextAgent";
import { editTextBlock, moveTextBlock, textBlockGroup } from "./textBlockTransforms";

export const BlockDragContext = createContext<MutableRefObject<string | null>>({ current: null });
const blockMime = "application/x-bowerbird-document-block";
function dropBlock(editor: PlateEditor, element: PlateElementProps["element"], id: string, event: DragEvent) {
  const from = editor.children.findIndex(node => node.id === id);
  const path = editor.api.findPath(element);
  if (from < 0 || !path || path.length !== 1) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const slot = path[0] + (event.clientY > rect.top + rect.height / 2 ? textBlockGroup(editor, path[0]).length : 0);
  moveTextBlock(editor, from, slot);
  editor.tf.focus();
}
export function useBlockDrop({ editor, element }: PlateElementProps) {
  const drag = useContext(BlockDragContext);
  const [edge, setEdge] = useState<"before" | "after" | undefined>();
  useEffect(() => {
    const clear = () => setEdge(undefined);
    window.addEventListener("dragend", clear); window.addEventListener("drop", clear);
    return () => { window.removeEventListener("dragend", clear); window.removeEventListener("drop", clear); };
  }, []);
  return {
    "data-drop-edge": edge,
    onDragOver(event: DragEvent) {
      if (!drag.current || !event.dataTransfer.types.includes(blockMime)) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
      const rect = event.currentTarget.getBoundingClientRect();
      setEdge(event.clientY > rect.top + rect.height / 2 ? "after" : "before");
    },
    onDragLeave(event: DragEvent) {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setEdge(undefined);
    },
    onDrop(event: DragEvent) {
      if (!drag.current || !event.dataTransfer.types.includes(blockMime)) return;
      event.preventDefault(); event.stopPropagation();
      setEdge(undefined);
      dropBlock(editor, element, drag.current, event);
      drag.current = null;
    },
  };
}
export function TextBlockShell(props: PlateElementProps) {
  const drop = useBlockDrop(props);
  return <div className="text-document-block" data-list={props.element.listStyleType ? "true" : undefined} data-block-type={props.element.type} {...drop}>
    <TextBlockActions {...props}/>{props.children}
  </div>;
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
    editTextBlock(editor, path[0], kind);
    requestAnimationFrame(() => editor.tf.focus());
  }
  return <span contentEditable={false} className={`text-block-actions${active && openAgent ? " has-agent" : ""}`}>
    {active && openAgent && <button type="button" className="text-block-agent" onMouseDown={event => event.preventDefault()} onClick={event => openAgent(String(element.id), event.currentTarget.getBoundingClientRect())}>Agent</button>}
    <button type="button" tabIndex={-1} aria-label="段落操作" aria-haspopup="menu" aria-expanded={!!menu} title="拖动排序 · 点击操作" draggable
      onDragStart={event => { drag.current = String(element.id); event.dataTransfer.setData(blockMime, String(element.id)); event.dataTransfer.effectAllowed = "move"; event.stopPropagation(); }}
      onDragEnd={() => { drag.current = null; }} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({x:rect.left,y:rect.bottom}); }}><GripVertical size={14}/></button>
    {menu && <ContextMenu {...menu} label="段落操作" onClose={() => setMenu(null)}>
      <button role="menuitem" className="app-context-item" onClick={() => action("after")}>下方插入段落</button>
      <button role="menuitem" className="app-context-item" onClick={() => action("copy")}>复制段落</button>
      <button role="menuitem" className="app-context-item is-danger" onClick={() => action("delete")}>删除段落</button>
    </ContextMenu>}
  </span>;
}
