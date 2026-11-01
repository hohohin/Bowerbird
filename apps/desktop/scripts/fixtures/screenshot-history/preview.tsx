import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { ScreenshotSettings } from '../../../src/components/ScreenshotSettings';
import { useStore } from '../../../src/store';
import '../../../src/styles.css';

const w = window as any;
w.calls = []; w.fail = ''; w.settings = { theme: 'light', screenshot_shortcuts: { capture: 'F1', paste: 'F3' } };
w.shots = [1, 2].map(n => ({ id: `image-${n}`, created_at: `2026-11-01T0${n}:00:00Z`, width: 320, height: 240, bytes: 1024 }));
const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
canvas.getContext('2d')!.fillRect(0, 0, 320, 240);
mockWindows('main');
mockIPC(async (command, args) => {
  w.calls.push({ command, args });
  if (command === w.fail) throw new Error('OS error 5 at C:\\private\\history');
  if (command === 'get_settings') return w.settings;
  if (command === 'update_settings') { w.settings = args.settings; return; }
  if (command === 'screenshot_shortcut_status') return { error: null };
  if (command === 'screenshot_history_list') return w.shots;
  if (command === 'screenshot_history_image') return (await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)))).arrayBuffer();
  if (command === 'screenshot_history_output') return true;
  if (command === 'screenshot_history_delete') w.shots = w.shots.filter((row: any) => row.id !== args.id);
  if (command === 'screenshot_history_clear') w.shots = [];
}, { shouldMockEvents: true });
useStore.setState({ settings: w.settings });
createRoot(document.getElementById('root')!).render(<div style={{ padding: 24, maxWidth: 800 }}><ScreenshotSettings /></div>);
