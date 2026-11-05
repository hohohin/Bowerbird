// Real local Studio in the production panel; native WebView IPC is a geometry/lifecycle fixture.
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
const cli = process.env.BOWERBIRD_HYPERFRAMES_CLI;
assert(cli, 'Set BOWERBIRD_HYPERFRAMES_CLI to the isolated pinned runtime');
const root = resolve('.tmp/video-studio');
const project = resolve(root, 'project');
await mkdir(root, { recursive: true });
await cp(resolve('.tmp/video-skill-render/project'), project, { recursive: true, filter: source => !source.includes('.hyperframes') });
const child = spawn(process.execPath, [cli, 'preview', '--foreground', '--no-open', '--force-new', '--port', '1688'], {
  cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', HYPERFRAMES_CACHE_DIR: resolve(root, 'cache'),
    HYPERFRAMES_FFMPEG_PATH: process.env.BOWERBIRD_FFMPEG_BINARY, HYPERFRAMES_FFPROBE_PATH: process.env.BOWERBIRD_FFPROBE_BINARY },
});
let logs = ''; child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
let server, browser;
try {
  for (let i = 0; i < 120; i++) {
    const config = await fetch('http://127.0.0.1:1688/__hyperframes_config').then(response => response.json()).catch(() => null);
    if (config?.pid === child.pid) break;
    assert(child.exitCode === null && i < 119, logs);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  server = await createServer({ configFile: false, cacheDir: '.tmp/video-studio-vite', root: process.cwd(), server: { host: '127.0.0.1', port: 1689, strictPort: true, hmr: false, watch: null } });
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const issues = [];
  page.on('pageerror', error => issues.push(error.message));
  page.on('response', response => { if (response.status() >= 400) issues.push(`${response.status()} ${response.url()}`); });
  await page.goto('http://127.0.0.1:1689/scripts/fixtures/video-studio/preview.html?studio=http://127.0.0.1:1688');
  const studio = page.frameLocator('iframe[title="HyperFrames Studio"]');
  await studio.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 30000 });
  await studio.getByText('scene', { exact: true }).first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: resolve(root, 'studio-selection.png') });
  await writeFile(resolve(root, 'studio-diagnostic.txt'), `${issues.join('\n')}\n${await studio.locator('body').innerText()}`);
  await studio.getByText('Tile', { exact: true }).first().waitFor({ timeout: 10000 });
  await studio.getByText('Tile', { exact: true }).first().click();
  const fontSize = studio.locator('input[title="Scroll or use Arrow keys to adjust"]').first();
  await fontSize.fill('20px'); await fontSize.press('Enter');
  let saved = '';
  for (let attempt = 0; attempt < 60; attempt++) {
    saved = await readFile(resolve(project, 'compositions/scene.html'), 'utf8');
    if (/font-size:\s*20px/.test(saved)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(saved, /font-size:\s*20px/, 'Studio manual edit persists in the shared composition');
  await page.screenshot({ path: resolve(root, 'studio-dark.png') });
  const calls = await page.evaluate(() => window.studioCalls);
  assert(calls.some(call => call[0] === 'open' && call[1] === 'studio-fixture' && call[3].width > 1000));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(() => window.studioCalls.some(call => call[0] === 'resize' && call[3].width < 1280));
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.waitForFunction(() => window.studioCalls.some(call => call[0] === 'close'));
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByRole('button', { name: '打开视频工程', exact: true }).click();
  await page.waitForFunction(() => window.studioCalls.filter(call => call[0] === 'open').length === 2);
  const reopened = await page.evaluate(() => window.studioCalls);
  const tokens = reopened.filter(call => call[0] === 'open').map(call => call[2]);
  assert.notEqual(tokens[0], tokens[1], 'reopening has a new panel identity');
  assert(reopened.filter(call => call[0] === 'close').every(call => call[2] === tokens[0]), 'old cleanup keeps its original identity');
  await page.goto('http://127.0.0.1:1689/scripts/fixtures/video-studio/preview.html?failure=1');
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').textContent(), /视频编辑器/);
  assert((await readFile(resolve(project, 'index.html'), 'utf8')).includes('data-composition-id'));
  console.log('PASS Studio timeline, saved manual edit, independent panel geometry/close and startup error');
} finally {
  await browser?.close(); await server?.close();
  if (child.exitCode === null && process.platform === 'win32') {
    const stop = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await new Promise(resolve => stop.once('exit', resolve));
  } else child.kill();
}
