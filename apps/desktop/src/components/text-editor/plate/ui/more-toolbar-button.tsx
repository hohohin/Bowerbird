// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import { CircleMinus, CirclePlus, GripVertical, MoreHorizontal } from 'lucide-react';
import { useRef, useState, type PointerEvent } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../primitives/popover';
import { CommentToolbarButton } from './comment-toolbar-button';
import {
  formatKeys, formatLabels, formatLimit, saveSelectionFormats, SelectionFormatButton, type SelectionFormat,
} from './selection-formats';
import { SuggestionToolbarButton } from './suggestion-toolbar-button';
import { Toolbar, ToolbarButton } from './toolbar';

export function MoreToolbarButton({ active }: { active: SelectionFormat[] }) {
  const tools = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ id: number; y: number; moved: boolean } | null>(null);
  const [drop, setDrop] = useState<{ key: SelectionFormat; after: boolean } | null>(null);
  const [moveOptions, setMoveOptions] = useState<SelectionFormat | null>(null);
  const [message, setMessage] = useState('');

  function move(key: SelectionFormat, index: number) {
    const old = active.indexOf(key);
    if (old < 0 || old === index || index < 0 || index >= active.length) return;
    const next = active.filter(item => item !== key);
    next.splice(index, 0, key);
    saveSelectionFormats(next);
    setMessage(formatLabels[key] + '已移至第' + (index + 1) + '项');
  }

  function toggle(key: SelectionFormat, pinned: boolean, keyboard: boolean) {
    if (!pinned && active.length >= formatLimit) return;
    saveSelectionFormats(pinned ? active.filter(item => item !== key) : [...active, key]);
    setMoveOptions(null);
    setMessage(formatLabels[key] + (pinned ? '已移除' : '已添加'));
    if (keyboard) requestAnimationFrame(() => {
      tools.current?.querySelector<HTMLButtonElement>('[data-format="' + key + '"] .text-plate-format-pin')?.focus();
    });
  }

  function locateDrop(event: PointerEvent<HTMLButtonElement>) {
    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-pinned-format]');
    if (!hit || !tools.current?.contains(hit)) return null;
    const key = hit.dataset.pinnedFormat as SelectionFormat;
    const rect = hit.getBoundingClientRect();
    return { key, after: event.clientY >= rect.top + rect.height / 2 };
  }

  function toolRow(key: SelectionFormat, pinned: boolean) {
    const name = formatLabels[key];
    const index = active.indexOf(key);
    const PinIcon = pinned ? CircleMinus : CirclePlus;
    return <div key={key} className="text-plate-selection-row" data-format={key}
      data-pinned-format={pinned ? key : undefined}
      data-drop={drop?.key === key ? (drop.after ? 'after' : 'before') : undefined}>
      {pinned && <button type="button" className="text-plate-format-grip"
        aria-label={'调整' + name + '的顺序'} title="拖动排序，或点击选择上移、下移"
        aria-expanded={moveOptions === key}
        onPointerDown={event => {
          if (!event.isPrimary || event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          gesture.current = { id: event.pointerId, y: event.clientY, moved: false };
        }}
        onPointerMove={event => {
          const drag = gesture.current;
          if (!drag || drag.id !== event.pointerId) return;
          if (!drag.moved && Math.abs(event.clientY - drag.y) < 4) return;
          drag.moved = true;
          const menu = tools.current!;
          const box = menu.getBoundingClientRect();
          if (event.clientY < box.top + 28) menu.scrollTop -= 12;
          if (event.clientY > box.bottom - 28) menu.scrollTop += 12;
          const target = locateDrop(event);
          setDrop(target?.key === key ? null : target);
        }}
        onPointerUp={event => {
          const drag = gesture.current;
          if (drag?.id !== event.pointerId) return;
          if (drag.moved) {
            const target = locateDrop(event);
            if (target && target.key !== key) {
              const base = active.filter(item => item !== key).indexOf(target.key);
              move(key, base + Number(target.after));
            }
          } else setMoveOptions(moveOptions === key ? null : key);
          gesture.current = null;
          setDrop(null);
        }}
        onLostPointerCapture={() => { gesture.current = null; setDrop(null); }}
        onClick={event => { if (event.detail === 0) setMoveOptions(moveOptions === key ? null : key); }}
        onKeyDown={event => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault(); event.stopPropagation();
          move(key, index + (event.key === 'ArrowUp' ? -1 : 1));
        }}><GripVertical /></button>}
      <SelectionFormatButton format={key} labeled />
      <button type="button" className="text-plate-format-pin" disabled={!pinned && active.length >= formatLimit}
        aria-label={(pinned ? '移除' : '添加') + name} title={pinned ? '从浮动栏移除' : '添加到浮动栏'}
        onMouseDown={event => event.preventDefault()} onClick={event => toggle(key, pinned, event.detail === 0)}>
        <PinIcon />
      </button>
      {pinned && moveOptions === key && <div className="text-plate-format-moves">
        <button type="button" disabled={index === 0} onMouseDown={event => event.preventDefault()}
          onClick={() => move(key, index - 1)}>上移</button>
        <button type="button" disabled={index === active.length - 1} onMouseDown={event => event.preventDefault()}
          onClick={() => move(key, index + 1)}>下移</button>
      </div>}
    </div>;
  }

  return <Popover modal={false} onOpenChange={open => {
    if (!open) { setMoveOptions(null); setDrop(null); gesture.current = null; }
  }}>
    <PopoverTrigger asChild>
      <ToolbarButton tooltip="更多选区工具"><MoreHorizontal /></ToolbarButton>
    </PopoverTrigger>
    <PopoverContent ref={tools} aria-label="更多选区工具" tabIndex={-1}
      className="ignore-click-outside/toolbar text-plate-selection-popover"
      collisionPadding={8} align="start"
      onOpenAutoFocus={event => { event.preventDefault(); tools.current?.focus({ preventScroll: true }); }}
      onInteractOutside={event => {
        if (event.target instanceof Element && event.target.closest('.text-plate-selection-child')) event.preventDefault();
      }}>
      <div className="text-plate-selection-heading"><strong>已激活</strong><span>{active.length} / {formatLimit}</span></div>
      <Toolbar aria-label="已激活" orientation="vertical" className="text-plate-selection-tools">
        {active.map(key => toolRow(key, true))}
      </Toolbar>
      {!active.length && <p>点击下方的加号添加常用格式。</p>}
      {active.length === formatLimit && <p>已满 8 项，移除一项后可继续添加。</p>}
      <div className="text-plate-selection-heading">可添加</div>
      <Toolbar aria-label="可添加" orientation="vertical" className="text-plate-selection-tools">
        {formatKeys.filter(key => !active.includes(key)).map(key => toolRow(key, false))}
      </Toolbar>
      <Toolbar aria-label="本机文档协作" className="text-plate-selection-local">
        <CommentToolbarButton labeled />
        <SuggestionToolbarButton labeled />
      </Toolbar>
      <span className="sr-only" role="status">{message}</span>
    </PopoverContent>
  </Popover>;
}
