import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../apps/html-renderer/node_modules/playwright/index.mjs';

const url = process.env.DOCUMENT_PREVIEW_URL || 'http://127.0.0.1:17924/';
const output = fileURLToPath(new URL('./.tmp/ui/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [], remote = [], posts = [];
page.setDefaultTimeout(12000);
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => {
  const request = route.request();
  if (!['GET', 'HEAD'].includes(request.method())) posts.push(request.url());
  if (new URL(request.url()).hostname !== '127.0.0.1') { remote.push(request.url()); return route.abort(); }
  return route.continue();
});
try {
  await page.goto(url);
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.waitFor();
  assert.equal(await editor.locator('[data-block-id="flower-image"] img').count(), 1);
  await page.screenshot({ path: `${output}/document-dark.png` });

  // Actual Plate input, including native composition; source switching must preserve it.
  const intro = editor.locator('[data-block-id="intro"]');
  await intro.click(); await page.keyboard.press('End'); await page.keyboard.insertText(' 保留红色花瓣。');
  await page.getByRole('button', { name: '源码', exact: true }).click();
  const source = page.getByRole('textbox', { name: 'Markdown 源码' });
  const markdown = await source.inputValue();
  assert.match(markdown, /保留红色花瓣/);
  assert.match(markdown, /bowerbird-asset:flowers/);
  assert.match(markdown, /<audio /); assert.match(markdown, /<video /);
  await source.fill(markdown + '\n这是源码追加的段落。\n');
  await page.getByRole('button', { name: '源码', exact: true }).click();
  assert.match(await source.inputValue(), /这是源码追加的段落/);
  await page.getByRole('button', { name: '正文', exact: true }).click();
  assert.match(await editor.textContent(), /这是源码追加的段落/);
  assert.equal(await editor.locator('img').count(), 1, 'image reference survives source round-trip');
  assert.equal(await editor.locator('video').count(), 1);
  assert.equal(await editor.locator('.document-audio').count(), 1);

  // Whole-document forwarding carries actual references; no model call is made.
  await page.getByRole('button', { name: '转发', exact: true }).click();
  await page.getByRole('button', { name: '视频卡片', exact: true }).click();
  const panel = page.getByRole('complementary', { name: '转发草稿' });
  await panel.waitFor();
  assert.equal(await panel.locator('.reference-row').count(), 3);
  assert.equal(await panel.locator('.reference-row.unsupported').count(), 1, 'audio is visible and unsupported');
  const snapshot = await panel.getByRole('textbox', { name: '草稿内容' }).inputValue();
  assert.match(snapshot, /@图片1/); assert.match(snapshot, /@视频1/); assert.match(snapshot, /@音频1/);
  await panel.getByRole('textbox', { name: '草稿内容' }).fill(snapshot + '\n草稿里的独立修改。');
  await panel.getByRole('button', { name: '带入草稿', exact: true }).click();
  assert.equal(await panel.getByRole('button', { name: '运行', exact: true }).isDisabled(), true);
  await page.screenshot({ path: `${output}/forward-video-dark.png` });
  await page.getByRole('button', { name: '关闭转发草稿' }).click();
  const firstDraftId = await page.getByRole('combobox', { name: '已有草稿' }).locator('option').nth(1).getAttribute('value');
  // A later forwarding action keeps the original draft instead of overwriting it.
  await page.getByRole('button', { name: '转发', exact: true }).click();
  await page.getByRole('button', { name: '生图卡片', exact: true }).click();
  assert.equal(await panel.locator('.reference-row.unsupported').count(), 2);
  await page.getByRole('combobox', { name: '已有草稿' }).selectOption(firstDraftId);
  assert.match(await panel.getByRole('textbox', { name: '草稿内容' }).inputValue(), /草稿里的独立修改/);
  await page.getByRole('button', { name: '关闭转发草稿' }).click();

  // Native block selection forwards only selected content, in document order.
  await editor.locator('input[type="checkbox"]').nth(0).check();
  await editor.locator('input[type="checkbox"]').nth(4).check();
  await page.getByRole('button', { name: '转发', exact: true }).click();
  await page.getByRole('button', { name: '对话框', exact: true }).click();
  assert.equal(await panel.locator('.reference-row').count(), 1);
  assert.doesNotMatch(await panel.getByRole('textbox', { name: '草稿内容' }).inputValue(), /这是源码追加的段落/);
  await page.getByRole('button', { name: '关闭转发草稿' }).click();
  await page.getByRole('button', { name: '2 段已选中' }).click();

  // Insert from the library into the current document using the actual Plate transform.
  await page.getByRole('button', { name: '插入 人物 · 光线参考.webp', exact: true }).click();
  assert.equal(await editor.locator('img').count(), 2);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  assert.equal(await editor.locator('img').count(), 1);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  assert.equal(await editor.locator('img').count(), 2);
  await editor.locator('.plate-block').first().click();
  const dropTarget = editor.locator('.plate-block').filter({ hasText: '这是源码追加的段落。' });
  await page.getByRole('button', { name: '插入 印刷 · 颗粒质感.webp', exact: true }).dragTo(dropTarget);
  const dropOrder = await editor.locator('.plate-block').evaluateAll(elements => ({
    paragraph: elements.findIndex(element => element.textContent.includes('这是源码追加的段落。')),
    image: elements.findIndex(element => element.querySelector('img[src*="preset-06"]')),
  }));
  assert.ok(dropOrder.image > 3 && Math.abs(dropOrder.image - dropOrder.paragraph) <= 1,
    'drag uses the paragraph under the pointer, not the previous title caret');

  // The sound starts only after a gesture, and persistent playback survives pointer leave.
  const audio = editor.locator('.document-audio');
  await audio.scrollIntoViewIfNeeded();
  await audio.getByRole('slider').hover();
  await page.waitForFunction(() => document.querySelector('.document-audio-wave svg path'));
  await audio.getByRole('button', { name: '从头播放 节奏参考.wav', exact: true }).click();
  await audio.getByRole('button', { name: '暂停 节奏参考.wav', exact: true }).waitFor();
  await page.mouse.move(10, 10); await page.waitForTimeout(180);
  assert.equal(await audio.getByRole('button', { name: '暂停 节奏参考.wav', exact: true }).count(), 1);
  await audio.getByRole('button', { name: '暂停 节奏参考.wav', exact: true }).click();
  const bounds = await audio.getByRole('slider').boundingBox();
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await audio.getByRole('button', { name: '暂停 节奏参考.wav', exact: true }).waitFor();
  await page.mouse.move(10, 10);
  await audio.getByRole('button', { name: '从头播放 节奏参考.wav', exact: true }).waitFor();
  await page.screenshot({ path: `${output}/media-dark.png` });
  const video = editor.locator('video');
  await video.scrollIntoViewIfNeeded();
  const videoBox = await video.boundingBox();
  await video.click({ position: { x: 24, y: videoBox.height - 48 } });
  await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0);
  assert.equal(await video.evaluate(element => element.error?.code ?? null), null);

  // Plain text stays plain; conversion creates a separate Markdown draft.
  await page.getByRole('button', { name: '随手记.txt', exact: true }).click();
  await page.getByRole('textbox', { name: '纯文本内容' }).fill('原文 **不是Markdown格式**');
  await page.getByRole('button', { name: '转为 Markdown 草稿' }).click();
  assert.equal(await page.getByRole('button', { name: '随手记.txt', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '随手记.md', exact: true }).count(), 1);
  assert.match(await editor.textContent(), /原文 \*\*不是Markdown格式\*\*/);

  // Untrusted source remains literal and must not trigger remote resource requests.
  await page.getByRole('button', { name: '源码', exact: true }).click();
  await source.fill('---\ntitle: note\n---\n\n<script>window.UNSAFE_EXECUTED = true</script>\n\n![remote](https://example.invalid/track.png)\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n');
  await page.getByRole('button', { name: '正文', exact: true }).click();
  assert.equal(await page.evaluate(() => window.UNSAFE_EXECUTED), undefined);
  await page.getByRole('button', { name: '源码', exact: true }).click();
  const protectedSource = await source.inputValue();
  assert.match(protectedSource, /title: note/); assert.match(protectedSource, /\| 1 \| 2 \|/);
  assert.match(protectedSource, /<script>window.UNSAFE_EXECUTED = true<\/script>/);
  await page.getByRole('button', { name: '正文', exact: true }).click();

  await page.getByLabel('选择文本文件', { exact: true }).setInputFiles({
    name: '本地试稿.md', mimeType: 'text/markdown',
    buffer: Buffer.from('# 本地文本\n\n![遗失图片](bowerbird-asset:unavailable)\n'),
  });
  await page.getByRole('button', { name: '本地试稿.md', exact: true }).waitFor();
  assert.match(await editor.textContent(), /本地文本/);
  await page.getByRole('button', { name: '转发', exact: true }).click();
  await page.getByRole('button', { name: 'Agent 卡片', exact: true }).click();
  assert.equal(await panel.getByRole('button', { name: '带入草稿', exact: true }).isDisabled(), true);
  assert.match(await panel.textContent(), /素材未连接/);
  await page.getByRole('button', { name: '关闭转发草稿' }).click();

  // Both themes and narrower desktop widths preserve controls and page bounds.
  await page.getByRole('button', { name: '花间 · 短片提案.md', exact: true }).click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [1440, 900, 800]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.getByRole('button', { name: '转发', exact: true }).isVisible(), true);
      await page.screenshot({ path: `${output}/document-${theme}-${width}.png` });
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.keyboard.press('Tab');
  assert.deepEqual(remote, [], 'document never fetches remote media or sends content');
  assert.deepEqual(posts, [], 'all forwarding remains local and does not execute a model');
  assert.deepEqual(errors, []);
  console.log('PASS Plate UI: editing/source, all media, ordered selected forwarding, independent drafts, real audio, plain text, source protection, dark/light 800–1440px; zero remote or model calls');
} finally { await browser.close(); }
