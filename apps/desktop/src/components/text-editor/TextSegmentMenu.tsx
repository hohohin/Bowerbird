import { useContext, useState, type ReactNode, type Ref } from 'react';
import { useEditorSelector, type PlateElementProps } from 'platejs/react';
import { BlockSelectionPlugin } from '@platejs/selection/react';
import { expandListItemsWithChildren } from '@platejs/list';
import { ContextMenu } from '../ContextMenu';
import { TextAgentContext } from '../TextAgent';
import { insertAfterTextBlock } from '../textBlockTransforms';
import { Button } from './plate/primitives/button';

export function TextSegmentMenu({ editor, element, children, handleRef, top }: Pick<PlateElementProps, 'editor' | 'element' | 'children'> & { children: ReactNode; handleRef: Ref<HTMLButtonElement>; top: number }) {
  const agent = useContext(TextAgentContext);
  const active = useEditorSelector(current => !!current.selection && current.children[current.selection.focus.path[0]]?.id === element.id, [element.id]);
  const [menu, setMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  function action(kind: 'copy' | 'delete' | 'after') {
    setMenu(null);
    const selection = editor.getApi(BlockSelectionPlugin).blockSelection;
    if (menu) selection.set(menu.ids);
    const nodes = selection.getNodes({ sort: true });
    if (kind === 'delete') editor.getTransforms(BlockSelectionPlugin).blockSelection.removeNodes();
    else if (kind === 'copy') editor.getTransforms(BlockSelectionPlugin).blockSelection.duplicate();
    else {
      const path = nodes[nodes.length - 1]?.[1] ?? editor.api.findPath(element);
      selection.deselect();
      if (path?.length === 1) insertAfterTextBlock(editor, path[0]);
      else if (path) editor.tf.insertNodes({ type: 'p', children: [{ text: '' }] }, { at: [...path.slice(0, -1), path[path.length - 1] + 1], select: true });
    }
    requestAnimationFrame(() => editor.tf.focus());
  }
  return <>
    {active && agent && <button className="text-segment-agent" contentEditable={false} onMouseDown={event => event.preventDefault()} onClick={event => agent(element.id as string, event.currentTarget.getBoundingClientRect())}>Agent</button>}
    <Button ref={handleRef} variant="ghost" className="absolute left-0 h-6 w-full p-0" style={{ top }} aria-label="段落操作" aria-haspopup="menu" aria-expanded={!!menu} data-plate-prevent-deselect onClick={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      const selected = editor.getApi(BlockSelectionPlugin).blockSelection.getNodes({ sort: true });
      const path = editor.api.findPath(element);
      if (!path) return;
      const nodes = selected.some(([node]) => node.id === element.id) ? selected : expandListItemsWithChildren(editor, [[element, path]]);
      setMenu({ x: rect.left, y: rect.bottom, ids: nodes.map(([node]) => node.id as string) });
    }}>{children}</Button>
    {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} label="段落操作">
      <button role="menuitem" className="app-context-item" onClick={() => action('after')}>下方插入段落</button>
      <button role="menuitem" className="app-context-item" onClick={() => action('copy')}>复制段落</button>
      <button role="menuitem" className="app-context-item is-danger" onClick={() => action('delete')}>删除段落</button>
    </ContextMenu>}
  </>;
}
