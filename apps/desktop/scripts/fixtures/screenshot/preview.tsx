import React from "react";
import { createRoot } from "react-dom/client";
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { ScreenshotWindow } from "../../../src/components/ScreenshotWindow";
import { ScreenshotSettings } from "../../../src/components/ScreenshotSettings";
import { useStore } from "../../../src/store";
import "../../../src/screenshot.css";
const w = window as any;
const mode = new URL(location.href).searchParams.get('mode');
if (mode === 'settings') await import('../../../src/styles.css');
w.calls = []; w.failOutput = false; w.cancelSave = false; w.conflict = false;
w.session = mode === "warm" ? null : "initial";
w.nextSession = async (session: string | null) => { w.session = session; await emit("screenshot-session", session); };
w.imageDelay = 0;
w.settings = { theme: 'light', screenshot_shortcuts: { capture: 'F1', paste: 'F3' } };
useStore.setState({ settings: w.settings });
const image = document.createElement('canvas'); image.width = 1600; image.height = 1200;
const ctx = image.getContext('2d')!;
const gradient = ctx.createLinearGradient(0, 0, 1600, 1200); gradient.addColorStop(0, '#173b64'); gradient.addColorStop(.5, '#7ec4ce'); gradient.addColorStop(1, '#f3ddab');
ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1600, 1200);
ctx.fillStyle = '#ffffff'; ctx.fillRect(180, 150, 640, 420); ctx.fillStyle = '#122e50'; ctx.font = 'bold 42px sans-serif'; ctx.fillText('Bowerbird / 截图测试', 220, 235);
ctx.font = '26px sans-serif'; ctx.fillText('选择区域 · 标注 · 复制 · 贴图', 220, 295);
for (let y = 340; y < 500; y += 8) { ctx.fillStyle = y % 16 ? '#444444' : '#dddddd'; ctx.fillRect(230, y, 500, 8); }
// Adjacent, distinct source pixels expose off-by-one and interpolation errors.
for (const [x, color] of [[999, '#0000ff'], [1000, '#ff0000'], [1001, '#00ff00']] as const) { ctx.fillStyle = color; ctx.fillRect(x, 300, 1, 1); }
w.basePaints = 0; w.readbacks = [];
const originalDraw = CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage = function (...args: any[]) {
  if (this.canvas.matches('.snip-stage > canvas:not(.snip-draft)') && args[0] instanceof HTMLImageElement) w.basePaints++;
  return (originalDraw as any).apply(this, args);
};
const originalRead = CanvasRenderingContext2D.prototype.getImageData;
CanvasRenderingContext2D.prototype.getImageData = function (...args: any[]) {
  w.readbacks.push({ canvasWidth: this.canvas.width, canvasHeight: this.canvas.height, region: args });
  return (originalRead as any).apply(this, args);
};
mockWindows(mode === 'settings' ? 'main' : mode === 'pin' ? 'pin-fixture' : 'snip-fixture');
mockIPC(async (command, args) => {
  w.calls.push({ command, args });
  if (command === 'screenshot_session') return w.session;
  if (command === 'screenshot_image') {
    const delay = w.imageDelay;
    const data = await new Promise<Blob>(resolve => image.toBlob(blob => resolve(blob!)));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    return data.arrayBuffer();
  }
  if (command === 'screenshot_show') {
    if (args.session === w.session) w.calls.push({ command: 'plugin:window|show', args });
  }
  if (command === 'plugin:window|set_cursor_position') {
    // Model native integer-device-pixel rounding and the resulting pointer event.
    const position = (args.value as any).position;
    const sx = image.width / innerWidth, sy = image.height / innerHeight;
    document.querySelector('.snip-stage')?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: Math.round(position.x * sx) / sx, clientY: Math.round(position.y * sy) / sy }));
  }
  if (command === 'screenshot_output') {
    if (args.session !== w.session) throw new Error('截图已结束');
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
