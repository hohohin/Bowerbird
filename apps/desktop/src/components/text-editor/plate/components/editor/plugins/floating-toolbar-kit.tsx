// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import { createPlatePlugin } from 'platejs/react';

import { FloatingToolbar } from '@/components/text-editor/plate/ui/floating-toolbar';
import { FloatingToolbarButtons } from '@/components/text-editor/plate/ui/floating-toolbar-buttons';

export const FloatingToolbarKit = [
  createPlatePlugin({
    key: 'floating-toolbar',
    render: {
      afterEditable: () => (
        <FloatingToolbar>
          <FloatingToolbarButtons />
        </FloatingToolbar>
      ),
    },
  }),
];
