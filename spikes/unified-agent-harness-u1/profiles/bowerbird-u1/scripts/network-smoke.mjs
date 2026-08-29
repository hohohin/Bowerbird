import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { spawnDsh, spikeRoot } from "./runtime.mjs";

const PROOF_PREFIX = "bowerbird-u1-private-proof:";
const NONCES = ["bowerbird-u1-network-smoke-a", "bowerbird-u1-network-smoke-b"];
const REQUEST_TIMEOUT_MS = 90_000;

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

function proofFor(nonce) {
  return createHash("sha256").update(`${PROOF_PREFIX}${nonce}`).digest("hex");
}

export async function runNetworkSmoke() {
  const child = spawnDsh([], { stdio: ["pipe", "pipe", "pipe"], allowNetwork: true });
  let stderr = "";
  let currentAssistantText = "";
  const updateKinds = [];

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
        updateKinds.push(update.sessionUpdate);
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          currentAssistantText += update.content.text;
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
    const created = await withTimeout(
      connection.newSession({ cwd: spikeRoot, mcpServers: [], additionalDirectories: [] }),
      "session/new",
    );
    assert.equal(initialize.protocolVersion, acp.PROTOCOL_VERSION);
    const turns = [];
    for (const nonce of NONCES) {
      currentAssistantText = "";
      const promptResult = await withTimeout(
        connection.prompt({
          sessionId: created.sessionId,
          prompt: [
            {
              type: "text",
              text: `Verify the U1 tool loop now. Call u1_record_observation exactly once with nonce ${nonce}. Then answer with TOOL_LOOP_OK, that nonce, and the opaque proof returned by the tool.`,
            },
          ],
        }),
        "session/prompt",
      );
      assert.equal(promptResult.stopReason, "end_turn");
      assert.match(currentAssistantText, /TOOL_LOOP_OK/);
      assert.match(currentAssistantText, new RegExp(nonce));
      assert.match(currentAssistantText, new RegExp(proofFor(nonce)));
      turns.push({ stopReason: promptResult.stopReason, proofObserved: true });
    }

    currentAssistantText = "";
    const cancellablePrompt = connection.prompt({
      sessionId: created.sessionId,
      prompt: [
        {
          type: "text",
          text: "Write a detailed 1,000-word explanation of deterministic idempotency in distributed systems.",
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await withTimeout(connection.cancel({ sessionId: created.sessionId }), "session/cancel");
    const cancelledResult = await withTimeout(cancellablePrompt, "cancelled session/prompt");
    assert.equal(cancelledResult.stopReason, "cancelled");

    return {
      package: "@deepseek-ai/dsh-acp@0.1.1-rc.2",
      protocolVersion: initialize.protocolVersion,
      sessionCreated: Boolean(created.sessionId),
      turns,
      inFlightCancelStopReason: cancelledResult.stopReason,
      updateKinds: [...new Set(updateKinds)],
      stderr: redactStderr(stderr).trim(),
    };
  } finally {
    await stopChild(child);
  }
}

const report = await runNetworkSmoke();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
