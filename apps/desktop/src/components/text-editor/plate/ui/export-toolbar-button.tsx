// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
import { useState } from 'react';
import type { DropdownMenuProps } from '@radix-ui/react-dropdown-menu';
import { ArrowDownToLineIcon } from 'lucide-react';
import { useEditorRef } from 'platejs/react';
import { notifyError } from '@/lib/notify';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../primitives/dropdown-menu';
import { ToolbarButton } from './toolbar';

const formats = [['html', 'HTML'], ['pdf', 'PDF'], ['png', '图片'], ['md', 'Markdown'], ['docx', 'Word']] as const;
export function ExportToolbarButton(props: DropdownMenuProps) {
  const editor = useEditorRef();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  async function save(format: typeof formats[number][0]) {
    setBusy(true);
    try { const { exportDocument } = await import('../../textEditorExport'); await exportDocument(editor, format); }
    catch (error) { notifyError(error, '导出失败，请检查文档中的媒体是否可访问后重试。'); }
    finally { setBusy(false); }
  }
  return <DropdownMenu open={open} onOpenChange={setOpen} modal={false} {...props}>
    <DropdownMenuTrigger asChild><ToolbarButton disabled={busy} pressed={open} tooltip="导出" isDropdown><ArrowDownToLineIcon className="size-4"/></ToolbarButton></DropdownMenuTrigger>
    <DropdownMenuContent align="start">{formats.map(([format, label]) => <DropdownMenuItem key={format} onSelect={() => { void save(format); }}>导出 {label}</DropdownMenuItem>)}</DropdownMenuContent>
  </DropdownMenu>;
}
