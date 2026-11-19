// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import { ExitBreakPlugin } from 'platejs';

export const ExitBreakKit = [
  ExitBreakPlugin.configure({
    shortcuts: {
      insert: { keys: 'mod+enter' },
      insertBefore: { keys: 'mod+shift+enter' },
    },
  }),
];
