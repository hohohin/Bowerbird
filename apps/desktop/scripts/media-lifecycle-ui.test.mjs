import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 1598, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.route('**/media-lifecycle-test', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://127.0.0.1:1598/media-lifecycle-test');
  await page.evaluate(async () => {
    window.__TAURI_INTERNALS__ = { convertFileSrc: path => path, invoke: async () => null };
    const [{ default: React }, { default: { createRoot } }, { CanvasConversationImages }, notifications] = await Promise.all([
      import('/node_modules/.vite/deps/react.js'), import('/node_modules/.vite/deps/react-dom_client.js'),
      import('/src/components/CanvasConversationImages.tsx'), import('/src/lib/generationNotifications.ts'),
    ]);
    const root = createRoot(document.getElementById('root'));
    window.renderImages = images => root.render(React.createElement(CanvasConversationImages, { images, onContextMenu: () => {} }));
    window.notifications = notifications;
    window.contexts = [];
    window.AudioContext = class {
      state = 'suspended'; currentTime = 0; resumes = 0; closes = 0;
      constructor() { window.contexts.push(this); }
      resume() { this.resumes++; return new Promise(resolve => { this.finishResume = () => { this.state = 'running'; resolve(); }; }); }
      close() { this.closes++; this.state = 'closed'; return Promise.resolve(); }
    };
    window.renderImages([
      { id: 'video', assetId: 'video', name: '视频', storePath: 'clip.mp4', thumbPath: 'poster.jpg' },
      { id: 'missing', assetId: 'missing', name: '无封面视频', storePath: 'no-poster.mp4', thumbPath: null },
    ]);
  });
  const selected = page.locator('[data-conversation-image]');
  await page.locator('[data-conversation-image="missing"]').waitFor();
  assert.equal(await selected.locator('video').count(), 0, 'a missing poster must not create a video player');
  assert.match(await selected.locator('img').getAttribute('src'), /^data:image/);
  await page.getByRole('button', { name: '上一张生成图片' }).click();
  await page.locator('[data-conversation-image="video"] img').waitFor();
  assert.equal(await selected.locator('img').getAttribute('src'), 'poster.jpg');
  assert.equal(await selected.locator('video').count(), 0, 'JPEG posters must not be sent to a video decoder');
  for (let i = 0; i < 5; i++) {
    await page.getByRole('button', { name: '下一张生成图片' }).click();
    await page.getByRole('button', { name: '上一张生成图片' }).click();
  }
  assert.equal(await page.locator('video').count(), 0);
  const audio = await page.evaluate(async () => {
    const gesture = () => window.dispatchEvent(new Event('pointerdown'));
    let cleanup = window.notifications.prepareGenerationSound(false);
    gesture(); window.dispatchEvent(new Event('keydown'));
    const disabled = window.contexts.length;
    cleanup?.();
    cleanup = window.notifications.prepareGenerationSound(true);
    gesture(); gesture(); window.dispatchEvent(new Event('keydown'));
    const pending = window.contexts.map(context => context.resumes);
    window.contexts[0].finishResume();
    await Promise.resolve(); await Promise.resolve();
    gesture();
    cleanup();
    // A completion arriving before another enabled user gesture must not create audio.
    await window.notifications.notifyGenerationComplete('silent-before-gesture', 'done', { generation_completion_popup: false, generation_completion_sound: true });
    cleanup = window.notifications.prepareGenerationSound(false);
    gesture(); cleanup?.();
    const afterDisable = window.contexts.length;
    cleanup = window.notifications.prepareGenerationSound(true);
    gesture(); cleanup();
    return { disabled, pending, afterDisable, contexts: window.contexts.map(({ resumes, closes }) => ({ resumes, closes })) };
  });
  assert.deepEqual(audio, { disabled: 0, pending: [1], afterDisable: 1, contexts: [{ resumes: 1, closes: 1 }, { resumes: 1, closes: 1 }] });
  assert.deepEqual(errors, []);
  console.log('PASS: static video posters, missing poster, carousel switching, disabled audio, resume coalescing, cleanup and re-enable');
} finally {
  await browser.close();
  await server.close();
}
