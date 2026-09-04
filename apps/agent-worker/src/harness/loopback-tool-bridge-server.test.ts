import { deepEqual, equal, ok, rejects, throws } from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  startLoopbackToolBridge,
  TOOL_BRIDGE_CAPABILITY_ENV,
  TOOL_BRIDGE_ENDPOINT_ENV,
  type PlanningToolDispatchPort,
} from "./loopback-tool-bridge-server.ts";
import { canonicalJson, deriveCallId, sha256Hex } from "../kernel/tool-ledger.ts";
import { createRunControlToolDefinitions, type RunAssetManifest, type RunControlToolsPort } from "./run-control-tools.ts";
import { ScopedToolGateway, ToolGatewayError } from "./scoped-tool-gateway.ts";
import { UnifiedPlanningToolBridge } from "./unified-planning-tool-bridge.ts";

function request(environment: Readonly<Record<string, string>>, body: unknown, capability?: string): Promise<Response> {
  return fetch(environment[TOOL_BRIDGE_ENDPOINT_ENV]!, {
    method: "POST",
    headers: {
      authorization: `Bearer ${capability ?? environment[TOOL_BRIDGE_CAPABILITY_ENV]}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function callFromIsolatedPluginChild(
  environment: Readonly<Record<string, string>>,
  body: unknown,
): Promise<unknown> {
  const childEnv: Record<string, string> = { ...environment };
  for (const key of ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value) childEnv[key] = value;
  }
  const fixture = resolve(
    import.meta.dirname,
    "../../../../spikes/unified-agent-harness-u1/profiles/bowerbird-u1/scripts/planning-plugin-fixture.mjs",
  );
  const child = spawn(process.execPath, [fixture], {
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(body));
  const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code) => resolveExit(code ?? -1));
  });
  equal(exitCode, 0, stderr);
  return JSON.parse(stdout);
}

test("loopback bridge accepts one capability-bound name+arguments request and hides call identity", async () => {
  const calls: unknown[] = [];
  const dispatcher: PlanningToolDispatchPort = {
    async dispatch(call) {
      calls.push(call);
      return { callId: "parent-only-call-id", value: { schemaVersion: 1, assets: [] } };
    },
  };
  const server = await startLoopbackToolBridge(dispatcher);
  try {
    ok(/^http:\/\/127\.0\.0\.1:\d+\/v1\/run-tools\/call$/.test(server.endpoint));
    const environment = server.childEnvironment();
    equal(Object.keys(environment).length, 2);
    equal(Object.isFrozen(environment), true);

    const response = await request(environment, { toolName: "list_run_assets", arguments: {} });
    equal(response.status, 200);
    deepEqual(await response.json(), { ok: true, value: { schemaVersion: 1, assets: [] } });
    const childResult = await callFromIsolatedPluginChild(environment, {
      toolName: "list_run_assets",
      arguments: {},
    });
    deepEqual(childResult, { ok: true, value: { schemaVersion: 1, assets: [] } });
    deepEqual(calls, [
      { toolName: "list_run_assets", arguments: {} },
      { toolName: "list_run_assets", arguments: {} },
    ]);
  } finally {
    await server.close();
  }
  throws(() => server.childEnvironment(), /tool_bridge_closed/);
  await rejects(() => fetch(server.endpoint), /fetch failed/);
});

test("isolated plugin child reaches the real parent Planning Bridge with parent-derived identity", async () => {
  const assets: RunAssetManifest["assets"] = [{
    assetId: "asset-current",
    role: "input",
    mime: "image/png",
    width: 640,
    height: 480,
  }];
  const manifest: RunAssetManifest = {
    schemaVersion: 1,
    runId: "run-loopback-e2e",
    manifestHash: sha256Hex(canonicalJson({ schemaVersion: 1, assets })),
    assets,
  };
  const identities: unknown[] = [];
  const port: RunControlToolsPort = {
    async readRunAssets(identity) {
      identities.push(identity);
      return manifest;
    },
    async requestPlanApproval() {
      throw new Error("not_used");
    },
  };
  const claimed = {
    run: {
      id: manifest.runId,
      conversationId: "conversation-loopback-e2e",
      skillId: "unified-agent",
      skillVersion: "0.1.0",
      inputManifestHash: "a".repeat(64),
      approvedPlanHash: null,
      plannedToolCount: null,
      resultFeedbackAction: null,
      budgetCredits: 10,
      pricingVersion: 1,
      checkpointHash: null,
      snapshotSchemaVersion: null,
    },
    lease: { leaseId: "lease-loopback-e2e", leaseSeconds: 60 },
    artifactUrls: [{
      artifactId: "asset-current",
      conversationId: "conversation-loopback-e2e",
      runId: manifest.runId,
      role: "input" as const,
      mime: "image/png" as const,
      bytes: 24,
      sha256: "b".repeat(64),
      width: 640,
      height: 480,
      userVisible: true,
    }],
  };
  const bridge = new UnifiedPlanningToolBridge({
    claimed,
    gateway: new ScopedToolGateway(createRunControlToolDefinitions(port)),
  });
  const server = await startLoopbackToolBridge(bridge);
  try {
    const environment = server.childEnvironment();
    deepEqual(await callFromIsolatedPluginChild(environment, {
      toolName: "list_run_assets",
      arguments: {},
    }), { ok: true, value: manifest });
    deepEqual(identities, [{
      runId: manifest.runId,
      leaseId: claimed.lease.leaseId,
      callId: deriveCallId({ runId: manifest.runId, phase: "compose_plan", logicalSlot: 0, revisionIndex: 0 }),
      phase: "compose_plan",
      toolName: "list_run_assets",
    }]);

    const injected = await request(environment, {
      toolName: "list_run_assets",
      arguments: { runId: "model-injected" },
    });
    equal(injected.status, 409);
    deepEqual(await injected.json(), { ok: false, error: { code: "tool_arguments_invalid" } });
    equal(identities.length, 1);
  } finally {
    await server.close();
  }
});

test("loopback bridge rejects invalid capability, wrapper injection, oversized bodies and safe-maps errors", async () => {
  let dispatches = 0;
  const server = await startLoopbackToolBridge({
    async dispatch(call) {
      dispatches += 1;
      if (call.toolName === "submit_plan") throw new ToolGatewayError("tool_arguments_invalid");
      throw new Error("provider secret detail must not escape");
    },
  });
  try {
    const environment = server.childEnvironment();
    const unauthorized = await request(environment, { toolName: "list_run_assets", arguments: {} }, "wrong");
    equal(unauthorized.status, 401);

    const injected = await request(environment, {
      toolName: "list_run_assets",
      arguments: {},
      runId: "model-injected",
    });
    equal(injected.status, 400);

    const denied = await request(environment, { toolName: "submit_plan", arguments: {} });
    equal(denied.status, 409);
    deepEqual(await denied.json(), { ok: false, error: { code: "tool_arguments_invalid" } });

    const failed = await request(environment, { toolName: "unknown_tool", arguments: {} });
    equal(failed.status, 502);
    deepEqual(await failed.json(), { ok: false, error: { code: "tool_execution_failed" } });

    const oversized = await request(environment, {
      toolName: "list_run_assets",
      arguments: { text: "x".repeat(70 * 1024) },
    });
    equal(oversized.status, 413);
    equal(dispatches, 2);
  } finally {
    await server.close();
  }
});
