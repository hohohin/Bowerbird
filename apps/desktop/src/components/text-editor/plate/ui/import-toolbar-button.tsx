// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
import { useEffect, useRef, useState } from 'react';
import type { DropdownMenuProps } from '@radix-ui/react-dropdown-menu';
import { ArrowUpToLineIcon } from 'lucide-react';
import { getCommentKey } from '@platejs/comment';
import { getEditorDOMFromHtmlString } from 'platejs/static';
import { useEditorRef } from 'platejs/react';
import { parseMarkdown } from '@/lib/documentCodec';
import { notifyError } from '@/lib/notify';
import { discussionPlugin } from '../components/editor/plugins/discussion-kit';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../primitives/dropdown-menu';
import { ToolbarButton } from './toolbar';

export function ImportToolbarButton(props: DropdownMenuProps) {
  const editor = useEditorRef();
  const [open, setOpen] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function choose(format: 'html' | 'md' | 'docx') {
    const bookmark = editor.selection ? editor.api.rangeRef(editor.selection) : null;
    const input = document.createElement('input');
    input.type = 'file'; input.accept = format === 'md' ? '.md,.mdx' : `.${format}`;
    input.oncancel = () => bookmark?.unref();
    input.onchange = async () => {
      try {
        const file = input.files?.[0];
        if (!file) return;
        let nodes: typeof editor.children;
        let discussions = [] as ReturnType<typeof parseMarkdown>['discussions'];
        if (format === 'docx') {
          const { importDocx } = await import('../../textEditorDocx');
          nodes = (await importDocx(editor, await file.arrayBuffer())).nodes as typeof nodes;
        } else if (format === 'html') nodes = editor.api.html.deserialize({ element: getEditorDOMFromHtmlString(await file.text()) }) as typeof nodes;
        else { const value = parseMarkdown(await file.text()); nodes = value; discussions = value.discussions; }
        if (!mounted.current) return;
        const keys = new Map<string, string>();
        for (const discussion of discussions ?? []) {
          const id = crypto.randomUUID(); keys.set(getCommentKey(discussion.id), getCommentKey(id));
          discussion.id = id;
          discussion.comments.forEach(comment => { comment.id = crypto.randomUUID(); comment.discussionId = id; });
        }
        const copy = (value: unknown): unknown => Array.isArray(value) ? value.map(copy) : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [keys.get(key) ?? key, key === 'id' ? crypto.randomUUID() : copy(entry)])) : value;
        if (bookmark?.current) editor.tf.select(bookmark.current);
        editor.tf.insertFragment(copy(nodes) as typeof nodes);
        if (discussions?.length) editor.setOption(discussionPlugin, 'discussions', [...editor.getOption(discussionPlugin, 'discussions'), ...discussions]);
        editor.tf.focus();
      } catch (error) { notifyError(error, '无法导入此文档，请检查文件格式后重试。'); }
      finally { bookmark?.unref(); }
    };
    input.click();
  }
  return <DropdownMenu open={open} onOpenChange={setOpen} modal={false} {...props}>
    <DropdownMenuTrigger asChild><ToolbarButton pressed={open} tooltip="导入" isDropdown><ArrowUpToLineIcon className="size-4"/></ToolbarButton></DropdownMenuTrigger>
    <DropdownMenuContent align="start">
      <DropdownMenuItem onSelect={() => choose('html')}>导入 HTML</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => choose('md')}>导入 Markdown</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => choose('docx')}>导入 Word</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
