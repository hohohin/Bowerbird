import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const entry = 'scripts/fixtures/canvas-reference/preview.html';
const directory = '.tmp/canvas-video-reference';
await mkdir(directory, { recursive: true });
const ffmpeg = process.env.BOWERBIRD_FFMPEG_BINARY || resolve('../../.tmp/video-integration/tools/local/ffmpeg.exe');
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=red:s=320x180:r=25:d=1',
  '-vf', "drawbox=color=yellow:t=fill:enable='gte(t,0.96)'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${directory}/clip.mp4`]);
const server = await createServer({ cacheDir: `${directory}/vite`, optimizeDeps: { entries: [entry] },
  server: { host: '127.0.0.1', port: 18557, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.setDefaultTimeout(8000);
  await page.goto(server.resolvedUrls.local[0] + entry);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async path => {
    const snapshot = window.snapshot(), base = snapshot.nodes[0];
    const asset = { id: 'clip', name: '测试视频', ext: 'mp4', width: 320, height: 180, duration: 1, store_path: path, source: 'imported' };
    snapshot.nodes = [
      { ...base, id: 'clip-node', assetId: asset.id, x: 190, y: 210, width: 320, height: 180 },
      { ...base, id: 'clip-session', kind: 'prompt', role: null, assetId: null, x: 190, y: 540, width: 320, height: 180,
        payloadJson: JSON.stringify({ job_id: 'video-job', turn_key: 'first', status: 'done', text: '视频会话' }) },
      { ...base, id: 'clip-session-output', assetId: asset.id, role: 'output', x: 190, y: 540,
        payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: asset.name, width: asset.width, height: asset.height },
          execution: { job_id: 'video-job', turn_key: 'first' } }) },
    ];
    snapshot.view = { ...snapshot.view, zoom: 1, panX: 0, panY: 0 };
    sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
    sessionStorage.setItem('reference-drafts', JSON.stringify([asset]));
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const image = { ...newWorkflowNode('generation', 700, 120, 'codex'), id: 'image-receiver' };
    const video = { ...newWorkflowNode('generation', 700, 550, 'codex'), id: 'video-receiver', generation: { media: 'video' } };
    sessionStorage.setItem('workflow-p', JSON.stringify({ revision: 0, document: { schema_version: 1, nodes: [image, video], run: null } }));
  }, `/${directory}/clip.mp4`);
  await page.reload();
  const imageReceiver = page.locator('[data-workflow-card="image-receiver"]');
  const videoReceiver = page.locator('[data-workflow-card="video-receiver"]');
  const options = page.getByRole('menu', { name: '引用视频' });
  async function openVideoOptions(sourceId, receiver) {
    const card = page.locator(`[data-canvas-node-id="${sourceId}"]`);
    await card.hover();
    const port = await page.locator(`[data-workflow-material="${sourceId}"] [data-canvas-connect-side="output"]`).boundingBox();
    const target = await receiver.boundingBox();
    const startX = port.x + port.width / 2, startY = port.y + port.height / 2;
    await page.mouse.move(startX, startY);
    const outputHit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-workflow-node]')?.dataset.workflowNode, { x: startX, y: startY });
    assert.equal(outputHit, sourceId, 'pointer can reach the visible output handle');
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + 25, { steps: 18 });
    await page.mouse.up();
    await options.waitFor().catch(error => { throw new Error(`Video menu did not appear for ${sourceId}`, { cause: error }); });
    assert.deepEqual(await options.getByRole('menuitem').allTextContents(),
      ['引用完整视频', '引用首帧画面', '引用尾帧画面']);
  }
  const option = name => options.getByRole('menuitem', { name, exact: true });
  await openVideoOptions('clip-node', imageReceiver);
  assert.equal(await option('引用完整视频').isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(await options.count(), 0);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'import_image_bytes').length), 0);

  for (const [source, label] of [['clip-node', '引用首帧画面'], ['clip-session', '引用尾帧画面']]) {
    await openVideoOptions(source, imageReceiver);
    await option(label).click();
    await page.waitForFunction(position => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes
      .find(node => node.id === 'image-receiver').inputs.image?.some(input => input.videoFrame?.position === position),
    label.includes('首帧') ? 'first' : 'last');
  }
  await openVideoOptions('clip-node', videoReceiver);
  assert.equal(await option('引用完整视频').isEnabled(), true);
  await option('引用完整视频').click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes
    .find(node => node.id === 'video-receiver').inputs.image?.some(input => input.assetId === 'clip'));

  const evidence = await page.evaluate(async () => {
    const { workflowInputValues, workflowBindingKey } = await import('/src/lib/canvasWorkflow.ts');
    const { filterAutomaticMediaValues } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { nodes } = JSON.parse(sessionStorage.getItem('workflow-p')).document;
    const [image, video] = nodes;
    const frames = image.inputs.image, complete = video.inputs.image[0];
    const values = workflowInputValues(nodes, image);
    await filterAutomaticMediaValues(image, values, nodes);
    const imports = window.calls.filter(call => call.command === 'import_image_bytes' && call.args.source === 'video-frame');
    const pixels = [];
    for (const call of imports) {
      const picture = new Image(); picture.src = call.args.dataUrl; await picture.decode();
      const canvas = document.createElement('canvas'); canvas.width = picture.width; canvas.height = picture.height;
      const context = canvas.getContext('2d'); context.drawImage(picture, 0, 0);
      pixels.push({ size: [canvas.width, canvas.height], rgb: [...context.getImageData(100, 100, 1, 1).data.slice(0, 3)], origin: call.args.videoFrame });
    }
    window.save();
    const first = frames[0], sameSourceTail = { ...first, videoFrame: { ...first.videoFrame, position: 'last' } };
    return { frames, complete, keys: new Set([complete, first, sameSourceTail].map(workflowBindingKey)).size, pixels,
      imageValues: values.image.map(value => value.assetIds[0]), videoValue: workflowInputValues(nodes, video).image[0].assetIds[0] };
  });
  assert.equal(evidence.keys, 3);
  assert.equal(evidence.complete.assetId, 'clip');
  assert.equal(evidence.complete.videoFrame, undefined);
  assert.equal(evidence.videoValue, 'clip');
  assert.deepEqual(evidence.frames.map(input => [input.assetId, input.assetNodeId, input.videoFrame.position]),
    [['clip', 'clip-node', 'first'], ['clip', 'clip-session-output', 'last']]);
  assert.deepEqual(evidence.imageValues, evidence.frames.map(input => input.videoFrame.assetId));
  assert.ok(evidence.imageValues.every(id => id !== 'clip'));
  assert.deepEqual(evidence.pixels.map(frame => frame.size), [[320, 180], [320, 180]]);
  assert.ok(evidence.pixels[0].rgb[0] > 200 && evidence.pixels[0].rgb[1] < 40 && evidence.pixels[0].rgb[2] < 40);
  assert.ok(evidence.pixels[1].rgb[0] > 200 && evidence.pixels[1].rgb[1] > 200 && evidence.pixels[1].rgb[2] < 40);
  assert.equal(evidence.pixels[0].origin.time, 0);
  assert.ok(evidence.pixels[1].origin.time > 0.96);
  assert.equal(evidence.pixels[0].origin.sourcePath, `/${directory}/clip.mp4`);

  await page.reload();
  for (const input of evidence.frames) {
    const id = input.videoFrame.assetId;
    const thumbnail = imageReceiver.locator(`[data-workflow-reference-asset="${id}"] img`);
    await thumbnail.waitFor();
    assert.equal(await thumbnail.evaluate(async img => { await img.decode(); return img.naturalWidth; }), 320);
    await page.locator(`path[data-auto-connection="${input.autoConnect}"][data-workflow-target="image-receiver"]`).waitFor({ state: 'attached' });
  }
  const tail = evidence.frames[1];
  await imageReceiver.locator('[data-canvas-connect-side="input"]').click({ button: 'right' });
  const disconnection = page.getByRole('menu', { name: '选择要断开的连线' });
  await disconnection.getByRole('menuitem').filter({
    has: page.locator(`[data-workflow-disconnect-asset="${tail.videoFrame.assetId}"]`),
  }).click();
  const savedFrameCount = count => page.waitForFunction(count => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes
    .find(node => node.id === 'image-receiver').inputs.image?.length === count, count);
  await savedFrameCount(1);
  await page.getByRole('button', { name: '撤销画布操作' }).click();
  await savedFrameCount(2);
  await imageReceiver.locator(`[data-workflow-reference-asset="${tail.videoFrame.assetId}"] img`).waitFor();
  console.log('PASS: video reference choices, exact source instances, original-size first/tail pixels, persisted frame thumbnails, disconnect and undo');
} finally { await browser.close(); await server.close(); }
