// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import * as React from 'react';

import type { VariantProps } from 'class-variance-authority';
import type { PlateContentProps } from 'platejs/react';

import { cva } from 'class-variance-authority';
import { PlateContainer, PlateContent } from 'platejs/react';

import { cn } from '@/components/text-editor/plate/lib/utils';

const editorContainerVariants = cva(
  'relative w-full cursor-text select-text overflow-y-auto caret-primary selection:bg-brand/25 focus-visible:outline-none [&_.slate-selection-area]:z-50 [&_.slate-selection-area]:border [&_.slate-selection-area]:border-brand/25 [&_.slate-selection-area]:bg-brand/15',
  {
    defaultVariants: {
      variant: 'default',
    },
    variants: {
      variant: {
        comment: cn(
          'flex flex-wrap justify-between gap-1 px-1 py-0.5 text-sm',
          'rounded-md border-[1.5px] border-transparent bg-transparent',
          'has-[[data-slate-editor]:focus]:border-brand/50 has-[[data-slate-editor]:focus]:ring-2 has-[[data-slate-editor]:focus]:ring-brand/30',
          'has-aria-disabled:border-input has-aria-disabled:bg-muted'
        ),
        default: 'h-full',
      },
    },
  }
);

export function EditorContainer({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof editorContainerVariants>) {
  return (
    <PlateContainer
      className={cn(
        'ignore-click-outside/toolbar',
        editorContainerVariants({ variant }),
        className
      )}
      {...props}
    />
  );
}

const editorVariants = cva(
  cn(
    'group/editor',
    'relative w-full cursor-text select-text overflow-x-hidden whitespace-break-spaces break-words',
    'rounded-md ring-offset-background focus-visible:outline-none',
    '**:data-slate-placeholder:!top-1/2 **:data-slate-placeholder:-translate-y-1/2 placeholder:text-muted-foreground/80 **:data-slate-placeholder:text-muted-foreground/80 **:data-slate-placeholder:opacity-100!',
    '[&_strong]:font-bold'
  ),
  {
    defaultVariants: {
      variant: 'default',
    },
    variants: {
      disabled: {
        true: 'cursor-not-allowed opacity-50',
      },
      focused: {
        true: 'ring-2 ring-ring ring-offset-2',
      },
      variant: {
        comment: cn('rounded-none border-none bg-transparent text-sm'),
        default:
          'size-full px-16 pt-4 pb-72 text-base sm:px-[max(64px,calc(50%-350px))]',
      },
    },
  }
);

export type EditorProps = PlateContentProps &
  VariantProps<typeof editorVariants>;

export const Editor = React.forwardRef<HTMLDivElement, EditorProps>(function Editor({
  className,
  disabled,
  focused,
  variant,
  ...props
}, ref) { return (
  <PlateContent
    ref={ref}
    className={cn(
      editorVariants({
        disabled,
        focused,
        variant,
      }),
      className
    )}
    disabled={disabled}
    disableDefaultStyles
    {...props}
  />
); });

Editor.displayName = 'Editor';
