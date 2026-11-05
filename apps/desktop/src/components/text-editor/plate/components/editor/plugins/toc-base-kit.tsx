// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
import { BaseTocPlugin } from '@platejs/toc';

import { TocElementStatic } from '@/components/text-editor/plate/ui/toc-node-static';

export const BaseTocKit = [BaseTocPlugin.withComponent(TocElementStatic)];
