// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';
import { zhCN } from 'date-fns/locale';


import {
  formatDateValue,
  getDateDisplayLabel,
  parseCanonicalDateValue,
} from '@platejs/date';
import type { TDateElement } from 'platejs';
import type { PlateElementProps } from 'platejs/react';

import { PlateElement, useReadOnly } from 'platejs/react';

import { Calendar } from '@/components/text-editor/plate/primitives/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/text-editor/plate/primitives/popover';
import { cn } from '@/components/text-editor/plate/lib/utils';
import { inlineSuggestionVariants } from '@/components/text-editor/plate/lib/suggestion';

export function DateElement(props: PlateElementProps<TDateElement>) {
  const { editor, element } = props;
  const readOnly = useReadOnly();

  const trigger = (
    <span
      className={cn(
        'w-fit cursor-pointer rounded-sm bg-muted px-1 text-muted-foreground',
        inlineSuggestionVariants()
      )}
      contentEditable={false}
      draggable
    >
      {element.date || element.rawDate ? (
        getDateDisplayLabel(element)
      ) : (
        <span>选择日期</span>
      )}
    </span>
  );

  return (
    <PlateElement
      {...props}
      className="inline-block"
      attributes={{
        ...props.attributes,
        contentEditable: false,
      }}
    >
      {readOnly ? (
        trigger
      ) : (
        <Popover>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          <PopoverContent className="w-auto p-0">
            <Calendar
              locale={zhCN}
              selected={parseCanonicalDateValue(element.date ?? '')}
              onSelect={(date) => {
                if (!date) return;

                editor.tf.setNodes(
                  { date: formatDateValue(date), rawDate: undefined },
                  { at: element }
                );
              }}
              mode="single"
              initialFocus
            />
          </PopoverContent>
        </Popover>
      )}
      {props.children}
    </PlateElement>
  );
}
