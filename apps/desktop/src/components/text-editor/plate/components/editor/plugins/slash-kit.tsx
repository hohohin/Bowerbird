// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import { SlashInputPlugin, SlashPlugin } from '@platejs/slash-command/react';
import { type SlateEditor, KEYS } from 'platejs';

import { SlashInputElement } from '@/components/text-editor/plate/ui/slash-node';

export const SlashKit = [
  SlashPlugin.configure({
    options: {
      triggerQuery: (editor: SlateEditor) =>
        !editor.api.some({
          match: { type: editor.getType(KEYS.codeBlock) },
        }),
    },
  }),
  SlashInputPlugin.withComponent(SlashInputElement),
];
