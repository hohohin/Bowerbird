import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

assert.equal(process.platform, "darwin", "native WKWebView test requires macOS");
const root = await mkdtemp(join(tmpdir(), "bb-wk-test-"));
const imagePath = resolve("src-tauri/icons/32x32.png");
const image = await readFile(imagePath);
let authenticated = 0;
const server = createServer((request, response) => {
  if (request.url === "/page") {
    response.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "bb_fixture=ok; HttpOnly; SameSite=Lax; Path=/" });
    return response.end("<input value='keep'><script>window.marker='unchanged'</script>");
  }
  if (!request.headers.cookie?.includes("bb_fixture=ok")) { response.writeHead(401); return response.end(); }
  authenticated++;
  if (request.url === "/disconnect") return request.socket.destroy();
  if (request.url === "/redirect") { response.writeHead(302, { Location: "/image" }); return response.end(); }
  if (request.url === "/unauthorized") { response.writeHead(401); return response.end("login"); }
  if (request.url === "/html") { response.writeHead(200, { "Content-Type": "text/html" }); return response.end("<html>login</html>"); }
  if (request.url === "/oversize") { response.writeHead(200, { "Content-Type": "image/png", "Content-Length": 51 * 1024 * 1024 }); response.write(image); return; }
  response.writeHead(200, { "Content-Type": "image/png" });
  if (request.url === "/slow") { response.flushHeaders(); return; }
  if (request.url === "/large-chunked") {
    const chunk = Buffer.alloc(1024 * 1024);
    let count = 0;
    const timer = setInterval(() => { if (++count > 51) { clearInterval(timer); response.end(); } else response.write(chunk); }, 20);
    response.on("close", () => clearInterval(timer));
    return;
  }
  if (request.url === "/chunked") { response.write(image.subarray(0, 16)); return setTimeout(() => response.end(image.subarray(16)), 30); }
  response.end(image);
});
// Different port => cross-origin image with no CORS headers, sharing the browser's HttpOnly cookie.
const images = createServer((request, response) => server.emit("request", request, response));
async function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  const [code, signal] = await once(child, "exit");
  assert.equal(code, 0, `${command} failed: ${code ?? signal}`);
}
try {
  server.listen(0, "127.0.0.1"); images.listen(0, "127.0.0.1");
  await Promise.all([once(server, "listening"), once(images, "listening")]);
  const binary = join(root, "capture-test");
  await run("clang", ["-fobjc-arc", "-fblocks", "-framework", "Cocoa", "-framework", "WebKit", "src-tauri/macos/browser_capture.m", "src-tauri/macos/browser_capture_test.m", "-o", binary]);
  await run(binary, [`http://127.0.0.1:${server.address().port}`, `http://127.0.0.1:${images.address().port}`, imagePath], { env: { ...process.env, TMPDIR: root } });
  assert.ok(authenticated >= 9);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith("bowerbird-browser-")), [], "temporary captures must be removed");
  console.log("PASS native WKWebView: HttpOnly cookie, cross-origin bytes, redirects, chunked data, HTTP/HTML/size/network/timeout errors, cleanup");
} finally {
  server.closeAllConnections(); images.closeAllConnections(); server.close(); images.close();
  await rm(root, { recursive: true, force: true });
}
