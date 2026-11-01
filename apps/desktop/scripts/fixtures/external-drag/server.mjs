import { createServer } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const server = await createServer({ configFile: false, root, cacheDir: resolve(root, '.tmp/external-drag-preview/live-vite'),
  css: { postcss: { plugins: [] } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: { entries: ['scripts/fixtures/external-drag/preview.html'], include: ['react', 'react-dom/client', 'react/jsx-runtime'] },
  server: { host: '127.0.0.1', port: Number(process.env.EXTERNAL_DRAG_PREVIEW_PORT || 17892), strictPort: true },
});
await server.listen();
console.log(`${server.resolvedUrls.local[0]}scripts/fixtures/external-drag/preview.html`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); process.exit(0); });
