// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import * as React from 'react';

import type { TElement, RangeRef } from 'platejs';

import { toUnitLess } from '@platejs/basic-styles';
import { FontSizePlugin } from '@platejs/basic-styles/react';
import { CaseSensitive, Minus, Plus } from 'lucide-react';
import { KEYS } from 'platejs';
import { useEditorPlugin, useEditorSelector } from 'platejs/react';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/text-editor/plate/primitives/popover';

import { ToolbarButton } from './toolbar';
import { readTextSelection } from '@/components/textBlockTransforms';

const DEFAULT_FONT_SIZE = '16';

const FONT_SIZE_MAP = {
  h1: '36',
  h2: '24',
  h3: '20',
} as const;

const FONT_SIZES = [
  '8',
  '9',
  '10',
  '12',
  '14',
  '16',
  '18',
  '24',
  '30',
  '36',
  '48',
  '60',
  '72',
  '96',
] as const;

function useCursorFontSize() {
  return useEditorSelector((editor) => {
    const fontSize = editor.api.marks()?.[KEYS.fontSize];
    if (fontSize) return toUnitLess(fontSize as string);
    const [block] = editor.api.block<TElement>() || [];
    if (!block?.type) return DEFAULT_FONT_SIZE;
    return block.type in FONT_SIZE_MAP
      ? FONT_SIZE_MAP[block.type as keyof typeof FONT_SIZE_MAP]
      : DEFAULT_FONT_SIZE;
  }, []);
}

function validFontSize(value: string) {
  const size = Number(toUnitLess(value));
  return Number.isFinite(size) && size >= 1 && size <= 100 ? size : null;
}

function useFontSizeSelection() {
  const { editor, tf } = useEditorPlugin(FontSizePlugin);
  const bookmark = React.useRef<RangeRef | null>(null);
  React.useEffect(() => () => { bookmark.current?.unref(); }, []);
  const rememberSelection = () => {
    const selection = readTextSelection(editor) ?? editor.selection;
    if (!bookmark.current && selection) bookmark.current = editor.api.rangeRef(selection);
  };
  const applyInput = (value: string) => {
    const at = bookmark.current?.unref(); bookmark.current = null;
    if (!at) return;
    editor.tf.select(at);
    const size = validFontSize(value);
    if (size !== null) tf.fontSize.addMark(`${size}px`);
  };
  return { editor, bookmark, rememberSelection, applyInput };
}

export function FontSizeToolbarButton({ children }: { children?: React.ReactNode }) {
  const { editor, bookmark, rememberSelection, applyInput } = useFontSizeSelection();
  const size = useCursorFontSize();
  const [value, setValue] = React.useState(size);
  const [open, setOpen] = React.useState(false);
  const field = React.useRef<HTMLInputElement>(null);
  const applied = React.useRef(false);

  function finish(next: string) {
    applyInput(next);
    applied.current = true;
    setOpen(false);
    editor.tf.focus();
  }

  return <Popover modal={false} open={open} onOpenChange={next => {
    if (next) {
      applied.current = false;
      rememberSelection();
      setValue(size);
    } else {
      if (bookmark.current && value !== size) applyInput(value);
      bookmark.current?.unref();
      bookmark.current = null;
    }
    setOpen(next);
  }}>
    <PopoverTrigger asChild>
      <ToolbarButton tooltip="字号" onPointerDownCapture={rememberSelection}><CaseSensitive />{children}</ToolbarButton>
    </PopoverTrigger>
    <PopoverContent
      aria-label="调整字号"
      className="ignore-click-outside/toolbar text-plate-selection-child text-plate-size-picker"
      collisionPadding={8}
      onOpenAutoFocus={event => { event.preventDefault(); field.current?.focus(); field.current?.select(); }}
      onEscapeKeyDown={() => { bookmark.current?.unref(); bookmark.current = null; }}
      onCloseAutoFocus={event => { if (applied.current) event.preventDefault(); }}
    >
      <div className="text-plate-size-input">
        <ToolbarButton tooltip="缩小字号" onClick={() => finish(String(Math.max(1, Number(size) - 1)))}><Minus /></ToolbarButton>
        <input aria-label="字号" ref={field} value={value} inputMode="numeric" data-plate-focus="true"
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); finish(value); }
          }}
        />
        <ToolbarButton tooltip="增大字号" onClick={() => finish(String(Math.min(100, Number(size) + 1)))}><Plus /></ToolbarButton>
      </div>
      <div className="text-plate-size-presets">
        {FONT_SIZES.map(preset => <button key={preset} type="button" aria-pressed={preset === size}
          onMouseDown={event => event.preventDefault()} onClick={() => finish(preset)}>{preset}</button>)}
      </div>
    </PopoverContent>
  </Popover>;
}
