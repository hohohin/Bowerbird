import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "site");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const file = resolve(root, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(root + sep)) throw new Error("Outside preview");
    const content = await readFile(file);
    response.setHeader("Content-Type", types[extname(file)] || "application/octet-stream");
    response.end(content);
  } catch {
    response.writeHead(404).end("Not found");
  }
});
server.on("error", error => { console.error(error.message); process.exitCode = 1; });
server.listen(17865, "127.0.0.1", () => console.log("Frozen preview: http://127.0.0.1:17865/?theme=light"));
