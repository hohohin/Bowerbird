import { deepEqual, equal, rejects, throws } from "node:assert/strict";
import { test } from "node:test";
import { computeArgsHash } from "../kernel/tool-ledger.ts";
import { AdaptiveToolGateway, type AdaptiveJournal, type AdaptiveAction } from "./adaptive-tool-gateway.ts";
import { parseTaskAuthorization, type TaskAuthorization } from "../contracts/task-authorization.ts";
import { parseTaskAuthorization as parseCloudAuthorization } from "../../../cloud/supabase/functions/_shared/task-authorization.ts";

const authorization: TaskAuthorization = { schemaVersion: 3, title: "产品场景", summary: "产品 A 的十张不同场景图片", assetIds: ["product-a"],
  outputCount: 10, modelTurns: 16, capabilities: [{ tool: "generate_image", maxCalls: 11 }, { tool: "inspect_artifact", maxCalls: 1 }] };
const initial = (): AdaptiveJournal => ({ authorizationHash: computeArgsHash(authorization), actions: [] });
const call = (toolName: string, actionId: string, input: unknown = {}) => ({ toolName, arguments: { actionId, input } });

test("task authorization is the same closed contract in Worker and Edge, without any step graph", () => {
  deepEqual(parseTaskAuthorization(authorization), parseCloudAuthorization(authorization));
  for (const value of [{ ...authorization, steps: [] }, { ...authorization, schemaVersion: 1 },
    { ...authorization, capabilities: [{ tool: "shell", maxCalls: 1 }] },
    { ...authorization, capabilities: [{ tool: "generate_image", maxCalls: 32 }] },
    { ...authorization, assetIds: ["product-a", "product-a"] }]) {
    throws(() => parseTaskAuthorization(value));
    throws(() => parseCloudAuthorization(value));
  }
});

test("ten images run concurrently, one result is inspected and replaced, then ten chosen outputs finalize", async () => {
  let active = 0, peak = 0, started = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const history: string[] = [];
  const gateway = new AdaptiveToolGateway(authorization, initial(), {
    validate: (_tool, value) => value,
    save: async () => {},
    async execute(action) {
      history.push(action.toolName);
      if (action.toolName === "generate_image") {
        active++; peak = Math.max(peak, active); started++;
        if (started === 10) release();
        await barrier;
        active--;
        return { artifactId: action.actionId };
      }
      if (action.toolName === "inspect_artifact") return { needsRepair: true, issue: "产品标签偏移" };
      return action.arguments;
    },
  });
  await Promise.all(Array.from({ length: 10 }, (_, index) => gateway.dispatch(call("generate_image", `scene-${index}`, { scene: index }))));
  equal(peak, 10);
  const inspection = await gateway.dispatch(call("inspect_artifact", "check-label", { assetId: "scene-2" }));
  equal((inspection.value as { needsRepair: boolean }).needsRepair, true);
  await gateway.dispatch(call("generate_image", "repair-label", { assetId: "scene-2", instruction: "修正标签" }));
  const outputs = Array.from({ length: 10 }, (_, index) => index === 2 ? "repair-label" : `scene-${index}`);
  await gateway.dispatch(call("finalize_output", "deliver", { outputs }));
  deepEqual(gateway.finalResult, { outputs });
  equal(history.length, 13);
  equal(history.includes("compose_html"), false);
});

test("duplicate actions share a flight; conflicting parameters and quota overflow do not execute", async () => {
  let executions = 0;
  const limited = { ...authorization, capabilities: [{ tool: "generate_image" as const, maxCalls: 1 }] };
  const gateway = new AdaptiveToolGateway(limited, { authorizationHash: computeArgsHash(limited), actions: [] }, {
    validate: (_tool, value) => value, save: async () => {}, execute: async () => { executions++; return { image: 1 }; },
  });
  const results = await Promise.all([gateway.dispatch(call("generate_image", "one")), gateway.dispatch(call("generate_image", "one"))]);
  deepEqual(results[0], results[1]);
  equal(executions, 1);
  equal((await gateway.dispatch(call("generate_image", "one", { change: true }))).value && executions, 1);
  const overflow = await gateway.dispatch(call("generate_image", "two"));
  equal((overflow.value as { errorCode: string }).errorCode, "adaptive_capability_limit_reached");
  equal(executions, 1);
});

test("checkpoint failure before reservation prevents effects; result-save crash replays the durable result", async () => {
  let effects = 0;
  const denied = new AdaptiveToolGateway(authorization, initial(), {
    validate: (_tool, value) => value, save: async () => { throw new Error("storage unavailable"); },
    execute: async () => { effects++; return {}; },
  });
  await rejects(() => denied.dispatch(call("generate_image", "one")), /storage unavailable/);
  equal(effects, 0);
  let saved = initial();
  const durable = new Map<number, unknown>();
  const execute = async (action: AdaptiveAction) => {
    if (!durable.has(action.slot)) { effects++; durable.set(action.slot, { artifactId: "persisted-image" }); }
    return durable.get(action.slot);
  };
  const beforeCrash = new AdaptiveToolGateway(authorization, saved, {
    validate: (_tool, value) => value, execute,
    save: async (journal) => {
      if (journal.actions.some((action) => action.status === "completed")) throw new Error("process crash");
      saved = JSON.parse(JSON.stringify(journal));
    },
  });
  await rejects(() => beforeCrash.dispatch(call("generate_image", "one")), /process crash/);
  const recovered = new AdaptiveToolGateway(authorization, saved, {
    validate: (_tool, value) => value, execute, save: async (journal) => { saved = journal; },
  });
  await recovered.recover();
  equal(effects, 1);
  equal(saved.actions[0]?.status, "completed");
  deepEqual((await recovered.dispatch(call("generate_image", "one"))).value, { artifactId: "persisted-image" });
});

test("another authorization cannot inherit the old journal", () => {
  throws(() => new AdaptiveToolGateway({ ...authorization, outputCount: 9 }, initial(), {
    validate: (_tool, value) => value, save: async () => {}, execute: async () => ({}),
  }), /authorization_mismatch/);
});
