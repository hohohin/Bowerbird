// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
import { BaseTogglePlugin } from '@platejs/toggle';

import { ToggleElementStatic } from '@/components/text-editor/plate/ui/toggle-node-static';

export const BaseToggleKit = [
  BaseTogglePlugin.withComponent(ToggleElementStatic),
];
