// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import { cn } from '@/components/text-editor/plate/lib/utils';

import { Toolbar } from './toolbar';

export function FixedToolbar(props: React.ComponentProps<typeof Toolbar>) {
  return (
    <Toolbar
      {...props}
      className={cn(
        'text-plate-format-toolbar sticky top-0 z-50 w-full bg-background',
        props.className
      )}
    />
  );
}
