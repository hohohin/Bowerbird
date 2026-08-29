import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { spawnDsh } from "./runtime.mjs";

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

export class NodeDshAcpPort {
  #child;
  #connection;
  #onCommittedContent;

  constructor({ allowNetwork = false, patches = [] } = {}) {
    const args = patches.flatMap((patch) => ["--patch", patch]);
    this.#child = spawnDsh(args, {
      stdio: ["pipe", "pipe", "pipe"],
      allowNetwork,
    });
    let stderr = "";
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk) => (stderr += chunk));
    this.#child.once("exit", (code) => {
      if (code && code !== 0 && stderr) {
        const key = process.env.DEEPSEEK_API_KEY;
        process.stderr.write(key ? stderr.replaceAll(key, "[REDACTED]") : stderr);
      }
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(this.#child.stdin),
      Readable.toWeb(this.#child.stdout),
    );
    const port = this;
    this.#connection = new acp.ClientSideConnection(
      () => ({
        async requestPermission() {
          return { outcome: { outcome: "cancelled" } };
        },
        async sessionUpdate(params) {
          const update = params.update;
          if (update.sessionUpdate === "agent_message_chunk") {
            port.#onCommittedContent?.(update.content);
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
  }

  async initialize() {
    return withTimeout(
      this.#connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      }),
      "initialize",
    );
  }

  async newSession({ cwd }) {
    return withTimeout(
      this.#connection.newSession({ cwd, mcpServers: [], additionalDirectories: [] }),
      "session/new",
    );
  }

  async prompt(args, onCommittedContent) {
    if (this.#onCommittedContent) throw new Error("concurrent ACP prompt is not allowed");
    this.#onCommittedContent = onCommittedContent;
    try {
      return await withTimeout(this.#connection.prompt(args), "session/prompt");
    } finally {
      this.#onCommittedContent = undefined;
    }
  }

  async cancel(args) {
    await withTimeout(this.#connection.cancel(args), "session/cancel");
  }

  async dispose() {
    if (this.#child.exitCode !== null) return;
    this.#child.stdin.end();
    await Promise.race([
      new Promise((resolve) => this.#child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (this.#child.exitCode === null) this.#child.kill();
  }
}
