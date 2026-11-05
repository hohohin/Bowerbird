// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import * as React from 'react';

import {
  type FloatingToolbarState,
  flip,
  offset,
  shift,
  size,
  hide,
  useFloatingToolbar,
  useFloatingToolbarState,
} from '@platejs/floating';
import { useComposedRef } from '@udecode/cn';
import { KEYS } from 'platejs';
import {
  useEditorId,
  useEditorRef,
  useEventEditorValue,
  usePluginOption,
} from 'platejs/react';

import { cn } from '@/components/text-editor/plate/lib/utils';

import { Toolbar } from './toolbar';

export function FloatingToolbar({
  children,
  className,
  state,
  ...props
}: React.ComponentProps<typeof Toolbar> & {
  state?: FloatingToolbarState;
}) {
  const editorId = useEditorId();
  const editor = useEditorRef();
  const toolbarRef = React.useRef<HTMLDivElement>(null);
  const boundary = () => ({ boundary: editor.api.toDOMNode(editor)?.closest<HTMLElement>('.text-plate-container') ?? 'clippingAncestors' as const, padding: 8 });
  const focusedEditorId = useEventEditorValue('focus');
  const isFloatingLinkOpen = !!usePluginOption({ key: KEYS.link }, 'mode');
  const isAIChatOpen = usePluginOption({ key: KEYS.aiChat }, 'open');

  const floatingToolbarState = useFloatingToolbarState({
    editorId,
    focusedEditorId,
    hideToolbar: isFloatingLinkOpen || isAIChatOpen,
    ...state,
    floatingOptions: {
      middleware: [
        offset(12),
        flip(() => ({
          fallbackPlacements: [
            'top-start',
            'top-end',
            'bottom-start',
            'bottom-end',
          ],
          ...boundary(),
        })),
        size(() => ({ ...boundary(), apply: ({ availableWidth, elements }) => { elements.floating.style.maxWidth = `${Math.max(80, availableWidth)}px`; } })),
        shift(() => ({ ...boundary(), crossAxis: true })),
        hide(boundary),
      ],
      placement: 'top',
      ...state?.floatingOptions,
    },
  });

  const {
    clickOutsideRef,
    hidden,
    props: rootProps,
    ref: floatingRef,
  } = useFloatingToolbar(floatingToolbarState);

  const ref = useComposedRef<HTMLDivElement>(typeof props.ref === 'string' ? undefined : props.ref, floatingRef, toolbarRef);
  React.useEffect(() => {
    const body = editor.api.toDOMNode(editor);
    body?.addEventListener('scroll', floatingToolbarState.floating.update, { passive: true });
    return () => body?.removeEventListener('scroll', floatingToolbarState.floating.update);
  }, [editor, floatingToolbarState.floating.update]);
  React.useEffect(() => {
    if (hidden) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (!editor.api.toDOMNode(editor)?.contains(document.activeElement) && !toolbarRef.current?.contains(document.activeElement)) return;
      if (event.altKey && event.key === 'F10') {
        event.preventDefault(); event.stopPropagation();
        toolbarRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
      }
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        floatingToolbarState.setWaitForCollapsedSelection(true);
        floatingToolbarState.setOpen(false);
        editor.tf.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [editor, hidden, floatingToolbarState.setOpen, floatingToolbarState.setWaitForCollapsedSelection]);

  if (hidden) return null;

  return (
    <div ref={clickOutsideRef}>
      <Toolbar
        aria-label="选中文字格式"
        {...props}
        {...rootProps}
        style={{ ...rootProps.style, visibility: floatingToolbarState.floating.middlewareData.hide?.referenceHidden ? 'hidden' : undefined }}
        ref={ref}
        onKeyDownCapture={event => {
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = { ArrowLeft: (current - 1 + buttons.length) % buttons.length, ArrowRight: (current + 1) % buttons.length, Home: 0, End: buttons.length - 1 }[event.key];
          if (current < 0 || next === undefined) return;
          event.preventDefault(); event.stopPropagation(); buttons[next]?.focus();
        }}
        className={cn(
          'scrollbar-hide absolute z-50 overflow-x-auto whitespace-nowrap rounded-md border bg-popover p-1 opacity-100 shadow-md print:hidden',
          'max-w-[80vw]',
          className
        )}
      >
        {children}
      </Toolbar>
    </div>
  );
}
