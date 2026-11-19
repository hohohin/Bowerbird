'use client';



import { lazy, Suspense, useMemo, useRef } from 'react';
import type { ExcalidrawInitialDataState, ExcalidrawProps } from '@excalidraw/excalidraw/types';
import type { TElement } from 'platejs';
import type { PlateElementProps } from 'platejs/react';

import { PlateElement, useReadOnly } from 'platejs/react';

import { cn } from '@/components/text-editor/plate/lib/utils';

import '@excalidraw/excalidraw/index.css';

Object.assign(window, { EXCALIDRAW_ASSET_PATH: new URL('/text-editor-assets/', window.location.href).href });
const Excalidraw = lazy(() => import('@excalidraw/excalidraw').then(module => ({ default: module.Excalidraw })));
export type DocumentDrawingElement = TElement & { data?: Pick<ExcalidrawInitialDataState, 'elements' | 'files'> & { state?: ExcalidrawInitialDataState['appState'] } };

export function ExcalidrawElement(
  props: PlateElementProps<DocumentDrawingElement>
) {
  const { children, element, editor } = props;
  const readOnly = useReadOnly();

  const initialData = useMemo(() => ({ elements: element.data?.elements ?? [], appState: element.data?.state, files: element.data?.files, scrollToContent: true }), [element.id]);
  const saved = useRef(JSON.stringify(element.data));
  const onChange: ExcalidrawProps['onChange'] = (elements, state, files) => {
    if (readOnly || (!element.data && !elements.length)) return;
    const data = { elements, files, state: { viewBackgroundColor: state.viewBackgroundColor, gridSize: state.gridSize, gridStep: state.gridStep, gridModeEnabled: state.gridModeEnabled } };
    const serialized = JSON.stringify(data);
    if (serialized === saved.current) return;
    const entry = editor.api.node({ at: [], match: node => node.id === element.id });
    if (!entry) return;
    saved.current = serialized;
    editor.tf.setNodes({ data: JSON.parse(serialized) }, { at: entry[1] });
  };

  return (
    <PlateElement {...props}>
      <div contentEditable={false}>
        <div
          className={cn(
            'mx-auto aspect-video h-[600px] w-[min(100%,600px)] overflow-hidden rounded-sm border'
          )}
        >
          <Suspense fallback={<div className="p-4 text-muted-foreground">正在打开绘图…</div>}>
            <Excalidraw
              initialData={initialData}
              onChange={onChange}
              langCode="zh-CN"
              viewModeEnabled={readOnly}
            />
          </Suspense>
        </div>
      </div>
      {children}
    </PlateElement>
  );
}
