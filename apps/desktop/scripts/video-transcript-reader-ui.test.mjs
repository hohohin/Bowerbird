import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({
  cacheDir: '.tmp/video-transcript-reader/vite',
  server: { host: '127.0.0.1', port: 17767, strictPort: false, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 600 }, reducedMotion: 'reduce' });
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
const url = `${server.resolvedUrls.local[0]}scripts/fixtures/video-transcript-reader/preview.html`;
const errors = [];
page.on('pageerror', error => errors.push(error.message));

try {
  await page.goto(url);
  const list = page.getByRole('list', { name: '转录文稿列表' });
  const first = list.locator('li[data-index="0"]');
  const input = page.getByRole('searchbox', { name: '搜索文稿' });
  await first.waitFor();
  await page.getByText('点击可定位的字词跳转', { exact: true }).waitFor();
  assert.equal(await first.locator('.video-transcript-reader-body').evaluate(node => getComputedStyle(node).fontSize), '14px');
  assert.equal(await first.getByRole('button', { name: '跳转至 0:00.000', exact: true }).count(), 1);
  assert.equal(await first.locator('.video-transcript-reader-body').textContent(), '好好，HELLO world！2026年。收工。');
  assert.deepEqual(await first.locator('.video-transcript-reader-word').allTextContents(), ['好', '好', 'HELLO', 'world', '年', '收', '工']);
  assert.equal(await list.locator('li[data-index="2"] .video-transcript-reader-word').count(), 0, 'an ambiguous repeat gets no invented timing');
  assert.deepEqual(await list.locator('li[data-index="3"] .video-transcript-reader-word').allTextContents(), ['乙']);
  assert.equal(await list.getByRole('button', { name: '跳转至 0:09.140 · 乙', exact: true }).count(), 1, 'a provider point timestamp remains clickable');
  await first.getByRole('button', { name: '跳转至 0:00.100 · 好', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.seekTimes), [0.1, 0.3]);
  assert.ok(await list.getByRole('listitem').count() < 25, 'mount only viewport rows');

  const rightBelow = list.locator('li[data-index="1"]');
  const initialHeight = (await rightBelow.boundingBox()).height;
  const searchTop = (await input.boundingBox()).y;
  await page.setViewportSize({ width: 270, height: 600 });
  await page.waitForFunction(height => {
    const second = document.querySelector('li[data-index="1"]').getBoundingClientRect();
    const third = document.querySelector('li[data-index="2"]').getBoundingClientRect();
    return second.height > height && third.top >= second.bottom - 1;
  }, initialHeight);

  await list.focus();
  await page.keyboard.press('End');
  await list.getByText('索引尾句，到了。', { exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement.closest('li')?.dataset.index === '2399');
  assert.equal((await input.boundingBox()).y, searchTop, 'search stays fixed while the reading area scrolls');
  assert.ok(await list.getByRole('listitem').count() < 25, 'recycle rows at the end of a two-hour transcript');
  await input.fill('索引尾句');
  await list.getByText('索引尾句，到了。', { exact: true }).waitFor();
  assert.equal(await list.getByRole('listitem').count(), 1);
  await list.getByRole('button').click();
  assert.equal(await page.evaluate(() => window.seekTimes.at(-1)), 7197);

  await input.fill('第 2399 句。 索引尾句');
  await list.getByText(/第 2399 句。\s+索引尾句/).waitFor();
  assert.equal(await list.getByRole('button').count(), 0, 'cross-sentence text stays readable without assigning a false time');
  await input.fill('仅全文存在');
  await list.getByText('仅全文存在的附注。', { exact: false }).waitFor();
  assert.equal(await list.getByRole('button').count(), 0, 'untimed search excerpts have no synthetic seek target');
  await page.evaluate(() => {
    navigator.clipboard.writeText = async text => { window.copiedTranscript = text; };
  });
  await page.getByRole('button', { name: '复制全文' }).click();
  await page.getByText('已复制', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.copiedTranscript === window.transcriptText), true);
  await page.goto(`${url}?legacy`);
  await page.getByText('这份文稿只有句级时间，点击句首时间跳转。', { exact: true }).waitFor();
  assert.equal(await first.locator('.video-transcript-reader-word').count(), 0);
  await first.getByRole('button', { name: '跳转至 0:00.000', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.seekTimes), [0]);
  assert.deepEqual(errors, []);
  console.log('PASS: two-hour virtualization, variable row heights, repeated character seeks, legacy controls, exact text, full search and copy');
} finally {
  await browser.close();
  await server.close();
}
