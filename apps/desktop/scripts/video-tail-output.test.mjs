import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const directory = '.tmp/video-tail-output';
await mkdir(directory, { recursive: true });
const ffmpeg = process.env.BOWERBIRD_FFMPEG_BINARY || resolve('../../.tmp/video-integration/tools/local/ffmpeg.exe');
const encode = color => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=red:s=320x180:r=25:d=1',
  '-vf', `drawbox=color=${color}:t=fill:enable='gte(t,0.96)'`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${directory}/tail.mp4`]);
encode('yellow');
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: `${directory}/vite`,
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
    sessionStorage.setItem('reference-drafts', JSON.stringify([{ id: 'clip', name: '测试视频', ext: 'mp4', width: 320, height: 180,
      store_path: '/.tmp/video-tail-output/tail.mp4', duration: 1, source: 'imported' }]));
  });
  await page.reload();
  await page.getByLabel('连接视频尾帧图到工作流').first().waitFor({ state: 'attached' });
  await page.getByLabel('输出：尾帧图').waitFor({ state: 'attached' });
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
    return { direct, session, loop };
  });
  const yellow = await run();
  for (const pixel of Object.values(yellow)) assert.ok(pixel[0] > 200 && pixel[1] > 200 && pixel[2] < 40, JSON.stringify(pixel));
  // Same file path and asset ID after overwrite: never reuse an old decoded tail.
  encode('lime');
  const green = await run();
  for (const pixel of Object.values(green)) assert.ok(pixel[0] < 40 && pixel[1] > 200 && pixel[2] < 40, JSON.stringify(pixel));
  console.log(await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { resolveVideoCardOutputs } = await import('/src/lib/workflowVideoFrames.ts');
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
    check(!document.querySelector('.video-player'), 'no player opened for extraction');
    return 'PASS original-resolution final pixels, card/session/loop delivery, overwrite refresh, prompt references, dedicated video port, failures and stopped run';
  }));
} finally { await browser.close(); await server.close(); }
