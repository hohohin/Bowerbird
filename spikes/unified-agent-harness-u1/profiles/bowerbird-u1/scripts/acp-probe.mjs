import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { spawnDsh, spikeRoot } from "./runtime.mjs";

const REQUEST_TIMEOUT_MS = 20_000;

function withTimeout(promise, label, timeoutMs = REQUEST_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function errorShape(error) {
  return {
    name: error?.name ?? "Error",
    code: error?.code ?? null,
    message: String(error?.message ?? error),
  };
}

async function captureUnsupported(label, operation) {
  try {
    const value = await withTimeout(operation(), label);
    return { supported: true, value };
  } catch (error) {
    return { supported: false, error: errorShape(error) };
  }
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.stdin?.end();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill();
}

export async function probeAcpLifecycle() {
  const child = spawnDsh([], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));

  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const connection = new acp.ClientSideConnection(
    () => ({
      async requestPermission() {
        return { outcome: { outcome: "cancelled" } };
      },
      async sessionUpdate() {},
      async readTextFile() {
        throw new Error("filesystem capability was not advertised");
      },
      async writeTextFile() {
        throw new Error("filesystem capability was not advertised");
      },
    }),
    stream,
  );

  try {
    const initialize = await withTimeout(
      connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }),
      "initialize",
    );
    const created = await withTimeout(
      connection.newSession({ cwd: spikeRoot, mcpServers: [], additionalDirectories: [] }),
      "session/new",
    );
    const sessionId = created.sessionId;

    await withTimeout(connection.cancel({ sessionId }), "session/cancel");

    const promptValidation = await captureUnsupported("session/prompt validation", () =>
      connection.prompt({ sessionId, prompt: [] }),
    );
    const list = await captureUnsupported("session/list", () => connection.listSessions({ cwd: spikeRoot }));
    const resume = await captureUnsupported("session/resume", () =>
      connection.resumeSession({
        sessionId,
        cwd: spikeRoot,
        mcpServers: [],
        additionalDirectories: [],
      }),
    );
    const close = await captureUnsupported("session/close", () => connection.closeSession({ sessionId }));

    const report = {
      package: "@deepseek-ai/dsh-acp@0.1.1-rc.2",
      protocolVersionRequested: acp.PROTOCOL_VERSION,
      initialize,
      session: { created: true, sessionIdPresent: Boolean(sessionId), cancelAccepted: true },
      promptValidation,
      optionalLifecycle: { list, resume, close },
      stderr: stderr.trim(),
    };

    assert.equal(initialize.protocolVersion, acp.PROTOCOL_VERSION);
    assert.equal(Boolean(sessionId), true);
    assert.equal(promptValidation.supported, false, "empty prompt must be rejected before provider access");
    assert.equal(list.supported, false, "published ACP package unexpectedly supports session/list");
    assert.equal(resume.supported, false, "published ACP package unexpectedly supports session/resume");
    assert.equal(close.supported, false, "published ACP package unexpectedly supports session/close");
    return report;
  } finally {
    await stopChild(child);
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const report = await probeAcpLifecycle();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
