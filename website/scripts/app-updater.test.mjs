import assert from "node:assert/strict";
import { once } from "node:events";
import { startServer } from "../server.mjs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

delete process.env.BOWERBIRD_WINDOWS_UPDATE_MANIFEST_URL;
delete process.env.BOWERBIRD_DARWIN_AARCH64_UPDATE_MANIFEST_URL;
delete process.env.BOWERBIRD_DARWIN_X86_64_UPDATE_MANIFEST_URL;
const root = await mkdtemp(join(tmpdir(), "bowerbird-updater-test-"));
await mkdir(join(root, "downloads/updates"), { recursive: true });
await writeFile(join(root, "downloads/updates/windows-x86_64.json"), '{"version":"26.9.18"}');
const server = startServer({ root, host: "127.0.0.1", port: 0 });
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
const channelUrl = (target) =>
  fetch(`${base}/api/desktop-update/${target}`, { redirect: "manual" });
try {
  let response = await channelUrl("windows-x86_64");
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("location"), "https://bowerbird.cn/downloads/updates/windows-x86_64.json");
  process.env.BOWERBIRD_WINDOWS_UPDATE_MANIFEST_URL = "https://example.com/release.json";
  response = await channelUrl("windows-x86_64");
  assert.equal(response.headers.get("location"), "https://example.com/release.json");
  process.env.BOWERBIRD_WINDOWS_UPDATE_MANIFEST_URL = "http://example.com/insecure.json";
  response = await channelUrl("windows-x86_64");
  assert.equal(response.headers.get("location"), "https://bowerbird.cn/downloads/updates/windows-x86_64.json");
  for (const target of ["windows-x86_64", "darwin-aarch64", "darwin-x86_64"]) {
    for (const method of ["GET", "HEAD"]) {
      response = await fetch(`${base}/api/desktop-update/${target}`, { method, redirect: "manual" });
      assert.equal(response.status, 307);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("location"), `https://bowerbird.cn/downloads/updates/${target}.json`);
      assert.equal(await response.text(), "");
    }
  }
  process.env.BOWERBIRD_DARWIN_AARCH64_UPDATE_MANIFEST_URL = "https://example.com/mac.json";
  response = await channelUrl("darwin-aarch64");
  assert.equal(response.headers.get("location"), "https://example.com/mac.json");
  delete process.env.BOWERBIRD_DARWIN_AARCH64_UPDATE_MANIFEST_URL;
  response = await channelUrl("darwin-aarch64");
  assert.equal(response.headers.get("location"), "https://bowerbird.cn/downloads/updates/darwin-aarch64.json");
  assert.equal((await channelUrl("linux-x86_64")).status, 204);
  assert.equal((await fetch(`${base}/api/desktop-update/linux-x86_64`, { method: "HEAD" })).status, 204);
  assert.equal((await fetch(`${base}/healthz`)).status, 204);
  response = await fetch(`${base}/downloads/updates/windows-x86_64.json`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).version, "26.9.18");
  console.log("PASS updater endpoint: signed channels, HTTPS, no cache, unsupported platform, website health");
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true });
}
