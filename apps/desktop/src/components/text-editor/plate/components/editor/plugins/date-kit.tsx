// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import { DatePlugin } from '@platejs/date/react';

import { DateElement } from '@/components/text-editor/plate/ui/date-node';

export const DateKit = [DatePlugin.withComponent(DateElement)];
