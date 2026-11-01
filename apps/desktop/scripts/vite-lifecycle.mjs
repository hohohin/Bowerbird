// Preview/dev servers belong to the process that launched them, not to a browser tab.
function closeWithOwner(server) {
  const ownerPid = process.ppid;
  let stopping = false;
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const dispose = () => {
    clearInterval(timer);
    for (const signal of signals) process.off(signal, stop);
    process.off('disconnect', stop);
    server.httpServer?.off('close', dispose);
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    dispose();
    // A stuck request or plugin must not keep an orphan alive indefinitely.
    const deadline = setTimeout(() => process.exit(1), 3000).unref();
    void Promise.resolve().then(() => server.close()).then(() => {
      clearTimeout(deadline);
      process.exit(0);
    }, () => process.exit(1));
  };
  const timer = setInterval(() => {
    if (process.ppid !== ownerPid) { stop(); return; }
    try { process.kill(ownerPid, 0); }
    catch (error) { if (error.code === 'ESRCH') stop(); }
  }, 1000).unref();
  for (const signal of signals) process.once(signal, stop);
  process.once('disconnect', stop);
  // Explicit close/restart releases ownership hooks without exiting the caller.
  const close = server.close.bind(server);
  server.close = (...args) => { dispose(); return close(...args); };
  server.httpServer?.once('close', dispose);
}

export function viteLifecycle() {
  return {
    name: 'bowerbird-vite-lifecycle',
    apply: 'serve',
    configResolved(config) {
      // Vite 5's mergeConfig skips null, retaining watch options from vite.config.ts.
      if (config.inlineConfig.server?.watch === null) config.server.watch = null;
    },
    configureServer: closeWithOwner,
    configurePreviewServer: closeWithOwner,
  };
}
