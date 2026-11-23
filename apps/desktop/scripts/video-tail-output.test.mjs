import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const directory = '.tmp/video-tail-output';
await mkdir(directory, { recursive: true });
const ffmpeg = process.env.BOWERBIRD_FFMPEG_BINARY || resolve('../../.tmp/video-integration/tools/local/ffmpeg.exe');
const encode = (color, name = 'tail') => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=red:s=320x180:r=25:d=1',
  '-vf', `drawbox=color=${color}:t=fill:enable='gte(t,0.96)'`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${directory}/${name}.mp4`]);
encode('yellow');
encode('blue', 'next');
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: `${directory}/vite`,
  resolve: { alias: { '@': resolve('src') } }, optimizeDeps: { entries: ['scripts/fixtures/canvas-reference/preview.html'] },
  server: { host: '127.0.0.1', port: 1659, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
try {
  await page.goto('http://127.0.0.1:1659/scripts/fixtures/canvas-reference/preview.html?strict');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(() => {
    const snapshot = window.snapshot(), base = snapshot.nodes[0];
    snapshot.nodes = [{ ...base, id: 'clip', assetId: 'clip', x: 180, y: 120, width: 320, height: 180,
      payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: '测试视频', width: 320, height: 180 } }) },
      { ...base, id: 'session', kind: 'prompt', assetId: null, x: 550, y: 120, width: 320, height: 180,
        payloadJson: JSON.stringify({ job_id: 'job', turn_key: 'turn', text: '测试', status: 'done' }) },
      { ...base, id: 'output', assetId: 'clip', role: 'output', x: 550, y: 380,
        payloadJson: JSON.stringify({ execution: { job_id: 'job', turn_key: 'turn' } }) }];
    snapshot.view = { ...snapshot.view, zoom: 1, panX: 0, panY: 0 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    sessionStorage.setItem('reference-drafts', JSON.stringify(['clip', 'next-clip'].map(id => ({ id, name: '测试视频', ext: 'mp4', width: 320, height: 180,
      store_path: `/.tmp/video-tail-output/${id === 'clip' ? 'tail' : 'next'}.mp4`, duration: 1, source: 'imported' }))));
  });
  await page.reload();
  await page.locator('[data-workflow-material="clip"] [data-canvas-connect-side="output"]').waitFor({ state: 'attached' });
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'import_image_bytes').length), 0, 'passive cards do not extract frames');
  const run = () => page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { CanvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const check = (ok, text) => { if (!ok) throw Error(text); };
    const base = window.snapshot().nodes[0];
    const pixels = async id => {
      const [asset] = await api.getAssetsByIds([id]);
      check(asset?.ext === 'png' && asset.width === 320 && asset.height === 180, 'original dimensions and PNG asset');
      const image = new Image(); image.src = asset.store_path; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      return [...ctx.getImageData(100, 100, 1, 1).data];
    };
    const create = async (input, loop = false) => {
      const id = crypto.randomUUID();
      await api.projectCanvasNodeCreate({ ...base, id, kind: 'note', assetId: null, role: null,
        payloadJson: JSON.stringify({ schema_version: 1, note_type: 'images', cells: [[{ id: 'cell', text: '', content_type: 'image' }]] }) });
      const writer = { ...newWorkflowNode('text', 0, 0, ''), id: 'writer', textTarget: { nodeId: id, cellId: 'cell', image: true },
        inputs: { image: [loop ? { nodeId: 'loop', portId: 'image' } : input] } };
      const controller = new CanvasWorkflowController(`tail-${crypto.randomUUID()}`); await controller.load();
      await controller.edit(loop ? [{ ...newWorkflowNode('loop', 0, 0, ''), id: 'loop', inputs: { image: [input] } }, writer] : [writer]);
      await controller.start(loop ? 'loop' : 'writer', true);
      check(controller.document.run.status === 'done', JSON.stringify(controller.issue));
      const target = (await api.projectCanvasGet(controller.projectId)).nodes.find(node => node.id === id);
      const imageId = JSON.parse(target.payloadJson).cells[0][0].image_refs[0].asset_id;
      check(imageId !== 'clip', 'receiver must get the tail image, not original video');
      return pixels(imageId);
    };
    const direct = await create({ assetId: 'clip', assetNodeId: 'clip' });
    const session = await create({ canvasNodeId: 'session', cellId: 'image' });
    const loop = await create({ assetId: 'clip', assetNodeId: 'clip' }, true);
    const { DEFAULT_COMFY_VIDEO, comfyVideoOptionsForMode } = await import('/src/lib/comfyVideo.ts');
    window.store.setState({ cloudAuth: { logged_in: true, user_id: 'tester' }, cloudEntitlement: {
      user_id: 'tester', tier: 'pro', offline_state: 'fresh', balances: { daily: 0, sub: 0, topup: 0 }, policy: { can_use_byo: true }, generation_services: [] } });
    const controller = new CanvasWorkflowController('dynamic-video-boundary'); await controller.load();
    const producer = { ...newWorkflowNode('comfy-video', 0, 0, 'codex'), id: 'a', prompt: '生成视频 A',
      comfyVideo: comfyVideoOptionsForMode(DEFAULT_COMFY_VIDEO, 'text') };
    const frameWire = position => ({ nodeId: 'a', portId: 'image', videoFrame: { position }, mediaFilter: ['image'], autoConnect: position });
    const inputs = { 'first-frame': [frameWire('last')], 'last-frame': [frameWire('first')] };
    if (!controller.document.nodes.length) await controller.edit([producer, { ...newWorkflowNode('comfy-video', 420, 0, 'codex'),
      id: 'b', prompt: '生成视频 B', inputs }, { ...newWorkflowNode('comfy-video', 420, 400, 'codex'), id: 'c', prompt: '生成视频 C',
      comfyVideo: comfyVideoOptionsForMode(DEFAULT_COMFY_VIDEO, 'r2v'), inputs: { 'reference-image': [frameWire('first')],
        'reference-video': [{ nodeId: 'a', portId: 'image', mediaFilter: ['video'] }] } }]);
    const sourceId = controller.document.run ? 'next-clip' : 'clip';
    const [asset] = await api.getAssetsByIds([sourceId]);
    const originalInvoke = window.__TAURI_INTERNALS__.invoke, submissions = [];
    let waitingRequest;
    window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === 'comfy_video_environment') return Promise.resolve({ phase: 'ready', endpoint: args.endpoint });
      if (cmd === 'comfy_video' && args.action === 'start') {
        submissions.push(args.input);
        if (args.input.prompt === '生成视频 B') {
          waitingRequest = args.requestId;
          return Promise.resolve({ status: 'unknown', message: '等待恢复' });
        }
        return Promise.resolve({ status: 'done', asset });
      }
      if (cmd === 'comfy_video' && args.action === 'status' && waitingRequest === args.requestId) return Promise.resolve({ status: 'done', asset });
      return originalInvoke(cmd, args);
    };
    try {
      await controller.start('a');
      check(controller.document.run?.status === 'waiting', JSON.stringify(controller.issue ?? controller.document.run));
      const before = window.calls.filter(call => call.command === 'import_image_bytes').length;
      await controller.continue();
      check(window.calls.filter(call => call.command === 'import_image_bytes').length === before, 'submitted card recovers without re-extracting');
    } finally { window.__TAURI_INTERNALS__.invoke = originalInvoke; }
    check(controller.document.run?.status === 'done' && submissions.length === 3, JSON.stringify(controller.issue ?? controller.document.run));
    const frames = submissions.find(submission => submission.prompt === '生成视频 B');
    const r2v = submissions.find(submission => submission.prompt === '生成视频 C');
    check(r2v.referenceVideos[0] === sourceId && r2v.referenceImages[0] !== sourceId, 'R2V frame and full video can share a producer');
    check(controller.document.run.steps.c.generationRunInput.references[0][0] === sourceId, 'R2V retry compares the source identity with the current wire');
    check(controller.document.nodes.find(n => n.id === 'a').outputs.image.assetIds[0] === sourceId, 'upstream output remains a video');
    check(controller.document.nodes.find(n => n.id === 'b').inputs['first-frame'][0].videoFrame.assetId === undefined, 'wire remains dynamic after running');
    const first = await pixels(frames.lastFrame);
    check(first[0] > 200 && first[1] < 40 && first[2] < 40, 'selected first frame is red');
    return { direct, session, loop, h3: await pixels(frames.firstFrame) };
  });
  const yellow = await run();
  for (const pixel of Object.values(yellow)) assert.ok(pixel[0] > 200 && pixel[1] > 200 && pixel[2] < 40, JSON.stringify(pixel));
  // Same file path and asset ID after overwrite: never reuse an old decoded tail.
  encode('lime');
  const { h3: newVideo, ...green } = await run();
  for (const pixel of Object.values(green)) assert.ok(pixel[0] < 40 && pixel[1] > 200 && pixel[2] < 40, JSON.stringify(pixel));
  assert.ok(newVideo[0] < 40 && newVideo[1] < 40 && newVideo[2] > 200, 'H3 rerun takes the blue tail from the new video ID and path');
  console.log(await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { resolveDynamicVideoFrame, resolveVideoCardOutputs } = await import('/src/lib/workflowVideoFrames.ts');
    const { newWorkflowNode, compileGenerationPrompt } = await import('/src/lib/canvasWorkflow.ts');
    const { readVideoLastFrame } = await import('/src/lib/videoFrame.ts');
    const check = (ok, text) => { if (!ok) throw Error(text); };
    const input = { assetId: 'clip', assetNodeId: 'clip' };
    const node = { ...newWorkflowNode('generation', 0, 0, ''), prompt: '使用 @[image]', inputs: { image: [input] },
      promptReferences: [{ id: 'image', type: 'image', assetId: 'clip', input, label: '图片' }] };
    const values = { image: [{ type: 'image', assetIds: ['clip'] }] };
    await resolveVideoCardOutputs(node, values, [], 'p', () => false);
    check(compileGenerationPrompt(node, values).assetIds[0] !== 'clip', 'legacy prompt reference resolves to PNG');
    const videoValue = { image: [{ type: 'image', assetIds: ['clip'] }] };
    await resolveVideoCardOutputs({ ...node, kind: 'text', inputs: { image: [{ nodeId: 'video-generator', portId: 'image' }] } }, videoValue, [], 'p', () => false);
    check(videoValue.image[0].assetIds[0] === 'clip', 'explicit video generation output remains video');
    window.failFrameImport = true;
    let failed = false;
    try { await resolveVideoCardOutputs(node, { image: [{ type: 'image', assetIds: ['clip'] }] }, [], 'p', () => false); } catch { failed = true; }
    check(failed, 'import error propagates, no fallback to video or poster');
    window.failFrameImport = false;
    let broken = false;
    try { await readVideoLastFrame('/missing-video.mp4', '/missing-video.mp4'); } catch { broken = true; }
    check(broken, 'unreadable video rejects');
    const before = window.calls.filter(call => call.command === 'import_image_bytes').length;
    await resolveVideoCardOutputs(node, { image: [{ type: 'image', assetIds: ['clip'] }] }, [], 'p', () => true);
    check(window.calls.filter(call => call.command === 'import_image_bytes').length === before, 'stopped workflow does not import');
    const wire = { nodeId: 'a', portId: 'image', videoFrame: { position: 'last' } };
    let unavailable = '';
    try { await resolveDynamicVideoFrame('p', node, wire, { type: 'image', assetIds: ['missing-video'] }, () => false); }
    catch (error) { unavailable = error.message; }
    check(unavailable.includes('上游视频') && unavailable.includes('视频文件不可用'), 'missing video identifies the failing frame input');
    const getAssets = api.getAssetsByIds;
    let stopped = false;
    api.getAssetsByIds = async ids => { const assets = await getAssets(ids); stopped = true; return assets; };
    try { await resolveDynamicVideoFrame('p', node, wire, { type: 'image', assetIds: ['clip'] }, () => stopped); }
    finally { api.getAssetsByIds = getAssets; }
    check(stopped && window.calls.filter(call => call.command === 'import_image_bytes').length === before, 'cancelling dynamic extraction prevents frame import');
    check(!document.querySelector('.video-player'), 'no player opened for extraction');
    return 'PASS frame pixels, H3-to-H3 dynamic frames, new upstream output, card/session/loop delivery, static references, failures and cancellation';
  }));
} finally { await browser.close(); await server.close(); }
