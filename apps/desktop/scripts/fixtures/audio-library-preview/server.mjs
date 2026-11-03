import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer as createHttpServer } from 'node:http';

const desktopRoot = fileURLToPath(new URL('../../../', import.meta.url));
const defaultFixtures = resolve(desktopRoot, '../../.tmp/audio-preview-fixtures');
const mimeTypes = { '.json': 'application/json; charset=utf-8', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.aiff': 'audio/aiff',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function inside(root, path) {
  const remainder = relative(root, path);
  return remainder && remainder !== '..' && !remainder.startsWith(`..\\`) && !remainder.startsWith('../') && !isAbsolute(remainder);
}

function byteRange(header, size) {
  if (!header) return [0, size - 1];
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < size ? [start, end] : null;
}

async function serveMedia(root, request, response) {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    const pathname = decodeURIComponent(request.url.split('?')[0]).replace(/^[/\\]+/, '');
    const target = resolve(root, pathname);
    if (!inside(root, target)) { response.writeHead(403).end(); return; }
    const physical = await realpath(target);
    if (!inside(root, physical)) { response.writeHead(403).end(); return; }
    const file = await stat(physical);
    if (!file.isFile()) { response.writeHead(404).end(); return; }
    const range = byteRange(request.headers.range, file.size);
    if (!range) { response.writeHead(416, { 'Content-Range': `bytes */${file.size}` }).end(); return; }
    const [start, end] = range;
    const headers = { 'Content-Type': mimeTypes[extname(physical).toLowerCase()] || 'application/octet-stream',
      'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
    if (request.headers.range) headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
    response.writeHead(request.headers.range ? 206 : 200, headers);
    if (request.method === 'HEAD') { response.end(); return; }
    const stream = createReadStream(physical, { start, end });
    response.on('close', () => stream.destroy());
    stream.on('error', () => response.destroy()); stream.pipe(response);
  } catch (error) { response.writeHead(error instanceof URIError ? 400 : 404).end(); }
}

export async function createPreviewServer({ port = 17879, fixturesDir = process.env.AUDIO_FIXTURES_DIR || defaultFixtures } = {}) {
  const root = await realpath(fixturesDir);
  const fixtureRoot = await realpath(fileURLToPath(new URL('./', import.meta.url)));
  const componentRoot = await realpath(resolve(desktopRoot, 'src/components'));
  // This study is native ESM + plain CSS: no bundler, HMR, Tailwind discovery,
  // application entry, broad source server, or transformation cache is needed.
  const httpServer = createHttpServer((request, response) => {
    const pathname = request.url.split('?')[0];
    if (pathname.startsWith('/audio-fixtures/')) {
      request.url = request.url.slice('/audio-fixtures'.length); void serveMedia(root, request, response);
    } else if (pathname.startsWith('/scripts/fixtures/audio-library-preview/')) {
      request.url = request.url.slice('/scripts/fixtures/audio-library-preview'.length); void serveMedia(fixtureRoot, request, response);
    } else if (pathname === '/src/components/LibraryTactical.css' || pathname === '/src/components/IndustrialTheme.css') {
      request.url = pathname.slice('/src/components'.length); void serveMedia(componentRoot, request, response);
    } else { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(port, '127.0.0.1', resolve); });
  const actualPort = httpServer.address().port;
  return { server: httpServer, httpServer, url: `http://127.0.0.1:${actualPort}/scripts/fixtures/audio-library-preview/preview.html`,
    close: () => new Promise(resolve => httpServer.close(resolve)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const preview = await createPreviewServer();
  console.log(preview.url);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await preview.close(); process.exit(0); });
}
