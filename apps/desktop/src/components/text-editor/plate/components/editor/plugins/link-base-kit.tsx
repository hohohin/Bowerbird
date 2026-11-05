// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
import { BaseLinkPlugin } from '@platejs/link';

import { LinkElementStatic } from '@/components/text-editor/plate/ui/link-node-static';

export const BaseLinkKit = [BaseLinkPlugin.withComponent(LinkElementStatic)];
