import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { spawnDsh, spikeRoot } from "./runtime.mjs";

const REQUEST_TIMEOUT_MS = 90_000;
const VISION_PATCH = "profiles/bowerbird-u1/cordis.vision.patch.yml";
const FIXTURE_PATH = path.resolve(spikeRoot, "..", "..", "apps", "extension", "icons", "128x128.png");

function withTimeout(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${REQUEST_TIMEOUT_MS} ms`)), REQUEST_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
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

function redactStderr(stderr) {
  const key = process.env.DEEPSEEK_API_KEY;
  return key ? stderr.replaceAll(key, "[REDACTED]") : stderr;
}

export async function runVisionSmoke() {
  const imageBuffer = await fs.readFile(FIXTURE_PATH);
  const imageData = imageBuffer.toString("base64");
  const child = spawnDsh(["--patch", VISION_PATCH], {
    stdio: ["pipe", "pipe", "pipe"],
    allowNetwork: true,
  });
  let stderr = "";
  let assistantText = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));

  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const connection = new acp.ClientSideConnection(
    () => ({
      async requestPermission() {
        return { outcome: { outcome: "cancelled" } };
      },
      async sessionUpdate(params) {
        const update = params.update;
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          assistantText += update.content.text;
        }
      },
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
    assert.equal(initialize.agentCapabilities?.promptCapabilities?.image, true);

    const created = await withTimeout(
      connection.newSession({ cwd: spikeRoot, mcpServers: [], additionalDirectories: [] }),
      "session/new",
    );
    const promptResult = await withTimeout(
      connection.prompt({
        sessionId: created.sessionId,
        prompt: [
          {
            type: "text",
            text: "Identify the pictured animal and its dominant foreground color. Answer exactly animal:color using lower-case English words.",
          },
          {
            type: "image",
            mimeType: "image/png",
            data: imageData,
          },
        ],
      }),
      "session/prompt",
    );

    assert.equal(promptResult.stopReason, "end_turn");
    assert.match(assistantText.toLowerCase(), /bird/);
    assert.match(assistantText.toLowerCase(), /blue/);

    assistantText = "";
    const followupResult = await withTimeout(
      connection.prompt({
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "Without another image, repeat only the animal noun from the prior image." }],
      }),
      "session/prompt follow-up",
    );
    assert.equal(followupResult.stopReason, "end_turn");
    assert.match(assistantText.toLowerCase(), /bird/);

    return {
      package: "@deepseek-ai/dsh-acp@0.1.1-rc.2",
      model: "deepseek-v4-flash-vision-exp",
      imageCapabilityAdvertised: true,
      fixtureBytes: imageBuffer.byteLength,
      sessionCreated: Boolean(created.sessionId),
      stopReason: promptResult.stopReason,
      followupStopReason: followupResult.stopReason,
      birdObserved: true,
      blueObserved: true,
      priorImageContextObserved: true,
      stderr: redactStderr(stderr).trim(),
    };
  } finally {
    await stopChild(child);
  }
}

const report = await runVisionSmoke();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
