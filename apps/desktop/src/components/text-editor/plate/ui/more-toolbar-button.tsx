// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import { Baseline, Code2, Highlighter, Keyboard, MoreHorizontal, PaintBucket, Strikethrough, Subscript, Superscript, Underline } from 'lucide-react';
import { useRef } from 'react';
import { KEYS } from 'platejs';
import { Popover, PopoverContent, PopoverTrigger } from '../primitives/popover';
import { CommentToolbarButton } from './comment-toolbar-button';
import { InlineEquationToolbarButton } from './equation-toolbar-button';
import { FontColorToolbarButton } from './font-color-toolbar-button';
import { FontSizeToolbarButton } from './font-size-toolbar-button';
import { MarkToolbarButton } from './mark-toolbar-button';
import { SuggestionToolbarButton } from './suggestion-toolbar-button';
import { Toolbar, ToolbarButton } from './toolbar';

export function MoreToolbarButton() {
  const tools = useRef<HTMLDivElement>(null);
  return <Popover modal={false}>
    <PopoverTrigger asChild>
      <ToolbarButton tooltip="更多选区工具"><MoreHorizontal /></ToolbarButton>
    </PopoverTrigger>
    <PopoverContent
      ref={tools}
      aria-label="更多选区工具"
      className="ignore-click-outside/toolbar text-plate-selection-popover"
      align="end"
      onOpenAutoFocus={event => { event.preventDefault(); tools.current?.focus({ preventScroll: true }); }}
      onInteractOutside={event => {
        if (event.target instanceof Element && event.target.closest('.text-plate-selection-child')) event.preventDefault();
      }}
    >
      <Toolbar aria-label="选区样式" className="text-plate-selection-tools">
        <MarkToolbarButton nodeType={KEYS.underline} tooltip="下划线"><Underline /></MarkToolbarButton>
        <MarkToolbarButton nodeType={KEYS.strikethrough} tooltip="删除线"><Strikethrough /></MarkToolbarButton>
        <MarkToolbarButton nodeType={KEYS.code} tooltip="行内代码"><Code2 /></MarkToolbarButton>
        <FontSizeToolbarButton />
        <FontColorToolbarButton nodeType={KEYS.color} tooltip="字色"><Baseline /></FontColorToolbarButton>
        <FontColorToolbarButton nodeType={KEYS.backgroundColor} tooltip="底色"><PaintBucket /></FontColorToolbarButton>
        <MarkToolbarButton nodeType={KEYS.highlight} tooltip="高亮"><Highlighter /></MarkToolbarButton>
        <InlineEquationToolbarButton />
        <MarkToolbarButton nodeType={KEYS.sup} clear={KEYS.sub} tooltip="上标"><Superscript /></MarkToolbarButton>
        <MarkToolbarButton nodeType={KEYS.sub} clear={KEYS.sup} tooltip="下标"><Subscript /></MarkToolbarButton>
        <MarkToolbarButton nodeType={KEYS.kbd} tooltip="按键样式"><Keyboard /></MarkToolbarButton>
      </Toolbar>
      <Toolbar aria-label="本机文档协作" className="text-plate-selection-local">
        <CommentToolbarButton labeled />
        <SuggestionToolbarButton labeled />
      </Toolbar>
    </PopoverContent>
  </Popover>;
}
