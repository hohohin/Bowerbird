// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import * as React from 'react';

import type { PlateEditor, PlateElementProps } from 'platejs/react';

import { AIChatPlugin } from '@platejs/ai/react';
import { LineHeightPlugin, TextAlignPlugin } from '@platejs/basic-styles/react';
import { EmojiPlugin } from '@platejs/emoji/react';
import { indent, outdent } from '@platejs/indent';
import { SlashPlugin } from '@platejs/slash-command/react';
import {
  AlignCenterIcon,
  AlignJustifyIcon,
  AlignLeftIcon,
  AlignRightIcon,
  CalendarIcon,
  ChevronRightIcon,
  Code2,
  Columns3Icon,
  FilmIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ImageIcon,
  IndentIcon,
  LightbulbIcon,
  ListIcon,
  ListOrdered,
  MinusIcon,
  OutdentIcon,
  PenToolIcon,
  PilcrowIcon,
  Quote,
  RadicalIcon,
  SmileIcon,
  SparklesIcon,
  Square,
  SuperscriptIcon,
  Table,
  TableOfContentsIcon,
  WrapTextIcon,
} from 'lucide-react';
import { type TComboboxInputElement, KEYS, RangeApi } from 'platejs';
import { PlateElement } from 'platejs/react';

import {
  insertBlock,
  insertInlineElement,
} from '@/components/text-editor/plate/components/editor/transforms';

import {
  InlineCombobox,
  InlineComboboxContent,
  InlineComboboxEmpty,
  InlineComboboxGroup,
  InlineComboboxGroupLabel,
  InlineComboboxInput,
  InlineComboboxItem,
} from './inline-combobox';

type Group = {
  group: string;
  items: {
    icon: React.ReactNode;
    value: string;
    onSelect: (editor: PlateEditor, value: string) => void;
    className?: string;
    focusEditor?: boolean;
    keywords?: string[];
    label?: string;
  }[];
};

const groups: Group[] = [
  {
    group: 'AI',
    items: [
      {
        focusEditor: false,
        icon: <SparklesIcon />,
        value: 'AI',
        onSelect: (editor) => {
          editor.getApi(AIChatPlugin).aiChat.show();
        },
      },
    ],
  },
  {
    group: '基础块',
    items: [
      {
        icon: <PilcrowIcon />,
        keywords: ['paragraph'],
        label: '正文',
        value: KEYS.p,
      },
      {
        icon: <Heading1Icon />,
        keywords: ['title', 'h1'],
        label: '标题 1',
        value: KEYS.h1,
      },
      {
        icon: <Heading2Icon />,
        keywords: ['subtitle', 'h2'],
        label: '标题 2',
        value: KEYS.h2,
      },
      {
        icon: <Heading3Icon />,
        keywords: ['subtitle', 'h3'],
        label: '标题 3',
        value: KEYS.h3,
      },
      {
        icon: <ListIcon />,
        keywords: ['unordered', 'ul', '-'],
        label: '无序列表',
        value: KEYS.ul,
      },
      {
        icon: <ListOrdered />,
        keywords: ['ordered', 'ol', '1'],
        label: '有序列表',
        value: KEYS.ol,
      },
      {
        icon: <Square />,
        keywords: ['checklist', 'task', 'checkbox', '[]'],
        label: '待办列表',
        value: KEYS.listTodo,
      },
      {
        icon: <ChevronRightIcon />,
        keywords: ['collapsible', 'expandable'],
        label: '折叠列表',
        value: KEYS.toggle,
      },
      {
        icon: <Code2 />,
        keywords: ['```'],
        label: '代码块',
        value: KEYS.codeBlock,
      },
      {
        icon: <Table />,
        label: '表格',
        value: KEYS.table,
      },
      {
        icon: <Quote />,
        keywords: ['citation', 'blockquote', 'quote', '>'],
        label: '引用',
        value: KEYS.blockquote,
      },
      {
        icon: <MinusIcon />,
        keywords: ['divider', 'hr', '---'],
        label: '分割线',
        value: KEYS.hr,
      },
      {
        description: '插入提示块',
        icon: <LightbulbIcon />,
        keywords: ['note'],
        label: '提示块',
        value: KEYS.callout,
      },
    ].map((item) => ({
      ...item,
      onSelect: (editor, value) => {
        insertBlock(editor, value, { upsert: true });
      },
    })),
  },
  {
    group: '高级块',
    items: [
      {
        icon: <TableOfContentsIcon />,
        keywords: ['toc'],
        label: '目录',
        value: KEYS.toc,
      },
      {
        icon: <Columns3Icon />,
        label: '三栏',
        value: 'action_three_columns',
      },
      {
        focusEditor: false,
        icon: <RadicalIcon />,
        label: '公式',
        value: KEYS.equation,
      },
      {
        icon: <PenToolIcon />,
        keywords: ['excalidraw'],
        label: 'Excalidraw',
        value: KEYS.excalidraw,
      },
      {
        focusEditor: false,
        icon: <Code2 />,
        keywords: [
          'code-drawing',
          'diagram',
          'plantuml',
          'graphviz',
          'flowchart',
          'mermaid',
        ],
        label: '代码绘图',
        value: KEYS.codeDrawing,
      },
      {
        icon: <FilmIcon />,
        keywords: ['embed', '嵌入'],
        label: '嵌入媒体',
        value: KEYS.mediaEmbed,
      },
    ].map((item) => ({
      ...item,
      onSelect: (editor, value) => {
        insertBlock(editor, value, { upsert: true });
      },
    })),
  },
  {
    group: '素材',
    items: [{
      icon: <ImageIcon />,
      label: '图片',
      value: KEYS.img,
      keywords: ['image'],
      onSelect: (editor, value) => insertBlock(editor, value, { upsert: true }),
    }],
  },
  {
    group: '行内元素',
    items: [
      ...[
        {
          focusEditor: true,
          icon: <CalendarIcon />,
          keywords: ['time'],
          label: '日期',
          value: KEYS.date,
        },
        {
          focusEditor: true,
          icon: <SuperscriptIcon />,
          keywords: ['citation', 'fn', 'footnote', '[^]'],
          label: '脚注',
          value: 'action_footnote',
        },
        {
          focusEditor: false,
          icon: <RadicalIcon />,
          label: '行内公式',
          value: KEYS.inlineEquation,
        },
      ].map((item) => ({
        ...item,
        onSelect: insertInlineElement,
      })),
      {
        icon: <SmileIcon />,
        focusEditor: false,
        keywords: ['emoji', ':'],
        label: '表情',
        value: KEYS.emoji,
        onSelect: (editor) => {
          const input = editor.getOption(EmojiPlugin, 'createComboboxInput')?.(':');
          if (input) editor.tf.insertNodes({ ...input, fromSlashMenu: true }, { select: true });
        },
      },
    ],
  },
];

const alignments = [
  ['left', '左对齐', AlignLeftIcon],
  ['center', '居中', AlignCenterIcon],
  ['right', '右对齐', AlignRightIcon],
  ['justify', '两端对齐', AlignJustifyIcon],
] as const;

function paragraphFormats(editor: PlateEditor): Group {
  const { validNodeValues = [] } = editor.getInjectProps(LineHeightPlugin);
  return {
    group: '段落格式',
    items: [
      ...alignments.map(([value, label, Icon]) => ({
        icon: <Icon />,
        keywords: ['对齐', 'align'],
        label,
        value: `align-${value}`,
        onSelect: (editor: PlateEditor) => editor.getTransforms(TextAlignPlugin).textAlign.setNodes(value),
      })),
      { icon: <IndentIcon />, keywords: ['缩进', 'indent'], label: '增加缩进', value: 'indent', onSelect: editor => indent(editor) },
      { icon: <OutdentIcon />, keywords: ['缩进', 'outdent'], label: '减少缩进', value: 'outdent', onSelect: editor => outdent(editor) },
      ...validNodeValues.map((value) => ({
        icon: <WrapTextIcon />,
        keywords: ['行距', 'line height'],
        label: `行高 ${value}`,
        value: `line-height-${value}`,
        onSelect: (editor: PlateEditor) => editor.getTransforms(LineHeightPlugin).lineHeight.setNodes(Number(value)),
      })),
    ],
  };
}

export function openTextSlashMenu(editor: PlateEditor) {
  if (editor.dom.readOnly) return;
  const { createComboboxInput, triggerQuery } = editor.getOptions(SlashPlugin);
  const at = editor.selection ? RangeApi.end(editor.selection) : editor.api.end([]);
  if (!at || !createComboboxInput) return;
  editor.tf.select(at);
  if (triggerQuery && !triggerQuery(editor)) return;
  editor.tf.insertNodes({ ...createComboboxInput('/'), fromToolbar: true }, { select: true });
}

export function SlashInputElement(
  props: PlateElementProps<TComboboxInputElement>
) {
  const { editor, element } = props;

  return (
    <PlateElement {...props} as="span">
      <InlineCombobox element={element} trigger="/" preserveOnCancel={!element.fromToolbar}>
        <InlineComboboxInput aria-label="搜索块" />

        <InlineComboboxContent>
          <InlineComboboxEmpty>没有匹配项</InlineComboboxEmpty>

          {[...groups, paragraphFormats(editor)].map(({ group, items }) => (
            <InlineComboboxGroup key={group}>
              <InlineComboboxGroupLabel>{group}</InlineComboboxGroupLabel>

              {items.map(
                ({ focusEditor, icon, keywords, label, value, onSelect }) => (
                  <InlineComboboxItem
                    key={value}
                    value={value}
                    onClick={() => onSelect(editor, value)}
                    label={label}
                    focusEditor={focusEditor}
                    group={group}
                    keywords={keywords}
                  >
                    <div className="mr-2 text-muted-foreground">{icon}</div>
                    {label ?? value}
                  </InlineComboboxItem>
                )
              )}
            </InlineComboboxGroup>
          ))}
        </InlineComboboxContent>
      </InlineCombobox>

      {props.children}
    </PlateElement>
  );
}
