// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
import { BaseCalloutPlugin } from '@platejs/callout';

import { CalloutElementStatic } from '@/components/text-editor/plate/ui/callout-node-static';

export const BaseCalloutKit = [
  BaseCalloutPlugin.withComponent(CalloutElementStatic),
];
