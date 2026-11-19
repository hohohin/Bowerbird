// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import * as React from 'react';

import type { TElement, RangeRef } from 'platejs';

import { toUnitLess } from '@platejs/basic-styles';
import { FontSizePlugin } from '@platejs/basic-styles/react';
import { Minus, Plus } from 'lucide-react';
import { KEYS } from 'platejs';
import { useEditorPlugin, useEditorSelector } from 'platejs/react';

import {
  Popover,
  PopoverContent,
  PopoverAnchor,
} from '@/components/text-editor/plate/primitives/popover';
import { cn } from '@/components/text-editor/plate/lib/utils';

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
    if (at) editor.tf.select(at);
    const size = validFontSize(value);
    if (size !== null) tf.fontSize.addMark(`${size}px`);
  };
  return { editor, tf, bookmark, rememberSelection, applyInput };
}

export function FontSizeToolbarButton() {
  const [inputValue, setInputValue] = React.useState(DEFAULT_FONT_SIZE);
  const [isFocused, setIsFocused] = React.useState(false);
  const { editor, tf, bookmark, rememberSelection, applyInput } = useFontSizeSelection();
  const cursorFontSize = useCursorFontSize();
  const handleInputChange = (value: string, restoreFocus = true) => {
    applyInput(value);
    setIsFocused(false);
    if (restoreFocus) editor.tf.focus();
  };

  const handleFontSizeChange = (delta: number) => {
    const newSize = Number(displayValue) + delta;
    tf.fontSize.addMark(`${newSize}px`);
    editor.tf.focus();
  };

  const displayValue = isFocused ? inputValue : cursorFontSize;

  return (
    <div className="flex h-7 items-center gap-1 rounded-md bg-muted/60 p-0">
      <ToolbarButton tooltip="缩小字号" onClick={() => handleFontSizeChange(-1)}>
        <Minus />
      </ToolbarButton>

      <Popover open={isFocused} modal={false}>
        <PopoverAnchor asChild>
          <input
            aria-label="字号"
            className={cn(
              'h-full w-10 shrink-0 bg-transparent px-1 text-center text-sm hover:bg-muted'
            )}
            value={displayValue}
            onBlur={event => {
              setIsFocused(false);
              if (bookmark.current) handleInputChange(event.currentTarget.value, false);
            }}
            onChange={(e) => setInputValue(e.target.value)}
            onFocus={() => {
              rememberSelection();
              setIsFocused(true);
              setInputValue(toUnitLess(cursorFontSize));
            }}
            onPointerDown={() => { rememberSelection(); setIsFocused(true); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleInputChange(e.currentTarget.value);
              }
            }}
            data-plate-focus="true"
            type="text"
          />
        </PopoverAnchor>
        <PopoverContent
          className="w-10 px-px py-1"
          onEscapeKeyDown={() => { bookmark.current?.unref(); bookmark.current = null; setIsFocused(false); editor.tf.focus(); }}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {FONT_SIZES.map((size) => (
            <button
              key={size}
              className={cn(
                'flex h-8 w-full items-center justify-center text-sm hover:bg-accent data-[highlighted=true]:bg-accent'
              )}
              onClick={() => {
                handleInputChange(size);
              }}
              onPointerDown={event => event.preventDefault()}
              data-highlighted={size === displayValue}
              type="button"
            >
              {size}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      <ToolbarButton tooltip="增大字号" onClick={() => handleFontSizeChange(1)}>
        <Plus />
      </ToolbarButton>
    </div>
  );
}
