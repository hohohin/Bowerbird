// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import { createPlatePlugin } from 'platejs/react';

import { FixedToolbar } from '@/components/text-editor/plate/ui/fixed-toolbar';
import { FixedToolbarButtons } from '@/components/text-editor/plate/ui/fixed-toolbar-buttons';

export const FixedToolbarKit = [
  createPlatePlugin({
    key: 'fixed-toolbar',
    render: {
      beforeEditable: () => (
        <FixedToolbar>
          <FixedToolbarButtons />
        </FixedToolbar>
      ),
    },
  }),
];
