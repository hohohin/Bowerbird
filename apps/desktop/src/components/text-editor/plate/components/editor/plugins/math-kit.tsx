// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import type { TEquationElement } from 'platejs';
import { toPlatePlugin } from 'platejs/react';

import { lazyPlateElement } from '../../../ui/lazy-plate-element';
import { BlockEquationRule, EquationSchema, InlineEquationRule, InlineEquationSchema } from './math-schema';

const EquationElement = lazyPlateElement<TEquationElement>(() => import('../../../ui/equation-node').then(module => ({ default: module.EquationElement })), '正在加载公式…');
const InlineEquationElement = lazyPlateElement<TEquationElement>(() => import('../../../ui/equation-node').then(module => ({ default: module.InlineEquationElement })), '公式');

export const MathKit = [
  toPlatePlugin(InlineEquationSchema).configure({
    inputRules: [InlineEquationRule()],
    node: {
      component: InlineEquationElement,
    },
  }),
  toPlatePlugin(EquationSchema).configure({
    inputRules: [BlockEquationRule()],
    node: {
      component: EquationElement,
    },
  }),
];
