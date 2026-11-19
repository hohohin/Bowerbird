// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';
import { useEffect, useState } from 'react';
import { resolveDocumentAttachment } from '@/lib/documentAttachments';
import { userErrorMessage } from '@/lib/userError';


import type { PlateElementProps } from 'platejs/react';

import { useMediaState } from '@platejs/media/react';
import { ResizableProvider } from '@platejs/resizable';
import { FileUp } from 'lucide-react';
import { type TFileElement, sanitizeUrl } from 'platejs';
import { PlateElement, useReadOnly, withHOC } from 'platejs/react';

import { cn } from '@/components/text-editor/plate/lib/utils';
import { Caption, CaptionTextarea } from './caption';

export const FileElement = withHOC(
  ResizableProvider,
  function FileElement(props: PlateElementProps<TFileElement>) {
    const [error, setError] = useState('');
    const attachmentId = typeof props.element.attachmentId === 'string' ? props.element.attachmentId : undefined;
    useEffect(() => {
      if (!attachmentId) return;
      let active = true;
      void resolveDocumentAttachment(attachmentId).then(url => {
        if (active) props.editor.tf.withoutSaving(() => props.editor.tf.setNodes({ url }, { at: props.element }));
      }, cause => { if (active) setError(userErrorMessage(cause, '附件暂不可用，请重新插入原文件。')); });
      return () => { active = false; };
    }, [attachmentId, props.editor]);
    const readOnly = useReadOnly();
    const { name, unsafeUrl } = useMediaState();
    const url =
      sanitizeUrl(unsafeUrl, {
        allowedSchemes: ['blob', 'http', 'https'],
        permitInvalid: true,
      }) ?? undefined;

    return (
      <PlateElement className="my-px rounded-sm" {...props}>
        <a
          className={cn(
            'group relative m-0 flex cursor-pointer items-center rounded px-0.5 py-[3px] hover:bg-muted'
          )}
          contentEditable={false}
          download={name}
          href={url}
          rel="noopener noreferrer"
          role="button"
          target="_blank"
        >
          <div className={cn('flex items-center gap-1 p-1')}>
            <FileUp className="size-5" />
            <div>{name}</div>
          </div>

          <Caption align="left">
            <CaptionTextarea
              className="text-left"
              readOnly={readOnly}
              placeholder="添加说明…"
            />
          </Caption>
        </a>
        {error && <div contentEditable={false} role="alert">{error}</div>}
        {props.children}
      </PlateElement>
    );
  }
);
