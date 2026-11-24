import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync, readdirSync, statfsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { processChatJob } from "../../agent-worker/src/cloud-chat/runtime.ts";
import { cropPng, encodePng, readPngHeader } from "../../html-renderer/src/png.ts";
import { createCloudProxy } from "../../../website/cloud-proxy.mjs";

const upstream = "https://fixture.supabase.co";
const self = fileURLToPath(import.meta.url);
const sha = text => createHash("sha256").update(text).digest("hex");
const group = readFileSync("/proc/self/cgroup", "utf8").trim().split(":").at(-1);
const counter = name => readFileSync(join("/sys/fs/cgroup", group, name), "utf8").trim();
const counters = name => Object.fromEntries(counter(name).split("\n").map(row => { const [key, value] = row.split(" "); return [key, Number(value)]; }));
const optional = name => { try { return Number(counter(name)); } catch { return null; } };
const tmpfs = () => { const { blocks, bfree, bsize } = statfsSync("/tmp"); return { bytes: blocks * bsize, used: (blocks - bfree) * bsize }; };
const kinds = ["chat_short", "chat_long", "png_crop"];
const storagePath = "/storage/v1/object/sign/generation-temp/jobs/e0000001-2222-4333-8444-555555555555/outputs/result.mp4";
const storageChunk = Buffer.alloc(64 * 1024, 73);
const storageChunks = 256;
const payloads = Object.fromEntries([ [kinds[0], 4096], [kinds[1], 524288] ].map(([kind, bytes]) =>
  [kind, JSON.stringify({ messages: [{ role: "user", content: "x".repeat(bytes) }], tools_enabled: false })]));

function isolate() {
  assert.equal(process.platform, "linux");
  assert.equal(process.getuid(), 1000);
  assert.deepEqual(Object.keys(networkInterfaces()), ["lo"]);
  assert.equal(counter("cpu.max"), "175000 100000");
  assert.equal(counter("memory.max"), "1610612736");
  assert.equal(counter("pids.max"), "256");
  assert.equal(tmpfs().bytes, 671088640);
}

function makePng() {
  const width = 1800, height = 1200, rgba = new Uint8Array(width * height * 4);
  let state = 17;
  for (let index = 0; index < rgba.length; index += 4) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    rgba[index] = state >>> 29 << 5;
    rgba[index + 1] = state >>> 26 & 224;
    rgba[index + 2] = state >>> 23 & 224;
    rgba[index + 3] = 255;
  }
  return encodePng({ width, height, rgba });
}

function startWorker(kind) {
  const source = kind === "png" ? makePng() : null;
  process.on("message", async ({ id, text }) => {
    try {
      if (source) {
        const bitmap = cropPng(source, { x: 120, y: 80, width: 1280, height: 840 });
        assert.ok(bitmap instanceof Uint8Array);
        assert.deepEqual(readPngHeader(bitmap), { width: 1280, height: 840, colorType: 6 });
        const directory = await mkdtemp(join(tmpdir(), "bb-cap-png-"));
        try {
          await writeFile(join(directory, "page.png"), bitmap);
          process.send({ id, ok: true, tmpfsUsed: tmpfs().used });
        } finally { await rm(directory, { recursive: true, force: true }); }
      } else {
        await processChatJob({ id, lease_id: "fixture", input_hash: sha(text), input_url: "fixture:" },
          async receipt => { assert.equal(receipt.action, "finish"); assert.equal(receipt.status, "succeeded"); return {}; },
          { async chat() { return { message: { role: "assistant", content: "synthetic-result" }, content: "synthetic-result",
            toolCalls: [], finishReason: "stop", usage: { promptTokens: 2, completionTokens: 1 } }; } },
          "fixture", async url => { assert.equal(url, "fixture:"); return new Response(text); });
        process.send({ id, ok: true });
      }
    } catch { process.send({ id, ok: false }); }
  });
  process.send({ ready: true, pngBytes: source?.byteLength });
}

function latency(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = p => sorted.length ? Math.round(sorted[Math.ceil(sorted.length * p) - 1] * 10) / 10 : null;
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95), max: percentile(1) };
}

async function capacity(level, accounts, offeredDownloads, expectedDownload429) {
  const clients = [1, 4, 6, 8, 12];
  assert.ok(clients.includes(level));
  assert.ok([1, 4].includes(accounts));
  assert.ok(Number.isSafeInteger(offeredDownloads) && offeredDownloads >= 0 && offeredDownloads <= 8);
  assert.ok(Number.isSafeInteger(expectedDownload429) && expectedDownload429 >= 0 && expectedDownload429 <= offeredDownloads);
  const queues = { chat: { tail: Promise.resolve(), waiting: 0 }, png: { tail: Promise.resolve(), waiting: 0 } };
  const workers = [], rows = [];
  let server, pngBytes, poll, queuePeak = 0, tempPeak = 0, sampledTaskPeak = 0, fdPeak = 0;
  const fdSoftLimit = Number(/^Max open files\s+(\d+)/m.exec(readFileSync("/proc/self/limits", "utf8"))?.[1]);
  const downloadReady = [];
  let releaseDownloads;
  const pendingDownloads = new Promise(resolve => { releaseDownloads = resolve; });
  const sampleQueue = () => { queuePeak = Math.max(queuePeak, queues.chat.waiting + queues.png.waiting); };
  try {
    for (const [lane, queue] of Object.entries(queues)) {
      const worker = fork(self, [lane], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      workers.push(worker);
      const [ready] = await once(worker, "message", { signal: AbortSignal.timeout(15_000) });
      assert.equal(ready.ready, true);
      pngBytes ??= ready.pngBytes;
      queue.worker = worker;
    }
    const records = new Map();
    const accept = (id, kind, text) => {
      const queue = kind === "png_crop" ? queues.png : queues.chat;
      const result = { id, kind, acceptedAt: performance.now() };
      queue.waiting++;
      sampleQueue();
      queue.tail = queue.tail.then(async () => {
        queue.waiting--;
        result.startedAt = performance.now();
        try {
          const receipt = once(queue.worker, "message", { signal: AbortSignal.timeout(30_000) });
          queue.worker.send({ id, text });
          const [done] = await receipt;
          result.ok = done.ok === true && done.id === id;
          if (Number.isSafeInteger(done.tmpfsUsed)) tempPeak = Math.max(tempPeak, done.tmpfsUsed);
        } catch { result.ok = false; }
        result.finishedAt = performance.now();
      });
      records.set(id, result);
    };
    const proxy = createCloudProxy({ upstream, publicKey: "synthetic-public-key", trustProxy: false,
      authFetchImpl: async (url, { headers }) => {
        assert.equal(String(url), upstream + "/auth/v1/user");
        assert.match(headers.Authorization, /^Bearer synthetic-user-[0-3]$/);
        await delay(12);
        return Response.json({ id: headers.Authorization.slice(-1) });
      }, async fetchImpl(url, request) {
        assert.equal(url.origin, upstream);
        if (url.pathname === storagePath) {
          assert.match(url.searchParams.get("token") ?? "", /^synthetic-signed-[0-7]$/);
          assert.deepEqual(request.headers, {});
          let chunks = 0;
          const body = new ReadableStream({
            async pull(controller) {
              if (chunks === 1) await pendingDownloads;
              if (chunks++ < storageChunks) controller.enqueue(storageChunk);
              else controller.close();
            },
          });
          return new Response(body, { headers: { "Content-Type": "video/mp4", "Content-Length": String(storageChunk.length * storageChunks) } });
        }
        assert.ok(["/functions/v1/chat-proxy", "/functions/v1/agent-run"].includes(url.pathname));
        const chunks = [];
        for await (const chunk of request.body) chunks.push(chunk);
        const { idempotency_key: id, kind, text } = JSON.parse(Buffer.concat(chunks));
        assert.ok(kinds.includes(kind));
        if (!records.has(id)) accept(id, kind, text);
        return Response.json({ id });
      } });
    server = createServer(proxy).listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}/api/cloud`;
    async function submit(kind, account) {
      const id = randomUUID(), startedAt = performance.now();
      const route = kind === "png_crop" ? "agent-run" : "chat-proxy";
      const response = await fetch(`${origin}/functions/v1/${route}`, {
        method: "POST", signal: AbortSignal.timeout(12_000),
        headers: { authorization: `Bearer synthetic-user-${account}`, "content-type": "application/json" },
        body: JSON.stringify({ action: "create", idempotency_key: id, kind, text: payloads[kind] }),
      });
      const responseBody = await response.json();
      if (response.ok) assert.equal(responseBody.id, id);
      return { id, kind, status: response.status, startedAt, gatewayMs: performance.now() - startedAt };
    }
    for (const kind of kinds) assert.equal((await submit(kind, 0)).status, 200);
    await Promise.all(Object.values(queues).map(queue => queue.tail));
    assert.ok([...records.values()].every(result => result.ok));
    records.clear();
    queuePeak = 0;
    tempPeak = tmpfs().used;
    poll = setInterval(() => {
      tempPeak = Math.max(tempPeak, tmpfs().used);
      sampledTaskPeak = Math.max(sampledTaskPeak, Number(counter("pids.current")));
      fdPeak = Math.max(fdPeak, readdirSync("/proc/self/fd").length - 1);
    }, 10);
    const firstBytes = Array.from({ length: offeredDownloads }, (_, index) => new Promise(resolve => { downloadReady[index] = resolve; }));
    const downloads = firstBytes.map(async (_, index) => {
      try {
        const response = await fetch(`${origin}${storagePath}?token=synthetic-signed-${index}`, { signal: AbortSignal.timeout(15_000) });
        if (response.status === 429) {
          assert.equal(response.headers.get("retry-after"), "60");
          await response.arrayBuffer();
          downloadReady[index](429);
          return 0;
        }
        assert.equal(response.status, 200);
        const reader = response.body.getReader();
        const first = await reader.read();
        assert.ok(first.value?.length > 0);
        downloadReady[index](200);
        const digest = createHash("sha256").update(first.value);
        let bytes = first.value.length;
        for (let part = await reader.read(); !part.done; part = await reader.read()) {
          bytes += part.value.length;
          digest.update(part.value);
        }
        const expected = createHash("sha256");
        for (let chunk = 0; chunk < storageChunks; chunk++) expected.update(storageChunk);
        assert.equal(digest.digest("hex"), expected.digest("hex"));
        assert.equal(bytes, storageChunk.length * storageChunks);
        return bytes;
      } catch {
        downloadReady[index](null);
        return 0;
      }
    });
    const downloadStatuses = await Promise.all(firstBytes);
    const storage429 = downloadStatuses.filter(status => status === 429).length;
    const heldDownloads = downloadStatuses.filter(status => status === 200).length;
    assert.equal(storage429, expectedDownload429);
    assert.equal(heldDownloads + storage429, offeredDownloads);
    const startCpu = counters("cpu.stat"), start = performance.now();
    let sent = 0;
    await Promise.all(Array.from({ length: level }, async (_, client) => {
      while (sent < 60) rows.push(await submit(kinds[sent++ % kinds.length], client % accounts));
    }));
    releaseDownloads();
    await Promise.all(Object.values(queues).map(queue => queue.tail));
    const downloadBytes = (await Promise.all(downloads)).reduce((total, bytes) => total + bytes, 0);
    assert.equal(downloadBytes, heldDownloads * storageChunk.length * storageChunks);
    const elapsed = (performance.now() - start) / 1000, endCpu = counters("cpu.stat");
    const success = [...records.values()].filter(receipt => receipt.ok);
    const accepted = rows.filter(row => row.status === 200);
    const submissionTimes = new Map(accepted.map(row => [row.id, row.startedAt]));
    assert.equal(accepted.length, records.size);
    const counts = { offered: rows.length, accepted: accepted.length, completed: success.length,
      gateway429: rows.filter(row => row.status === 429).length, otherHttp: rows.filter(row => ![200, 429].includes(row.status)).length,
      failedWork: records.size - success.length };
    const perKind = Object.fromEntries(kinds.map(kind => {
      const jobs = success.filter(row => row.kind === kind);
      return [kind, { acceptedGatewayMs: latency(accepted.filter(row => row.kind === kind).map(row => row.gatewayMs)),
        queueMs: latency(jobs.map(row => row.startedAt - row.acceptedAt)),
        executeMs: latency(jobs.map(row => row.finishedAt - row.startedAt)),
        endToEndMs: latency(jobs.map(row => row.finishedAt - submissionTimes.get(row.id))) }];
    }));
    console.log(JSON.stringify({ level, accounts, offeredDownloads, heldDownloads, storage429, downloadBytes, counts,
      elapsedSec: +elapsed.toFixed(3), completionsPerSec: +(success.length / elapsed).toFixed(2),
      queuePeak, gatewayMs: latency(accepted.map(row => row.gatewayMs)), queueMs: latency(success.map(row => row.startedAt - row.acceptedAt)),
      endToEndMs: latency(success.map(row => row.finishedAt - submissionTimes.get(row.id))), perKind,
      resources: { cpuMs: (endCpu.usage_usec - startCpu.usage_usec) / 1000, throttledPeriods: endCpu.nr_throttled - startCpu.nr_throttled,
        memoryPeakBytes: optional("memory.peak"), tasksPeak: optional("pids.peak") ?? sampledTaskPeak,
        tmpfsPeakUsedBytes: tempPeak, oomKills: counters("memory.events").oom_kill, gatewayFdPeak: fdPeak, gatewayFdSoftLimit: fdSoftLimit },
      sampleBytes: { shortText: Buffer.byteLength(payloads.chat_short), longText: Buffer.byteLength(payloads.chat_long), png: pngBytes } }));
    assert.equal(counts.otherHttp, 0);
    assert.equal(counts.failedWork, 0);
  } finally {
    releaseDownloads();
    if (poll) clearInterval(poll);
    if (server?.listening) { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; }
    for (const worker of workers) { if (worker.connected) worker.disconnect(); }
  }
}

isolate();
if (["chat", "png"].includes(process.argv[2])) startWorker(process.argv[2]);
else await capacity(Number(process.argv[2]), Number(process.argv[3] ?? 1), Number(process.argv[4] ?? 0), Number(process.argv[5] ?? 0));
