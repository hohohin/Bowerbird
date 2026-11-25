import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "../../html-renderer/node_modules/playwright/index.mjs";

// Run from apps/desktop with the same isolated executable and Chromium as extension-pair-native.test.mjs.
const workspace = resolve("../..");
const artifacts = resolve(".tmp/video-extension-native");
const nativeFixture = resolve("src-tauri/target/debug/examples", process.platform === "win32" ? "collect_video_smoke.exe" : "collect_video_smoke");
const baseline = "af955e571";
const liveCdn = process.argv.includes("--live-cdn");
const count = 50;
const downloadLatency = 110;
const avif = await readFile("src-tauri/tests/fixtures/image/blue-16.avif");
const cloudinary = "https://res.cloudinary.com/demo/image/upload";
const lowerCdnUrl = `${cloudinary}/w_400,c_fill,q_auto/sample.jpg`;
const selectedCdnUrl = `${cloudinary}/w_800,c_fill,q_auto/sample.jpg`;
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="green"/></svg>';
const pageHtml = '<!doctype html><title>Collect image fixture</title>' + Array.from({ length: count }, (_, index) => (
  `<img width="240" height="240" src="/thumbnail.svg" data-src="/media/${index}.svg">`
)).join("");

async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Condition stayed false for ${timeout} ms: ${check}`);
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function run({ previous = false, verifyHeartbeat = false } = {}) {
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, previous ? "collect-052-" : "collect-current-"));
  const ext = join(root, "extension");
  await mkdir(join(root, "appdata"));
  await mkdir(join(root, "localappdata"));
  await writeFile(join(root, "isolated-fixture"), "isolated multitab and batch fixture");
  if (previous) {
    const files = execFileSync("git", ["ls-tree", "-r", "--name-only", baseline, "--", "apps/extension"], { cwd: workspace, encoding: "utf8" });
    for (const path of files.trim().split(/\r?\n/)) {
      const output = join(root, path.replace(/^apps\//, ""));
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, execFileSync("git", ["show", `${baseline}:${path}`], { cwd: workspace }));
    }
  } else {
    await cp(resolve("../extension"), ext, { recursive: true });
    const overlay = join(ext, "ui-overlay.js");
    const source = await readFile(overlay, "utf8");
    const inspectable = source.replace(/attachShadow\(\{\s*mode:\s*"closed"\s*\}\)/, 'attachShadow({mode:"open"})');
    assert.notEqual(inspectable, source, "enable locators only in the isolated copy");
    await writeFile(overlay, inspectable);
  }

  const child = spawn(nativeFixture, [], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "localappdata"), BOWERBIRD_COLLECT_TEST_ROOT: root },
  });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const exited = new Promise(resolve => {
    child.once("exit", resolve);
    child.once("error", error => { output += error.message; resolve(null); });
  });
  const pairing = [];
  const sockets = [];
  const activeConnections = new Set();
  let fetches = 0;
  let peakFetches = 0;
  let target;
  let context;
  const proxy = createServer(async (req, res) => {
    if (req.url === "/pairing-session") {
      pairing.push(performance.now());
      const upstream = request({ hostname: "127.0.0.1", port: target.port, path: req.url }, reply => {
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      });
      upstream.on("error", () => res.writeHead(502).end());
      upstream.end();
      return;
    }
    res.setHeader("cache-control", "no-store");
    if (req.url === "/format.avif") {
      res.setHeader("content-type", "application/octet-stream");
      res.end(avif);
      return;
    }
    if (req.url === "/format" || req.url === "/comma-cdn") {
      res.setHeader("content-type", "text/html");
      res.end(req.url === "/format"
        ? '<!doctype html><img id="fixture-image" width="80" height="80" src="/format.avif">'
        : `<!doctype html><img id="fixture-image" width="200" src="${lowerCdnUrl}" srcset="${lowerCdnUrl} 400w, ${selectedCdnUrl} 800w" sizes="200px">`);
      return;
    }
    if (req.url === "/batch" || req.url.startsWith("/idle")) {
      res.setHeader("content-type", "text/html");
      res.end(req.url === "/batch" ? pageHtml : "<!doctype html><title>Idle tab</title>");
      return;
    }
    if (req.url.startsWith("/media/") && req.headers["sec-fetch-dest"] !== "image") {
      fetches += 1;
      peakFetches = Math.max(fetches, peakFetches);
      await delay(downloadLatency);
      fetches -= 1;
    }
    res.setHeader("content-type", "image/svg+xml");
    res.end(image);
  });
  proxy.on("connection", socket => {
    activeConnections.add(socket);
    socket.once("close", () => activeConnections.delete(socket));
  });
  proxy.on("upgrade", (req, socket, head) => {
    const seen = { at: performance.now(), status: null };
    sockets.push(seen);
    const upstream = request({ hostname: "127.0.0.1", port: target.port, path: req.url, headers: req.headers });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.on("response", reply => { seen.status = reply.statusCode; reply.resume(); socket.end(); });
    upstream.on("upgrade", (reply, remote, bytes) => {
      seen.status = reply.statusCode;
      const headers = Object.entries(reply.headers).map(([name, value]) => `${name}: ${value}`).join("\r\n");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n\r\n`);
      if (bytes.length) socket.write(bytes);
      if (head.length) remote.write(head);
      remote.on("error", () => socket.destroy());
      socket.once("close", () => remote.destroy());
      socket.pipe(remote).pipe(socket);
    });
    upstream.end();
  });

  try {
    const address = await until(() => readJson(join(root, "address.json")));
    target = new URL(address.url);
    await new Promise(done => proxy.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${proxy.address().port}`;
    const protocolFiles = ["collection-utils.js", "pairing.js"];
    if (!previous) protocolFiles.push("image-batch.js", "video-upload.js");
    for (const name of protocolFiles) {
      const file = join(ext, name);
      await writeFile(file, (await readFile(file, "utf8")).replaceAll("127.0.0.1:39871", `127.0.0.1:${proxy.address().port}`));
    }
    context = await chromium.launchPersistentContext(join(root, "profile"), {
      channel: "chromium", headless: true, executablePath: process.env.BOWERBIRD_TEST_CHROMIUM,
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 10000 });
    const options = await context.newPage();
    await options.goto(new URL("options.html", worker.url()).href);
    await options.waitForFunction(() => document.querySelector("#code")?.value.length === 97);
    const manifest = JSON.parse(await readFile(join(ext, "manifest.json"), "utf8"));
    await writeFile(join(root, "pending-pair.txt"), await options.locator("#code").inputValue());
    await rename(join(root, "pending-pair.txt"), join(root, "fixture-pair.txt"));
    await until(() => readJson(join(root, "ready.json")));

    async function captureImage(path) {
      const page = await context.newPage();
      await page.goto(`${origin}/${path}`);
      await page.getByRole("button", { name: "Bowerbird 采集菜单", exact: true }).waitFor();
      await page.locator("#fixture-image").click({ modifiers: ["Alt"] });
      await page.locator("#__bowerbird_toast").filter({ hasText: /采集结束.*已保存 1/ }).waitFor();
      const db = new DatabaseSync(join(root, "library.db"), { readOnly: true });
      try {
        return { ...db.prepare("SELECT ext, width, height FROM assets WHERE source_url = ?").get(`${origin}/${path}`) };
      } finally {
        db.close();
      }
    }

    if (liveCdn) {
      await worker.evaluate(() => {
        const fetchFromNetwork = globalThis.fetch;
        globalThis.fixtureRequests = [];
        globalThis.fetch = (url, options) => {
          globalThis.fixtureRequests.push(String(url));
          return fetchFromNetwork(url, options);
        };
      });
      const asset = await captureImage("comma-cdn");
      assert.equal(asset.width, 800);
      const requests = await worker.evaluate(() => globalThis.fixtureRequests);
      assert.deepEqual(requests.filter(url => url.startsWith(cloudinary)), [selectedCdnUrl]);
      return asset;
    }

    const status = () => readJson(join(root, "status.json"));
    let tabs = [];
    if (verifyHeartbeat) {
      tabs = await Promise.all(Array.from({ length: 20 }, () => context.newPage()));
      await Promise.all(tabs.map((tab, index) => tab.goto(`${origin}/idle/${index}`)));
      await tabs.at(-1).bringToFront();
      const connected = await until(async () => {
        const value = await status();
        return value?.connected && value.version && value;
      });
      assert.equal(connected.version.reported, manifest.version);
      assert.equal(connected.version.reported, connected.version.expected);
      assert.equal(connected.version.update_required, false);
      await until(() => sockets.length > 1, 20000);
      assert.equal(pairing.length, 2);
      assert.equal(sockets.length, 2);
      assert.ok(pairing[1] - pairing[0] >= 14900, JSON.stringify(pairing));
      assert.ok(sockets.every(socket => socket.status === 101), JSON.stringify(sockets));
    }

    const page = await context.newPage();
    await page.goto(`${origin}/batch`);
    await page.getByRole("button", { name: "Bowerbird 采集菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: "采集本页图片", exact: true }).click();
    const confirm = page.getByRole("button", { name: "采集", exact: true });
    await confirm.waitFor();
    await until(() => sockets.length && sockets.every(socket => socket.status !== null));
    await delay(300); // Complete the menu's current-project lookup before timing the confirmation.
    if (previous) {
      const version = await until(async () => (await readJson(join(root, "status.json")))?.version);
      assert.equal(version.reported, null);
      assert.equal(version.update_required, true);
    }
    const before = sockets.length;
    const started = performance.now();
    await confirm.click();
    await page.locator("#__bowerbird_toast").filter({ hasText: /采集结束.*已保存 50/ }).waitFor({ timeout: 20000 });
    const result = { milliseconds: Math.round(performance.now() - started), connections: sockets.length - before, peakFetches };
    assert.ok(sockets.every(socket => socket.status === 101), JSON.stringify(sockets));
    if (verifyHeartbeat) {
      assert.equal((await status()).connected, true);
      await Promise.all([...tabs, page].map(tab => tab.close()));
      await until(async () => (await status())?.connected === false, 38000);
      assert.ok(performance.now() - sockets.at(-1).at >= 29000, "desktop must keep connection through its timeout");

      assert.deepEqual(await captureImage("format"), { ext: "png", width: 16, height: 16 });
    }
    return result;
  } catch (error) {
    throw new Error(`Isolated extension fixture ${root}: ${error.message}\n${output}`, { cause: error });
  } finally {
    await context?.close();
    for (const socket of activeConnections) socket.destroy();
    proxy.close();
    await writeFile(join(root, "stop"), "done");
    if (child.exitCode === null && !await Promise.race([exited.then(() => true), delay(5000, false)])) child.kill();
    await exited;
  }
}

if (liveCdn) {
  console.log("PASS: public Cloudinary srcset retained the comma-separated transform and saved the 800px image", await run());
} else {
  const previous = await run({ previous: true });
  const current = await run({ verifyHeartbeat: true });
  assert.equal(previous.connections, count, JSON.stringify(previous));
  assert.equal(current.connections, 1, JSON.stringify(current));
  assert.ok(current.peakFetches >= 3 && current.peakFetches <= 4, JSON.stringify(current));
  const faster = 1 - current.milliseconds / previous.milliseconds;
  assert.ok(faster > 0.5, JSON.stringify({ previous, current }));
  console.log(`PASS: Chromium 20-tab heartbeat, 30-second native expiry and ${count}-image batch; ${JSON.stringify({ previous, current, faster })}`);
}
