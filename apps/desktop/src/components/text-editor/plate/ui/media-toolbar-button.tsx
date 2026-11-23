// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import * as React from 'react';
import { isUrl, KEYS } from 'platejs';
import { useEditorRef } from 'platejs/react';
import { notifyError } from '@/lib/notify';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../primitives/alert-dialog';
import { Input } from '../primitives/input';

const mediaTitles = {
  [KEYS.audio]: '插入音频',
  [KEYS.file]: '插入附件',
  [KEYS.img]: '插入图片',
  [KEYS.video]: '插入视频',
};

export type MediaNodeType = keyof typeof mediaTitles;

export function MediaUrlDialog({ nodeType, close }: { nodeType: MediaNodeType; close(): void }) {
  return <AlertDialog open onOpenChange={value => { if (!value) close(); }}>
    <AlertDialogContent className="gap-6">
      <MediaUrlDialogContent nodeType={nodeType} close={close}/>
    </AlertDialogContent>
  </AlertDialog>;
}
function MediaUrlDialogContent({
  nodeType,
  close,
}: {
  nodeType: MediaNodeType;
  close(): void;
}) {
  const editor = useEditorRef();
  const [url, setUrl] = React.useState('');

  const embedMedia = React.useCallback(() => {
    if (!isUrl(url)) return notifyError('请输入有效的媒体链接。', '请输入有效的媒体链接。');

    close();
    editor.tf.insertNodes({
      children: [{ text: '' }],
      name: nodeType === KEYS.file ? url.split('/').pop() : undefined,
      type: nodeType,
      url,
    });
  }, [url, editor, nodeType, close]);

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{mediaTitles[nodeType]}</AlertDialogTitle>
      </AlertDialogHeader>

      <AlertDialogDescription className="group relative w-full">
        <label
          className="-translate-y-1/2 absolute top-1/2 block cursor-text px-1 text-muted-foreground/70 text-sm transition-all group-focus-within:pointer-events-none group-focus-within:top-0 group-focus-within:cursor-default group-focus-within:font-medium group-focus-within:text-foreground group-focus-within:text-xs has-[+input:not(:placeholder-shown)]:pointer-events-none has-[+input:not(:placeholder-shown)]:top-0 has-[+input:not(:placeholder-shown)]:cursor-default has-[+input:not(:placeholder-shown)]:font-medium has-[+input:not(:placeholder-shown)]:text-foreground has-[+input:not(:placeholder-shown)]:text-xs"
          htmlFor="url"
        >
          <span className="inline-flex bg-background px-2">URL</span>
        </label>
        <Input
          id="url"
          className="w-full"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') embedMedia();
          }}
          placeholder=""
          type="url"
          autoFocus
        />
      </AlertDialogDescription>

      <AlertDialogFooter>
        <AlertDialogCancel>取消</AlertDialogCancel>
        <AlertDialogAction
          onClick={(e) => {
            e.preventDefault();
            embedMedia();
          }}
        >
          接受
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  );
}
