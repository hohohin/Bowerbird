// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
import { BaseMentionPlugin } from '@platejs/mention';

import { MentionElementStatic } from '@/components/text-editor/plate/ui/mention-node-static';

export const BaseMentionKit = [
  BaseMentionPlugin.withComponent(MentionElementStatic),
];
