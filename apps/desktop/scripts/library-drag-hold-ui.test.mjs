import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/library-drag-hold/vite', server: { host: '127.0.0.1', port: 17961, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const card = page.locator('.folder-media-card[data-asset-id="image"]');
const overlay = page.locator('.external-drag-backdrop');
const calls = () => page.evaluate(() => window.calls.filter(call => call.command === 'start_external_drag'));
const pointer = (type, x = 120, y = 100, buttons = 1) => card.dispatchEvent(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons, clientX: x, clientY: y });
const finish = async () => { await page.evaluate(() => window.resolveDrag({ dropped: false })); await page.waitForFunction(() => !window.payload()); };
try {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/external-drag/production.html`);
  await card.waitFor();
  await page.clock.install();
  await pointer('pointerdown');
  await page.clock.runFor(599);
  assert.equal(await overlay.count(), 0);
  await page.clock.runFor(1);
  assert.equal(await overlay.count(), 1, 'stationary library hold shows feedback at 600ms without any dragstart or window exit');
  await page.clock.runFor(64);
  assert.equal((await calls()).length, 1);
  assert.deepEqual((await calls())[0].args.assetIds, ['image', 'offscreen']);
  await card.dispatchEvent('dragover', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
  assert.equal(await overlay.evaluate(el => getComputedStyle(el).visibility), 'visible', 'native dragover at its origin must not immediately hide long-press feedback');
  const drop = await page.locator('#internal-target').evaluate(el => {
    const transfer = new DataTransfer();
    const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
    el.dispatchEvent(event);
    return { prevented: event.defaultPrevented, drops: window.drops.length };
  });
  assert.deepEqual(drop, { prevented: true, drops: 0 }, 'explicit outgoing hold cannot accidentally insert into its source app');
  await finish();
  await card.dispatchEvent('click', { detail: 1 });
  assert.equal(await page.evaluate(() => window.selectedClicks ?? 0), 0, 'tail click from the hold never opens or selects a material');
  await pointer('pointerdown'); await pointer('pointerup', 120, 100, 0); await card.dispatchEvent('click');
  assert.equal(await page.evaluate(() => window.selectedClicks), 1, 'a fresh ordinary click remains available');

  await pointer('pointerdown'); await pointer('pointermove', 124);
  await page.clock.runFor(664);
  assert.equal((await calls()).length, 2, 'exactly 4px of movement is allowed');
  await finish();
  await pointer('pointerdown'); await pointer('pointermove', 125); await pointer('pointermove');
  await page.clock.runFor(700);
  assert.equal((await calls()).length, 2, 'moving beyond 4px permanently cancels the hold for this press');
  await pointer('pointerup', 120, 100, 0);

  for (const reason of ['release', 'escape', 'blur', 'scroll', 'lost-button']) {
    await pointer('pointerdown'); await page.clock.runFor(300);
    if (reason === 'release') await pointer('pointerup', 120, 100, 0);
    else if (reason === 'lost-button') await pointer('pointermove', 120, 100, 0);
    else await page.evaluate(reason => window.dispatchEvent(reason === 'escape' ? new KeyboardEvent('keydown', { key: 'Escape' }) : new Event(reason)), reason);
    await page.clock.runFor(500);
    assert.equal((await calls()).length, 2, `${reason} cancels an untriggered hold`);
  }
  await pointer('pointerdown');
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await card.dispatchEvent('dragstart', { dataTransfer: transfer });
  await page.clock.runFor(700);
  assert.equal((await calls()).length, 3, 'ordinary dragging still works and cancels its pending long press');
  await card.dispatchEvent('dragover', { dataTransfer: transfer });
  assert.equal(await overlay.evaluate(el => getComputedStyle(el).visibility), 'hidden', 'ordinary dragging retains clear internal drop targets');
  await finish();
  for (const id of ['audio', 'video']) {
    const media = page.locator(`.folder-media-card[data-asset-id="${id}"]`);
    await media.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: 120, clientY: 100 });
    await page.clock.runFor(664);
    assert.deepEqual((await calls()).at(-1).args.assetIds, [id], `${id} uses the same stationary hold`);
    assert.equal(await overlay.evaluate(el => getComputedStyle(el).visibility), 'visible');
    await finish();
  }
  const beforeControls = (await calls()).length;
  await page.locator('.folder-media-card[data-asset-id="text"]').dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 });
  await page.clock.runFor(700);
  assert.equal((await calls()).length, beforeControls, 'text has no native outgoing-file support and must not enter a misleading hold mode');
  await page.locator('.audio-waveform-wave').dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 });
  await page.clock.runFor(700);
  assert.equal((await calls()).length, beforeControls, 'audio controls do not become outgoing drags');
  await pointer('pointerdown');
  await card.evaluate(el => el.setAttribute('inert', ''));
  await page.clock.runFor(700);
  assert.equal((await calls()).length, beforeControls, 'a hidden/inert card cannot start a late hold');
  await card.evaluate(el => el.removeAttribute('inert'));

  // Exercise real Chromium pointer/click dispatch, not just synthetic events.
  const bounds = await card.boundingBox();
  await page.mouse.move(bounds.x + 40, bounds.y + 40); await page.mouse.down();
  await page.clock.runFor(664);
  assert.equal((await calls()).length, beforeControls + 1);
  await mkdir('.tmp/library-drag-hold', { recursive: true });
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.external-drag-backdrop')).opacity) > .95);
  await page.screenshot({ path: '.tmp/library-drag-hold/stationary-hud.png' });
  const clicks = await page.evaluate(() => window.selectedClicks);
  await page.mouse.up(); await finish();
  assert.equal(await page.evaluate(() => window.selectedClicks), clicks, 'real mouse release after long press does not click the card');
  await page.mouse.move(bounds.x + 40, bounds.y + 40); await page.mouse.down();
  await page.mouse.move(bounds.x + 44, bounds.y + 40);
  await page.clock.runFor(664);
  assert.equal((await calls()).length, beforeControls + 2, 'real pointer jitter at 4px still becomes a long press');
  await card.dispatchEvent('dragover', { dataTransfer: transfer });
  assert.equal(await overlay.evaluate(el => getComputedStyle(el).visibility), 'visible');
  await page.mouse.up(); await finish();
  await page.mouse.move(bounds.x + 40, bounds.y + 40); await page.mouse.down();
  await page.mouse.move(bounds.x + 44, bounds.y + 40); await page.clock.runFor(100);
  assert.equal((await calls()).length, beforeControls + 2, 'browser dragstart inside the tolerance does not start early');
  await page.mouse.move(bounds.x + 46, bounds.y + 40); await page.clock.runFor(64);
  assert.equal((await calls()).length, beforeControls + 3, 'moving farther after a deferred browser drag still starts normal dragging');
  await card.dispatchEvent('dragover', { dataTransfer: transfer });
  assert.equal(await overlay.evaluate(el => getComputedStyle(el).visibility), 'hidden');
  await page.clock.runFor(700);
  assert.equal((await calls()).length, beforeControls + 3, 'deferred drag never also starts a long press');
  await page.mouse.up(); await finish();
  await pointer('pointerdown'); await page.clock.runFor(300);
  await page.evaluate(() => window.unmount()); await page.clock.runFor(700);
  assert.equal((await calls()).length, beforeControls + 3, 'unmount cancels a pending hold');

  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/home-navigation-live/preview.html?source-library&detail-route&canvas-library&media-home`);
  const liveCard = page.locator('.library-home .folder-media-card[data-asset-id]').first();
  await liveCard.waitFor();
  await page.evaluate(() => {
    window.isTauri = true;
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === 'start_external_drag') return new Promise(resolve => { window.resolveLibraryDrag = resolve; });
      if (command === 'cancel_pending_external_drag') return Promise.resolve(false);
      return invoke(command, args);
    };
  });
  const liveBounds = await liveCard.boundingBox();
  await page.mouse.move(liveBounds.x + liveBounds.width / 2, liveBounds.y + liveBounds.height / 2); await page.mouse.down();
  await page.clock.runFor(664);
  assert.equal(await overlay.count(), 1, 'the real home catalog wires the hold without a dragstart');
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.external-drag-backdrop')).opacity) > .95);
  await page.getByRole('status').filter({ hasText: '拖到其他应用中使用' }).waitFor();
  await page.screenshot({ path: '.tmp/library-drag-hold/home-stationary-hud.png' });
  await page.mouse.up(); await page.evaluate(() => window.resolveLibraryDrag({ dropped: false }));
  await overlay.waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('dialog').count(), 0, 'home image-preview capture cannot consume the hold tail');
  await liveCard.click();
  await page.getByRole('dialog', { name: '图片与会话预览' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS library stationary hold: timing, 4px boundary, immediate persistent HUD, multi-selection, cancellation, click suppression and ordinary drag compatibility');
} finally { await browser.close(); await server.close(); }
