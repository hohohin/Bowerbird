// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import { BasicBlocksKit } from './basic-blocks-kit';
import { BasicMarksKit } from './basic-marks-kit';

export const BasicNodesKit = [...BasicBlocksKit, ...BasicMarksKit];
