// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
import {
  BaseFootnoteDefinitionPlugin,
  BaseFootnoteReferencePlugin,
} from '@platejs/footnote';

import {
  FootnoteDefinitionElementStatic,
  FootnoteReferenceElementStatic,
} from '@/components/text-editor/plate/ui/footnote-node-static';

export const BaseFootnoteKit = [
  BaseFootnoteReferencePlugin.withComponent(FootnoteReferenceElementStatic),
  BaseFootnoteDefinitionPlugin.withComponent(FootnoteDefinitionElementStatic),
];
