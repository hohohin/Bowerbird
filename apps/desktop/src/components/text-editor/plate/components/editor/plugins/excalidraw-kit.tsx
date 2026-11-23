'use client';

import { ExcalidrawPlugin } from '@platejs/excalidraw/react';

import type { DocumentDrawingElement } from '../../../ui/excalidraw-node';
import { lazyPlateElement } from '../../../ui/lazy-plate-element';

const ExcalidrawElement = lazyPlateElement<DocumentDrawingElement>(() => import('../../../ui/excalidraw-node').then(module => ({ default: module.ExcalidrawElement })), '正在打开绘图…');

export const ExcalidrawKit = [
  ExcalidrawPlugin.withComponent(ExcalidrawElement),
];
