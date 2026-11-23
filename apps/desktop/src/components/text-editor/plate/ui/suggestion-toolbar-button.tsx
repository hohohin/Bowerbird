// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';


import { SuggestionPlugin } from '@platejs/suggestion/react';
import { PencilLineIcon } from 'lucide-react';
import { useEditorPlugin, usePluginOption } from 'platejs/react';

import { cn } from '@/components/text-editor/plate/lib/utils';

import { ToolbarButton } from './toolbar';

export function SuggestionToolbarButton({ labeled = false }: { labeled?: boolean }) {
  const { setOption } = useEditorPlugin(SuggestionPlugin);
  const isSuggesting = usePluginOption(SuggestionPlugin, 'isSuggesting');

  return (
    <ToolbarButton
      className={cn(isSuggesting && 'text-brand/80 hover:text-brand/80')}
      onClick={() => setOption('isSuggesting', !isSuggesting)}
      onMouseDown={(e) => e.preventDefault()}
      aria-pressed={isSuggesting}
      tooltip={isSuggesting ? '关闭修订' : '修订'}
    >
      <PencilLineIcon />
      {labeled && (isSuggesting ? '关闭修订' : '修订')}
    </ToolbarButton>
  );
}
