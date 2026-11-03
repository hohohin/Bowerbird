import { createServer } from 'vite';
const server = await createServer({
  cacheDir: '.tmp/text-workspace-review-vite',
  server: { host: '127.0.0.1', port: 1456, strictPort: true, hmr: false, watch: null },
});
await server.listen();
console.log('http://127.0.0.1:1456/scripts/fixtures/text-workspace-review/preview.html');
