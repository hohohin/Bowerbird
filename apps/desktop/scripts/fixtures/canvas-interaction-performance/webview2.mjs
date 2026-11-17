import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { chromium } from '../../../../html-renderer/node_modules/playwright/index.mjs';

// Reuse the debug-only, hidden WebView2 host. It has no desktop setup or database commands.
export async function openWebView(origin) {
  const base = path.resolve('.tmp/audio-preview-native');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'canvas-'));
  for (const dir of ['appdata', 'localappdata', 'fixtures']) await mkdir(path.join(root, dir));
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const url = new URL('scripts/fixtures/canvas-interaction-performance/preview.html', origin).href;
  const child = spawn(path.resolve('src-tauri/target/debug/examples/audio_preview_smoke.exe'), [], { windowsHide: true, stdio: ['ignore','ignore','pipe'], env: {
    ...process.env, APPDATA: path.join(root,'appdata'), LOCALAPPDATA: path.join(root,'localappdata'),
    BOWERBIRD_AUDIO_TEST_ROOT: root, BOWERBIRD_AUDIO_TEST_FIXTURES: path.join(root,'fixtures'), BOWERBIRD_AUDIO_TEST_URL: url, BOWERBIRD_AUDIO_TEST_SOURCES: '{}',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  } });
  let error, stderr = '', browser;
  const closed = new Promise(resolve => child.once('close', resolve));
  async function close() {
    try { await browser?.close(); } finally {
      child.kill(); await closed;
      // Only this invocation's mkdtemp directory may be removed.
      if (path.dirname(path.resolve(root)) !== base || !path.basename(root).startsWith('canvas-')) throw new Error('Invalid fixture profile');
      await rm(root, { recursive:true, force:true, maxRetries:5, retryDelay:150 });
    }
  }
  child.on('error', cause => { error = cause; });
  child.stderr.on('data', data => { stderr += data; });
  try {
    for (let i = 0; i < 100; i++) {
      if (error || child.exitCode !== null) throw error ?? new Error(stderr || 'Native host exited');
      try { browser ??= await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 800 }); } catch { /* starting */ }
      const page = browser?.contexts()[0]?.pages().find(page => page.url().startsWith(origin));
      if (page) return { browser, page, close };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Isolated WebView2 did not open the fixture: ' + stderr);
  } catch (cause) { await close(); throw cause; }
}
