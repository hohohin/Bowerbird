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
const server = await createServer({ configFile: false, resolve: { alias: { '@': resolve('src') } },
  cacheDir: `${directory}/vite`, optimizeDeps: { entries: [entry] },
  server: { host: '127.0.0.1', port: 18557, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(60000);
  await page.goto(server.resolvedUrls.local[0] + entry);
  await page.locator('[data-canvas-node-id="old"]').waitFor({ timeout: 30000 });
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
      ['引用完整视频', '引用首帧画面', '引用尾帧画面', '引用视频音频']);
  }
  const option = name => options.getByRole('menuitem', { name, exact: true });
  await openVideoOptions('clip-node', imageReceiver);
  assert.equal(await option('引用完整视频').isDisabled(), true);
  assert.equal(await option('引用视频音频').isDisabled(), true);
  assert.match(await option('引用视频音频').getAttribute('title'), /音频|不能接收/);
  await page.keyboard.press('Escape');
  assert.equal(await options.count(), 0);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'import_image_bytes').length), 0);

  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const c = canvasWorkflowController('p'), isWriteLocked = c.isWriteLocked.bind(c);
    c.isWriteLocked = id => id === 'clip-node' || isWriteLocked(id);
    window.unlockStaticVideo = () => { c.isWriteLocked = isWriteLocked; };
  });
  await openVideoOptions('clip-node', videoReceiver);
  assert.equal(await option('引用完整视频').isEnabled(), true, 'saving a reference does not read the static file');
  for (const label of ['引用首帧画面', '引用尾帧画面', '引用视频音频']) {
    assert.equal(await option(label).isDisabled(), true);
    assert.match(await option(label).getAttribute('title'), /来源卡片正在使用/);
  }
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.unlockStaticVideo());

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
  await openVideoOptions('clip-node', videoReceiver);
  await option('引用视频音频').click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes
    .find(node => node.id === 'video-receiver').inputs.image?.some(input => input.videoAudio?.assetId === 'audio-clip'));
  await videoReceiver.locator('[data-workflow-reference-asset="audio-clip"]').waitFor();

  const evidence = await page.evaluate(async () => {
    const { workflowInputValues, workflowBindingKey } = await import('/src/lib/canvasWorkflow.ts');
    const { filterAutomaticMediaValues } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const { nodes } = JSON.parse(sessionStorage.getItem('workflow-p')).document;
    const [image, video] = nodes;
    const frames = image.inputs.image, [complete, audio] = video.inputs.image;
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
    return { frames, complete, audio, keys: new Set([complete, first, sameSourceTail, audio].map(workflowBindingKey)).size, pixels,
      imageValues: values.image.map(value => value.assetIds[0]), videoValues: workflowInputValues(nodes, video).image.flatMap(value => value.assetIds) };
  });
  assert.equal(evidence.keys, 4);
  assert.equal(evidence.complete.assetId, 'clip');
  assert.equal(evidence.complete.videoFrame, undefined);
  assert.deepEqual(evidence.videoValues, ['clip', 'audio-clip']);
  assert.equal(evidence.audio.assetId, 'clip');
  assert.equal(evidence.audio.assetNodeId, 'clip-node');
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
  const audio = evidence.audio;
  const audioWire = page.locator(`path[data-auto-connection="${audio.autoConnect}"][data-workflow-target="video-receiver"]`);
  await audioWire.waitFor({ state: 'attached' });
  await videoReceiver.locator('[data-canvas-connect-side="input"]').click({ button: 'right' });
  await disconnection.getByRole('menuitem').filter({ has: page.locator('[data-workflow-disconnect-asset="audio-clip"]') }).click();
  await audioWire.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '撤销画布操作' }).click();
  await audioWire.waitFor({ state: 'attached' });
  const cover = await page.evaluate(async () => {
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const nodes = ['a', 'b'].map((id, i) => ({ ...newWorkflowNode('comfy-video', 160 + i * 490, 100, 'codex'), id }));
    const snapshot = window.snapshot();
    const drafts = JSON.parse(sessionStorage.getItem('reference-drafts'));
    const video = drafts.find(asset => asset.id === 'clip');
    const picture = (sky, hills) => {
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 100;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, 160, 100);
      ctx.fillStyle = '#f3dcb3'; ctx.beginPath(); ctx.arc(45, 30, 15, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = hills; ctx.beginPath(); ctx.moveTo(0, 72); ctx.lineTo(47, 50); ctx.lineTo(93, 69);
      ctx.lineTo(131, 40); ctx.lineTo(160, 60); ctx.lineTo(160, 100); ctx.lineTo(0, 100); ctx.fill();
      return canvas.toDataURL();
    };
    const thumbs = [picture('#87a6b0', '#476b64'), picture('#b77e6e', '#6c484d')];
    const thumb = thumbs[0];
    const original = window.store.getState().assets.find(asset => asset.id === 'existing').store_path;
    const longNames = ['reference'.repeat(12) + '.png', '长文件名'.repeat(30) + '.png'];
    drafts.push({ ...video, id: 'covered-clip', name: '带封面的视频', thumb_path: thumb },
      { id: 'photo', name: '普通图片', ext: 'svg', source: 'external', store_path: original, thumb_path: thumb },
      ...longNames.map((name, i) => ({ id: 'long-' + i, name, ext: 'png', source: 'external', store_path: original, thumb_path: thumbs[i] })),
      { ...video, id: 'long-clip', name: '片段'.repeat(60) + '.mp4', thumb_path: thumb },
      { id: 'long-audio', name: 'recording'.repeat(12) + '.wav', ext: 'wav', source: 'external', store_path: '/recording.wav' });
    sessionStorage.setItem('reference-drafts', JSON.stringify(drafts));
    sessionStorage.setItem('reference-fixture', JSON.stringify({ ...snapshot, nodes: [], edges: [] }));
    sessionStorage.setItem('workflow-p', JSON.stringify({ revision: 0, document: { schema_version: 1, nodes, run: null } }));
    return { thumb, thumbs, original, longNames };
  });
  await page.reload();
  const workflowCard = id => page.locator(`[data-workflow-card="${id}"]`);
  async function dragVideoWire(id, end) {
    const source = workflowCard(id);
    await source.locator('header').hover();
    const port = await source.getByRole('button', { name: '添加下游', exact: true }).boundingBox();
    await page.mouse.move(port.x + port.width / 2, port.y + port.height / 2);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 18 });
    await page.mouse.up();
  }
  const targetHeader = await workflowCard('b').locator('header').boundingBox();
  await dragVideoWire('a', { x: targetHeader.x + targetHeader.width / 2, y: targetHeader.y + 10 });
  assert.ok(await option('引用完整视频').isDisabled());
  await option('引用尾帧画面').click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n => n.id === 'b').inputs['first-frame']?.length === 1);
  await page.reload();
  const frameSlot = workflowCard('b').locator('.h3-frame-group').first();
  await frameSlot.getByText('待输入', { exact: true }).waitFor();
  await frameSlot.getByText('尾帧画面', { exact: true }).waitFor();
  const input = await page.evaluate(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n => n.id === 'b').inputs['first-frame'][0]);
  assert.deepEqual(input.videoFrame, { position: 'last' });
  assert.equal(input.nodeId, 'a');
  assert.equal(input.portId, 'image');
  assert.equal(input.assetId, undefined);
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const c = canvasWorkflowController('p');
    const run = { id: 'active-video', startId: 'a', threadId: 'thread', status: 'running', order: ['a'],
      lockedNodeIds: ['a'], writeNodeIds: ['a'], steps: { a: { status: 'running' } } };
    await c.save({ ...c.document, run, runs: [run] });
  });
  await dragVideoWire('a', { x: targetHeader.x + targetHeader.width / 2, y: targetHeader.y + 10 });
  await option('引用视频音频').click();
  await workflowCard('b').getByText('视频音频 · 等待上游素材', { exact: true }).waitFor();
  await workflowCard('b').getByRole('combobox', { name: 'H3 模式' }).click();
  await page.getByRole('option', { name: /多素材参考/ }).click();
  await dragVideoWire('a', { x: targetHeader.x + targetHeader.width / 2, y: targetHeader.y + 10 });
  await option('引用完整视频').click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.find(n => n.id === 'b').inputs['reference-video']?.[0]?.nodeId === 'a');
  await dragVideoWire('a', { x: targetHeader.x + targetHeader.width / 2, y: targetHeader.y + 10 });
  await option('引用首帧画面').click();
  const referenceImages = workflowCard('b').getByRole('group', { name: '参考图片输入' });
  await referenceImages.getByText('1 / 9', { exact: true }).waitFor();
  await referenceImages.getByText('<Picture 1>', { exact: true }).waitFor();
  await referenceImages.getByText('首帧画面 · 等待上游素材', { exact: true }).waitFor();
  await dragVideoWire('a', { x: targetHeader.x + targetHeader.width / 2, y: targetHeader.y + 10 });
  await option('引用视频音频').click();
  const referenceAudios = workflowCard('b').getByRole('group', { name: '参考音频输入' });
  await referenceAudios.getByText('1 / 3', { exact: true }).waitFor();
  await referenceAudios.getByText('视频音频 · 等待上游素材', { exact: true }).waitFor();
  await dragVideoWire('a', { x: 1190, y: 450 });
  await page.getByRole('menu', { name: '添加下游', exact: true }).getByRole('menuitem', { name: '图片生成', exact: true }).click();
  await option('引用首帧画面').click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes.some(
    n => n.kind === 'generation' && n.inputs.image?.[0].nodeId === 'a' && n.inputs.image[0].videoFrame?.position === 'first'));
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const c = canvasWorkflowController('p');
    if (c.document.run?.status !== 'running') throw Error('creating readers must leave the video run active');
    await c.save({ ...c.document, run: null, runs: [] });
  });

  const setVideoOutput = assetId => page.evaluate(async assetId => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const c = canvasWorkflowController('p');
    await c.edit(c.document.nodes.map(node => node.id === 'a'
      ? { ...node, outputs: { image: { type: 'image', assetIds: [assetId] } } } : node));
  }, assetId);
  async function chooseMode(name) {
    await workflowCard('b').getByRole('combobox', { name: 'H3 模式' }).click();
    await page.getByRole('option', { name, exact: true }).click();
  }
  async function checkFrameImages(slot, thumbPath, previewPath) {
    const thumb = slot.locator('.comfy-frame-thumbnail');
    assert.equal(await thumb.getAttribute('src'), thumbPath);
    await thumb.evaluate(img => img.decode());
    await thumb.hover();
    const preview = slot.locator('.comfy-frame-preview');
    assert.equal(await preview.getAttribute('src'), previewPath);
    await preview.evaluate(img => img.decode());
    await workflowCard('b').locator('header').hover();
  }
  await setVideoOutput('covered-clip');
  await referenceImages.getByText('首帧画面 · 带封面的视频', { exact: true }).waitFor();
  await referenceImages.getByText('1 / 9', { exact: true }).waitFor();
  await referenceImages.getByText('<Picture 1>', { exact: true }).waitFor();
  await workflowCard('b').getByRole('group', { name: '参考视频输入' }).getByText('带封面的视频', { exact: true }).waitFor();
  await checkFrameImages(referenceImages, cover.thumb, cover.thumb);
  const videoCover = workflowCard('b').locator('.comfy-r2v-video-cover');
  assert.equal(await videoCover.locator('img').getAttribute('src'), cover.thumb);
  await setVideoOutput('clip');
  await referenceImages.getByText('首帧画面', { exact: true }).waitFor();
  assert.equal(await referenceImages.locator('img').count(), 0);
  await videoCover.locator('svg').waitFor();
  for (const mode of ['首尾帧', '单图']) {
    await chooseMode(mode);
    await setVideoOutput('covered-clip');
    await checkFrameImages(frameSlot, cover.thumb, cover.thumb);
    await setVideoOutput('clip');
    await frameSlot.locator('.comfy-frame-placeholder').filter({ hasText: /^尾帧画面$/ }).waitFor();
    assert.equal(await frameSlot.locator('img').count(), 0);
  }
  await page.evaluate(async () => {
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const c = canvasWorkflowController('p');
    await c.edit(c.document.nodes.map(node => node.id === 'b'
      ? { ...node, inputs: { ...node.inputs, 'first-frame': [{ assetId: 'photo' }] } } : node));
  });
  await checkFrameImages(frameSlot, cover.thumb, cover.original);
  await chooseMode('多素材参考（R2V）');
  await referenceImages.getByRole('button', { name: '断开参考图片来源 1' }).click();
  await page.evaluate(async () => (await import('/src/lib/dragPayload.ts')).setDragAssets(['long-0', 'long-1']));
  await referenceImages.dispatchEvent('drop');
  await page.evaluate(async () => (await import('/src/lib/dragPayload.ts')).setDragAssets(null));
  await referenceImages.getByText('2 / 9', { exact: true }).waitFor();
  for (const name of cover.longNames) await referenceImages.getByText(name, { exact: true }).waitFor();
  await page.evaluate(async () => {
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const c = canvasWorkflowController('p');
    const producer = { ...newWorkflowNode('generation', 2400, 0, 'codex'), id: 'photos',
      outputs: { image: { type: 'image', assetIds: ['long-0', 'long-1'] } } };
    await c.edit([...c.document.nodes.map(n => n.id === 'b' ? { ...n, inputs: {
      'reference-image': [{ nodeId: 'photos', portId: 'image' }],
      'reference-video': [{ assetId: 'long-clip' }],
      'r2v-audio': [{ assetId: 'long-audio' }, { nodeId: 'photos', portId: 'image', mediaFilter: ['audio'] }],
    } } : n), producer]);
  });
  const b = workflowCard('b');
  const audioGroup = b.getByRole('group', { name: '参考音频输入' });
  await audioGroup.getByText('1 / 3', { exact: true }).waitFor();
  await audioGroup.getByText('无匹配素材', { exact: true }).waitFor();
  const tiles = referenceImages.locator('.comfy-r2v-picture');
  for (const [i, name] of cover.longNames.entries()) {
    await tiles.nth(i).getByText(name, { exact: true }).waitFor();
    assert.equal(await tiles.nth(i).getAttribute('title'), name);
    await tiles.nth(i).getByText(`<Picture ${i + 1}>`, { exact: true }).waitFor();
    await checkFrameImages(tiles.nth(i), cover.thumbs[i], cover.original);
  }
  const layout = await b.evaluate(el => {
    const card = el.getBoundingClientRect();
    return {
      within: [...el.querySelectorAll('.comfy-video-card,.comfy-audio-input,.comfy-audio-row,.comfy-r2v-picture,.comfy-r2v-source button')].every(child => {
        const { left, right } = child.getBoundingClientRect();
        return left >= card.left && right <= card.right + 1;
      }),
      truncated: [...el.querySelectorAll('.comfy-r2v-picture > .comfy-audio-source,.comfy-r2v-source > .comfy-audio-source')].filter(
        child => child.scrollWidth > child.clientWidth && getComputedStyle(child).textOverflow === 'ellipsis').length,
    };
  });
  assert.deepEqual(layout, { within: true, truncated: 4 });
  await audioGroup.getByRole('button', { name: '断开参考音频来源 2' }).click();
  await b.screenshot({ path: `${directory}/r2v-gallery.png` });
  await tiles.first().getByRole('button', { name: '断开参考图片来源 1' }).click();
  await referenceImages.getByText('1 / 9', { exact: true }).waitFor();
  assert.equal(await tiles.count(), 1);
  await tiles.first().getByText(cover.longNames[1], { exact: true }).waitFor();
  await tiles.first().getByText('<Picture 1>', { exact: true }).waitFor();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('workflow-p')).document.nodes
    .find(n => n.id === 'b').inputs['reference-image'][0].excludedAssetIds?.includes('long-0'));
  await page.reload();
  await tiles.first().getByText(cover.longNames[1], { exact: true }).waitFor();
  assert.equal(await tiles.count(), 1);
  const submittedImages = await page.evaluate(async () => {
    const { workflowInputValues, filterDisconnectedReferences, h3RunReferences } = await import('/src/lib/canvasWorkflow.ts');
    const { nodes } = JSON.parse(sessionStorage.getItem('workflow-p')).document;
    const b = nodes.find(n => n.id === 'b');
    return h3RunReferences(filterDisconnectedReferences(b.inputs, workflowInputValues(nodes, b)), 'r2v')[0];
  });
  assert.deepEqual(submittedImages, ['long-1']);
  await page.evaluate(async () => (await import('/src/lib/dragPayload.ts')).setDragAssets(['existing', 'a', 'b', 'c', 'd', 'long-0']));
  await referenceImages.dispatchEvent('drop');
  await page.evaluate(async () => (await import('/src/lib/dragPayload.ts')).setDragAssets(null));
  await referenceImages.getByText('7 / 9', { exact: true }).waitFor();
  const lastThumb = tiles.last().locator('.comfy-frame-thumbnail');
  await lastThumb.focus();
  const enlarged = tiles.last().locator('.comfy-frame-preview');
  await enlarged.evaluate(img => img.decode());
  assert.ok(await enlarged.evaluate(img => {
    const box = img.getBoundingClientRect();
    img.style.pointerEvents = 'auto';
    const visible = document.elementFromPoint(box.x + box.width / 2, box.y + box.height * .75) === img;
    img.style.removeProperty('pointer-events');
    return visible;
  }), 'a second-row keyboard preview paints above the first-row tiles');
  await lastThumb.press('Escape');
  await enlarged.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.command === 'import_image_bytes').length), 0);
  console.log('PASS: static video boundary pixels and audio references, dynamic H3 frame and audio wires, R2V references, covered and coverless frame previews, reload, disconnect and undo');
} catch (error) { console.error(error); throw error; }
finally { await browser.close(); await server.close(); }
