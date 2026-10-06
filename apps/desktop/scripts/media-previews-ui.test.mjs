import { createServer } from 'vite';
import { chromium } from '../../html-renderer/node_modules/playwright/index.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const server = await createServer({ cacheDir: '.tmp/media-previews-vite', server: { host: '127.0.0.1', port: 1599, strictPort: true, hmr: false, watch: null } });
await server.listen();
let browser;
let nativeDirectory;
try {
  if (process.argv.includes('--native')) {
    if (process.platform !== 'darwin') throw new Error('Native smoke requires macOS');
    nativeDirectory = await mkdtemp(join(tmpdir(), 'bowerbird-media-smoke-'));
    const binary = join(nativeDirectory, 'media-smoke');
    const run = promisify(execFile);
    await run('swiftc', [fileURLToPath(new URL('../../../macOS/media-preview-smoke.swift', import.meta.url)),
      '-module-cache-path', join(nativeDirectory, 'module-cache'), '-o', binary], { timeout: 120000 });
    const running = run(binary, ['http://127.0.0.1:1599/scripts/fixtures/media-previews/preview.html?native'], { timeout: 160000 });
    running.child.stdout.on('data', chunk => process.stdout.write(chunk));
    await running;
  } else {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:1599/scripts/fixtures/media-previews/preview.html');
  await page.waitForFunction(() => typeof window.runMediaPreviewSmoke === 'function');
  console.log(await page.evaluate(() => window.runMediaPreviewSmoke()));
  }
} finally {
  await browser?.close(); await server.close();
  if (nativeDirectory) await rm(nativeDirectory, { recursive: true, force: true });
}
