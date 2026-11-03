import { createServer } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { viteLifecycle } from '../../vite-lifecycle.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const server = await createServer({ configFile: false, root, cacheDir: resolve(root, '.tmp/canvas-drag-hud-preview/live-vite'),
  plugins: [viteLifecycle()],
  css: { postcss: { plugins: [] } }, esbuild: { jsx: 'automatic' },
  optimizeDeps: { entries: ['scripts/fixtures/canvas-drag-hud/preview.html'], include: ['react', 'react-dom/client', 'react/jsx-runtime'] },
  server: { host: '127.0.0.1', port: Number(process.env.CANVAS_DRAG_HUD_PREVIEW_PORT || 17943), strictPort: true, hmr: false, watch: null },
});
await server.listen();
console.log(`${server.resolvedUrls.local[0]}scripts/fixtures/canvas-drag-hud/preview.html`);
