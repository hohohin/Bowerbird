// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import { ListStyleType, toggleList } from '@platejs/list';
import { List, ListOrdered } from 'lucide-react';
import { useEditorRef } from 'platejs/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../primitives/dropdown-menu';
import { ToolbarButton } from './toolbar';

const styles = [
  [ListStyleType.Circle, '空心圆'],
  [ListStyleType.Square, '方块'],
  [ListStyleType.LowerAlpha, '小写字母'],
  [ListStyleType.UpperAlpha, '大写字母'],
  [ListStyleType.LowerRoman, '小写罗马数字'],
  [ListStyleType.UpperRoman, '大写罗马数字'],
] as const;

export function ListToolbarButton() {
  const editor = useEditorRef();
  const changeList = (listStyleType: ListStyleType) => {
    if (!editor.selection) {
      const end = editor.api.end([]);
      if (end) editor.tf.select(end);
    }
    toggleList(editor, { listStyleType });
    editor.tf.focus();
  };

  return <DropdownMenu modal={false}>
    <DropdownMenuTrigger asChild><ToolbarButton aria-label="列表" tooltip="列表"><List /></ToolbarButton></DropdownMenuTrigger>
    <DropdownMenuContent align="start" onCloseAutoFocus={event => { event.preventDefault(); editor.tf.focus(); }}>
      <DropdownMenuItem onSelect={() => changeList(ListStyleType.Disc)}><List />无序列表</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => changeList(ListStyleType.Decimal)}><ListOrdered />有序列表</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>列表样式</DropdownMenuSubTrigger>
        <DropdownMenuPortal>
          <DropdownMenuSubContent>
            {styles.map(([style, name]) => <DropdownMenuItem key={style} onSelect={() => changeList(style)}>{name}</DropdownMenuItem>)}
          </DropdownMenuSubContent>
        </DropdownMenuPortal>
      </DropdownMenuSub>
    </DropdownMenuContent>
  </DropdownMenu>;
}
