import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ cacheDir: '.tmp/ui-text-selection/vite', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
try {
  await page.goto(`${server.resolvedUrls.local[0]}scripts/fixtures/creation-editor/preview.html`);
  await page.locator('.ProseMirror').waitFor();
  await page.evaluate(async () => {
    await import('/src/components/CanvasWorkflow.css');
    document.querySelector('#root').style.height = 'auto';
    const host = document.createElement('section');
    host.innerHTML = `<h2 id="heading">素材库界面标题</h2>
      <label id="label">设置面板选项</label>
      <div id="portal" role="dialog"><span>弹出面板说明文字</span></div>
      <input id="input" value="可编辑输入文字" />
      <textarea id="textarea">可编辑多行文字</textarea>
      <input id="readonly" readonly value="只读复制内容" />
      <div id="editable" contenteditable="">可编辑正文文字</div>
      <div id="plaintext" contenteditable="plaintext-only">可编辑纯文本</div>
      <div class="local-chat-text"><p id="chat">需要复制的对话正文</p></div>
      <div class="workflow-text-result"><p id="result">需要复制的生成结果</p></div>`;
    document.body.append(host); // Portals outside #root share the same policy.
    for (const el of host.children) el.style.cssText += ';display:block;margin:12px;width:320px';
  });

  async function dragText(selector, field = false) {
    await page.evaluate(() => { document.activeElement?.blur(); getSelection().removeAllRanges(); });
    const box = await page.locator(selector).evaluate((el, field) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = field ? el.getBoundingClientRect() : range.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, field);
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    return page.locator(selector).evaluate((el, field) => field
      ? el.value.slice(el.selectionStart, el.selectionEnd)
      : getSelection().toString(), field);
  }

  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const selector of ['#heading', '#label', '#portal span']) {
      assert.equal(await dragText(selector), '', `${theme}: ${selector} must not produce a native text selection`);
    }
    for (const selector of ['#input', '#textarea', '#readonly']) {
      assert.ok(await dragText(selector, true), `${theme}: ${selector} must remain selectable`);
    }
    for (const selector of ['.ProseMirror p', '#editable', '#plaintext', '#chat', '#result']) {
      assert.ok(await dragText(selector), `${theme}: ${selector} must remain selectable`);
    }
  }
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('abc');
  assert.equal(await page.locator('.ProseMirror').innerText(), '你好abc');
  console.log('PASS: UI drag selection blocked; fields, editor, readonly and result text remain selectable in both themes; editor typing works');
} finally {
  await browser.close();
  await server.close();
}
