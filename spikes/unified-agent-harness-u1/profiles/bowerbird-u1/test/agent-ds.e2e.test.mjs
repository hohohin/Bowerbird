import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { startLoopbackToolBridge } from "../../../../../apps/agent-worker/src/harness/loopback-tool-bridge-server.ts";
import { createAgentDsToolDispatch, newAgentDsSession, runAgentDsDshTurn } from "../../../../../apps/agent-worker/src/local/agent-ds-dsh.ts";
import { NodeDshAcpPort } from "../scripts/dsh-acp-port.mjs";
import { spikeRoot } from "../scripts/runtime.mjs";

const AGENT_DS_PATCH = "profiles/bowerbird-u1/cordis.agent-ds.patch.yml";
// 1x1 valid PNG：DSH 附件层会解码投影，不能用任意 base64。
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function toolCallSse(name, argumentsValue, sequence) {
  const event = {
    id: `fixture-${sequence}`,
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: `fixture-call-${sequence}`,
          type: "function",
          function: { name, arguments: JSON.stringify(argumentsValue) },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 12,
    },
  };
  return `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`;
}

function textSse(text, sequence) {
  const event = {
    id: `fixture-${sequence}`,
    choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 12,
    },
  };
  return `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`;
}

test("real DSH in agent-ds mode exposes the two Bowerbird tools, sees the inline image and chats", async () => {
  const requests = [];
  const rpcCalls = [];
  const events = [];
  const server = createServer(async (request, response) => {
    // 适配器带图请求先试 Files API（POST /files，multipart）；本地计量代理对该路由
    // 回 404，适配器按合同回退 inline data URL——假服务器复现同一行为。
    if (!request.url?.startsWith("/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "files api unavailable" } }));
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    const wire = JSON.parse(body);
    requests.push(wire);
    assert.equal(wire.model, "deepseek-flash");
    if (requests.length === 1) {
      assert.deepEqual(
        wire.tools.map((tool) => tool.function.name).sort(),
        ["dreamina_generate", "understand_asset"],
      );
      const serialized = JSON.stringify(wire);
      assert.ok(serialized.includes("Agent DS"));
      assert.ok(!serialized.includes("Bowerbird's creative Agent"));
      assert.ok(!serialized.includes("request_task_authorization"));
      assert.ok(!serialized.includes("list_run_assets"));
      assert.ok(serialized.includes("画一张蓝色小鸟"));
      // deepseek-flash 在 agent-ds patch 声明多模态：prompt 的 image block 应进入 wire
      assert.ok(serialized.includes("image_url"));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(toolCallSse("understand_asset", { image_path: "D:/a.png" }, 1));
    } else {
      assert.equal(requests.length, 2);
      const toolMessages = wire.messages.filter((message) => message.role === "tool");
      assert.equal(toolMessages.length, 1);
      assert.ok(toolMessages[0].content.includes("蓝色小鸟"));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(textSse("参考图画的是一只蓝色小鸟，已按此理解你的需求。", 2));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const bridge = await startLoopbackToolBridge(createAgentDsToolDispatch({
    rpc: async (tool, args) => {
      rpcCalls.push({ tool, args });
      return { text: "画面主体是一只蓝色小鸟" };
    },
    emit: (event) => events.push(event),
  }));
  const previous = Object.fromEntries(
    ["BOWERBIRD_U1_ALLOW_NETWORK", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    BOWERBIRD_U1_ALLOW_NETWORK: "1",
    DEEPSEEK_API_KEY: "fixture-only",
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  });
  try {
    const port = new NodeDshAcpPort({ allowNetwork: true, patches: [AGENT_DS_PATCH], toolBridge: bridge.childEnvironment() });
    await port.initialize();
    const { sessionId } = await port.newSession({ cwd: spikeRoot });
    const updated = await runAgentDsDshTurn({
      openSession: async () => ({
        prompt: (blocks, onText) =>
          port.prompt({ sessionId, prompt: blocks }, (content) => {
            if (content.type === "text") onText(content.text);
          }),
        dispose: () => port.dispose(),
      }),
      readImageFile: (path) => (path === "D:/a.png" ? { mimeType: "image/png", base64: PNG_1x1 } : null),
      emit: (event) => events.push(event),
    }, newAgentDsSession(), "画一张蓝色小鸟", ["D:/a.png"]);
    assert.equal(requests.length, 2);
    assert.deepEqual(rpcCalls, [{ tool: "understand_asset", args: { image_path: "D:/a.png" } }]);
    assert.deepEqual(events[0], { kind: "ds_status", phase: "tool", text: "Agent DS 正在反推图片…" });
    assert.equal(events.filter((event) => event.kind === "ds_reply").length, 1);
    assert.ok(events.find((event) => event.kind === "ds_reply").text.includes("蓝色小鸟"));
    assert.equal(updated.turns.length, 2);
    assert.deepEqual(updated.turns[0], { role: "user", text: "画一张蓝色小鸟", images: ["D:/a.png"] });
  } finally {
    await bridge.close();
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
