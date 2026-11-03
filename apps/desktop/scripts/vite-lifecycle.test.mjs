import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createServer, resolveConfig } from 'vite';

const script = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));

if (process.argv[2] === '--owner') {
  // Most cases deliberately have no IPC: ownership must also work for plain node launches.
  const ipc = process.argv[3] === 'disconnect';
  const child = spawn(process.execPath, [script, '--server', process.argv[3]], { cwd: root, windowsHide: true, detached: true,
    // CI disables Vite's stdin-end shortcut; parent ownership must not depend on a terminal pipe.
    env: { ...process.env, CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
  process.send({ child: child.pid });
  child.stdout.setEncoding('utf8');
  let output = '';
  child.stdout.on('data', text => {
    output += text;
    for (const line of output.split('\n').slice(0, -1)) {
      if (line.startsWith('READY ')) process.send(JSON.parse(line.slice(6)));
    }
    output = output.slice(output.lastIndexOf('\n') + 1);
  });
  child.stderr.pipe(process.stderr);
  process.on('message', message => {
    if (message === 'exit') process.exit(0);
    if (message === 'disconnect') child.disconnect();
  });
} else if (process.argv[2] === '--server') {
  const server = await createServer({ root, logLevel: 'silent', cacheDir: '.tmp/vite-lifecycle/owner-cache',
    optimizeDeps: { noDiscovery: true, entries: [] }, server: { host: '127.0.0.1', port: 0, hmr: false },
    plugins: [{ name: 'lifecycle-test-route',
      // Keep the orphan regression focused on ownership, independent of the watcher bug.
      configResolved(config) { config.server.watch = null; },
      configureServer(instance) { instance.middlewares.use('/__lifecycle', (_req, res) => res.end('ready')); },
      closeBundle() {
        if (process.argv[3] === 'stuck-close') return new Promise(() => setInterval(() => {}, 1000));
      },
    }],
  });
  await server.listen();
  console.log('READY ' + JSON.stringify({ port: server.httpServer.address().port }));
} else {
  function alive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  }
  async function waitUntil(check, timeout = 6000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await check()) return true; await delay(100); }
    return false;
  }
  for (const scenario of ['exit', 'kill', 'disconnect', 'stuck-close']) test(`a Vite preview shuts down after ${scenario}`, { timeout: 30000 }, async () => {
    const owner = fork(script, ['--owner', scenario], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let child, port, errors = '';
    owner.stderr.on('data', text => { errors += text; });
    owner.on('message', message => { child ??= message.child; port ??= message.port; });
    try {
      assert.equal(await waitUntil(() => port, 10000), true, errors || 'preview did not start');
      const url = `http://127.0.0.1:${port}/__lifecycle`;
      assert.equal(await (await fetch(url)).text(), 'ready');
      await delay(1000);
      assert.equal(alive(child), true, 'server must stay available while the owner lives');
      if (scenario === 'disconnect') owner.send('disconnect');
      else {
        const exited = once(owner, 'exit');
        if (scenario === 'kill') owner.kill('SIGKILL'); else owner.send('exit');
        await exited;
      }
      assert.equal(await waitUntil(() => !alive(child)), true, `orphan preview ${child} still alive after owner exit`);
      await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
      if (scenario === 'disconnect') assert.equal(owner.exitCode, null, 'IPC loss closes only the server, not its owner');
    } finally {
      // Every PID below was created by this test; never enumerate or stop other Node processes.
      try {
        if (child && alive(child)) {
          try { process.kill(child, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
          if (!await waitUntil(() => !alive(child), 3000)) {
            try { process.kill(child, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
            assert.equal(await waitUntil(() => !alive(child), 3000), true, `test cleanup could not stop its own preview ${child}`);
          }
        }
      } finally {
        try {
          if (owner.exitCode === null && owner.signalCode === null) { const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited; }
        } finally { owner.stdout.destroy(); owner.stderr.destroy(); }
      }
    }
  });
  test('explicit watch:null remains disabled after project configuration merges', async () => {
    const config = await resolveConfig({ root, logLevel: 'silent', server: { watch: null } }, 'serve');
    assert.equal(config.server.watch, null);
    const server = await createServer({ root, logLevel: 'silent', cacheDir: '.tmp/vite-lifecycle/no-watch-cache',
      optimizeDeps: { noDiscovery: true, entries: [] }, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
    try {
      await server.listen();
      server.watcher.add(join(root, 'src'));
      await delay(150);
      assert.deepEqual(server.watcher.getWatched(), {}, 'disabled watcher must not reopen source watches');
    } finally { await server.close(); }
  });
  test('generated preview files are ignored while source changes are still watched', { timeout: 15000 }, async () => {
    const server = await createServer({ root, logLevel: 'silent', cacheDir: '.tmp/vite-lifecycle/watch-cache',
      optimizeDeps: { noDiscovery: true, entries: [] }, server: { host: '127.0.0.1', port: 0, hmr: false } });
    const source = join(root, 'src', `vite-lifecycle-probe-${process.pid}.ts`);
    const generated = join(root, '.tmp', 'vite-lifecycle', `generated-${process.pid}.js`);
    const changed = [];
    const written = [];
    server.watcher.on('all', (_event, file) => changed.push(file.replaceAll('\\', '/')));
    try {
      await server.listen();
      assert.equal(await waitUntil(() => Object.keys(server.watcher.getWatched()).some(dir => dir.replaceAll('\\', '/').endsWith('/src'))), true);
      await mkdir(join(root, '.tmp', 'vite-lifecycle'), { recursive: true });
      await writeFile(source, 'export const probe = 1;\n', { flag: 'wx' });
      written.push(source);
      await writeFile(generated, 'export const generated = 1;\n', { flag: 'wx' });
      written.push(generated);
      assert.equal(await waitUntil(() => changed.includes(source.replaceAll('\\', '/'))), true, 'real source change should be watched');
      await delay(300);
      assert.equal(changed.includes(generated.replaceAll('\\', '/')), false, 'build output must not feed the watcher');
      assert.equal(Object.keys(server.watcher.getWatched()).some(dir => dir.replaceAll('\\', '/').includes('/.tmp/')), false);
    } finally {
      await server.close();
      await Promise.all(written.map(file => unlink(file)));
    }
  });
  test('close before listen, close after listen, and restart release process hooks', async () => {
    const events = ['SIGINT', 'SIGTERM', 'SIGHUP', 'disconnect'];
    const hooks = () => events.map(event => process.listenerCount(event));
    const initial = hooks();
    const options = { root, logLevel: 'silent', cacheDir: '.tmp/vite-lifecycle/restart-cache',
      optimizeDeps: { noDiscovery: true, entries: [] }, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
      plugins: [{ name: 'restart-test-route', configureServer(server) {
        server.middlewares.use('/__lifecycle', (_req, res) => res.end('restarted'));
      } }] };
    const unopened = await createServer(options);
    await unopened.close();
    assert.deepEqual(hooks(), initial, 'closing before listen must release owner hooks');
    const server = await createServer(options);
    try {
      await server.listen();
      const running = hooks();
      await server.restart();
      assert.deepEqual(hooks(), running, 'restart must replace hooks, not accumulate them');
      assert.equal(server.httpServer.listening, true);
      assert.equal(await (await fetch(`http://127.0.0.1:${server.httpServer.address().port}/__lifecycle`)).text(), 'restarted');
    } finally { await server.close(); }
    assert.deepEqual(hooks(), initial, 'explicit close must release all process hooks');
  });
}
