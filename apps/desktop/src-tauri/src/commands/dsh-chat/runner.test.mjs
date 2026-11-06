import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cloudMessages, completionSse, managedPatch } from "./bridge.mjs";

test("managed requests contain only the existing Cloud text and card tool contract", () => {
  const request = { model: "bowerbird-chat", stream: true, messages: [
    { role: "system", content: "local managed persona" },
    { role: "user", content: "create a section" },
  ], tools: [{ type: "function", function: { name: "create_canvas_cards" } }] };
  assert.deepEqual(cloudMessages(request), [{ role: "user", content: "create a section" }]);
  assert.throws(() => cloudMessages({ ...request, model: "arbitrary" }), /MODEL/);
  assert.throws(() => cloudMessages({ ...request, tools: [{ type: "function", function: { name: "shell" } }] }), /TOOL/);
  assert.throws(() => cloudMessages({ ...request, messages: [{ role: "user", content: [{ type: "image_url" }] }] }), /MESSAGE/);
});

test("completion translation preserves tool call identity and ends the stream", () => {
  const call = { id: "create-1", type: "function", function: { name: "create_canvas_cards", arguments: '{"cards":[]}' } };
  const stream = completionSse({ role: "assistant", content: null, tool_calls: [call] });
  assert.match(stream, /"index":0,"id":"create-1"/);
  assert.match(stream, /"finish_reason":"tool_calls"/);
  assert.ok(stream.endsWith("data: [DONE]\n\n"));
  assert.throws(() => completionSse({ role: "assistant", content: null }), /EMPTY/);
});

test("base profile uses an allowlist and never enables retry, shell, files, web or profile settings", () => {
  const rows = ["llm", "session", "tools", "agent-loop", "llm-retry", "settings", "credentials", "tool-bash", "tool-fs", "tool-web", "unexpected-new-plugin"].map(id => ({ id }));
  const patch = managedPatch(rows, "http://127.0.0.1:1234");
  for (const id of ["llm-retry", "settings", "credentials", "tool-bash", "tool-fs", "tool-web", "unexpected-new-plugin"]) {
    assert.equal(patch.find(row => row.id === id).disabled, true, id);
  }
});

const runtime = process.env.DSH_CHAT_TEST_RUNTIME;
const runner = fileURLToPath(new URL("./runner.mjs", import.meta.url));
const tool = JSON.parse(await readFile(new URL("../../../../../cloud/supabase/functions/_shared/chat-card-tool.json", import.meta.url), "utf8"));

async function runFixture(t, reply) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "bowerbird-dsh-test-"));
  const child = spawn(process.execPath, [runner], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => { child.kill(); await rm(workspace, { recursive: true, force: true }); });
  const events = [];
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const reader = createInterface({ input: child.stdout });
  reader.on("line", line => {
    const event = JSON.parse(line);
    events.push(event);
    if (["model", "tool"].includes(event.type)) {
      const result = reply(event, events);
      if (result === undefined) { child.stdin.end(); return; }
      child.stdin.write(`${JSON.stringify({ type: "result", id: event.id, ...result })}\n`);
    }
  });
  child.stdin.write(`${JSON.stringify({ type: "start", prompt: "Create a content card in a section", tools: [tool], runtime, workspace })}\n`);
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`runner timeout: ${stderr}`)); }, 25000);
    child.once("exit", code => { clearTimeout(timer); resolve(code); });
    child.once("error", reject);
  });
  return { events, exit, stderr };
}

test("pinned DSH runs the card tool loop through the host and returns text", { skip: !runtime }, async t => {
  const args = { cards: [{ id: "a", kind: "content", title: "A", text: "hello" }], sections: [{ id: "s", title: "Section", members: ["a"] }] };
  let models = 0;
  const result = await runFixture(t, event => {
    if (event.type === "tool") {
      assert.equal(event.id, "create-1");
      assert.equal(event.name, "create_canvas_cards");
      assert.deepEqual(event.args, args);
      return { result: { cards: [{ id: "saved" }], sections: [{ id: "section-saved" }] } };
    }
    models++;
    assert.ok(event.messages.every(message => message.role !== "system"));
    if (models === 1) return { result: { role: "assistant", content: null, tool_calls: [{ id: "create-1", type: "function", function: { name: "create_canvas_cards", arguments: JSON.stringify(args) } }] } };
    assert.ok(event.messages.some(message => message.role === "tool" && message.tool_call_id === "create-1" && message.content.includes("section-saved")));
    return { result: { role: "assistant", content: "卡片和分区已创建。" } };
  });
  assert.equal(result.exit, 0, JSON.stringify(result.events) + result.stderr);
  assert.equal(models, 2);
  assert.equal(result.events.filter(event => event.type === "tool").length, 1);
  assert.equal(result.events.filter(event => event.type === "text").map(event => event.text).join(""), "卡片和分区已创建。");
  assert.equal(result.events.at(-1).type, "done");
});

test("unknown model outcome aborts without retrying or dispatching tools", { skip: !runtime }, async t => {
  const result = await runFixture(t, () => ({ error: "CHAT_OUTCOME_UNKNOWN" }));
  assert.equal(result.events.filter(event => event.type === "model").length, 1, JSON.stringify(result.events) + result.stderr);
  assert.equal(result.events.filter(event => event.type === "tool").length, 0);
  assert.equal(result.events.at(-1).type, "error");
  assert.notEqual(result.exit, 0);
});

test("stdin close cancels a pending model request and exits", { skip: !runtime }, async t => {
  const result = await runFixture(t, () => undefined);
  assert.equal(result.events.filter(event => event.type === "model").length, 1);
  assert.equal(result.events.at(-1).error, "DSH_CANCELLED");
  assert.notEqual(result.exit, 0);
});

test("DSH model loop is capped at twelve host completions", { skip: !runtime }, async t => {
  let models = 0;
  const result = await runFixture(t, event => {
    if (event.type === "tool") return { result: { cards: [] } };
    models++;
    return { result: { role: "assistant", content: null, tool_calls: [{ id: `call-${models}`, type: "function", function: { name: "create_canvas_cards", arguments: '{"cards":[]}' } }] } };
  });
  assert.equal(models, 12, JSON.stringify(result.events));
  assert.equal(result.events.at(-1).error, "DSH_MODEL_TURN_LIMIT");
});

test("runtime check starts the real ACP profile without a model or user configuration", { skip: !runtime }, async t => {
  const child = spawn(process.execPath, [runner, "--check", runtime], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  const exit = await new Promise(resolve => child.once("exit", resolve));
  assert.equal(exit, 0, stdout);
  assert.deepEqual(stdout.trim().split("\n").map(JSON.parse), [{ ready: true, version: "0.1.1-rc.2" }]);
});
