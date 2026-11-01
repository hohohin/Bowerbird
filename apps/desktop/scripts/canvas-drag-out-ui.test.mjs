import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/canvas-drag-out-ui/vite', server: { host: '127.0.0.1', port: 17905, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(6500);
const errors = [], remote = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => { if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue(); remote.push(route.request().url()); return route.abort(); });
const node = id => page.locator(`[data-canvas-node-id="${id}"]`);
const count = () => page.evaluate(() => window.exportCalls.length);
const snapshot = () => page.evaluate(() => { const { view, ...snapshot } = window.snapshot(); return snapshot; });
const center = async locator => { const box = await locator.boundingBox(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
const move = point => page.mouse.move(point.x, point.y);
const press = async locator => { await move(await center(locator)); await page.mouse.down(); };
let expectedExports = 0;
async function open(sample = 'plain') {
  expectedExports = 0;
  await page.goto(`http://127.0.0.1:17905/scripts/fixtures/canvas-drag-out/production.html?case=${sample}`, { waitUntil: 'domcontentloaded' });
  await node(sample === 'plain' ? 'first' : sample === 'group' ? 'group' : 'session').waitFor();
}
async function exported(ids, before) {
  await page.waitForFunction(expected => window.exportCalls.length === expected, ++expectedExports);
  assert.deepEqual(await page.evaluate(() => window.exportCalls.at(-1).assetIds), ids);
  assert.equal(await page.evaluate(() => window.exportCalls.at(-1).mode), 'hold');
  assert.equal(await page.locator('[data-canvas-node-id]').evaluateAll(nodes => nodes.some(node => node.hasPointerCapture(1))), false, 'canvas releases capture before native ownership');
  assert.deepEqual(await snapshot(), before, 'long press does not move or place a canvas item');
}
async function finish(dropped = true) {
  await page.evaluate(dropped => window.finishExport({ dropped }), dropped); await page.mouse.up();
  await page.waitForTimeout(400);
  assert.deepEqual(await page.evaluate(() => window.picks), []); assert.deepEqual(await page.evaluate(() => window.peeks), []);
  assert.equal(await page.locator('[data-project-inspector]').count(), 0);
  assert.equal(await page.getByRole('dialog', { name: /媒体预览/ }).count(), 0, 'release after export never opens the original');
}
try {
  await mkdir('.tmp/canvas-drag-out-ui', { recursive: true });
  await open(); const original = await snapshot();
  await press(node('first')); await page.waitForTimeout(350); assert.equal(await count(), 0);
  await exported(['existing'], original);
  await page.screenshot({ path: '.tmp/canvas-drag-out-ui/canvas-hold-dark.png' });
  await page.locator('[data-canvas-stage]').evaluate(element => {
    const dataTransfer = new DataTransfer(); dataTransfer.items.add(new File(['synthetic'], 'existing.png', { type: 'image/png' }));
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientX: rect.right - 100, clientY: rect.top + 100 }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: rect.right - 100, clientY: rect.top + 100 }));
  });
  await page.waitForTimeout(100);
  assert.deepEqual(await snapshot(), original, 'canvas-origin native drop back into Bowerbird never duplicates or moves its source');
  await finish();
  assert.deepEqual(await snapshot(), original);
  await node('first').click({ button: 'right' }); assert.equal(await page.getByRole('menuitem', { name: '拖入到其他应用', exact: true }).count(), 0, 'old pickup entry is removed'); await page.keyboard.press('Escape');
  // Movement starts before 600ms; pausing while moving never arms a second long press.
  await open(); const start = await center(node('first')); await press(node('first'));
  await page.mouse.move(start.x + 30, start.y + 20); await page.waitForTimeout(70);
  assert.ok((await center(node('first'))).x > start.x + 20, 'ordinary movement does not wait for the hold threshold');
  await page.waitForTimeout(750); assert.equal(await count(), 0); await page.mouse.up();
  await open(); await press(node('first')); await page.mouse.move((await center(node('first'))).x + 4, (await center(node('first'))).y);
  await page.waitForTimeout(750); assert.equal(await count(), 0, 'the existing exact 4px threshold cancels long press'); await page.mouse.up();
  // No trigger after a short click, Escape, or leaving the project during the timer.
  await open(); await press(node('first')); await page.mouse.up(); await page.waitForTimeout(700); assert.equal(await count(), 0);
  await open(); await press(node('first')); await page.keyboard.press('Escape'); await page.waitForTimeout(700); assert.equal(await count(), 0); await page.mouse.up();
  await open(); await press(node('first')); await page.evaluate(() => window.changeProject()); await page.waitForTimeout(700); assert.equal(await count(), 0); await page.mouse.up();
  // Multi-select retains every actual asset, not node identities.
  await open(); await node('first').click({ modifiers: ['Control'] }); await node('second').click({ modifiers: ['Control'] });
  const multiple = await snapshot(); await press(node('first')); await exported(['existing', 'a'], multiple); await finish(false);
  // Both collapsed thumbnails and expanded members target that file, not their siblings.
  await open('group'); const folded = await snapshot(); await press(node('group').locator('[data-frequent-asset-id="a"]'));
  await exported(['a'], folded); await finish(); assert.equal(await node('group').getAttribute('aria-expanded'), 'false');
  await node('group').click(); const member = page.locator('[data-canvas-folder-asset-id="member-a"]'); await member.waitFor();
  const grouped = await snapshot(); await press(member); await exported(['a'], grouped); await finish(); assert.deepEqual(await snapshot(), grouped);
  // An external receiver may consume the final DOM click; the next real press still works.
  await press(member); await exported(['a'], grouped);
  await page.evaluate(() => { window.consumePointerTail = event => event.stopImmediatePropagation(); for (const name of ['pointerup', 'click']) window.addEventListener(name, window.consumePointerTail, { capture: true, once: true }); });
  await page.mouse.up(); await page.evaluate(() => { for (const name of ['pointerup', 'click']) window.removeEventListener(name, window.consumePointerTail, true); window.finishExport({ dropped: true }); });
  await member.click(); await page.getByRole('dialog', { name: '媒体预览，1 / 1' }).waitFor(); await page.keyboard.press('Escape');
  await press(member); await exported(['a'], grouped);
  await page.evaluate(() => { window.consumePointerTail = event => event.stopImmediatePropagation(); for (const name of ['pointerup', 'click']) window.addEventListener(name, window.consumePointerTail, { capture: true, once: true }); });
  await page.mouse.up(); await page.evaluate(() => { for (const name of ['pointerup', 'click']) window.removeEventListener(name, window.consumePointerTail, true); window.finishExport({ dropped: true }); });
  await member.focus(); await page.keyboard.press('Enter'); await page.getByRole('dialog', { name: '媒体预览，1 / 1' }).waitFor(); await page.keyboard.press('Escape');
  // A generated image targets the shown output, preserving carousel buttons.
  await open('conversation'); const conversation = node('session'); await page.locator('[data-conversation-image="b"]').waitFor();
  await conversation.hover(); await conversation.getByRole('button', { name: '上一张生成图片' }).click(); await page.locator('[data-conversation-image="a"]').waitFor();
  const generated = await snapshot(); await press(page.locator('[data-conversation-image="a"]')); await exported(['a'], generated); await finish();
  assert.deepEqual(await snapshot(), generated);
  // Navigation while the native IPC is pending requests cancellation of its own session.
  await open(); await press(node('first')); await exported(['existing'], await snapshot());
  const sessionId = await page.evaluate(() => window.exportCalls.at(-1).sessionId);
  await page.evaluate(() => window.changeProject());
  await page.waitForFunction(id => window.cancellations.some(item => item.sessionId === id), sessionId);
  await finish(false); assert.equal(await node('first').count(), 0);
  // An old cancelled export can finish while the next ordinary canvas move is hovering a target.
  await open(); await press(node('first')); await page.waitForFunction(() => window.exportCalls.length === 1);
  await page.mouse.up(); await page.locator('.external-drag-backdrop').waitFor({ state: 'detached' });
  await press(node('first')); await move(await center(node('second')));
  await page.getByRole('tooltip', { name: '松开创建素材组', exact: true }).waitFor();
  await page.evaluate(() => window.finishExport({ dropped: false }));
  assert.equal(await page.getByRole('tooltip', { name: '松开创建素材组', exact: true }).count(), 1, 'old external completion preserves a newer internal drag target');
  await page.mouse.up(); await page.waitForFunction(() => window.snapshot().groups.length === 1);
  assert.deepEqual(errors, []); assert.deepEqual(remote, []);
  await writeFile('.tmp/canvas-drag-out-ui/result.json', JSON.stringify({ passed: true, errors, remote, boundary: 'real CanvasWorkspace with controlled native IPC' }, null, 2));
  console.log('Canvas long-press integration passed (controlled native IPC).');
} finally { await browser.close(); await server.close(); }
