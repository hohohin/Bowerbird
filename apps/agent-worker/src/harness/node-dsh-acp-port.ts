import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HarnessPromptBlock } from "./contracts.ts";
import type { DshAcpCommittedContent, DshAcpPort } from "./dsh-acp-harness-adapter.ts";
import { createDshRuntimeHome, type DshRuntimeHome } from "./dsh-runtime-home.ts";
import {
  TOOL_BRIDGE_CAPABILITY_ENV,
  TOOL_BRIDGE_ENDPOINT_ENV,
} from "./loopback-tool-bridge-server.ts";

const DEFAULT_TIMEOUT_MS = 90_000;
const BRIDGE_ENDPOINT = /^http:\/\/127\.0\.0\.1:\d+\/v1\/run-tools\/call$/;
const BRIDGE_CAPABILITY = /^[0-9a-f]{64}$/;
const MODEL_PROXY_BASE_URL = /^http:\/\/127\.0\.0\.1:\d+$/;
const WINDOWS_RUNTIME_ENV = ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"] as const;
const POSIX_RUNTIME_ENV = ["PATH", "TMPDIR", "LANG", "LC_ALL"] as const;

type AcpClientCallbacks = {
  requestPermission(): Promise<{ outcome: { outcome: "cancelled" } }>;
  sessionUpdate(params: { update: unknown }): Promise<void>;
  readTextFile(): Promise<never>;
  writeTextFile(): Promise<never>;
};

type AcpConnection = {
  initialize(args: { protocolVersion: number; clientCapabilities: Record<string, never> }): Promise<{ protocolVersion: number }>;
  newSession(args: { cwd: string; mcpServers: never[]; additionalDirectories: never[] }): Promise<{ sessionId: string }>;
  prompt(args: { sessionId: string; prompt: HarnessPromptBlock[] }): Promise<{ stopReason: string }>;
  cancel(args: { sessionId: string }): Promise<void>;
};

type AcpModule = {
  PROTOCOL_VERSION: number;
  ndJsonStream(writable: unknown, readable: unknown): unknown;
  ClientSideConnection: new (callbacks: () => AcpClientCallbacks, stream: unknown) => AcpConnection;
};

export type NodeDshAcpPortOptions = {
  profileTemplateDir: string;
  runtimeRoot: string;
  childEnvironment: Readonly<Record<string, string>>;
  providerEnvironment?: Readonly<Record<string, string>>;
  parentEnvironment?: Record<string, string | undefined>;
  timeoutMs?: number;
  profileMode?: "planning" | "controlled-model" | "html-execution" | "content-execution";
};

export type NodeDshAcpPortDependencies = {
  loadAcp(profileTemplateDir: string): Promise<AcpModule>;
  spawnProcess: typeof spawn;
};

const DEFAULT_DEPENDENCIES: NodeDshAcpPortDependencies = {
  async loadAcp(profileTemplateDir) {
    const entry = join(
      profileTemplateDir,
      "node_modules",
      "@agentclientprotocol",
      "sdk",
      "dist",
      "acp.js",
    );
    return await import(pathToFileURL(entry).href) as unknown as AcpModule;
  },
  spawnProcess: spawn,
};

function exactBridgeEnvironment(value: Readonly<Record<string, string>>): Record<string, string> {
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== TOOL_BRIDGE_CAPABILITY_ENV || keys[1] !== TOOL_BRIDGE_ENDPOINT_ENV) {
    throw new Error("dsh_tool_bridge_environment_invalid");
  }
  const endpoint = value[TOOL_BRIDGE_ENDPOINT_ENV];
  const capability = value[TOOL_BRIDGE_CAPABILITY_ENV];
  if (!endpoint || !BRIDGE_ENDPOINT.test(endpoint) || !capability || !BRIDGE_CAPABILITY.test(capability)) {
    throw new Error("dsh_tool_bridge_environment_invalid");
  }
  return { [TOOL_BRIDGE_ENDPOINT_ENV]: endpoint, [TOOL_BRIDGE_CAPABILITY_ENV]: capability };
}

function exactProviderEnvironment(value: Readonly<Record<string, string>>): Record<string, string> {
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "DEEPSEEK_API_KEY" || keys[1] !== "DEEPSEEK_BASE_URL") {
    throw new Error("dsh_model_proxy_environment_invalid");
  }
  const capability = value.DEEPSEEK_API_KEY;
  const baseUrl = value.DEEPSEEK_BASE_URL;
  if (!capability || !BRIDGE_CAPABILITY.test(capability) || !baseUrl || !MODEL_PROXY_BASE_URL.test(baseUrl)) {
    throw new Error("dsh_model_proxy_environment_invalid");
  }
  return { DEEPSEEK_API_KEY: capability, DEEPSEEK_BASE_URL: baseUrl };
}

export function buildDshChildEnvironment(
  runtime: DshRuntimeHome,
  options: NodeDshAcpPortOptions,
): Record<string, string> {
  const parent = options.parentEnvironment ?? process.env;
  const environment: Record<string, string> = {};
  const runtimeKeys = process.platform === "win32" ? WINDOWS_RUNTIME_ENV : POSIX_RUNTIME_ENV;
  for (const key of runtimeKeys) {
    const value = parent[key];
    if (value) environment[key] = value;
  }
  Object.assign(environment, exactBridgeEnvironment(options.childEnvironment));
  environment.DSH_HOME = runtime.home;
  environment.DSH_TELEMETRY_DISABLED = "1";
  environment.DSH_PERMISSION_MODE = "read-only";

  if (options.providerEnvironment) Object.assign(environment, exactProviderEnvironment(options.providerEnvironment));
  return environment;
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timer: unknown;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`dsh_acp_${label}_timeout`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function committedContent(update: unknown): DshAcpCommittedContent | undefined {
  if (!update || typeof update !== "object" || Array.isArray(update)) return undefined;
  const record = update as Record<string, unknown>;
  if (record.sessionUpdate !== "agent_message_chunk") return undefined;
  const content = record.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new Error("dsh_acp_committed_content_invalid");
  }
  const block = content as Record<string, unknown>;
  if (block.type !== "text" || typeof block.text !== "string") {
    throw new Error("dsh_acp_committed_content_invalid");
  }
  return { type: "text", text: block.text };
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (processTerminated(child)) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function processTerminated(child: ReturnType<typeof spawn>): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export class NodeDshAcpPort implements DshAcpPort {
  private readonly runtime: DshRuntimeHome;
  private readonly child: ReturnType<typeof spawn>;
  private readonly connection: AcpConnection;
  private readonly protocolVersion: number;
  private readonly timeoutMs: number;
  private onCommittedContent?: (content: DshAcpCommittedContent) => void;
  private disposed = false;

  private constructor(args: {
    runtime: DshRuntimeHome;
    child: ReturnType<typeof spawn>;
    connection: AcpConnection;
    protocolVersion: number;
    timeoutMs: number;
  }) {
    this.runtime = args.runtime;
    this.child = args.child;
    this.connection = args.connection;
    this.protocolVersion = args.protocolVersion;
    this.timeoutMs = args.timeoutMs;
  }

  static async create(
    options: NodeDshAcpPortOptions,
    dependencies: NodeDshAcpPortDependencies = DEFAULT_DEPENDENCIES,
  ): Promise<NodeDshAcpPort> {
    const runtime = createDshRuntimeHome({
      templateDir: options.profileTemplateDir,
      runtimeRoot: options.runtimeRoot,
    });
    try {
      const acp = await dependencies.loadAcp(options.profileTemplateDir);
      const child = dependencies.spawnProcess(process.execPath, [
        "--expose-internals",
        runtime.dshBin,
        "--profile",
        runtime.profileName,
        "--patch",
        options.profileMode === "content-execution"
          ? runtime.contentExecutionPatch
          : options.profileMode === "html-execution"
          ? runtime.htmlExecutionPatch
          : options.profileMode === "controlled-model"
            ? runtime.controlledModelPatch
            : runtime.bridgePatch,
      ], {
        cwd: runtime.home,
        env: buildDshChildEnvironment(runtime, options),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", () => undefined);

      let port: NodeDshAcpPort | undefined;
      const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
      const connection = new acp.ClientSideConnection(
        () => ({
          async requestPermission() {
            return { outcome: { outcome: "cancelled" } };
          },
          async sessionUpdate(params) {
            const content = committedContent(params.update);
            if (content) port?.onCommittedContent?.(content);
          },
          async readTextFile() {
            throw new Error("dsh_filesystem_capability_not_advertised");
          },
          async writeTextFile() {
            throw new Error("dsh_filesystem_capability_not_advertised");
          },
        }),
        stream,
      );
      port = new NodeDshAcpPort({
        runtime,
        child,
        connection,
        protocolVersion: acp.PROTOCOL_VERSION,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      return port;
    } catch (error) {
      runtime.dispose();
      throw error;
    }
  }

  async initialize(): Promise<{ protocolVersion: number }> {
    return await withTimeout(this.connection.initialize({
      protocolVersion: this.protocolVersion,
      clientCapabilities: {},
    }), "initialize", this.timeoutMs);
  }

  async newSession(args: { cwd: string }): Promise<{ sessionId: string }> {
    return await withTimeout(this.connection.newSession({
      cwd: args.cwd,
      mcpServers: [],
      additionalDirectories: [],
    }), "new_session", this.timeoutMs);
  }

  async prompt(
    args: { sessionId: string; prompt: HarnessPromptBlock[] },
    onCommittedContent: (content: DshAcpCommittedContent) => void,
  ): Promise<{ stopReason: string }> {
    if (this.onCommittedContent) throw new Error("dsh_acp_prompt_concurrent");
    this.onCommittedContent = onCommittedContent;
    try {
      return await withTimeout(this.connection.prompt(args), "prompt", this.timeoutMs);
    } finally {
      this.onCommittedContent = undefined;
    }
  }

  async cancel(args: { sessionId: string }): Promise<void> {
    await withTimeout(this.connection.cancel(args), "cancel", this.timeoutMs);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (!processTerminated(this.child)) {
        this.child.stdin.end();
        await waitForExit(this.child, 2_000);
      }
      if (!processTerminated(this.child)) {
        this.child.kill("SIGKILL");
        await waitForExit(this.child, 5_000);
      }
      if (!processTerminated(this.child)) throw new Error("dsh_acp_child_stuck");
    } finally {
      if (processTerminated(this.child)) this.runtime.dispose();
    }
  }
}
