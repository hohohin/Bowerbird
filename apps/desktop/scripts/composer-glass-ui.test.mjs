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
        return ['seedance2.5', 'seedance2.0', 'seedance2.0mini', 'seedance2.0fast_vip'].map(model_version => ({ model_version, resolutions: ['720p', '1080p'], min_duration: 4, max_duration: 30 }));
      }
      if (command === 'dreamina_credit_balance') return 100;
      if (command === 'material_catalog_assets') return window.store.getState().assets;
      return original(command, args);
    };
    window.store.setState({ activeGenProvider: 'jimeng', codexHealth: { ok: true }, dreaminaHealth: { ok: true }, cloudAuth: { logged_in: true, cloud_available: true },
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
  const provider = dock.locator('.provider-choice');
  const imageMenu = page.getByRole('dialog', { name: '图像模型', exact: true });
  for (const [key, source, label] of [
    ['codex', 'personal', 'gpt-image-2'], ['jimeng', 'personal', 'Seedream 5.0 Pro'],
    ['bowerbird-cloud-image_hd', 'cloud', 'Seedream 5.0 Pro'],
  ]) {
    await provider.click();
    assert.equal(await dock.locator('.composer-heading').isVisible(), true, 'portal focus must not collapse the composer');
    assert.equal(await imageMenu.locator('.model-select-column').count(), 2);
    assert.equal(await imageMenu.locator('.model-select-column-title').first().innerText(), '自有订阅');
    assert.equal(await imageMenu.locator('[data-model-key="bowerbird-cloud-image_fast"]').count(), 0, 'Fast is absent from new selections');
    await imageMenu.locator(`[data-model-key="${key}"]`).click();
    assert.equal(await provider.getAttribute('data-source'), source);
    assert.equal(await provider.locator('.model-select-source').innerText(), '', 'collapsed source uses an icon, not a second label');
    const iconColor = await provider.locator('.model-select-source').evaluate(el => getComputedStyle(el).backgroundColor);
    await provider.click();
    assert.equal(await imageMenu.locator(`[data-source="${source}"] .model-select-column-title`).evaluate(el => getComputedStyle(el).color), iconColor, 'expanded column and collapsed icon share the source color');
    assert.equal(await imageMenu.locator(`[data-source="${source}"] .model-source-badge`).evaluate(el => getComputedStyle(el).backgroundColor), iconColor, 'menu and trigger use the same filled badge');
    assert.equal(await imageMenu.locator(`[data-model-key="${key}"] > svg`).evaluate(el => getComputedStyle(el).color), iconColor);
    await page.keyboard.press('Escape');
    assert.ok((await provider.innerText()).includes(label));
    assert.equal(await page.evaluate(() => window.store.getState().activeGenProvider), key, 'display names do not change routing keys');
  }
  await provider.click();
  await page.waitForFunction(() => document.activeElement?.dataset.modelKey === 'bowerbird-cloud-image_hd');
  await imageMenu.locator('[data-model-key="codex"]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.modelKey), 'bowerbird-cloud-image_hd');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.store.getState().activeGenProvider), 'bowerbird-cloud-image_lite');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await provider.click();
    await page.waitForTimeout(350);
    const sourceColors = await imageMenu.locator('.model-select-column-title').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color));
    assert.notEqual(sourceColors[0], sourceColors[1], 'personal and cloud remain visually distinct in each theme');
    assert.equal(await provider.locator('.model-select-source').evaluate(el => getComputedStyle(el).backgroundColor), sourceColors[1]);
    const dockBox = await dock.boundingBox(), menuBox = await imageMenu.boundingBox();
    await page.screenshot({ path: `.tmp/composer-glass/provider-${theme}.png`, clip: {
      x: Math.min(dockBox.x, menuBox.x), y: Math.min(dockBox.y, menuBox.y) - 8,
      width: Math.max(dockBox.x + dockBox.width, menuBox.x + menuBox.width) - Math.min(dockBox.x, menuBox.x),
      height: dockBox.y + dockBox.height - Math.min(dockBox.y, menuBox.y) + 8,
    } });
    await page.keyboard.press('Escape');
    assert.equal(await dock.locator('.composer-heading').isVisible(), true);
  }
  await page.setViewportSize({ width: 900, height: 600 });
  await provider.click();
  const menuBounds = await imageMenu.boundingBox();
  assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= 900 && menuBounds.y >= 0);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1600, height: 1000 });
  for (const [key, source, label] of [
    ['bowerbird-cloud', 'cloud', 'Seedream 5.0 Pro'], ['bowerbird-cloud-new-tier', 'cloud', 'Bowerbird Cloud'],
    ['unrecognized-provider', null, 'unrecognized-provider'],
  ]) {
    await page.evaluate(activeGenProvider => window.store.setState({ activeGenProvider }), key);
    assert.equal(await provider.getAttribute('data-source'), source);
    assert.ok((await provider.innerText()).includes(label));
  }
  await page.evaluate(() => window.store.setState({ activeGenProvider: 'jimeng', dreaminaHealth: { ok: false, reason: '请登录即梦' } }));
  await provider.click();
  assert.equal(await imageMenu.locator('[data-model-key="jimeng"]').isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.store.setState({ dreaminaHealth: { ok: true }, settings: { ...window.store.getState().settings, dreamina_model_version: '4.5' } }));
  assert.ok((await provider.innerText()).includes('Seedream 4.5'), 'model label follows actual Dreamina settings');
  await page.evaluate(() => window.store.setState({ settings: { ...window.store.getState().settings, dreamina_model_version: '5.0Pro' } }));
  await page.evaluate(() => window.store.setState({ cloudEntitlement: { ...window.store.getState().cloudEntitlement, generation_services: [
    { service: 'image_hd', label: 'Bowerbird Cloud Pro', credits: 1 },
    { service: 'image_gpt25_sunburst', label: 'GPT Sunburst', credits: 1 },
    { service: 'image_lite', label: 'Bowerbird Cloud Lite', credits: 1 },
    { service: 'image_gpt25_flare', label: 'GPT Flare', credits: 1 },
    { service: 'image_fast', label: 'Bowerbird Cloud Fast', credits: 1 },
  ] } }));
  await provider.click();
  const cloudColumn = imageMenu.locator('[data-source="cloud"]');
  assert.deepEqual(await cloudColumn.locator('.model-select-option').allTextContents(), [
    'Seedream 5.0 Pro', 'Seedream 5.0 Lite', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare',
  ], 'dynamic models remain available and models of each family stay adjacent without series headings');
  assert.equal(await imageMenu.getByRole('heading').count(), 0);
  await cloudColumn.getByRole('button', { name: '设为默认：Seedream 5.0 Pro', exact: true }).click();
  assert.equal(await page.evaluate(() => window.store.getState().defaultProvider), 'bowerbird-cloud-image_hd');
  assert.equal(await provider.getAttribute('aria-expanded'), 'true', 'setting a favorite does not choose or close the model');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.store.setState({ cloudEntitlement: { ...window.store.getState().cloudEntitlement, generation_services: undefined,
    policy: { can_use_byo: false }, balances: { daily: 0, sub: 0, topup: 0 } } }));
  await provider.click();
  assert.equal(await imageMenu.locator('.model-select-option:enabled').count(), 0, 'Pro and credit gates remain enforced');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.store.setState({ cloudEntitlement: { ...window.store.getState().cloudEntitlement,
    policy: { can_use_byo: true }, balances: { daily: 100, sub: 0, topup: 0 } } }));
  await dock.getByRole('button', { name: '视频', exact: true }).click();
  await dock.getByLabel('视频分辨率').selectOption('1080p');
  await dock.getByLabel('视频时长（秒）').fill('8');
  assert.equal(await editor.innerText(), referenced, 'mode changes retain the prompt and references');
  for (const label of ['视频分辨率','视频生成模式','视频时长（秒）']) {
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
    assert.equal(fields.length, 5, 'video settings remain one complete group');
    let right = row.x;
    for (const field of fields) {
      const box = await field.boundingBox();
      assert.ok(Math.abs(box.y + box.height / 2 - row.y - row.height / 2) < 1, 'all five settings share one row');
      assert.ok(box.x >= right - 1 && box.x + box.width <= row.x + row.width + 1, 'settings do not overlap or overflow');
      right = box.x + box.width;
    }
    assert.ok(row.height <= 36, 'parameters never wrap to a second line');
    const send = await dock.locator('.composer-send').boundingBox();
    const material = await dock.locator('.composer-add-material').boundingBox();
    const help = await dock.locator('.composer-help').boundingBox();
    const toolbar = await dock.locator('.composer-toolbar').boundingBox();
    for (const box of [send, material, help]) {
      assert.ok(Math.abs(box.y + box.height / 2 - row.y - row.height / 2) < 1, 'materials, parameters, help and send must share ONE row');
      assert.ok(box.x >= toolbar.x && box.x + box.width <= toolbar.x + toolbar.width, 'actions remain within toolbar');
    }
    assert.ok(material.x + material.width <= row.x && row.x + row.width <= help.x && help.x + help.width <= send.x, 'all footer groups remain non-overlapping');
    assert.ok(toolbar.height <= 62, 'entire video toolbar never grows to two rows');
  };
  const chooseVideo = async (key) => {
    await dock.locator('.model-select-trigger').click();
    const menu = page.getByRole('dialog', { name: '视频模型', exact: true });
    assert.equal(await menu.locator('[data-model-key*="fast"]').count(), 0);
    await menu.locator(`[data-model-key="${key}"]`).click();
  };
  for (const width of [900, 1240, 1600]) {
    await page.setViewportSize({ width, height: width === 900 ? 600 : 1000 });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, width === 900 ? 'dark' : 'light');
    for (const channel of ['jimeng', 'cloud']) {
      await chooseVideo(`${channel}:seedance2.5`);
      assert.equal(await dock.locator('.model-select-source').getAttribute('aria-label'), channel === 'cloud' ? 'Bowerbird 积分' : '自有订阅');
      for (const kind of ['text2video', 'image2video', 'frames2video', 'multimodal2video']) {
        await dock.getByLabel('视频生成模式').selectOption(kind);
        if (channel === 'jimeng') await chooseVideo('jimeng:seedance2.0mini');
        await assertVideoRow();
      }
      await dock.screenshot({ path: `.tmp/composer-glass/video-${channel}-${width}.png` });
      if (width === 1600) {
        await dock.locator('.model-select-trigger').click();
        const menu = page.getByRole('dialog', { name: '视频模型', exact: true });
        if (channel === 'jimeng') await menu.getByText('即梦剩余：100 积分', { exact: true }).waitFor();
        const panel = await dock.boundingBox(), popup = await menu.boundingBox();
        await page.screenshot({ path: `.tmp/composer-glass/video-menu-${channel}.png`, clip: {
          x: panel.x, y: Math.min(panel.y, popup.y) - 8, width: panel.width,
          height: panel.y + panel.height - Math.min(panel.y, popup.y) + 8,
        } });
        await page.keyboard.press('Escape');
      }
    }
  }
  await page.setViewportSize({ width: 900, height: 600 });
  await chooseVideo('jimeng:seedance2.5');
  await page.evaluate(() => { window.failVideoModels = true; });
  await dock.getByLabel('视频生成模式').selectOption('text2video');
  await dock.getByRole('button', { name: '模型查询失败，重试' }).waitFor();
  await assertVideoRow();
  await page.evaluate(() => { window.failVideoModels = false; });
  await dock.getByRole('button', { name: '模型查询失败，重试' }).click();
  await chooseVideo('jimeng:seedance2.0');
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
