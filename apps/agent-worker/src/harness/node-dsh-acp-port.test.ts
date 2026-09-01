import { deepEqual, equal, ok, rejects, throws } from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { HarnessPromptBlock } from "./contracts.ts";
import type { DshRuntimeHome } from "./dsh-runtime-home.ts";
import {
  buildDshChildEnvironment,
  NodeDshAcpPort,
  type NodeDshAcpPortDependencies,
} from "./node-dsh-acp-port.ts";
import {
  TOOL_BRIDGE_CAPABILITY_ENV,
  TOOL_BRIDGE_ENDPOINT_ENV,
} from "./loopback-tool-bridge-server.ts";

function root(name: string): string {
  return join(tmpdir(), `bowerbird-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function bridgeEnvironment(): Record<string, string> {
  return {
    [TOOL_BRIDGE_ENDPOINT_ENV]: "http://127.0.0.1:43210/v1/run-tools/call",
    [TOOL_BRIDGE_CAPABILITY_ENV]: "a".repeat(64),
  };
}

function template(directory: string): void {
  mkdirSync(join(directory, "plugins"), { recursive: true });
  mkdirSync(join(directory, "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  for (const file of ["package.json", "cordis.yml", "cordis.patch.yml", "cordis.bridge.patch.yml", "cordis.controlled-model.patch.yml", "cordis.html-execution.patch.yml", "cordis.content-execution.patch.yml"]) {
    writeFileSync(join(directory, file), file, "utf8");
  }
  for (const file of ["bowerbird-planning-rpc.mjs", "bowerbird-planning-tools.mjs", "bowerbird-controlled-model-tools.mjs", "bowerbird-html-execution-tools.mjs", "bowerbird-content-execution-tools.mjs"]) {
    writeFileSync(join(directory, "plugins", file), file, "utf8");
  }
  writeFileSync(join(directory, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), "bin", "utf8");
}

test("formal Node DSH port scopes environment, forwards committed text, cancels and cleans its home", async () => {
  const fixture = root("node-dsh-port");
  const profile = join(fixture, "template");
  const runtimeRoot = join(fixture, "runtime");
  template(profile);
  let spawnOptions: { cwd?: string; env: Record<string, string> } | undefined;
  let spawnArguments: string[] = [];
  let cancelled = 0;
  let callbacks: { sessionUpdate(params: { update: unknown }): Promise<void> } | undefined;
  const child = {
    exitCode: 0,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    once() {},
    kill() { return true; },
  };
  class FakeConnection {
    constructor(factory: () => typeof callbacks) {
      callbacks = factory();
    }
    async initialize(args: { protocolVersion: number }) {
      return { protocolVersion: args.protocolVersion };
    }
    async newSession() {
      return { sessionId: "session-formal" };
    }
    async prompt() {
      await callbacks?.sessionUpdate({
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "committed" } },
      });
      return { stopReason: "end_turn" };
    }
    async cancel() {
      cancelled += 1;
    }
  }
  const dependencies = {
    async loadAcp() {
      return {
        PROTOCOL_VERSION: 1,
        ndJsonStream() { return {}; },
        ClientSideConnection: FakeConnection,
      };
    },
    spawnProcess(_command: string, args: string[], options: { cwd?: string; env: Record<string, string> }) {
      spawnArguments = args;
      spawnOptions = options;
      return child;
    },
  } as unknown as NodeDshAcpPortDependencies;

  try {
    const port = await NodeDshAcpPort.create({
      profileTemplateDir: profile,
      runtimeRoot,
      childEnvironment: bridgeEnvironment(),
      profileMode: "html-execution",
      parentEnvironment: {
        PATH: "fixture-path",
        DEEPSEEK_API_KEY: "must-not-pass-without-provider-mode",
        ARK_API_KEY: "must-never-pass",
        SUPABASE_SERVICE_ROLE_KEY: "must-never-pass",
      },
    }, dependencies);
    ok(spawnOptions?.cwd?.startsWith(runtimeRoot));
    equal(spawnArguments[0], "--expose-internals");
    equal(spawnArguments.at(-1), "profiles\\bowerbird-u1\\cordis.html-execution.patch.yml".replaceAll("\\", process.platform === "win32" ? "\\" : "/"));
    equal(spawnOptions?.env.DSH_HOME, spawnOptions?.cwd);
    equal(spawnOptions?.env.DEEPSEEK_API_KEY, undefined);
    equal(spawnOptions?.env.ARK_API_KEY, undefined);
    equal(spawnOptions?.env.SUPABASE_SERVICE_ROLE_KEY, undefined);
    equal((await port.initialize()).protocolVersion, 1);
    equal((await port.newSession({ cwd: runtimeRoot })).sessionId, "session-formal");
    const committed: HarnessPromptBlock[] = [];
    equal((await port.prompt({ sessionId: "session-formal", prompt: [{ type: "text", text: "hello" }] },
      (content) => committed.push(content))).stopReason, "end_turn");
    deepEqual(committed, [{ type: "text", text: "committed" }]);
    await port.cancel({ sessionId: "session-formal" });
    equal(cancelled, 1);
    const home = spawnOptions?.cwd ?? "";
    await port.dispose();
    equal(existsSync(home), false);
    equal(existsSync(profile), true);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("formal Node DSH port passes only the loopback model proxy capability and rejects widening", () => {
  const runtime: DshRuntimeHome = {
    home: "/bounded/dsh-home",
    profileName: "bowerbird-u1",
    dshBin: "/immutable/bin.js",
    bridgePatch: "profiles/bowerbird-u1/cordis.bridge.patch.yml",
    controlledModelPatch: "profiles/bowerbird-u1/cordis.controlled-model.patch.yml",
    htmlExecutionPatch: "profiles/bowerbird-u1/cordis.html-execution.patch.yml",
    contentExecutionPatch: "profiles/bowerbird-u1/cordis.content-execution.patch.yml",
    dispose() {},
  };
  const environment = buildDshChildEnvironment(runtime, {
    profileTemplateDir: "/immutable",
    runtimeRoot: "/bounded",
    childEnvironment: bridgeEnvironment(),
    providerEnvironment: {
      DEEPSEEK_API_KEY: "c".repeat(64),
      DEEPSEEK_BASE_URL: "http://127.0.0.1:43124",
    },
    parentEnvironment: {
      PATH: "/usr/bin",
      DEEPSEEK_API_KEY: "real-parent-key-must-not-pass",
      DEEPSEEK_BASE_URL: "https://api.deepseek.example",
      ARK_API_KEY: "must-not-pass",
      AGENT_WORKER_TOKEN: "must-not-pass",
    },
  });
  equal(environment.DEEPSEEK_API_KEY, "c".repeat(64));
  equal(environment.DEEPSEEK_BASE_URL, "http://127.0.0.1:43124");
  equal(environment.ARK_API_KEY, undefined);
  equal(environment.AGENT_WORKER_TOKEN, undefined);
  throws(() => buildDshChildEnvironment(runtime, {
    profileTemplateDir: "/immutable",
    runtimeRoot: "/bounded",
    childEnvironment: { ...bridgeEnvironment(), EXTRA: "widened" },
  }), /dsh_tool_bridge_environment_invalid/);
  throws(() => buildDshChildEnvironment(runtime, {
    profileTemplateDir: "/immutable",
    runtimeRoot: "/bounded",
    childEnvironment: bridgeEnvironment(),
    providerEnvironment: {
      DEEPSEEK_API_KEY: "real-key",
      DEEPSEEK_BASE_URL: "https://api.deepseek.example",
    },
  }), /dsh_model_proxy_environment_invalid/);
});

test("formal Node DSH port rejects an incomplete immutable profile before spawning", async () => {
  let spawned = 0;
  const dependencies = {
    async loadAcp() { return {}; },
    spawnProcess() { spawned += 1; throw new Error("should_not_spawn"); },
  } as unknown as NodeDshAcpPortDependencies;
  await rejects(() => NodeDshAcpPort.create({
    profileTemplateDir: root("missing-profile"),
    runtimeRoot: root("runtime"),
    childEnvironment: bridgeEnvironment(),
  }, dependencies), /dsh_profile_template_incomplete/);
  equal(spawned, 0);
});
