// Adapted from Plate (MIT). See LICENSE.md in this directory tree.
'use client';

import * as React from 'react';

import { PlaceholderPlugin, UploadErrorCode } from '@platejs/media/react';
import { usePluginOption } from 'platejs/react';
import { notifyError } from '@/lib/notify';

export function MediaUploadToast() {
  useUploadErrorToast();

  return null;
}

const useUploadErrorToast = () => {
  const error = usePluginOption(PlaceholderPlugin, 'error');
  React.useEffect(() => {
    if (!error) return;
    const messages = {
      [UploadErrorCode.INVALID_FILE_SIZE]: '文件大小无效，请重新选择。',
      [UploadErrorCode.INVALID_FILE_TYPE]: '此文件格式不支持，请重新选择。',
      [UploadErrorCode.TOO_LARGE]: '文件超过大小限制，请使用更小的文件。',
      [UploadErrorCode.TOO_LESS_FILES]: '请选择需要插入的文件。',
      [UploadErrorCode.TOO_MANY_FILES]: '一次选择的文件过多，请分批插入。',
    };
    notifyError(messages[error.code], '文件未能插入，请检查文件后重试。');
  }, [error]);
};
