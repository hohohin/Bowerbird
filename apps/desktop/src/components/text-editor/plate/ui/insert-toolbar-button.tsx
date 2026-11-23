// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import { AudioLinesIcon, FileUpIcon, FilmIcon, ImageIcon, LinkIcon, PlusIcon, SlashIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { KEYS } from 'platejs';
import { useEditorRef } from 'platejs/react';
import { PlaceholderPlugin } from '@platejs/media/react';
import { useFilePicker } from 'use-file-picker';

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
import { insertInlineElement } from '../components/editor/transforms';
import { MediaUrlDialog, type MediaNodeType } from './media-toolbar-button';
import { openTextSlashMenu } from './slash-node';
import { ToolbarButton } from './toolbar';

export interface InsertSourceAction {
  label: string;
  disabled?: boolean;
  run(): void;
}

const mediaLinks = [
  [KEYS.img, '图片', ImageIcon],
  [KEYS.audio, '音频', AudioLinesIcon],
  [KEYS.video, '视频', FilmIcon],
  [KEYS.file, '附件', FileUpIcon],
] as const;

export function InsertToolbarButton({ source }: { source?: InsertSourceAction }) {
  const editor = useEditorRef();
  const afterClose = useRef<(() => void) | null>(null);
  const [mediaUrl, setMediaUrl] = useState<MediaNodeType>();
  const onFilesSelected = ({ plainFiles }: { plainFiles: FileList }) => {
    if (!editor.selection) {
      const end = editor.api.end([]);
      if (end) editor.tf.select(end);
    }
    editor.getTransforms(PlaceholderPlugin).insert.media(plainFiles);
  };
  const images = useFilePicker({ accept: ['image/*'], multiple: true, onFilesSelected });
  const audiovisual = useFilePicker({ accept: ['audio/*', 'video/*'], multiple: true, onFilesSelected });
  const attachments = useFilePicker({ accept: ['*'], multiple: true, onFilesSelected });

  return <>
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton tooltip="插入素材"><PlusIcon /><span className="text-plate-format-caption">插入素材</span></ToolbarButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" onCloseAutoFocus={event => {
        if (!afterClose.current) return;
        event.preventDefault();
        const action = afterClose.current;
        afterClose.current = null;
        action();
      }}>
        {source && <DropdownMenuItem disabled={source.disabled} onSelect={source.run}><ImageIcon />{source.label}</DropdownMenuItem>}
        <DropdownMenuItem onSelect={images.openFilePicker}><ImageIcon />选择本地图片</DropdownMenuItem>
        <DropdownMenuItem onSelect={audiovisual.openFilePicker}><FilmIcon />选择本地音视频</DropdownMenuItem>
        <DropdownMenuItem onSelect={attachments.openFilePicker}><FileUpIcon />选择本地附件</DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger><LinkIcon />通过链接插入媒体</DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent>
              {mediaLinks.map(([type, label, Icon]) => <DropdownMenuItem key={type} onSelect={() => {
                afterClose.current = () => setMediaUrl(type);
              }}><Icon />{label}</DropdownMenuItem>)}
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => {
          afterClose.current = () => {
            if (!editor.selection) {
              const end = editor.api.end([]);
              if (end) editor.tf.select(end);
            }
            insertInlineElement(editor, KEYS.link);
          };
        }}><LinkIcon />插入链接</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => {
          afterClose.current = () => openTextSlashMenu(editor);
        }}><SlashIcon />插入其他块…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {mediaUrl && <MediaUrlDialog nodeType={mediaUrl} close={() => setMediaUrl(undefined)} />}
  </>;
}
