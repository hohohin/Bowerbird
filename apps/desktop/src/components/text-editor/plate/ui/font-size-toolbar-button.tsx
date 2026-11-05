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
  PopoverTrigger,
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

export function FontSizeToolbarButton() {
  const [inputValue, setInputValue] = React.useState(DEFAULT_FONT_SIZE);
  const [isFocused, setIsFocused] = React.useState(false);
  const { editor, tf } = useEditorPlugin(FontSizePlugin);
  const bookmark = React.useRef<RangeRef | null>(null);
  React.useEffect(() => () => { bookmark.current?.unref(); }, []);
  const rememberSelection = () => {
    const selection = readTextSelection(editor) ?? editor.selection;
    if (!bookmark.current && selection) bookmark.current = editor.api.rangeRef(selection);
  };

  const cursorFontSize = useEditorSelector((editor) => {
    const fontSize = editor.api.marks()?.[KEYS.fontSize];

    if (fontSize) {
      return toUnitLess(fontSize as string);
    }

    const [block] = editor.api.block<TElement>() || [];

    if (!block?.type) return DEFAULT_FONT_SIZE;

    return block.type in FONT_SIZE_MAP
      ? FONT_SIZE_MAP[block.type as keyof typeof FONT_SIZE_MAP]
      : DEFAULT_FONT_SIZE;
  }, []);

  const handleInputChange = (value: string) => {
    const at = bookmark.current?.unref(); bookmark.current = null;
    if (at) editor.tf.select(at);
    const newSize = Number(toUnitLess(value));
    if (Number.isFinite(newSize) && newSize >= 1 && newSize <= 100) tf.fontSize.addMark(`${newSize}px`);
    setIsFocused(false);
    editor.tf.focus();
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
        <PopoverTrigger asChild>
          <input
            aria-label="字号"
            className={cn(
              'h-full w-10 shrink-0 bg-transparent px-1 text-center text-sm hover:bg-muted'
            )}
            value={displayValue}
            onBlur={event => {
              setIsFocused(false);
              if (bookmark.current) handleInputChange(event.currentTarget.value);
            }}
            onChange={(e) => setInputValue(e.target.value)}
            onFocus={() => {
              rememberSelection();
              setIsFocused(true);
              setInputValue(toUnitLess(cursorFontSize));
            }}
            onPointerDown={rememberSelection}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleInputChange(e.currentTarget.value);
              }
            }}
            data-plate-focus="true"
            type="text"
          />
        </PopoverTrigger>
        <PopoverContent
          className="w-10 px-px py-1"
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
