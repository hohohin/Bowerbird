import assert from "node:assert/strict";
import { once } from "node:events";
import { startServer } from "../server.mjs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

delete process.env.BOWERBIRD_WINDOWS_UPDATE_MANIFEST_URL;
const root = await mkdtemp(join(tmpdir(), "bowerbird-updater-test-"));
await mkdir(join(root, "downloads/updates"), { recursive: true });
await writeFile(join(root, "downloads/updates/windows-x86_64.json"), '{"version":"26.9.18"}');
const server = startServer({ root, host: "127.0.0.1", port: 0 });
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
try {
  let response = await fetch(`${base}/api/desktop-update/windows-x86_64`, { redirect: "manual" });
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("location"), "https://bowerbird.cn/downloads/updates/windows-x86_64.json");
  process.env.BOWERBIRD_WINDOWS_UPDATE_MANIFEST_URL = "https://example.com/release.json";
  response = await fetch(`${base}/api/desktop-update/windows-x86_64`, { redirect: "manual" });
  assert.equal(response.headers.get("location"), "https://example.com/release.json");
  process.env.BOWERBIRD_WINDOWS_UPDATE_MANIFEST_URL = "http://example.com/insecure.json";
  response = await fetch(`${base}/api/desktop-update/windows-x86_64`, { redirect: "manual" });
  assert.equal(response.headers.get("location"), "https://bowerbird.cn/downloads/updates/windows-x86_64.json");
  assert.equal((await fetch(`${base}/api/desktop-update/darwin-aarch64`)).status, 204);
  assert.equal((await fetch(`${base}/healthz`)).status, 204);
  response = await fetch(`${base}/downloads/updates/windows-x86_64.json`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).version, "26.9.18");
  console.log("PASS updater endpoint: signed channel, HTTPS, no cache, unsupported platform, website health");
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true });
}
