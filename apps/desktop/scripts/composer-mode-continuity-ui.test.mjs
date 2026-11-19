import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/composer-mode-continuity';
await mkdir(output, { recursive: true });
const server = await createServer({ cacheDir: `${output}/vite`, server: { host: '127.0.0.1', port: 18986, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const url = `${server.resolvedUrls.local[0]}scripts/fixtures/library-creation-parity/preview.html?source-library&detail-route&canvas-library`;
const settle = () => page.waitForTimeout(350);
async function checkModes(dock, location) {
  await dock.locator('.ProseMirror').fill('图片草稿'); await settle();
  await page.evaluate(() => {
    window.composerEntries = [];
    document.addEventListener('animationstart', event => {
      if (event.target.matches('.creation-dock')) window.composerEntries.push(event.animationName);
    });
    document.addEventListener('click', event => {
      if (!event.target.closest('.composer-mode-picker > button')) return;
      window.composerFrames = [];
      const sample = () => {
        const dock = document.querySelector('.creation-dock:not(.is-collapsed)');
        const style = dock && getComputedStyle(dock);
        const surface = dock?.querySelector('.composer-projection-surface');
        window.composerFrames.push({ opacity: style?.opacity, transform: style?.transform, masked: !!surface && getComputedStyle(surface).maskImage.startsWith('url(') });
        if (window.composerFrames.length < 8) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, true);
  });
  const drafts = { 图片: '图片草稿', 视频: '视频草稿\n保留第二行', 对话: '对话草稿' };
  const saved = { 图片: await dock.locator('.ProseMirror').innerText() };
  for (const mode of ['视频', '对话', '图片', '视频', '对话', '图片']) {
    await dock.getByRole('button', { name: mode, exact: true }).click();
    await settle();
    assert.deepEqual(await page.evaluate(() => window.composerEntries), [], `${location}/${mode}: switching never replays the whole composer entrance`);
    const frames = await page.evaluate(() => window.composerFrames);
    assert.ok(frames.length === 8 && frames.every(frame => frame.opacity === '1' && frame.transform === 'none' && frame.masked), `${location}/${mode}: every switching frame keeps the stable projected surface: ${JSON.stringify(frames)}`);
    assert.equal(await dock.evaluate(el => getComputedStyle(el).opacity), '1');
    assert.ok(await dock.locator('.composer-projection-surface').evaluate(el => getComputedStyle(el).maskImage.startsWith('url(')), 'projection is ready after switching');
    const editor = dock.locator('.ProseMirror');
    if (mode in saved) assert.equal(await editor.innerText(), saved[mode], `${mode}: its own draft is restored`);
    else { await editor.fill(drafts[mode]); saved[mode] = await editor.innerText(); }
  }
  await dock.getByRole('button', { name: '退出创作模式', exact: true }).click(); await settle();
  await dock.getByRole('button', { name: '展开创作描述', exact: true }).click(); await settle();
  assert.deepEqual(await page.evaluate(() => window.composerEntries), ['composer-optical-rise'], 'a real collapse/reopen still animates');
  for (const width of [1440, 900, 640]) {
    await page.setViewportSize({ width, height: 900 }); await settle();
    const edges = await dock.evaluate(el => ({
      editor: el.querySelector('.ProseMirror').getBoundingClientRect().right,
      send: el.querySelector('.generation-send-button').getBoundingClientRect().right,
    }));
    assert.ok(Math.abs(edges.editor - edges.send) <= 2, `${location}/${width}: input extends to the send button right edge: ${JSON.stringify(edges)}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 }); await settle();
  await dock.locator('.ProseMirror').fill('让清晨的光线落在柔和的材质上，镜头沿着弧面缓缓推进，呈现细腻的纹理与空间层次。');
  await page.mouse.move(20, 160);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme); await settle();
    await page.screenshot({ path: `${output}/${location}-${theme}.png`, clip: { x: 0, y: 560, width: 1440, height: 340 } });
  }
}
try {
  await page.goto(url); await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.getByRole('button', { name: '返回主页', exact: true }).click();
  await page.getByRole('navigation', { name: '首页' }).getByRole('button', { name: '素材库', exact: true }).click();
  const home = page.locator('.library-composer .creation-dock');
  await home.getByRole('button', { name: '展开创作描述', exact: true }).click();
  await checkModes(home, 'home');
  await page.goto(url); await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await checkModes(page.locator('.canvas-workspace .creation-dock'), 'canvas');
  assert.deepEqual(errors, []);
  console.log('PASS composer mode continuity, independent drafts, reopen animation and input right alignment');
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` }); throw error;
} finally { await browser.close(); await server.close(); }
