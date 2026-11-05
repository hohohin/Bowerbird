// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';


import type { PlateElementProps } from 'platejs/react';

import { PlateElement } from 'platejs/react';

import { cn } from '@/components/text-editor/plate/lib/utils';

export function ParagraphElement(props: PlateElementProps) {
  return (
    <PlateElement {...props} className={cn('m-0 px-0 py-1')}>
      {props.children}
    </PlateElement>
  );
}
