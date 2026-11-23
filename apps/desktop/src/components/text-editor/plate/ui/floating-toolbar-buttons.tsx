// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import { BoldIcon, ItalicIcon, WandSparklesIcon } from 'lucide-react';
import { KEYS } from 'platejs';

import { AIToolbarButton } from './ai-toolbar-button';
import { LinkToolbarButton } from './link-toolbar-button';
import { MarkToolbarButton } from './mark-toolbar-button';
import { MoreToolbarButton } from './more-toolbar-button';

export function FloatingToolbarButtons() {
  return <>
    <AIToolbarButton className="text-plate-format-agent" tooltip="Agent 指令"><WandSparklesIcon />Agent</AIToolbarButton>
    <MarkToolbarButton nodeType={KEYS.bold} tooltip="加粗"><BoldIcon /></MarkToolbarButton>
    <MarkToolbarButton nodeType={KEYS.italic} tooltip="斜体"><ItalicIcon /></MarkToolbarButton>
    <LinkToolbarButton />
    <MoreToolbarButton />
  </>;
}
