import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } }, cacheDir: '.tmp/composer-h3-optimization/vite', server: { host: '127.0.0.1', port: 1711, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:1711/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { React, createRoot } = await import('/scripts/fixtures/composer-h3-optimization.tsx');
    const { CreativeComposer } = await import('/src/components/CreativeComposer.tsx');
    const { comfyVideoOptionsForMode, DEFAULT_COMFY_VIDEO } = await import('/src/lib/comfyVideo.ts');
    window.store.setState({ boardOpen: true, cloudAuth: { logged_in: true, user_id: 'tester' }, cloudEntitlement: { user_id: 'tester', tier: 'pro', offline_state: 'fresh', is_test_account: true, balances: { daily: 100, sub: 0, topup: 0 }, generation_services: [], policy: { can_use_agent_runs: true, allowed_agent_skills: ['bowerbird-unified-agent'] } } });
    window.optimizations = []; window.generations = [];
    const host = document.createElement('div'); host.id = 'h3-composer-test'; host.style.cssText = 'position:fixed;inset:auto 30px 20px;z-index:99999;background:var(--bb-panel)'; document.body.append(host);
    const root = createRoot(host);
    window.renderComposer = (mode = 'text', projectId = 'p') => root.render(React.createElement(CreativeComposer, {
      key: `${mode}-${projectId}`, projectId,
      draftJson: JSON.stringify({ schema_version: 1, mode: 'video', modeDrafts: { video: { doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '先看左下，然后抬眼看右上' }] }] }, refs: [], generation: { media: 'video', localVideo: comfyVideoOptionsForMode(DEFAULT_COMFY_VIDEO, mode) } } } }),
      onDraftChange: draft => { window.savedDraft = JSON.parse(draft); }, resolveCreativeThread: async () => ({}),
      onGenerateLocalVideo: async request => { window.generations.push(request); },
      onOptimizeLocalVideo: async (request, target) => { window.optimizations.push({ request, target }); return await new Promise(resolve => { window.finishOptimization = resolve; }); },
    }));
    window.renderComposer();
  });
  const composer = page.locator('#h3-composer-test');
  const button = composer.getByRole('button', { name: '优化提示词', exact: true });
  try { await button.waitFor({ timeout: 5000 }); } catch (error) { console.error(errors, await composer.innerText()); throw error; }
  await button.click();
  await page.waitForFunction(() => window.optimizations.length === 1);
  assert.equal(await composer.getByRole('button', { name: '正在优化…', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.finishOptimization('固定低机位特写。她先看左下，然后优雅地抬眼看右上。'));
  await page.waitForFunction(() => document.querySelector('#h3-composer-test .ProseMirror').textContent.includes(window.optimizations.length === 1 ? '固定低机位特写' : '保持参考图端点'));
  assert.equal(await composer.locator('.composer-h3-result').count(), 0);
  const field = await composer.locator('.composer-input-area').boundingBox();
  const action = await button.boundingBox();
  assert.ok(action.y > field.y + field.height / 2 && action.x + action.width <= field.x + field.width && action.y + action.height <= field.y + field.height);
  await page.screenshot({ path: '.tmp/composer-h3-optimization/result.png' });
  assert.match(await composer.locator('.ProseMirror').innerText(), /固定低机位特写/);
  assert.equal(await page.evaluate(() => window.generations.length), 0);
  assert.equal(await page.evaluate(() => window.optimizations[0].target), 'p');
  await page.evaluate(() => {
    window.store.setState({ assets: window.store.getState().assets.map(asset => ({ ...asset, thumb_path: asset.store_path, store_path: `/synthetic-${asset.id}.png` })) });
    window.renderComposer('frames');
  });
  await composer.locator('.ProseMirror').click();
  await page.evaluate(async () => {
    const { BOARD_ASSET_PICK_EVENT } = await import('/src/components/creation/useCreationEditor.ts');
    for (const assetId of ['a', 'b']) window.dispatchEvent(new CustomEvent(BOARD_ASSET_PICK_EVENT, { detail: { assetId, canvasNodeId: `canvas-${assetId}` } }));
  });
  await button.click();
  await page.waitForFunction(() => window.optimizations.length === 2);
  assert.deepEqual(await page.evaluate(() => [window.optimizations[1].request.firstFrame, window.optimizations[1].request.lastFrame]), ['a', 'b']);
  await page.evaluate(() => window.finishOptimization('保持参考图端点，缓慢转头。'));
  await page.waitForFunction(() => document.querySelector('#h3-composer-test .ProseMirror').textContent.includes(window.optimizations.length === 1 ? '固定低机位特写' : '保持参考图端点'));
  const references = await page.evaluate(() => window.savedDraft.modeDrafts.video.doc.content.flatMap(p => p.content ?? []).filter(n => n.type === 'image').map(n => [n.attrs.assetId, n.attrs.canvasNodeId]));
  assert.deepEqual(references, [['a', 'canvas-a'], ['b', 'canvas-b']], 'apply preserves ordered frame and canvas identities');
  await button.click();
  await page.waitForFunction(() => window.optimizations.length === 3);
  await page.evaluate(() => window.renderComposer('text', 'q'));
  await composer.getByLabel('优化后的提示词').waitFor({ state: 'hidden' });
  await page.evaluate(() => window.finishOptimization('旧项目结果不可覆盖新项目'));
  assert.equal(await composer.getByLabel('优化后的提示词').count(), 0);
  assert.doesNotMatch(await composer.locator('.ProseMirror').innerText(), /旧项目/);
  // Exercise both real host callbacks and the durable H3 runtime, with synthetic IPC only.
  for (const host of ['canvas', 'library']) {
    await page.evaluate(() => { sessionStorage.clear(); localStorage.removeItem('bowerbird.libraryComposer.draft.v1'); });
    await page.reload();
    await page.locator('[data-canvas-node-id="old"]').waitFor();
    await page.evaluate(async host => {
      const { api } = await import('/src/lib/api.ts');
      window.store.setState({ boardOpen: true, cloudAuth: { logged_in: true, cloud_available: true, user_id: 'tester' }, cloudEntitlement: { user_id: 'tester', tier: 'pro', offline_state: 'fresh', is_test_account: true, balances: { daily: 100, sub: 0, topup: 0 }, policy: { can_use_byo: true, can_use_agent_runs: true, max_parallel_agent_runs: 3, allowed_agent_skills: ['bowerbird-unified-agent'], agent_budget_options: ['unified-standard'] }, generation_services: [] }, openCloudAgentRun: () => {} });
      window.cloudCalls = []; window.localCalls = [];
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === 'comfy_video_environment') return { phase: 'ready', endpoint: args.endpoint, message: '就绪' };
        if (command === 'comfy_video') { window.localCalls.push(args); return { status: 'done', asset: { id: 'h3-video', ext: 'mp4', store_path: '/synthetic.mp4' } }; }
        return invoke(command, args);
      };
      api.getAssetsByIds = async ids => ids.map(id => ({ id, ext: id === 'h3-video' ? 'mp4' : 'png', store_path: `/synthetic.${id === 'h3-video' ? 'mp4' : 'png'}` }));
      api.cloudAgentStart = async request => { window.cloudCalls.push(request); return { runId: `cloud-${window.cloudCalls.length}` }; };
      api.cloudAgentGet = async runId => ({ runId, status: 'succeeded', snapshot: { run: {}, events: [{ type: 'text.result', display_payload: { schemaVersion: 1, text: 'integrated_multimodal_description: 先固定镜头，再缓慢后拉。' } }] } });
      if (host === 'library') {
        const { React, createRoot } = await import('/scripts/fixtures/composer-h3-optimization.tsx');
        const { LibraryComposer } = await import('/src/components/LibraryComposer.tsx');
        document.getElementById('root').style.display = 'none';
        const container = document.createElement('div'); container.id = 'library-host'; container.style.cssText = 'position:fixed;inset:auto 20px 20px'; document.body.append(container);
        api.prepareLibraryGenerationProject = async () => ({ id: 'p', name: '测试项目' });
        window.store.setState({ activeProjectId: null });
        createRoot(container).render(React.createElement(LibraryComposer));
      }
    }, host);
    const actual = page.locator(host === 'library' ? '#library-host .creation-dock' : '.canvas-composer-host .creation-dock');
    await actual.getByRole('button', { name: '视频', exact: true }).click();
    await actual.getByTitle('选择视频模型', { exact: true }).click();
    await page.locator('[data-model-key="local:h3"]').click();
    await actual.getByLabel('本地视频模式', { exact: true }).click();
    await page.getByRole('option', { name: '文生视频', exact: true }).click();
    await actual.locator('.ProseMirror').fill('镜头先固定，然后后拉');
    await actual.getByRole('button', { name: '优化提示词', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.composer-glass .ProseMirror')?.textContent.includes('先固定镜头')); 
    assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p') ?? '{"document":{"nodes":[]}}').document.nodes.length), 0, 'optimizing a draft must not add H3/workflow cards');
    assert.equal(await page.evaluate(() => window.cloudCalls.length), 1);
    assert.equal(await page.evaluate(() => window.localCalls.length), 0);
    assert.equal(await page.evaluate(() => window.cloudCalls[0].projectId), host === 'canvas' ? 'p' : undefined);
    assert.equal(await page.evaluate(() => window.cloudCalls[0].references.length), 0);
    assert.equal((await actual.locator('.ProseMirror').innerText()).trim(), '先固定镜头，再缓慢后拉。');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.screenshot({ path: `.tmp/composer-h3-optimization/${host}-${theme}.png`, animations: 'disabled' });
    }
    await actual.locator('.ProseMirror').fill('编辑过的优化结果');
    await actual.getByRole('button', { name: '生成视频', exact: true }).click();
    await page.waitForFunction(() => window.localCalls.length === 1);
    assert.equal(await page.evaluate(() => window.localCalls[0].input.prompt), '编辑过的优化结果');
    assert.equal(await page.evaluate(() => window.cloudCalls.length), 1, 'manual generation must not optimize again');
    const persisted = await page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document);
    assert.equal(persisted.nodes.length, 1, 'only the explicitly generated H3 card is created');
    assert.equal(await page.evaluate(() => window.cloudCalls[0].threadId), undefined, 'pure text does not request a creative thread');
  }
  assert.deepEqual(errors, []);
  console.log('H3 composer: explicit optimization, direct replacement, no automatic generation, project isolation passed');
} finally { await browser.close(); await server.close(); }
