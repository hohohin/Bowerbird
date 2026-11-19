import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("native resume passes the selected route to agents without requiring agent.model", async () => {
  // Exercise the shipped bridge against the pinned 0.1 AgentHandle surface.
  // In particular, model is not an Agent property in the deployed harness.
  const source = readFileSync(new URL("./native-chat-acp.mjs", import.meta.url), "utf8");
  let api;
  let resumed;
  const sandbox = {
    process: { env: { BOWERBIRD_DSH_SESSION_ID: "session", BOWERBIRD_DSH_CHAT_MODEL: "deepseek-pro", BOWERBIRD_DSH_CHAT_EFFORT: "high" }, stdout: {}, stdin: {} },
    AgentSideConnection: class { constructor(factory) { api = factory(); } },
    Writable: { toWeb: () => ({}) }, Readable: { toWeb: () => ({}) }, ndJsonStream: () => ({}),
  };
  runInNewContext(source.slice(source.indexOf("export const name")).replaceAll("export ", ""), sandbox);
  sandbox.apply({ on() {}, agents: { async resume(options) {
    resumed = options;
    return { agent: { session: { id: "session" } } };
  } } });
  await assert.rejects(() => api.loadSession({ sessionId: "other" }), /invalid_session/);
  await api.loadSession({ sessionId: "session" });
  assert.deepEqual(JSON.parse(JSON.stringify(resumed)), {
    resumeSessionId: "session", agentOptions: { provider: "deepseek-official", model: "deepseek-pro", reasoningEffort: "high" },
  });
  await assert.rejects(() => api.loadSession({ sessionId: "session" }), /invalid_session/);
});

