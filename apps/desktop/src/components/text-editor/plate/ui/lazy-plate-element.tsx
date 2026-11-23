import { lazy, Suspense, type ComponentType } from 'react';
import type { TElement } from 'platejs';
import { PlateElement, type PlateElementProps } from 'platejs/react';

export function lazyPlateElement<Element extends TElement>(load: () => Promise<{ default: ComponentType<PlateElementProps<Element>> }>, label: string) {
  const Component = lazy(load);
  return function LazyPlateElement(props: PlateElementProps<Element>) {
    return <Suspense fallback={<PlateElement {...props}><span contentEditable={false}>{label}</span>{props.children}</PlateElement>}>
      <Component {...props}/>
    </Suspense>;
  };
}
