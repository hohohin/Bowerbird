// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
import { BaseCommentPlugin } from '@platejs/comment';

import { CommentLeafStatic } from '@/components/text-editor/plate/ui/comment-node-static';

export const BaseCommentKit = [
  BaseCommentPlugin.withComponent(CommentLeafStatic),
];
