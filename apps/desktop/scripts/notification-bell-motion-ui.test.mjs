import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/notification-bell-motion';
await mkdir(output, { recursive: true });
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 18957, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
page.setDefaultTimeout(5000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const latest = page.getByRole('dialog', { name: '新通知' });
async function pose(time) {
  return latest.evaluate((panel, time) => {
    if (time !== null) for (const animation of window.motionAnimations) animation.currentTime = time;
    const style = getComputedStyle(panel), matrix = new DOMMatrixReadOnly(style.transform);
    return { x: matrix.m41, y: matrix.m42, opacity: Number(style.opacity), contact: Number(getComputedStyle(panel, '::after').opacity) };
  }, time);
}
try {
  await page.clock.install({ time: new Date('2026-11-03T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-03T00:00:01Z'));
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/notifications-scrollbars/bell-test.html`);
  await page.getByRole('button', { name: /^通知/ }).waitFor();
  await page.evaluate(() => {
    // Freeze browser-rendered animations at mount so geometry can be sampled deterministically.
    new MutationObserver(() => {
      const panel = document.querySelector('.notification-bell-panel');
      if (!panel || window.motionPanel === panel) return;
      window.motionPanel = panel;
      window.motionAnimations = panel.getAnimations({ subtree: true });
      for (const animation of window.motionAnimations) { animation.pause(); animation.currentTime = 0; }
    }).observe(document.body, { childList: true });
  });
  await page.evaluate(() => window.notice('第一条卡入'));
  await latest.waitFor();
  const start = await pose(0), travel = await pose(120), contact = await pose(270), settled = await pose(450);
  assert.ok(start.x >= 32 && start.y === 0 && travel.x < start.x, 'new message travels from right to left without dropping vertically');
  assert.ok(contact.x < 0 && contact.x >= -4, 'card briefly passes the slot before settling');
  assert.equal(settled.x, 0); assert.equal(settled.opacity, 1);
  assert.ok((await pose(270)).contact > (await pose(310)).contact, 'slot edge flashes once');
  assert.ok((await pose(350)).contact > (await pose(450)).contact, 'second contact flash ends cleanly');
  assert.equal((await pose(350)).opacity, 1, 'message text remains readable during the edge flash');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await pose(270); await page.screenshot({ path: `${output}/${theme}-contact.png` });
    await pose(450); await page.screenshot({ path: `${output}/${theme}-settled.png` });
  }
  await page.evaluate(() => window.notice('第二条卡入'));
  await latest.getByText('快速生成 · 第二条卡入', { exact: true }).waitFor();
  assert.ok((await pose(null)).x >= 32, 'a replacement message also replays the entrance');
  await pose(450); await latest.hover();
  await page.evaluate(() => window.notice('阅读时到达'));
  await latest.getByText('快速生成 · 第二条卡入', { exact: true }).waitFor();
  assert.equal((await pose(null)).x, 0, 'reading a message never restarts its animation');
  await page.clock.runFor(4500); assert.equal(await latest.count(), 1);
  await page.keyboard.press('Escape'); await page.mouse.move(5, 600);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => window.notice('减少动态效果'));
  await latest.waitFor();
  assert.equal(await latest.evaluate(panel => panel.getAnimations({ subtree: true }).length), 0, 'reduced motion skips travel and flashing');
  assert.equal((await pose(0)).x, 0); assert.equal((await pose(0)).opacity, 1);
  await page.clock.runFor(3999); assert.equal(await latest.count(), 1);
  await page.clock.runFor(2); assert.equal(await latest.count(), 0, 'idle dismissal still happens at four seconds');
  assert.deepEqual(errors, []);
  console.log('PASS real bell: horizontal slot entrance, brief edge flashes, new-message replay, reading stability, reduced motion and four-second dismissal');
} finally { await browser.close(); await server.close(); }
