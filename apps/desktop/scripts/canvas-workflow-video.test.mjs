import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 1637, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
try {
  await page.goto('http://127.0.0.1:1637/scripts/fixtures/canvas-reference/preview.html');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => { const canvas = window.snapshot(); canvas.nodes = canvas.nodes.filter(node => node.id !== 'far'); sessionStorage.setItem('reference-fixture', JSON.stringify(canvas)); });
  await page.reload(); await page.locator('[data-canvas-node-id="old"]').waitFor();
  const mockCatalog = () => page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    api.dreaminaVideoModels = async () => [{ model_version: 'seedance2.5', resolutions: ['480p', '720p', '1080p'], min_duration: 4, max_duration: 30 }];
    api.dreaminaCreditBalance = async () => ({ total_credit: 10 });
  });
  await mockCatalog();
  await page.getByRole('button', { name: '新增生成卡片', exact: true }).click();
  await page.getByRole('button', { name: '适应内容', exact: true }).click();
  const card = page.locator('.workflow-card.is-generation').first();
  await card.hover();
  await card.getByLabel('生成类型', { exact: true }).selectOption('video');
  await card.getByLabel('视频生成渠道').selectOption('cloud');
  await card.getByLabel('视频生成模式').selectOption('frames2video');
  await card.getByLabel('视频时长（秒）').fill('8');
  await card.getByLabel('视频分辨率').selectOption('1080p');
  await card.getByLabel('卡片指令', { exact: true }).fill('首尾平滑转场');
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes[0].generation.videoOptions.duration === 8);
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes[0]);
  await page.reload();
  await card.waitFor();
  assert.equal(await card.getByLabel('视频时长（秒）').inputValue(), '8');
  assert.equal(await card.getByLabel('视频生成模式').inputValue(), 'frames2video');
  assert.equal(await card.getByRole('button', { name: '输出：视频', exact: true }).count(), 1);
  // Controls must lie below sockets, inside the card, without horizontal overflow.
  const layout = await card.evaluate(el => {
    const controls = el.querySelector('.workflow-video-controls').getBoundingClientRect();
    const socket = el.querySelector('.workflow-port.is-input').getBoundingClientRect();
    const fieldset = el.querySelector('.workflow-video-controls');
    return { top: controls.top, bottom: socket.bottom, scroll: fieldset.scrollWidth, width: fieldset.clientWidth };
  });
  assert.ok(layout.top > layout.bottom && layout.scroll <= layout.width + 2, JSON.stringify(layout));
  await page.getByRole('button', { name: '适应内容', exact: true }).click();
  await mkdir('.tmp/workflow-video', { recursive: true });
  await page.screenshot({ path: '.tmp/workflow-video/controls.png' });
  await card.hover();
  await card.getByLabel('生成类型', { exact: true }).selectOption('image');
  assert.equal(await card.getByLabel('视频时长（秒）').count(), 0);
  await card.getByLabel('生成类型', { exact: true }).selectOption('video');
  assert.equal(await card.getByLabel('视频时长（秒）').inputValue(), '8');
  await card.getByLabel('复制卡片', { exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.length === 2);
  assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes[1].generation), saved.generation);

  const result = await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode, workflowReferenceToken } = await import('/src/lib/canvasWorkflow.ts');
    const { captureWorkflowTemplate } = await import('/src/lib/workflowTemplates.ts');
    const { useStore } = await import('/src/store.ts');
    const check = (ok, message) => { if (!ok) throw Error(message); };
    const assets = ['a', 'b', 'v'].map(id => ({ id, store_path: `/tmp/${id}.${id === 'v' ? 'mp4' : 'png'}`, duration: id === 'v' ? 5 : null }));
    api.getAssetsByIds = async ids => ids.map(id => assets.find(asset => asset.id === id)).filter(Boolean);
    let calls = [], active, loseResult = false;
    api.localAgentFindAssetId = async () => loseResult ? null : 'v';
    useStore.setState({ startGeneration: async (...args) => {
      calls.push(args);
      const identity = args[12];
      check(active.document.run.steps.gen.jobId === identity.jobId, 'persist identity before submitting');
      useStore.setState({ genJobs: { [identity.jobId]: { turns: [{ turnKey: identity.turnKey, images: ['/tmp/v.mp4'] }] } } });
      return { accepted: true, jobId: identity.jobId };
    } });
    const setup = async (kind, refs = [], channel = 'jimeng') => {
      active = new CanvasWorkflowController(`video-${crypto.randomUUID()}`); await active.load();
      const promptReferences = refs.map((assetId, i) => ({ id: `ref${i}`, label: `图片来源 ${i + 1}`, type: 'image', input: { assetId } }));
      const node = { ...newWorkflowNode('generation', 0, 0, 'codex'), id: 'gen', ratio: '2:3',
        prompt: `镜头推进 ${promptReferences.map(ref => workflowReferenceToken(ref.id)).join(' ')}`,
        inputs: { image: refs.map(assetId => ({ assetId })) }, promptReferences,
        generation: { media: 'video', videoChannel: channel, ratio: '9:16', videoOptions: { kind, model_version: 'seedance2.5', duration: 8, video_resolution: '1080p' } } };
      await active.edit([node]);
      return node;
    };
    for (const channel of ['jimeng', 'cloud']) for (const [kind, refs] of [['text2video', []], ['image2video', ['a']], ['frames2video', ['b', 'a']], ['multimodal2video', ['a', 'v']]]) {
      await setup(kind, refs, channel); await active.start('gen', true);
      check(active.document.run.status === 'done', JSON.stringify(active.issue));
      const args = calls.at(-1);
      check(args[3] === (channel === 'cloud' ? 'bowerbird-cloud-video_seedance25_1080p' : 'jimeng'), 'video provider independent from image provider');
      check(args[11].videoOptions.kind === kind && args[11].media === 'video' && args[2] === '9:16', 'video options and independent ratio submitted');
      check(JSON.stringify(args[1].map(asset => asset.id)) === JSON.stringify(refs), 'reference order preserved');
      check(active.document.nodes[0].outputs.image.assetIds[0] === 'v', 'video output delivered as library asset');
    }
    const beforeInvalid = calls.length;
    for (const [kind, refs] of [['text2video', ['a']], ['image2video', []], ['frames2video', ['a']], ['image2video', ['v']]]) {
      await setup(kind, refs); await active.start('gen', true);
      check(active.document.run.status === 'failed' && !active.document.run.steps.gen.jobId, 'invalid inputs fail before job identity or submission');
    }
    check(calls.length === beforeInvalid, 'invalid modes never submit');
    await setup('text2video'); loseResult = true; await active.start('gen', true);
    check(active.document.run.status === 'waiting', 'missing ingest remains retrievable');
    const step = active.document.run.steps.gen, count = calls.length, projectId = active.projectId;
    api.recentGenSessions = async () => [{ id: step.jobId, status: 'done', turns: [{ turn_key: step.turnKey, images: ['/tmp/v.mp4'] }] }];
    loseResult = false; active = new CanvasWorkflowController(projectId); await active.load(); await active.continue();
    check(active.document.run.status === 'done' && calls.length === count, 'reload retrieves exact original turn without resubmission');
    const generator = await setup('text2video');
    await api.projectCanvasNodeCreate({ ...window.snapshot().nodes[0], id: 'video-content', kind: 'note', assetId: null, role: null, threadId: null,
      payloadJson: JSON.stringify({ schema_version: 1, note_type: 'text', text: '', member_ids: [], cells: [[{ id: 'video-cell', text: '', bold: false, italic: false, align: 'left', content_type: 'image' }]] }) });
    const writer = { ...newWorkflowNode('text', 0, 0, ''), id: 'writer', textTarget: { nodeId: 'video-content', cellId: 'video-cell', image: true }, inputs: { image: [{ nodeId: 'gen', portId: 'image' }] } };
    await active.edit([generator, writer]); await active.start('gen', true);
    check(active.document.run.status === 'done', 'video receiver completes');
    const content = (await api.projectCanvasGet(active.projectId)).nodes.find(node => node.id === 'video-content');
    check(JSON.parse(content.payloadJson).cells[0][0].image_refs[0].asset_id === 'v', 'content cell receives video asset');
    // Image-only consumers continue rejecting videos, including a video with missing duration.
    const node = await setup('multimodal2video', ['v']);
    assets[2].duration = null;
    await active.edit([{ ...node, generation: { media: 'image' } }]); await active.start('gen', true);
    check(active.document.run.status === 'failed' && calls.length === count + 1, 'image generation never receives a video');
    let rejected = false;
    try { captureWorkflowTemplate([node], new Set(['gen']), 'video'); } catch { rejected = true; }
    check(rejected, 'portable templates cannot silently discard video settings');
    return { submissions: calls.length, modes: 4, channels: 2 };
  });
  console.log('PASS workflow video UI, persistence, copy, input validation, routing and recovery', result);
} finally { await browser.close(); await server.close(); }
