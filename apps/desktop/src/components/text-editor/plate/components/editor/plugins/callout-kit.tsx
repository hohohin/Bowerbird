// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import { CalloutPlugin } from '@platejs/callout/react';

import { CalloutElement } from '@/components/text-editor/plate/ui/callout-node';

export const CalloutKit = [CalloutPlugin.withComponent(CalloutElement)];
