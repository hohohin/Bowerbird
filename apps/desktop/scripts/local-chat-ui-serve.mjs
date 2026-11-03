import { createServer } from 'vite';
// Deliberately separate from the user's application Vite port and Tauri process.
const port = Number(process.env.BOWERBIRD_CHAT_TEST_PORT || 17881);
const server = await createServer({ cacheDir: '.tmp/local-chat/vite', server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null } });
await server.listen();
console.log(`Local chat isolated fixture: http://127.0.0.1:${port}/scripts/fixtures/local-chat/preview.html`);
