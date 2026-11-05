import { createReadStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';

// Excalidraw expects runtime font URLs, which Vite cannot discover from its JS.
export function textEditorAssets() {
  const root = join(dirname(fileURLToPath(import.meta.resolve('@excalidraw/excalidraw'))), 'fonts');
  const prefix = '/text-editor-assets/fonts/';
  return {
    name: 'text-editor-local-fonts',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith(prefix)) return next();
        let path;
        try { path = resolve(root, decodeURIComponent(request.url.slice(prefix.length).split('?')[0])); }
        catch { response.statusCode = 400; response.end(); return; }
        if (!path.startsWith(root + sep)) { response.statusCode = 404; response.end(); return; }
        response.setHeader('Content-Type', path.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');
        const stream = createReadStream(path);
        stream.on('error', () => { response.statusCode = 404; response.end(); }); stream.pipe(response);
      });
    },
    async generateBundle() {
      const files = await readdir(root, { recursive: true, withFileTypes: true });
      for (const file of files) if (file.isFile()) {
        const path = join(file.parentPath, file.name);
        this.emitFile({ type: 'asset', fileName: `text-editor-assets/fonts/${relative(root, path).split(sep).join('/')}`, source: await readFile(path) });
      }
    },
  };
}
