import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ root, cacheDir: '.tmp/library-connections-vite', optimizeDeps: { entries: ['scripts/fixtures/library-connections/preview.html'] }, server: { host: '127.0.0.1', port: 17871, strictPort: true, hmr: false, watch: null } });
await server.listen();
console.log('Connection study: http://127.0.0.1:17871/scripts/fixtures/library-connections/preview.html');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0); });
