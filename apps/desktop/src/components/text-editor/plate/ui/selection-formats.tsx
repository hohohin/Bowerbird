import {
  Baseline, Bold, Code2, Highlighter, Italic, Keyboard, PaintBucket, Strikethrough, Subscript,
  Superscript, Underline,
} from 'lucide-react';
import { KEYS } from 'platejs';
import { useMemo, useSyncExternalStore } from 'react';
import { InlineEquationToolbarButton } from './equation-toolbar-button';
import { FontColorToolbarButton } from './font-color-toolbar-button';
import { FontSizeToolbarButton } from './font-size-toolbar-button';
import { LinkToolbarButton } from './link-toolbar-button';
import { MarkToolbarButton } from './mark-toolbar-button';

export const formatLabels = {
  bold: '加粗', italic: '斜体', link: '链接', underline: '下划线', strikethrough: '删除线',
  fontSize: '字号', color: '字色', backgroundColor: '底色', code: '行内代码', highlight: '高亮',
  equation: '行内公式', sup: '上标', sub: '下标', kbd: '按键样式',
};
export type SelectionFormat = keyof typeof formatLabels;
export const formatKeys = Object.keys(formatLabels) as SelectionFormat[];
export const formatLimit = 8;

const defaultFormats: SelectionFormat[] = ['bold', 'italic', 'link'];
const storageKey = 'bowerbird.textEditor.selectionFormats.v1';
let unsavedPreference: string | null = null;

function subscribe(listener: () => void) {
  window.addEventListener(storageKey, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(storageKey, listener);
    window.removeEventListener('storage', listener);
  };
}

function readPreference() {
  try { return unsavedPreference ?? localStorage.getItem(storageKey); }
  catch { return unsavedPreference; }
}

export function useSelectionFormats() {
  const raw = useSyncExternalStore(subscribe, readPreference);
  return useMemo(() => {
    try {
      const saved: unknown = raw && JSON.parse(raw);
      if (Array.isArray(saved)) {
        return [...new Set(saved)].filter((key): key is SelectionFormat => formatKeys.includes(key)).slice(0, formatLimit);
      }
    } catch { /* Use the original toolbar when the local preference is unreadable. */ }
    return defaultFormats;
  }, [raw]);
}

export function saveSelectionFormats(formats: SelectionFormat[]) {
  const value = JSON.stringify(formats);
  try { localStorage.setItem(storageKey, value); unsavedPreference = null; }
  catch { unsavedPreference = value; }
  window.dispatchEvent(new Event(storageKey));
}

const markIcons = { bold: Bold, italic: Italic, underline: Underline, strikethrough: Strikethrough,
  code: Code2, highlight: Highlighter, sup: Superscript, sub: Subscript, kbd: Keyboard };

export function SelectionFormatButton({ format, labeled = false }: { format: SelectionFormat; labeled?: boolean }) {
  const name = formatLabels[format];
  const label = labeled ? name : undefined;
  switch (format) {
    case 'link': return <LinkToolbarButton>{label}</LinkToolbarButton>;
    case 'equation': return <InlineEquationToolbarButton aria-label={name}>{label}</InlineEquationToolbarButton>;
    case 'fontSize': return <FontSizeToolbarButton>{label}</FontSizeToolbarButton>;
    case 'color':
    case 'backgroundColor': {
      const Icon = format === 'color' ? Baseline : PaintBucket;
      return <FontColorToolbarButton nodeType={KEYS[format]} tooltip={name}><Icon />{label}</FontColorToolbarButton>;
    }
    default: {
      const Icon = markIcons[format];
      const clear = format === 'sup' ? KEYS.sub : format === 'sub' ? KEYS.sup : undefined;
      return <MarkToolbarButton nodeType={KEYS[format]} clear={clear} tooltip={name}><Icon />{label}</MarkToolbarButton>;
    }
  }
}
