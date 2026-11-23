// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import { CodeDrawingPlugin } from '@platejs/code-drawing/react';
import type { TCodeDrawingElement } from '@platejs/code-drawing';

import { lazyPlateElement } from '../../../ui/lazy-plate-element';

const CodeDrawingElement = lazyPlateElement<TCodeDrawingElement>(() => import('../../../ui/code-drawing-node').then(module => ({ default: module.CodeDrawingElement })), '正在加载代码绘图…');

export const CodeDrawingKit = [
  CodeDrawingPlugin.withComponent(CodeDrawingElement),
];
