// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
import { BaseDatePlugin } from '@platejs/date';

import { DateElementStatic } from '@/components/text-editor/plate/ui/date-node-static';

export const BaseDateKit = [BaseDatePlugin.withComponent(DateElementStatic)];
