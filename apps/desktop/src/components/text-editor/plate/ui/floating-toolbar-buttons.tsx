// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import { WandSparklesIcon } from 'lucide-react';

import { AIToolbarButton } from './ai-toolbar-button';
import { MoreToolbarButton } from './more-toolbar-button';
import { SelectionFormatButton, useSelectionFormats } from './selection-formats';

export function FloatingToolbarButtons() {
  const active = useSelectionFormats();
  return <>
    <AIToolbarButton className="text-plate-format-agent" tooltip="Agent 指令"><WandSparklesIcon />Agent</AIToolbarButton>
    {active.map(format => <SelectionFormatButton key={format} format={format} />)}
    <MoreToolbarButton active={active} />
  </>;
}
