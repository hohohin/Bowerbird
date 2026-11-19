import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const files = new Map([
  ['/', [resolve(here, 'index.html'), 'text/html; charset=utf-8']],
  ...['style.css', 'app.mjs', 'model.mjs'].map(name => [`/${name}`, [resolve(here, name), name.endsWith('css') ? 'text/css' : 'text/javascript']]),
  ['/audio/reference.wav', [resolve(root, '.tmp/voxcpm-local/user-reference/reference.wav'), 'audio/wav']],
  ['/audio/clone.wav', [resolve(root, '.tmp/voxcpm-local/user-clone-output/01-clone.wav'), 'audio/wav']],
]);
export function createPreview() { return http.createServer(async (req, res) => {
  const item = files.get(new URL(req.url, 'http://localhost').pathname);
  if (!item || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404).end(); return; }
  try {
    const info = await stat(item[0]); let start = 0, end = info.size - 1, status = 200;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) { start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), end) : end; status = 206; }
    if (start > end) { res.writeHead(416).end(); return; }
    res.writeHead(status, { 'Content-Type': item[1], 'Content-Length': end - start + 1, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}) });
    res.end(req.method === 'HEAD' ? undefined : (await readFile(item[0])).subarray(start, end + 1));
  } catch { res.writeHead(404).end(); }
}); }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createPreview().listen(18026, '127.0.0.1', () => console.log('Local: http://127.0.0.1:18026'));
}
