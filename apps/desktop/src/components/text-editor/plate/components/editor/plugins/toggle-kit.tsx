// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import { TogglePlugin } from '@platejs/toggle/react';

import { IndentKit } from '@/components/text-editor/plate/components/editor/plugins/indent-kit';
import { ToggleElement } from '@/components/text-editor/plate/ui/toggle-node';

export const ToggleKit = [
  ...IndentKit,
  TogglePlugin.withComponent(ToggleElement),
];
