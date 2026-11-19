import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const entry = 'scripts/fixtures/canvas-reference/preview.html';
const server = await createServer({ cacheDir: '.tmp/workflow-inline-audio/vite', optimizeDeps: { entries: [entry] },
  server: { host: '127.0.0.1', port: 17987, strictPort: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
  await page.goto(server.resolvedUrls.local[0] + entry);
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  await page.evaluate(async () => {
    const { api } = await import('/src/lib/api.ts');
    const { newWorkflowNode } = await import('/src/lib/canvasWorkflow.ts');
    const { canvasWorkflowController } = await import('/src/lib/canvasWorkflowRuntime.ts');
    const tracks = ['鼓点.wav', '潮声.wav'].map((name, i) => ({ id: 'track-' + i, name, ext: 'wav',
      store_path: '/fixture/' + name, duration: 4 }));
    const getAssets = api.getAssetsByIds;
    api.getAssetsByIds = async ids => [...await getAssets(ids), ...tracks.filter(asset => ids.includes(asset.id))];
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command !== 'audio_waveform' || !tracks.some(asset => asset.id === args.assetId)) return invoke(command, args);
      return Promise.resolve({ sourceVersion: args.assetId, duration: 4, sampleRate: 16000, channels: 1,
        framesPerPeak: 1000, totalFrames: 64000, peaks: Array.from({ length: 64 }, (_, i) => {
          const amplitude = (i < 32) === (args.assetId === 'track-0') ? .9 : .08;
          return [-amplitude, amplitude];
        }) });
    };
    window.plays = 0;
    HTMLMediaElement.prototype.play = async () => { window.plays++; };
    const controller = canvasWorkflowController('p');
    const inputs = { image: tracks.map(asset => ({ assetId: asset.id })) };
    const { DEFAULT_VIDEO_OPTIONS } = await import('/src/lib/videoGeneration.ts');
    window.store.setState({ dreaminaHealth: { ok: true }, codexHealth: { ok: true },
      cloudEntitlement: { policy: { can_use_byo: true }, balances: { daily: 100, sub: 0, topup: 0 } } });
    await controller.edit(['generation', 'agent'].map((kind, i) => ({ ...newWorkflowNode(kind, 350 + i * 420, 80, 'codex'),
      ...(kind === 'generation' ? { generation: { media: 'video', videoChannel: 'jimeng', videoOptions: DEFAULT_VIDEO_OPTIONS } }
        : { skill: 'hyperframes', agentTransport: 'codex-cli' }),
      id: kind, prompt: '海边的声音', inputs })));
  });
  for (const id of ['generation', 'agent']) {
    const card = page.locator('[data-workflow-card="' + id + '"]');
    const strip = card.locator('.workflow-preview');
    for (const [name, leftIsLouder] of [['鼓点.wav', true], ['潮声.wav', false]]) {
      const canvas = strip.getByRole('img', { name: '音频：' + name }).locator('canvas');
      await canvas.waitFor();
      assert.ok((await strip.innerText()).includes(name), 'visible filename ' + name);
      const painted = await canvas.evaluate(el => {
        const { width, height } = el;
        const pixels = el.getContext('2d').getImageData(0, 0, width, height).data;
        const halves = [0, 0];
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          if (pixels[(y * width + x) * 4 + 3]) halves[Number(x >= width / 2)]++;
        }
        return halves;
      });
      assert.ok(painted[Number(!leftIsLouder)] > 2 * painted[Number(leftIsLouder)], id + ' shows ' + name + ' peaks: ' + painted);
    }
    await mkdir('.tmp/workflow-inline-audio', { recursive: true });
    await card.screenshot({ path: '.tmp/workflow-inline-audio/' + id + '.png' });
  }
  const tracks = page.locator('[data-workflow-card="generation"] [data-workflow-reference-asset]');
  const [first, second] = await Promise.all([tracks.nth(0).boundingBox(), tracks.nth(1).boundingBox()]);
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-workflow-card="generation"] [data-workflow-reference-asset]')?.dataset.workflowReferenceAsset === 'track-1');
  assert.equal(await page.evaluate(() => window.plays), 0);
  console.log('PASS inline generation and Agent waveform pixels match both tracks, filenames visible, drag reorders without playback');
} finally { await browser.close(); await server.close(); }
