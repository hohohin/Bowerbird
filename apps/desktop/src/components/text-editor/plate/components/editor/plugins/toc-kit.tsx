// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import { TocPlugin } from '@platejs/toc/react';

import { TocElement } from '@/components/text-editor/plate/ui/toc-node';

export const TocKit = [
  TocPlugin.configure({
    options: {
      // isScroll: true,
      topOffset: 80,
    },
  }).withComponent(TocElement),
];
