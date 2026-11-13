import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppErrorBoundary } from '../../../src/components/AppErrorBoundary';
import '../../../src/styles.css';

function BrokenPane(): React.ReactNode {
  throw new Error('测试渲染失败：内容卡片无法载入');
}

document.documentElement.dataset.theme = 'dark';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode><AppErrorBoundary><BrokenPane /></AppErrorBoundary></React.StrictMode>,
);
