// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import { cn } from '@/components/text-editor/plate/lib/utils';

import { Toolbar } from './toolbar';

export function FixedToolbar(props: React.ComponentProps<typeof Toolbar>) {
  return (
    <Toolbar
      {...props}
      className={cn(
        'sticky top-0 left-0 z-50 w-full justify-between overflow-x-auto rounded-t-lg border-b border-b-border bg-background p-1',
        props.className
      )}
    />
  );
}
