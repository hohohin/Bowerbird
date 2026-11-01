import { createServer } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const server = await createServer({ configFile: false, root, cacheDir: resolve(root, '.tmp/canvas-drag-out-preview/live-vite'),
  css: { postcss: { plugins: [] } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: { entries: ['scripts/fixtures/canvas-drag-out/preview.html'], include: ['react', 'react-dom/client', 'react/jsx-runtime'] },
  server: { host: '127.0.0.1', port: Number(process.env.CANVAS_DRAG_OUT_PREVIEW_PORT || 17903), strictPort: true },
});
await server.listen();
console.log(`${server.resolvedUrls.local[0]}scripts/fixtures/canvas-drag-out/preview.html`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); process.exit(0); });
