import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const output = '.tmp/canvas-creation-image';
await mkdir(output, { recursive: true });
const server = await createServer({ cacheDir: `${output}/vite`,
  server: { host: '127.0.0.1', port: 17945, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(12000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const node = id => page.locator(`[data-canvas-node-id="${id}"]`);
const modal = page.locator('.creation-image-preview');
const imageRegion = modal.getByRole('region', { name: '放大图片' });
const detailsRegion = modal.getByRole('region', { name: '独立会话面板' });
const inspector = modal.getByRole('region', { name: '图片详情', exact: true });
const mainImage = imageRegion.getByRole('img', { name: /^合成参考 / });
const picks = () => page.evaluate(() => window.picks);
const idle = () => page.waitForTimeout(750);
const close = async () => { await page.keyboard.press('Escape'); await modal.waitFor({ state: 'detached' }); };
const assertNoPreview = async () => {
  await idle();
  assert.equal(await modal.count(), 0, 'no delayed creation preview opens');
  assert.equal(await page.locator('.media-lightbox').count(), 0, 'double click does not also open a lightbox');
};
const reset = async ({ empty = false } = {}) => {
  await page.evaluate(empty => {
    const snapshot = JSON.parse(sessionStorage.getItem('creation-image-base'));
    if (empty) { snapshot.nodes = snapshot.nodes.filter(node => !node.id.startsWith('output-')); snapshot.edges = []; }
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
  }, empty);
  await page.reload();
  await page.locator('.canvas-workspace[aria-busy="false"]').waitFor();
  await page.evaluate(() => {
    const state = window.store.getState();
    const assets = state.assets;
    const previous = window.__TAURI_INTERNALS__.invoke;
    window.picks = [];
    window.inspectorTags = {};
    window.inspectorWrites = [];
    window.addEventListener('bowerbird://board-asset-picked', event => window.picks.push(event.detail));
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'list_asset_tags') return (window.inspectorTags[args.assetId] ?? ['参考分类']).map(name => ({ name, source: 'manual', origin: 'manual' }));
      if (command === 'local_classification_labels') return ['参考分类','新增参考'].map(name => ({ id: name, name }));
      if (command === 'local_classification_example') {
        window.inspectorWrites.push(args);
        window.inspectorTags[args.assetIds[0]] = ['参考分类', args.tagId];
        return;
      }
      if (command === 'list_analyses_by_asset') return [{ id: 'caption-' + args.assetId, kind: 'caption',
        payload: JSON.stringify({ sections: [{ title: '构图', body: '图片详情中的构图描述' }] }), created_at: 1 }];
      if (command === 'material_catalog') return { tags: [], collections: [], prompts: [], tag_asset_ids: {} };
      if (command === 'material_catalog_assets') return assets;
      if (command === 'external_files_media') return args.path;
      if (command === 'generation_history') return args.assetId === 'a' || args.assetId === 'b'
        ? { session_id: 'session-1', provider: 'codex', references: [assets[0]], turns: [
          { turn_key: 'one', prompt: '第一轮画海报', prompt_raw: '第一轮画海报', images: [assets[1].store_path], references: [], ref_assets: [] },
          { turn_key: 'two', prompt: '第二轮加蓝', prompt_raw: '第二轮加蓝', images: [assets[2].store_path], references: [], ref_assets: [] },
        ] } : { session_id: null, references: [], turns: [] };
      return previous(command, args);
    };
    const job = { id: 'job', sessionId: 'session-1', projectId: 'p', threadId: 't', running: false,
      streaming: '', createdAt: 1, provider: 'codex', lastPrompt: '第一轮画海报', lastRefs: [], refAssets: [],
      turns: [
        { id: 1, turnKey: 'one', prompt: '第一轮画海报', promptRaw: '第一轮画海报', images: [assets[1].store_path], refs: [], refAssets: [] },
        { id: 2, turnKey: 'two', prompt: '第二轮加蓝', promptRaw: '第二轮加蓝', images: [assets[2].store_path], refs: [], refAssets: [] },
      ] };
    window.store.setState({ boardOpen: true, canvasLibraryOpen: false, genPanelOpen: false, genEditing: null,
      activeJobId: null, genJobs: { job }, genJobOrder: ['job'], mode: 'browse', selectedIds: new Set() });
    window.emitAssetsChanged();
  });
  await page.locator('.canvas-workspace.is-source-collapsed').waitFor();
  await page.locator('.canvas-source-panel').evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
};
const preview = async target => {
  const before = await picks();
  await target.click();
  await modal.waitFor();
  await mainImage.waitFor();
  await page.waitForFunction(() => document.querySelector('.creation-image-preview')?.contains(document.activeElement),
    undefined, { timeout: 1000 });
  await idle();
  assert.deepEqual(await picks(), before, 'single click previews without inserting a reference');
  const left = await imageRegion.boundingBox();
  const right = await detailsRegion.count() ? await detailsRegion.boundingBox() : null;
  const info = await inspector.boundingBox();
  assert.ok(info.width >= 200 && info.x + info.width <= left.x, 'reused image inspector is left of the enlarged image');
  assert.ok(left.width > 100 && (!right || right.width > 100 && left.x + left.width <= right.x + 2),
    'image and details form a left/right layout');
  assert.equal(await modal.locator('.app-modal').count(), 0, 'image and conversation have no common modal panel');
  assert.deepEqual(await imageRegion.evaluate(element => {
    const style = getComputedStyle(element.parentElement);
    return [style.backgroundColor, style.borderWidth, style.boxShadow];
  }), ['rgba(0, 0, 0, 0)', '0px', 'none'], 'the shared layout adds no background, frame or shadow');
};
const reference = async (target, expected) => {
  const before = await picks();
  await target.dblclick();
  await page.waitForFunction(count => window.picks.length > count, before.length);
  await assertNoPreview();
  assert.deepEqual(await picks(), [...before, expected], 'double click inserts exactly once with the right origin');
};

try {
  await page.goto('http://127.0.0.1:17945/scripts/fixtures/canvas-reference/preview.html?source-library');
  await node('old').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot(), base = snapshot.nodes[0];
    const payload = id => JSON.stringify({ schema_version: 1, snapshot: { name: `合成参考 ${id}`, width: 190, height: 150 } });
    const session = { ...base, id: 'session', kind: 'prompt', role: null, assetId: null,
      x: 480, y: 130, width: 260, height: 205,
      payloadJson: JSON.stringify({ schema_version: 1, job_id: 'job', turn_key: 'two', text: '第二轮加蓝', provider: 'codex', status: 'done' }) };
    const outputs = ['a', 'b'].map(assetId => ({ ...base, id: `output-${assetId}`, assetId, role: 'output',
      x: 480, y: 130, payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: `合成参考 ${assetId}`, width: 190, height: 150 },
        execution: { job_id: 'job', turn_key: 'two' } }) }));
    snapshot.nodes = [{ ...base, x: 140, y: 130 }, session, ...outputs,
      ...['c', 'd'].map(assetId => ({ ...base, id: `member-${assetId}`, assetId, x: 920, y: 130, payloadJson: payload(assetId) }))];
    snapshot.edges = outputs.map((item, ordinal) => ({ id: `produced-${ordinal}`, projectId: 'p', threadId: 't',
      fromNodeId: 'session', toNodeId: item.id, kind: 'produced', ordinal, createdAt: 1 }));
    snapshot.groups = [{ id: 'group', projectId: 'p', name: '素材组', role: null,
      x: 950, y: 130, width: 240, height: 230, zIndex: 2, createdAt: 1, updatedAt: 1 }];
    snapshot.groupItems = ['c', 'd'].map((id, ordinal) => ({ projectId: 'p', groupId: 'group', nodeId: `member-${id}`, ordinal }));
    snapshot.view = { ...snapshot.view, panX: 0, panY: 0, zoom: 1 };
    sessionStorage.setItem('creation-image-base', JSON.stringify(snapshot));
  });
  await reset();
  await preview(page.locator('[data-conversation-image="b"]'));
  const lightboxTrigger = detailsRegion.getByRole('button', { name: '点击放大', exact: true }).last();
  await lightboxTrigger.click();
  const lightbox = page.getByRole('dialog', { name: /^媒体预览/ });
  await lightbox.waitFor();
  await page.waitForFunction(() => document.querySelector('.media-lightbox')?.contains(document.activeElement),
    undefined, { timeout: 1000 });
  const enteredLightbox = await lightbox.evaluate(element => element.contains(document.activeElement));
  await lightbox.locator('button:enabled').last().focus();
  await page.keyboard.press('Tab');
  const trappedInLightbox = await lightbox.evaluate(element => element.contains(document.activeElement));
  await lightbox.getByRole('button', { name: '关闭（Esc）', exact: true }).click();
  await lightbox.waitFor({ state: 'detached' });
  const restoredToThumbnail = await lightboxTrigger.evaluate(element => element === document.activeElement);
  await page.keyboard.press('Escape');
  await idle();
  const closedParentWithEscape = await modal.count() === 0;

  await reset();
  await preview(page.locator('[data-conversation-image="b"]'));
  await modal.getByRole('button', { name: '收起会话', exact: true }).focus();
  await page.keyboard.down('Space');
  const backgroundPan = await page.locator('.canvas-stage.is-pan-ready').count() > 0;
  await page.keyboard.up('Space');
  await idle();
  const collapsedWithSpace = !await detailsRegion.isVisible();
  const keyboardResults = { enteredLightbox, trappedInLightbox, restoredToThumbnail, closedParentWithEscape,
    backgroundPan, collapsedWithSpace };
  console.log('Nested preview and Space key results:', JSON.stringify(keyboardResults));
  assert.deepEqual(keyboardResults, { enteredLightbox: true, trappedInLightbox: true, restoredToThumbnail: true,
    closedParentWithEscape: true, backgroundPan: false, collapsedWithSpace: true },
  'nested preview owns keyboard focus and HUD Space actions do not reach the canvas');
  console.log('PASS nested preview focus/Tab/return/Escape and Space collapse isolation');

  const wholeCardResults = [];
  for (const region of ['title', 'body']) {
    await reset();
    await page.evaluate(() => window.store.setState(state => ({ genJobs: { ...state.genJobs,
      job: { ...state.genJobs.job, running: true, streaming: '正在生成下一轮' } } })));
    const card = node('session');
    await card.locator('.canvas-prompt-content').waitFor();
    assert.equal(await card.evaluate(element => element.classList.contains('is-image-only')), false,
      'the regression uses a real conversation card with visible title/body');
    await (region === 'title' ? card.getByText('生成会话', { exact: true }) : card.locator('.canvas-prompt-content')).click();
    await idle();
    wholeCardResults.push({ region, preview: await modal.isVisible(), picks: await picks(),
      boardOpen: await page.evaluate(() => window.store.getState().boardOpen) });
    await page.screenshot({ path: `${output}/whole-card-${region}.png` });
  }
  console.log('Whole conversation card click results:', JSON.stringify(wholeCardResults));
  assert.deepEqual(wholeCardResults, ['title', 'body'].map(region => ({ region, preview: true, picks: [], boardOpen: true })),
    'single-clicking a conversation card title/body opens image + conversation without leaving creation mode');
  console.log('PASS conversation card title/body share the image preview entry');
  for (const region of ['title', 'body']) {
    await reset();
    await page.evaluate(() => window.store.setState(state => ({ genJobs: { ...state.genJobs,
      job: { ...state.genJobs.job, running: true } } })));
    const card = node('session');
    await (region === 'title' ? card.getByText('生成会话', { exact: true }) : card.locator('.canvas-prompt-content')).dblclick();
    await idle();
    assert.deepEqual(await picks(), [], `double-clicking the conversation ${region} does not reference its image`);
    assert.equal(await page.evaluate(() => window.store.getState().boardOpen), true);
  }
  console.log('PASS only image double-clicks add references, not conversation title/body double-clicks');

  await reset();
  const editor = page.locator('.creation-dock .ProseMirror').first();
  await editor.fill('保留创作草稿');
  await preview(node('old'));
  assert.equal(await detailsRegion.count(), 0, 'imported images open image and inspector without an empty conversation');
  assert.equal(await modal.getByRole('button', { name: /显示会话|收起会话/ }).count(), 0);
  assert.match(await inspector.innerText(), /导入时间/);
  assert.match(await inspector.innerText(), /参考分类/);
  assert.match(await inspector.innerText(), /图片详情中的构图描述/);
  assert.equal(await inspector.locator('.asset-detail-stage, .asset-detail-toolbar').count(), 0, 'inspector reuses details without another image or page toolbar');
  await inspector.getByRole('button', { name: '添加标签', exact: true }).click();
  const tagMenu = page.getByRole('dialog', { name: '添加标签', exact: true });
  await tagMenu.getByRole('checkbox', { name: '新增参考', exact: true }).waitFor();
  await tagMenu.getByPlaceholder('搜索或新建标签').fill('新增参考');
  await page.keyboard.press('Enter');
  await inspector.getByText('新增参考', { exact: false }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.inspectorWrites), [{ assetIds: ['existing'], tagId: '新增参考', positive: true }]);
  await tagMenu.getByPlaceholder('搜索或新建标签').fill('取消编辑');
  await page.keyboard.press('Escape');
  assert.equal(await modal.isVisible(), true, 'Escape in tag editor cancels editing before closing the preview');
  assert.equal(await tagMenu.count(), 0);
  assert.equal(await inspector.getByRole('tablist').count(), 0, 'the preview directly displays information without redundant tabs');
  assert.equal(await inspector.getByText('生成来源', { exact: true }).count(), 0);
  console.log('PASS direct inspector content, tag persistence and local Escape handling');
  const enlarged = await mainImage.evaluate(image => {
    const box = image.getBoundingClientRect();
    const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
    return { width: image.naturalWidth * scale, height: image.naturalHeight * scale };
  });
  assert.ok(enlarged.width > 285 && enlarged.height > 225, 'the image itself enlarges, not just its surrounding panel');
  for (const surface of [imageRegion.locator('figure'), inspector]) {
    const motion = await surface.evaluate(element => {
      const style = getComputedStyle(element);
      return { name: style.animationName, duration: Number.parseFloat(style.animationDuration) };
    });
    assert.ok(motion.name !== 'none' && motion.duration > 0 && motion.duration <= 0.5,
      'the image and ready projection use short opening motions');
  }
  assert.equal(await page.evaluate(() => window.store.getState().boardOpen), true);
  const closing = await modal.evaluate(element => {
    element.querySelector('button[aria-label="关闭预览"]').click();
    return new Promise(resolve => requestAnimationFrame(() => resolve({ attached: element.isConnected,
      closing: element.classList.contains('is-closing') })));
  });
  assert.deepEqual(closing, { attached: true, closing: true }, 'closing retains the overlay during its short transition');
  await modal.waitFor({ state: 'detached' });
  assert.equal(await editor.innerText(), '保留创作草稿', 'preview does not replace the current draft');
  await reference(node('old'), { assetId: 'existing', canvasNodeId: 'old' });
  await reset();
  const slowDouble = await node('old').boundingBox();
  await page.mouse.click(slowDouble.x + 60, slowDouble.y + 50);
  await page.waitForTimeout(400);
  await page.mouse.click(slowDouble.x + 60, slowDouble.y + 50, { clickCount: 2 });
  await assertNoPreview();
  assert.deepEqual(await picks(), [{ assetId: 'existing', canvasNodeId: 'old' }], 'a spaced double click also inserts exactly once');
  await reset();
  await node('old').focus(); await page.keyboard.press('Enter');
  await modal.waitFor();
  await page.waitForFunction(() => document.querySelector('.creation-image-preview')?.contains(document.activeElement),
    undefined, { timeout: 1000 });
  await modal.getByRole('button', { name: '关闭预览', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await modal.evaluate(element => element.contains(document.activeElement)), true, 'backward Tab stays within the preview');
  await page.keyboard.press('Tab');
  assert.equal(await modal.evaluate(element => element.contains(document.activeElement)), true, 'forward Tab stays within the preview');
  await close();
  assert.equal(await node('old').evaluate(element => element === document.activeElement), true, 'closing restores the keyboard trigger');
  console.log('PASS independent image: preview, double-click reference and retained draft');

  await reset();
  const sessionImage = page.locator('[data-conversation-image="b"]');
  await preview(sessionImage);
  assert.match(await detailsRegion.innerText(), /第二轮加蓝/);
  assert.equal(await modal.getByRole('button', { name: /复用提示词|继续创作|重新编辑/ }).count(), 0,
    'conversation preview does not replace the active composer with an editing action');
  await page.screenshot({ path: `${output}/conversation-dark.png` });
  const imageBeforeCollapse = await mainImage.boundingBox();
  const sourceBeforeCollapse = await mainImage.getAttribute('src');
  await modal.getByRole('button', { name: '收起会话面板', exact: true }).click();
  await detailsRegion.waitFor({ state: 'hidden' });
  assert.deepEqual(await mainImage.boundingBox(), imageBeforeCollapse, 'collapsing the conversation leaves the image in place');
  assert.equal(await mainImage.getAttribute('src'), sourceBeforeCollapse);
  assert.equal(await modal.isVisible(), true, 'the image preview remains open independently');
  const showConversation = modal.getByRole('button', { name: '显示会话', exact: true });
  assert.equal(await showConversation.evaluate(element => element === document.activeElement), true, 'collapsing hands focus to the surviving toggle');
  await showConversation.click();
  await detailsRegion.waitFor();
  assert.match(await detailsRegion.innerText(), /第二轮加蓝/);
  await close();
  await reference(sessionImage, { assetId: 'b', canvasNodeId: 'output-b' });
  await node('session').hover();
  await node('session').getByRole('button', { name: '上一张生成图片' }).click();
  await assertNoPreview();
  assert.equal((await picks()).length, 1, 'carousel navigation only changes the shown image');
  await reference(page.locator('[data-conversation-image="a"]'), { assetId: 'a', canvasNodeId: 'output-a' });
  console.log('PASS generated image: selected output, conversation and carousel controls');

  await reset();
  await node('group').click();
  const member = node('group').locator('[data-canvas-folder-asset-id="member-c"]');
  await member.waitFor();
  await preview(member);
  await close();
  await reference(member, { assetId: 'c', canvasNodeId: 'member-c' });
  console.log('PASS expanded group images share the same gestures');

  await reset();
  await page.evaluate(() => window.store.getState().setCanvasLibraryOpen(true));
  const libraryImage = page.locator('.categorized-library [data-asset-id="a"]').first();
  await libraryImage.waitFor();
  await preview(libraryImage);
  await close();
  await reference(libraryImage, 'a');
  await reset();
  await page.evaluate(() => window.store.getState().setCanvasLibraryOpen(true));
  await libraryImage.click({ modifiers: ['Shift'] });
  await page.locator('.categorized-library [data-asset-id="b"]').first().click();
  await assertNoPreview();
  assert.deepEqual(await picks(), [], 'library multi-selection takes priority over preview/reference gestures');
  console.log('PASS library image preview and library-origin double-click reference');

  await reset();
  await node('old').click({ modifiers: ['Control'] });
  await assertNoPreview();
  assert.deepEqual(await picks(), []);
  assert.match(await node('old').getAttribute('class'), /is-selected/);
  await node('old').click({ button: 'right' });
  await assertNoPreview();
  await page.keyboard.press('Escape');
  const box = await node('old').boundingBox();
  await page.mouse.move(box.x + 70, box.y + 60); await page.mouse.down();
  await page.mouse.move(box.x + 130, box.y + 80, { steps: 10 }); await page.mouse.up();
  await assertNoPreview();
  assert.deepEqual(await picks(), [], 'selection, context menu and dragging never insert references');
  assert.notEqual((await node('old').boundingBox()).x, box.x);
  const generatedBox = await page.locator('[data-conversation-image="b"]').boundingBox();
  await page.mouse.move(generatedBox.x + 80, generatedBox.y + 70); await page.mouse.down();
  await page.mouse.move(generatedBox.x + 120, generatedBox.y + 95, { steps: 8 }); await page.mouse.up();
  await page.evaluate(() => window.store.getState().setCanvasLibraryOpen(true));
  await preview(libraryImage);
  await close();
  await reference(libraryImage, 'a');
  console.log('PASS selection, right-click and dragging retain their own behavior');

  await reset();
  await node('old').click();
  await page.evaluate(() => window.store.setState({ boardOpen: false }));
  await assertNoPreview();
  assert.deepEqual(await picks(), []);
  await reset();
  await node('old').click();
  await page.evaluate(() => window.store.setState({ activeProjectId: 'q' }));
  await assertNoPreview();
  assert.deepEqual(await picks(), []);
  console.log('PASS delayed clicks are cancelled on mode/project changes');

  await reset();
  await page.evaluate(() => window.store.setState({ boardOpen: false }));
  await node('old').click();
  await modal.waitFor({ timeout: 400 });
  assert.equal(await page.locator('.media-lightbox').count(), 0, 'ordinary image browsing opens the shared HUD immediately');
  assert.equal(await page.evaluate(() => window.store.getState().boardOpen), false);
  await close();
  await page.locator('[data-conversation-image="b"]').click();
  await modal.waitFor();
  await detailsRegion.waitFor();
  assert.equal(await page.locator('[data-project-inspector]').count(), 0, 'the generated image uses the shared HUD without opening its editor');
  assert.deepEqual(await picks(), [], 'ordinary browsing does not insert references');
  await close();
  await node('old').click({ modifiers: ['Control'] });
  await assertNoPreview();
  assert.match(await node('old').getAttribute('class'), /is-selected/, 'ordinary modified clicks keep canvas selection');
  const ordinaryDrag = await node('old').boundingBox();
  await page.mouse.move(ordinaryDrag.x + 60, ordinaryDrag.y + 60); await page.mouse.down();
  await page.mouse.move(ordinaryDrag.x + 90, ordinaryDrag.y + 80, { steps: 6 }); await page.mouse.up();
  await assertNoPreview();
  await node('group').click();
  await node('group').locator('[data-canvas-folder-asset-id="member-c"]').click();
  await modal.waitFor(); await close();
  await page.evaluate(() => window.store.getState().setCanvasLibraryOpen(true));
  await libraryImage.click(); await modal.waitFor();
  assert.deepEqual(await picks(), [], 'ordinary canvas library image also previews without inserting');
  await close();
  console.log('PASS ordinary canvas, generated and library images share the HUD without activating creation');

  for (const region of ['title', 'body']) {
    await reset();
    await page.evaluate(() => window.store.setState(state => ({ boardOpen: false,
      genJobs: { ...state.genJobs, job: { ...state.genJobs.job, running: true } } })));
    const card = node('session');
    await (region === 'title' ? card.getByText('生成会话', { exact: true }) : card.locator('.canvas-prompt-content')).click();
    await page.locator('[data-project-inspector]').waitFor();
    assert.equal(await modal.count(), 0, `ordinary browsing keeps the ${region} conversation entry`);
    assert.deepEqual(await picks(), []);
  }
  await reset({ empty: true });
  assert.equal(await node('session').locator('.canvas-conversation-images').count(), 0, 'empty conversation has no result image');
  await node('session').getByText('生成指令', { exact: true }).click();
  await page.locator('[data-project-inspector]').waitFor();
  assert.equal(await modal.count(), 0, 'a conversation without results falls back to its existing details');
  assert.deepEqual(await picks(), []);
  console.log('PASS ordinary whole-card entry and no-image fallback');

  await reset();
  await page.evaluate(() => window.store.setState({ boardOpen: false, genEditing: 'edit', activeJobId: 'job', genPanelOpen: true }));
  await preview(node('old'));
  assert.deepEqual(await page.evaluate(() => { const state = window.store.getState(); return [state.boardOpen, state.genEditing, state.activeJobId]; }), [false, 'edit', 'job']);
  await close();
  await reference(node('old'), { assetId: 'existing', canvasNodeId: 'old' });
  console.log('PASS editing an existing generation retains its job and mode');

  await reset();
  await page.setViewportSize({ width: 800, height: 760 });
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await preview(node('old'));
  for (const surface of [inspector, imageRegion]) {
    const panel = await surface.boundingBox();
    assert.ok(panel.x >= 0 && panel.x + panel.width <= 801 && panel.y >= 0 && panel.y + panel.height <= 761);
  }
  await page.screenshot({ path: `${output}/preview-light-800.png` });
  await close();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await preview(node('old'));
  for (const surface of [inspector, imageRegion.locator('figure')]) {
    assert.equal(await surface.evaluate(element => getComputedStyle(element).animationName), 'none',
      'reduced motion disables the independent surface animations');
  }
  assert.equal(await modal.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length), 0,
    'reduced motion keeps the preview static');
  await close();
  assert.deepEqual(errors, []);
  console.log('PASS responsive left/right layout, light theme, reduced motion and clean browser runtime');
} finally {
  await browser.close();
  await server.close();
}
