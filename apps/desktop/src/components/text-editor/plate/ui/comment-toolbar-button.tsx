// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';


import { MessageSquareTextIcon } from 'lucide-react';
import { useEditorRef } from 'platejs/react';

import { commentPlugin } from '@/components/text-editor/plate/components/editor/plugins/comment-kit';

import { ToolbarButton } from './toolbar';

export function CommentToolbarButton({ labeled = false }: { labeled?: boolean }) {
  const editor = useEditorRef();

  return (
    <ToolbarButton
      onClick={() => {
        editor.getTransforms(commentPlugin).comment.setDraft();
      }}
      data-plate-prevent-overlay
      tooltip="评论"
    >
      <MessageSquareTextIcon />
      {labeled && '评论'}
    </ToolbarButton>
  );
}
