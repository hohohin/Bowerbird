// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import { BoldIcon, ItalicIcon, WandSparklesIcon } from 'lucide-react';
import { KEYS } from 'platejs';
import { useEditorReadOnly } from 'platejs/react';

import { AIToolbarButton } from './ai-toolbar-button';
import { ExportToolbarButton } from './export-toolbar-button';
import { RedoToolbarButton, UndoToolbarButton } from './history-toolbar-button';
import { InsertToolbarButton, type InsertSourceAction } from './insert-toolbar-button';
import { ListToolbarButton } from './list-toolbar-button';
import { MarkToolbarButton } from './mark-toolbar-button';
import { TurnIntoToolbarButton } from './turn-into-toolbar-button';

export function FixedToolbarButtons({ insertSource }: { insertSource?: InsertSourceAction }) {
  const readOnly = useEditorReadOnly();

  return <div className="text-plate-format-actions">
    {!readOnly && <>
      <div className="text-plate-format-group" role="group" aria-label="历史">
        <UndoToolbarButton />
        <RedoToolbarButton />
      </div>
      <div className="text-plate-format-group" role="group" aria-label="基础格式">
        <TurnIntoToolbarButton />
        <MarkToolbarButton nodeType={KEYS.bold} tooltip="加粗"><BoldIcon /></MarkToolbarButton>
        <MarkToolbarButton nodeType={KEYS.italic} tooltip="斜体"><ItalicIcon /></MarkToolbarButton>
        <ListToolbarButton />
      </div>
      <div className="text-plate-format-group" role="group" aria-label="插入">
        <InsertToolbarButton source={insertSource} />
      </div>
    </>}
    <div className="text-plate-format-output text-plate-format-group" role="group" aria-label="Agent 与导出">
      {!readOnly && <AIToolbarButton className="text-plate-format-agent" tooltip="Agent 指令"><WandSparklesIcon />Agent</AIToolbarButton>}
      <ExportToolbarButton />
    </div>
  </div>;
}
