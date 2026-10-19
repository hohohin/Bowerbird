import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';

const directory = '.tmp/video-frame-placement';
await mkdir(directory, { recursive: true });
execFileSync(process.env.BOWERBIRD_FFMPEG_BINARY || resolve('../../.tmp/video-integration/tools/local/ffmpeg.exe'),
  ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=teal:s=320x180:r=25:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${directory}/clip.mp4`]);
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: `${directory}/vite`,
  server: { host: '127.0.0.1', port: 1669, strictPort: true, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
try {
  await page.goto('http://127.0.0.1:1669/scripts/fixtures/canvas-reference/preview.html?source-library');
  await page.locator('[data-canvas-node-id="old"]').waitFor();
  for (const mode of ['card', 'session', 'library']) {
    await page.evaluate(mode => {
      const snapshot = window.snapshot(), base = snapshot.nodes[0];
      const clip = { ...base, kind: 'asset', role: 'reference', id: 'clip', assetId: 'clip', x: 3000, y: -1000, width: 320, height: 180,
        payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: '视频', width: 320, height: 180 } }) };
      const obstacle = { ...clip, id: 'obstacle', assetId: 'existing', x: 3352, width: 320 };
      snapshot.nodes = mode === 'library' ? [{ ...obstacle, x: 2800, y: -1200, width: 1600, height: 1400 }] : [clip, obstacle];
      snapshot.edges = [];
      if (mode === 'session') {
        snapshot.nodes[0] = { ...clip, x: 20000, y: 20000, role: 'output',
          payloadJson: JSON.stringify({ schema_version: 1, snapshot: { name: '视频', width: 320, height: 180 }, execution: { job_id: 'job', turn_key: 'one' } }) };
        snapshot.nodes.push({ ...clip, kind: 'prompt', id: 'session', assetId: null, role: null,
          payloadJson: JSON.stringify({ schema_version: 1, job_id: 'job', turn_key: 'one', text: '视频会话', status: 'done' }) });
        snapshot.edges = [{ id: 'edge', projectId: 'p', threadId: 't', fromNodeId: 'session', toNodeId: 'clip', kind: 'produced', ordinal: 0, createdAt: 1 }];
      }
      snapshot.view = { ...snapshot.view, zoom: 0.7, panX: -1800, panY: 850 };
      sessionStorage.setItem('reference-fixture', JSON.stringify(snapshot));
      sessionStorage.setItem('reference-drafts', JSON.stringify([{ id: 'clip', name: '视频', ext: 'mp4', width: 320, height: 180, duration: 1,
        store_path: '/.tmp/video-frame-placement/clip.mp4', source: 'imported' }]));
    }, mode);
    await page.reload();
    await page.locator('[data-canvas-node-id="obstacle"]').waitFor();
    if (mode === 'library') {
      await page.getByRole('button', { name: '展开画板素材库', exact: true }).click();
      await page.getByRole('tab', { name: '项目素材', exact: true }).click();
      await page.locator('.canvas-source-panel [data-asset-id="clip"]').click();
    } else if (mode === 'session') {
      await page.locator('[data-canvas-node-id="session"] .canvas-conversation-images').click();
    } else {
      await page.locator('[data-canvas-node-id="clip"]').focus(); await page.keyboard.press('Enter');
    }
    await page.waitForFunction(() => document.querySelector('.video-player video')?.readyState >= 2);
    const expected = await page.evaluate(mode => {
      const stage = document.querySelector('[data-canvas-stage]'), bounds = stage.getBoundingClientRect();
      const matrix = new DOMMatrix(getComputedStyle(document.querySelector('.canvas-plane')).transform);
      const point = (x, y) => ({ x: (x - bounds.left - matrix.e) / matrix.a, y: (y - bounds.top - matrix.f) / matrix.a });
      const composer = stage.parentElement.querySelector('.canvas-composer-host')?.getBoundingClientRect();
      const bottom = composer?.height > 0 ? Math.min(bounds.bottom, composer.top) : bounds.bottom;
      const rect = document.querySelector(`[data-canvas-node-id="${mode === 'session' ? 'session' : 'clip'}"]`)?.getBoundingClientRect();
      return { center: point(bounds.left + bounds.width / 2, (bounds.top + bottom) / 2),
        source: rect && { ...point(rect.left, rect.top), width: rect.width / matrix.a, height: rect.height / matrix.a } };
    }, mode);
    await page.getByRole('button', { name: '添加该帧到画板', exact: true }).click();
    await page.getByRole('button', { name: '已添加到画板', exact: true }).waitFor();
    const frame = await page.evaluate(() => window.snapshot().nodes.find(node => node.assetId?.startsWith('frame-')));
    assert.ok(frame, mode);
    if (mode === 'library') {
      assert.ok(Math.abs(frame.x + frame.width / 2 - expected.center.x) < 1, JSON.stringify({ frame, expected }));
      assert.ok(Math.abs(frame.y + frame.height / 2 - expected.center.y) < 1, JSON.stringify({ frame, expected }));
    } else {
      const source = expected.source;
      assert.ok(Math.hypot(frame.x - source.x, frame.y - source.y) < 900, JSON.stringify({ frame, source }));
      const obstacle = (await page.evaluate(() => window.snapshot())).nodes.find(node => node.id === 'obstacle');
      for (const other of [source, obstacle]) assert.ok(!(frame.x < other.x + other.width && frame.x + frame.width > other.x
        && frame.y < other.y + other.height && frame.y + frame.height > other.y), `overlap: ${mode}`);
    }
    await page.keyboard.press('Escape');
  }
  console.log('PASS nearby collision placement, visible folded-session anchor, library-only visual center with pan/zoom');
} catch (error) {
  await page.screenshot({ path: `${directory}/failure.png` });
  console.log(await page.evaluate(() => ({ nodes: window.snapshot().nodes, visible: [...document.querySelectorAll('[data-canvas-node-id]')].map(el => ({ id: el.dataset.canvasNodeId, text: el.textContent.slice(0, 150) })) })));
  throw error;
} finally { await browser.close(); await server.close(); }
