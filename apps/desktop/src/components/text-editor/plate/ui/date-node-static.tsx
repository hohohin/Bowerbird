// Adapted from Plate (MIT). See LICENSE.md in this directory tree.

import { getDateDisplayLabel } from '@platejs/date';
import type { TDateElement } from 'platejs';
import type { SlateElementProps } from 'platejs/static';

import { SlateElement } from 'platejs/static';
import { cn } from '@/components/text-editor/plate/lib/utils';
import { inlineSuggestionVariants } from '@/components/text-editor/plate/lib/suggestion';

export function DateElementStatic(props: SlateElementProps<TDateElement>) {
  const { element } = props;

  return (
    <SlateElement as="span" className="inline-block" {...props}>
      <span
        className={cn(
          'w-fit rounded-sm bg-muted px-1 text-muted-foreground',
          inlineSuggestionVariants()
        )}
      >
        {element.date || element.rawDate ? (
          getDateDisplayLabel(element)
        ) : (
          <span>选择日期</span>
        )}
      </span>
      {props.children}
    </SlateElement>
  );
}
