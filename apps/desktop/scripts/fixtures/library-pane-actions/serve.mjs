import { createServer } from 'vite';
const server = await createServer({ server: { host: '127.0.0.1', port: 17934, strictPort: true, hmr: false }, cacheDir: '.tmp/library-pane-actions-preview-vite' });
await server.listen();
console.log('Preview: http://127.0.0.1:17934/scripts/fixtures/library-pane-actions/preview.html');
