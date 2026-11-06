// Actual installed DSH runtime + deterministic in-process model; no user profile or model API.
// node tests/dsh-local-preset-probe.mjs <directory containing @deepseek-ai packages>
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createServer } from "node:http";

const modules = resolve(process.argv[2]);
const require = createRequire(join(dirname(modules), "bowerbird-probe.cjs"));
const load = async name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
const { Context } = await load("cordis");
const { default: Loader } = await load("cordis-plugin-loader");
const { default: Include } = await load("cordis-plugin-include");
const { default: LlmRuntime, LlmAdapter } = await load("dsh-llm");
const { default: SessionStore } = await load("dsh-session");
const { default: SessionPersistence } = await load("dsh-session-persistence-jsonl");
const { default: SystemPrompt } = await load("dsh-system-prompt");
const { default: ToolRuntime } = await load("dsh-tools");
const { default: AgentRegistry } = await load("dsh-agent");
const { default: AgentLoop } = await load("dsh-agent-loop");
const { default: AgentPresets } = await load("dsh-agent-presets");
const { default: UserQuestions } = await load("dsh-user-questions");
const { createApiProxy, toFetchHandler } = await load("dsh-host-apiproxy");
const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(here, "../src/commands/local_chat_dsh_tool.mjs"), "utf8");
const tool = JSON.parse(await readFile(join(here, "../../../cloud/supabase/functions/_shared/chat-card-tool.json"), "utf8"));
const root = await mkdtemp(join(tmpdir(), "bowerbird-dsh-probe-"));
const preset = join(root, "fixture");
await mkdir(preset);
const received = [];
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  assert.equal(request.headers.authorization, "Bearer fixture-only");
  received.push(JSON.parse(raw));
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ success: true, action: { id: "fixture-action" } }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const connection = { endpoint: `http://127.0.0.1:${server.address().port}/cards`, token: "fixture-only", session: "fixture-session" };
await writeFile(join(preset, "bowerbird-tools.mjs"), `const connection=${JSON.stringify(connection)};\nconst tool=${JSON.stringify(tool)};\n${source}`);
await writeFile(join(preset, "agent.cordis.yml"), JSON.stringify([
  { id: "persona", name: "@deepseek-ai/dsh-persona", config: { text: "Only create requested cards.", complete: true, includeRuntimeContext: false } },
  { id: "cards", name: "./bowerbird-tools.mjs" },
]));
let ctx = new Context();
ctx.baseUrl = pathToFileURL(dirname(modules)).href + "/";
let requests = 0;
class FixtureModel extends LlmAdapter {
  async *stream(options) {
    assert.equal(options.provider, "fixture");
    assert.deepEqual(options.tools.map(tool => tool.name), ["create_canvas_cards"]);
    requests++;
    if (requests === 1) {
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 0, id: "fixture-call", name: "create_canvas_cards", argumentsDelta: JSON.stringify({ cards: [{ id: "text", kind: "content", title: "测试", text: "fixture" }] }) };
      yield { type: "finish", reason: { kind: "tool-calls" } };
    } else {
      assert.ok(JSON.stringify(options.messages).includes("fixture-action"));
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "卡片已创建" };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }
}
try {
  await ctx.plugin(Loader);
  ctx.loader.builtins.include = Include;
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionPersistence, { root: join(root, "sessions"), compression: "none" });
  await ctx.plugin(SystemPrompt, { persona: "" });
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(UserQuestions);
  ctx.llm.registerAdapter(["fixture"], new FixtureModel());
  ctx.tools.register({ name: "dangerous_global", description: "must remain hidden", parameters: { type: "object", properties: {} }, output: { schema: {}, render: () => [] }, execute: async () => { throw new Error("global tool executed"); } });
  await ctx.plugin(AgentPresets, { default: "fixture", roots: [{ path: root, trust: "user" }], includeUserRoot: false });
  let carrier = toFetchHandler(createApiProxy(ctx, { cwd: root, defaultModelSelection: () => ({ provider: "fixture", model: "fixture" }) }));
  const rpc = async (method, payload, rpcId = "fixture-request") => {
    const response = await carrier.fetch(new Request(`http://127.0.0.1/api/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "client-request", rpcId, method, payload }) }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.result.ok, true, JSON.stringify(result));
    return result.result.value;
  };
  const created = await rpc("session.create", { sessionId: connection.session, cwd: root, agentPreset: "fixture" });
  assert.equal(created.agentPreset, "fixture");
  const agent = ctx.agents.get(connection.session);
  assert.deepEqual(ctx.tools.schemas(agent).map(tool => tool.name), ["create_canvas_cards"]);
  assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), ["dangerous_global"]);
  assert.deepEqual(await rpc("session.prompt", { sessionId: connection.session, mode: "queue", content: [{ type: "text", text: "Create a text card." }] }), { accepted: true });
  await agent.whenIdle();
  assert.equal(requests, 2);
  assert.equal(received.length, 1, JSON.stringify(agent.session.events.filter(event => event.type === "tool/result")));
  assert.equal(received[0].sessionId, connection.session);
  assert.equal(received[0].callId, "fixture-call");
  assert.equal(received[0].arguments.cards[0].title, "测试");
  assert.equal(agent.session.events.findLast(event => event.type === "turn/end").data.reason.kind, "completed");
  assert.equal(agent.session.events.find(event => event.type === "user/message").data.source.rpcId, "fixture-request");
  assert.equal(agent.session.events.findLast(event => event.type === "assistant/message").data.message.content[0].text, "卡片已创建");
  const history = await rpc("session.history", { sessionId: connection.session, maxMessages: 30 });
  assert.equal(history.events.find(entry => entry.event.type === "user/message").event.data.source.rpcId, "fixture-request");
  assert.equal(history.events.findLast(entry => entry.event.type === "turn/end").event.data.reason.kind, "completed");
  await ctx.sessions.flush(agent.session);
  const visibleTools = ctx.tools.schemas(agent).map(tool => tool.name);
  await ctx.fiber.dispose();
  await rm(join(preset, "agent.cordis.yml"));
  await rm(join(preset, "bowerbird-tools.mjs"));
  ctx = new Context();
  ctx.baseUrl = pathToFileURL(dirname(modules)).href + "/";
  await ctx.plugin(Loader);
  ctx.loader.builtins.include = Include;
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionPersistence, { root: join(root, "sessions"), compression: "none" });
  await ctx.plugin(SystemPrompt, { persona: "" });
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(UserQuestions);
  await ctx.plugin(AgentPresets, { default: "fixture", roots: [{ path: root, trust: "user" }], includeUserRoot: false });
  carrier = toFetchHandler(createApiProxy(ctx, { cwd: root, defaultModelSelection: () => ({ provider: "fixture", model: "fixture" }) }));
  const restored = await rpc("session.history", { sessionId: connection.session, maxMessages: 30 });
  assert.equal(restored.events.findLast(entry => entry.event.type === "turn/end").event.data.reason.kind, "completed");
  assert.equal(ctx.agents.get(connection.session), undefined, "history recovery must not resume a model agent");
  console.log(JSON.stringify({ passed: true, runtime: "installed DSH", modelRequests: requests, toolCallbacks: received.length, visibleTools, coldHistoryAfterPresetCleanup: true }));
} finally {
  await ctx.fiber.dispose();
  await new Promise(resolve => server.close(resolve));
  if (root.startsWith(join(tmpdir(), "bowerbird-dsh-probe-"))) await rm(root, { recursive: true, force: true });
}
