import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
const { chromium } = await import(process.env.BOWERBIRD_PLAYWRIGHT_MODULE || '../../html-renderer/node_modules/playwright/index.mjs');
const server = await createServer({ server: { host: '127.0.0.1', port: 1717, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await mkdir('.tmp/composer-glass', { recursive: true });
try {
  await page.goto('http://127.0.0.1:1717/scripts/fixtures/canvas-reference/preview.html?source-library');
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'dreamina_video_models') {
        if (window.failVideoModels) throw new Error('fixture: model lookup unavailable');
        return ['seedance2.5', 'seedance2.0fast_vip'].map(model_version => ({ model_version, resolutions: ['720p', '1080p'], min_duration: 4, max_duration: 30 }));
      }
      if (command === 'dreamina_credit_balance') return 100;
      if (command === 'material_catalog_assets') return window.store.getState().assets;
      return original(command, args);
    };
    window.store.setState({ activeGenProvider: 'jimeng', dreaminaHealth: { ok: true }, cloudAuth: { logged_in: true, cloud_available: true },
      cloudEntitlement: { plan: 'pro', policy: { can_use_byo: true }, balances: { daily: 100, sub: 0, topup: 0 } } });
  });
  const dock = page.locator('.composer-glass');
  const editor = dock.locator('.ProseMirror');
  assert.equal(await dock.count(), 1);
  assert.equal(await dock.getByRole('button', { name: '选择 Agent 模式' }).count(), 0, 'unentitled accounts do not gain an Agent entry');
  await dock.getByRole('button', { name: '展开创作描述' }).click();
  assert.equal(await page.evaluate(() => window.store.getState().boardOpen), true, 'expand focuses the writing area and enters creation');
  await editor.fill('为产品设计一张自然、安静的海报。\n第二行保持留白。');
  const content = await editor.innerText();
  await dock.getByRole('button', { name: '退出创作模式', exact: true }).click();
  assert.equal(await editor.innerText(), content, 'collapse keeps the actual editor document');
  assert.equal(await dock.locator('.composer-heading').isVisible(), false);
  const collapsed = await dock.boundingBox();
  assert.ok(collapsed.height < 90, 'collapsed dock exposes only the label and first line');
  assert.equal(await dock.locator('.collection-scroll-viewport').evaluate(el => el.scrollTop), 0);
  await dock.screenshot({ path: '.tmp/composer-glass/collapsed.png' });
  await dock.getByRole('button', { name: '展开创作描述' }).click();
  await editor.fill('前后');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await dock.getByRole('button', { name: '添加参考素材' }).click();
  await page.waitForFunction(() => window.store.getState().canvasLibraryOpen && document.activeElement?.classList.contains('canvas-source-panel'));
  await page.locator('.categorized-library [data-asset-id="a"]').click();
  await editor.locator('[data-asset-id="a"]').waitFor();
  assert.equal(await editor.evaluate(el => el.textContent.startsWith('前') && el.textContent.endsWith('后')), true, 'visible material action preserves the insertion caret');
  await page.getByRole('button', { name: '关闭素材库', exact: true }).click();
  const referenced = await editor.innerText();
  await dock.getByRole('button', { name: '退出创作模式', exact: true }).click();
  await dock.screenshot({ path: '.tmp/composer-glass/collapsed-reference.png' });
  await dock.getByRole('button', { name: '展开创作描述' }).click();
  assert.equal(await editor.innerText(), referenced);
  await dock.screenshot({ path: '.tmp/composer-glass/image.png' });
  await dock.getByRole('button', { name: '视频', exact: true }).click();
  await dock.getByLabel('视频分辨率').selectOption('1080p');
  await dock.getByLabel('视频时长（秒）').fill('8');
  assert.equal(await editor.innerText(), referenced, 'mode changes retain the prompt and references');
  for (const label of ['视频生成渠道','视频模型','视频分辨率','视频生成模式','视频时长（秒）']) {
    assert.equal(await dock.locator('.composer-toolbar').getByLabel(label, { exact: true }).isVisible(), true);
  }
  assert.equal(await dock.getByTitle('生成选项：透明图层 / 张数（即梦与 Cloud 按张数分别提交，消耗相应积分）').count(), 0);
  for (const theme of ['light','dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.waitForTimeout(350);
    await dock.screenshot({ path: `.tmp/composer-glass/video-${theme}.png` });
  }
  // The native desktop window's supported minimum is 900 × 600.
  await page.setViewportSize({ width: 900, height: 600 });
  await page.waitForTimeout(350);
  const bounds = await dock.boundingBox();
  await page.screenshot({ path: '.tmp/composer-glass/narrow.png' });
  assert.ok(bounds.x >= 64 && bounds.x + bounds.width <= 900 && bounds.y >= 0);
  for (const el of await dock.locator('.composer-toolbar select, .composer-toolbar input, .generation-send-button').all()) {
    const box = await el.boundingBox();
    assert.ok(box.x >= bounds.x && box.x + box.width <= bounds.x + bounds.width + 1, 'parameters stay inside narrow dock');
  }
  await page.screenshot({ path: '.tmp/composer-glass/narrow.png' });
  const assertVideoRow = async () => {
    const row = await dock.locator('.composer-video-fields').boundingBox();
    const fields = await dock.locator('.composer-video-fields > *').all();
    assert.equal(fields.length, 6, 'video settings remain one complete group');
    let right = row.x;
    for (const field of fields) {
      const box = await field.boundingBox();
      assert.ok(Math.abs(box.y + box.height / 2 - row.y - row.height / 2) < 1, 'all six settings share one row');
      assert.ok(box.x >= right - 1 && box.x + box.width <= row.x + row.width + 1, 'settings do not overlap or overflow');
      right = box.x + box.width;
    }
    assert.ok(row.height <= 36, 'parameters never wrap to a second line');
    const send = await dock.locator('.composer-send').boundingBox();
    const material = await dock.locator('.composer-add-material').boundingBox();
    assert.ok(send.y >= row.y + row.height && Math.abs(send.y - material.y) < 3, 'actions align below the parameter row');
    assert.ok((await dock.locator('.composer-toolbar').boundingBox()).height <= 104, 'video toolbar stays within two compact rows');
  };
  for (const width of [900, 1600]) {
    await page.setViewportSize({ width, height: width === 900 ? 600 : 1000 });
    for (const channel of ['jimeng', 'cloud']) {
      await dock.getByLabel('视频生成渠道').selectOption(channel);
      for (const kind of ['text2video', 'image2video', 'frames2video', 'multimodal2video']) {
        await dock.getByLabel('视频生成模式').selectOption(kind);
        if (channel === 'jimeng') {
          await page.waitForFunction(() => !document.querySelector('[aria-label="视频模型"]').disabled);
          await dock.getByLabel('视频模型').selectOption('seedance2.0fast_vip');
        }
        await assertVideoRow();
      }
      await dock.screenshot({ path: `.tmp/composer-glass/video-${channel}-${width}.png` });
    }
  }
  await page.setViewportSize({ width: 900, height: 600 });
  await page.evaluate(() => { window.failVideoModels = true; });
  await dock.getByLabel('视频生成渠道').selectOption('jimeng');
  await dock.getByRole('button', { name: '模型查询失败，重试' }).waitFor();
  await assertVideoRow();
  await page.evaluate(() => { window.failVideoModels = false; });
  await dock.getByRole('button', { name: '模型查询失败，重试' }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="视频模型"]').disabled);
  await assertVideoRow();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.evaluate(() => window.store.setState({ cloudEntitlement: { plan: 'pro', is_test_account: true, balances: { daily: 100, sub: 0, topup: 0 },
    policy: { can_use_byo: true, can_use_agent_runs: true, max_parallel_agent_runs: 2, allowed_agent_skills: ['bowerbird-unified-agent'], agent_budget_options: [30] } } }));
  await dock.getByRole('button', { name: '选择 Agent 模式' }).click();
  await page.keyboard.press('Escape');
  assert.equal(await dock.getByRole('dialog', { name: 'Agent 模式' }).count(), 0);
  assert.equal(await page.evaluate(() => window.store.getState().boardOpen), true, 'Escape closes the picker without exiting creation');
  await dock.getByRole('button', { name: '选择 Agent 模式' }).click();
  await dock.getByRole('switch', { name: 'Agent', exact: true }).click();
  assert.equal(await dock.getByRole('button', { name: '选择 Agent 模式' }).getAttribute('aria-pressed'), 'true');
  assert.equal(await dock.getByLabel('视频模型').count(), 0, 'choosing Agent from video leaves no video controls');
  await dock.getByRole('button', { name: '图片', exact: true }).click();
  assert.equal(await dock.getByRole('button', { name: '选择 Agent 模式' }).getAttribute('aria-pressed'), 'false');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.ok(await dock.locator('.composer-mode-thumb').evaluate(el => parseFloat(getComputedStyle(el).transitionDuration) <= 0.001));
  await editor.fill(Array.from({length: 20}, (_,i) => `第 ${i + 1} 行创作描述`).join('\n'));
  await dock.getByRole('scrollbar', { name: '创作描述滚动条' }).waitFor();
  const widths = await dock.locator('.collection-scroll-viewport').evaluate(el => ({ client: el.clientWidth, outer: el.offsetWidth }));
  assert.equal(widths.client, widths.outer, 'scrollbar overlays instead of reserving a gutter');
  await dock.getByRole('button', { name: '退出创作模式', exact: true }).click();
  assert.equal(await dock.locator('.collection-scroll-viewport').evaluate(el => el.scrollTop), 0, 'long prompts collapse to their first line');
  await dock.getByRole('button', { name: '展开创作描述' }).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.store.getState().boardOpen), true, 'keyboard expansion activates the editor');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  assert.equal(await dock.evaluate(el => getComputedStyle(el).backdropFilter), 'none');
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  await page.emulateMedia({ forcedColors: 'active' });
  assert.equal(await dock.evaluate(el => getComputedStyle(el).backdropFilter), 'none');
  await page.emulateMedia({ forcedColors: 'none' });
  await editor.fill('设计一张护肤品海报，保留瓶身与标签。\n使用柔和的自然光，呈现安静的清晨感。');
  await page.keyboard.press('Control+Home');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('bowerbird://board-asset-picked', { detail: { assetId: 'a' } })));
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.waitForTimeout(350);
    await dock.screenshot({ path: `.tmp/composer-glass/final-${theme}.png` });
  }
  assert.deepEqual(errors, []);
  console.log('PASS glass composer: first-line collapse, references/caret, video controls, Agent gates/exclusivity, narrow layout, reduced motion and overlay scroll');
} finally { await browser.close(); await server.close(); }
