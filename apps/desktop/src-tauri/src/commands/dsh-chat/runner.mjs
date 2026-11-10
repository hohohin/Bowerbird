import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { cloudMessages, completionSse, DSH_VERSION, managedPatch, MODEL, TOOL } from "./bridge.mjs";

const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const checking = process.argv[2] === "--check";
const checkWorkspace = checking ? await mkdtemp(path.join(os.tmpdir(), "bowerbird-dsh-check-")) : undefined;
const abort = new AbortController();
const pending = new Map();
let firstResolve;
const first = new Promise(resolve => { firstResolve = resolve; });
if (checking) firstResolve({ type: "start", runtime: process.argv[3], workspace: checkWorkspace, prompt: "check", tools: [{ name: TOOL }] });
let started = false;
let child;
let server;
let failure;
function stop(reason = "DSH_CANCELLED") {
  failure ??= reason;
  abort.abort();
  for (const item of pending.values()) item.reject(new Error(reason));
  pending.clear();
  child?.kill();
  server?.closeAllConnections();
  server?.close();
}
const reader = checking ? undefined : createInterface({ input: process.stdin });
reader?.on("line", line => {
  try {
    const message = JSON.parse(line);
    if (!started) {
      started = true;
      firstResolve(message);
      return;
    }
    if (message.type !== "result" || !pending.has(message.id)) throw new Error("DSH_UNEXPECTED_RESULT");
    const item = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      failure = String(message.error);
      item.reject(new Error(failure));
    } else item.resolve(message.result);
  } catch { stop("DSH_PROTOCOL_INVALID"); }
});
reader?.on("close", () => { firstResolve(undefined); stop(); });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { firstResolve(undefined); stop(); });

function host(event) {
  if (abort.signal.aborted || failure) return Promise.reject(new Error(failure ?? "DSH_CANCELLED"));
  if (pending.has(event.id)) return Promise.reject(new Error("DSH_DUPLICATE_REQUEST"));
  return new Promise((resolve, reject) => {
    pending.set(event.id, { resolve, reject });
    emit(event);
  });
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serve(capability) {
  let rounds = 0;
  const dispatched = new Set();
  server = http.createServer(async (request, response) => {
    try {
      if (failure || abort.signal.aborted) throw new Error(failure ?? "DSH_CANCELLED");
      if (request.method !== "POST" || request.headers.authorization !== `Bearer ${capability}`) throw new Error("DSH_UNAUTHORIZED");
      const body = await requestBody(request);
      if (request.url === "/chat/completions") {
        if (++rounds > 12) throw new Error("DSH_MODEL_TURN_LIMIT");
        const messages = cloudMessages(body);
        const result = await host({ type: "model", id: `model-${rounds}`, messages });
        const sse = completionSse(result);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(sse);
      } else if (request.url === "/tool") {
        if (body.name !== TOOL || !/^[\w-]{1,120}$/.test(body.id) || !body.args || typeof body.args !== "object" || Array.isArray(body.args) || dispatched.has(body.id)) throw new Error("DSH_TOOL_INVALID");
        dispatched.add(body.id);
        const result = await host({ type: "tool", id: body.id, name: TOOL, args: body.args });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      } else throw new Error("DSH_ENDPOINT_NOT_ALLOWED");
    } catch (error) {
      failure ??= error.message;
      if (!response.headersSent) response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "BOWERBIRD_BRIDGE_FAILED", message: "Bowerbird managed request failed" } }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function makeProfile(start, endpoint) {
  const require = createRequire(path.join(start.runtime, "package.json"));
  for (const name of ["dsh", "dsh-acp", "dsh-base", "dsh-llm-deepseek", "dsh-tools"]) {
    const manifest = JSON.parse(await readFile(path.join(start.runtime, "node_modules", "@deepseek-ai", name, "package.json"), "utf8"));
    if (manifest.version !== DSH_VERSION) throw new Error("DSH_RUNTIME_VERSION_MISMATCH");
  }
  const yaml = require("js-yaml");
  const schema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type("tag:yaml.org,2002:js", { kind: "scalar", construct: value => value })]);
  const base = yaml.load(await readFile(path.join(start.runtime, "node_modules", "@deepseek-ai", "dsh-base", "cordis.patch.yml"), "utf8"), { schema });
  const profile = path.join(start.workspace, "profiles", "chat");
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, "package.json"), JSON.stringify({ private: true, type: "module", dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }));
  await writeFile(path.join(profile, "cordis.yml"), "[]\n");
  const patch = managedPatch(base.flatMap(item => item.insert ?? []), endpoint);
  patch.push({ insert: [
    { id: "bowerbird-chat-cards", name: "./cards-plugin.mjs" },
    { id: "acp", name: pathToFileURL(require.resolve("@deepseek-ai/dsh-acp")).href, config: { provider: "deepseek-official", model: MODEL } },
  ] });
  await writeFile(path.join(profile, "cordis.patch.yml"), yaml.dump(patch));
  const plugin = await readFile(new URL("./cards-plugin.mjs", import.meta.url), "utf8");
  await writeFile(path.join(profile, "cards-plugin.mjs"), plugin.replace('"@deepseek-ai/dsh-tools"', JSON.stringify(pathToFileURL(require.resolve("@deepseek-ai/dsh-tools")).href)));
  return import(pathToFileURL(require.resolve("@agentclientprotocol/sdk")).href);
}

function childEnvironment(runtime, workspace, endpoint, capability) {
  const env = {};
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "PATH", "TMPDIR", "LANG", "LC_ALL"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, NODE_PATH: path.join(runtime, "node_modules"), DSH_HOME: workspace, DSH_TELEMETRY_DISABLED: "1", BOWERBIRD_DSH_ENDPOINT: endpoint, BOWERBIRD_DSH_CAPABILITY: capability };
}

async function run(start) {
  if (start?.type !== "start" || typeof start.prompt !== "string" || !start.prompt.trim() || !path.isAbsolute(start.runtime ?? "") || !path.isAbsolute(start.workspace ?? "") || !Array.isArray(start.tools) || start.tools.length !== 1 || start.tools[0]?.name !== TOOL) throw new Error("DSH_START_INVALID");
  const capability = randomBytes(32).toString("hex");
  const endpoint = await serve(capability);
  const acp = await makeProfile(start, endpoint);
  if (abort.signal.aborted) throw new Error("DSH_CANCELLED");
  child = spawn(process.execPath, [path.join(start.runtime, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), "--profile", "chat"], {
    cwd: start.workspace, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: childEnvironment(start.runtime, start.workspace, endpoint, capability),
  });
  // Do not expose raw provider/configuration diagnostics on the app's wire.
  child.stderr.on("data", chunk => { if (process.env.DSH_CHAT_DEBUG === "1") process.stderr.write(String(chunk).replaceAll(capability, "[redacted]")); });
  const connection = new acp.ClientSideConnection(() => ({
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    sessionUpdate: async ({ update }) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") emit({ type: "text", text: update.content.text });
    },
    readTextFile: async () => { throw new Error("DSH_FILES_DISABLED"); },
    writeTextFile: async () => { throw new Error("DSH_FILES_DISABLED"); },
  }), acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  const closed = new Promise((_, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error(failure ?? "DSH_PROCESS_EXITED")));
  });
  const operation = async () => {
    await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await connection.newSession({ cwd: start.workspace, mcpServers: [], additionalDirectories: [] });
    if (checking) return;
    const result = await connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: start.prompt }] });
    if (failure || result.stopReason !== "end_turn") throw new Error(failure ?? "DSH_TURN_INCOMPLETE");
  };
  await Promise.race([operation(), closed]);
  emit(checking ? { ready: true, version: DSH_VERSION } : { type: "done" });
}

try { await run(await first); }
catch (error) { emit({ type: "error", error: failure ?? error.message }); process.exitCode = 1; }
finally {
  stop(); reader?.close(); process.stdin.pause();
  if (checkWorkspace && path.dirname(path.resolve(checkWorkspace)) === path.resolve(os.tmpdir()) && path.basename(checkWorkspace).startsWith("bowerbird-dsh-check-")) {
    if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once("exit", resolve));
    await rm(checkWorkspace, { recursive: true, force: true });
  }
}
