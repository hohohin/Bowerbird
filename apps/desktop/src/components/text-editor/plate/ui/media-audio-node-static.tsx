// Adapted from Plate (MIT). See LICENSE.md in this directory tree.

import type { TAudioElement } from 'platejs';
import type { SlateElementProps } from 'platejs/static';

import { SlateElement } from 'platejs/static';

import { cn } from '@/components/text-editor/plate/lib/utils';

export function AudioElementStatic(props: SlateElementProps<TAudioElement>) {
  return (
    <SlateElement {...props} className="mb-1">
      <figure className="group relative cursor-default">
        <div className={cn('h-16 rounded-sm')}>
          <audio className="size-full" src={props.element.url} controls />
        </div>
      </figure>
      {props.children}
    </SlateElement>
  );
}
