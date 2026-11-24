// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
import { lazy, Suspense, type ComponentType } from 'react';
import type { TEquationElement } from 'platejs';
import { SlateElement, type SlateElementProps } from 'platejs/static';

import { EquationSchema, InlineEquationSchema } from './math-schema';

function lazyEquation(load: () => Promise<{ default: ComponentType<SlateElementProps<TEquationElement>> }>) {
  const Equation = lazy(load);
  return function LazyEquation(props: SlateElementProps<TEquationElement>) {
    return <Suspense fallback={<SlateElement {...props}>{props.element.texExpression}</SlateElement>}>
      <Equation {...props}/>
    </Suspense>;
  };
}

const EquationElementStatic = lazyEquation(() => import('../../../ui/equation-node-static').then(module => ({ default: module.EquationElementStatic })));
const InlineEquationElementStatic = lazyEquation(() => import('../../../ui/equation-node-static').then(module => ({ default: module.InlineEquationElementStatic })));

export const BaseMathKit = [
  InlineEquationSchema.withComponent(InlineEquationElementStatic),
  EquationSchema.withComponent(EquationElementStatic),
];
