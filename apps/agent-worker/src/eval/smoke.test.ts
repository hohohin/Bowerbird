import { test } from "node:test";
import { ok, equal } from "node:assert/strict";
import type { ModelBackend, ModelTurnResult } from "../contracts/model.ts";

// 冒烟测试：验证 Node v24 类型剥离 + node --test 工具链能跑通契约 .ts，
// 并锁定 ModelBackend 契约的最小行为形状（v1 冻结点）。
test("smoke: ModelBackend contract shape is usable", async () => {
  const fake: ModelBackend = {
    id: "fake",
    async turn(req) {
      ok(req.runId, "turn request carries runId");
      ok(req.allowedActions.length > 0, "kernel hands allowedActions");
      const result: ModelTurnResult = {
        kind: "action",
        action: req.allowedActions[0]!.name,
        arguments: {},
        providerUsage: { totalTokens: 1 },
      };
      return result;
    },
  };
  const out = await fake.turn(
    {
      runId: "r-1",
      phase: "p",
      systemPolicy: "",
      skillInstructions: "",
      context: [],
      allowedActions: [{ name: "ping", kind: "read_only", description: "", argumentSchema: {} }],
      responseSchemaVersion: 1,
    },
    { aborted: false },
  );
  equal(out.kind, "action");
  if (out.kind === "action") equal(out.action, "ping");
});
