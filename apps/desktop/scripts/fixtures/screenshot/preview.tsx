import React from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { ScreenshotWindow } from "../../../src/components/ScreenshotWindow";
import { ScreenshotSettings } from "../../../src/components/ScreenshotSettings";
import { useStore } from "../../../src/store";
import "../../../src/styles.css";
const w = window as any;
const mode = new URL(location.href).searchParams.get('mode');
w.calls = []; w.failOutput = false; w.cancelSave = false; w.conflict = false;
w.settings = { theme: 'light', screenshot_shortcuts: { capture: 'F1', paste: 'F3' } };
useStore.setState({ settings: w.settings });
const image = document.createElement('canvas'); image.width = 1600; image.height = 1200;
const ctx = image.getContext('2d')!;
const gradient = ctx.createLinearGradient(0, 0, 1600, 1200); gradient.addColorStop(0, '#173b64'); gradient.addColorStop(.5, '#7ec4ce'); gradient.addColorStop(1, '#f3ddab');
ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1600, 1200);
ctx.fillStyle = '#ffffff'; ctx.fillRect(180, 150, 640, 420); ctx.fillStyle = '#122e50'; ctx.font = 'bold 42px sans-serif'; ctx.fillText('Bowerbird / 截图测试', 220, 235);
ctx.font = '26px sans-serif'; ctx.fillText('选择区域 · 标注 · 复制 · 贴图', 220, 295);
for (let y = 340; y < 500; y += 8) { ctx.fillStyle = y % 16 ? '#444444' : '#dddddd'; ctx.fillRect(230, y, 500, 8); }
mockWindows(mode === 'settings' ? 'main' : mode === 'pin' ? 'pin-fixture' : 'snip-fixture');
mockIPC(async (command, args) => {
  w.calls.push({ command, args });
  if (command === 'screenshot_image') return image.toDataURL('image/png');
  if (command === 'screenshot_output') {
    if (w.failOutput) throw new Error('剪贴板暂时不可用');
    return !(w.cancelSave && args.action === 'save');
  }
  if (command === 'screenshot_set_shortcuts') {
    if (w.conflict) throw new Error('快捷键已被占用');
    w.settings = { ...w.settings, screenshot_shortcuts: args.shortcuts };
  }
  if (command === 'get_settings') return w.settings;
  if (command === 'screenshot_shortcut_status') return { error: null };
}, { shouldMockEvents: true });
createRoot(document.getElementById('root')!).render(<React.StrictMode>{mode === 'settings' ? <div style={{ padding: 32, maxWidth: 800 }}><ScreenshotSettings /></div> : <ScreenshotWindow pinned={mode === 'pin'} />}</React.StrictMode>);
