// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import { CodeDrawingPlugin } from '@platejs/code-drawing/react';

import { CodeDrawingElement } from '@/components/text-editor/plate/ui/code-drawing-node';

export const CodeDrawingKit = [
  CodeDrawingPlugin.withComponent(CodeDrawingElement),
];
