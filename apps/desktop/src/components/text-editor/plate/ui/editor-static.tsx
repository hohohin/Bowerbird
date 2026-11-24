// Adapted from Plate (MIT). See LICENSE.md in this directory tree.

import type { VariantProps } from 'class-variance-authority';

import { cva } from 'class-variance-authority';
import { type PlateStaticProps, PlateStatic } from 'platejs/static';

import { cn } from '@/components/text-editor/plate/lib/utils';

const editorVariants = cva(
  cn(
    'group/editor',
    'relative w-full cursor-text select-text overflow-x-hidden whitespace-break-spaces break-words',
    'rounded-md ring-offset-background focus-visible:outline-none',
    'placeholder:text-muted-foreground/80 **:data-slate-placeholder:top-[auto_!important] **:data-slate-placeholder:text-muted-foreground/80 **:data-slate-placeholder:opacity-100!',
    '[&_strong]:font-bold'
  ),
  {
    defaultVariants: {
      variant: 'none',
    },
    variants: {
      disabled: {
        true: 'cursor-not-allowed opacity-50',
      },
      focused: {
        true: 'ring-2 ring-ring ring-offset-2',
      },
      variant: {
        aiChat:
          'max-h-[min(70vh,320px)] w-full overflow-y-auto px-5 py-3 text-base md:text-sm',
        none: '',
      },
    },
  }
);

export function EditorStatic({
  className,
  variant,
  ...props
}: PlateStaticProps & VariantProps<typeof editorVariants>) {
  return (
    <PlateStatic
      className={cn(editorVariants({ variant }), className)}
      {...props}
    />
  );
}
