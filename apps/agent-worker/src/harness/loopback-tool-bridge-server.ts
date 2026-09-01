import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ToolGatewayError, type ToolGatewayResult } from "./scoped-tool-gateway.ts";
import type { HarnessModelToolCall } from "./unified-planning-tool-bridge.ts";

export const TOOL_BRIDGE_ENDPOINT_ENV = "BOWERBIRD_TOOL_BRIDGE_ENDPOINT";
export const TOOL_BRIDGE_CAPABILITY_ENV = "BOWERBIRD_TOOL_BRIDGE_CAPABILITY";

const REQUEST_PATH = "/v1/run-tools/call";
const MAX_REQUEST_BYTES = 64 * 1024;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export type PlanningToolDispatchPort = {
  dispatch(call: HarnessModelToolCall): Promise<ToolGatewayResult>;
};

type BridgeRequest = {
  toolName: string;
  arguments: unknown;
};

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  const bytes = new TextEncoder().encode(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(bytes.byteLength),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function authorized(request: IncomingMessage, capability: Uint8Array): boolean {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const candidate = new TextEncoder().encode(header.slice("Bearer ".length));
  return candidate.byteLength === capability.byteLength && timingSafeEqual(candidate, capability);
}

async function readRequest(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new BridgeHttpError(415, "content_type_invalid");
  }
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new BridgeHttpError(413, "request_too_large");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    request.on("data", (bytes) => {
      if (settled) return;
      total += bytes.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        settled = true;
        reject(new BridgeHttpError(413, "request_too_large"));
        return;
      }
      chunks.push(Uint8Array.from(bytes));
    });
    request.on("end", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    request.on("error", () => {
      if (!settled) {
        settled = true;
        reject(new BridgeHttpError(400, "request_invalid"));
      }
    });
  });
  if (total === 0) throw new BridgeHttpError(400, "request_invalid");
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(combined));
  } catch {
    throw new BridgeHttpError(400, "request_invalid");
  }
}

function parseBridgeRequest(value: unknown): BridgeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeHttpError(400, "request_invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "arguments" || keys[1] !== "toolName" ||
      typeof record.toolName !== "string" || !TOOL_NAME.test(record.toolName)) {
    throw new BridgeHttpError(400, "request_invalid");
  }
  return { toolName: record.toolName, arguments: record.arguments };
}

class BridgeHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "BridgeHttpError";
    this.status = status;
    this.code = code;
  }
}

function safeToolError(error: unknown): { status: number; code: string } {
  if (error instanceof ToolGatewayError) return { status: 409, code: error.code };
  return { status: 502, code: "tool_execution_failed" };
}

export class LoopbackToolBridgeServer {
  private closed = false;
  private readonly server: Server;
  private readonly endpointValue: string;
  private readonly capabilityValue: string;

  constructor(
    server: Server,
    endpointValue: string,
    capabilityValue: string,
  ) {
    this.server = server;
    this.endpointValue = endpointValue;
    this.capabilityValue = capabilityValue;
  }

  get endpoint(): string {
    return this.endpointValue;
  }

  /** The returned values are the only bridge secrets permitted in the DSH child. */
  childEnvironment(): Readonly<Record<string, string>> {
    if (this.closed) throw new Error("tool_bridge_closed");
    return Object.freeze({
      [TOOL_BRIDGE_ENDPOINT_ENV]: this.endpointValue,
      [TOOL_BRIDGE_CAPABILITY_ENV]: this.capabilityValue,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error?: Error) => error ? reject(error) : resolve());
    });
  }
}

export async function startLoopbackToolBridge(
  bridge: PlanningToolDispatchPort,
): Promise<LoopbackToolBridgeServer> {
  const capabilityValue = Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const capability = new TextEncoder().encode(capabilityValue);
  let active = true;

  const server = createServer(async (request, response) => {
    if (!active) {
      sendJson(response, 410, { ok: false, error: { code: "bridge_closed" } });
      return;
    }
    if (request.method !== "POST" || request.url !== REQUEST_PATH) {
      sendJson(response, 404, { ok: false, error: { code: "route_not_found" } });
      return;
    }
    if (!authorized(request, capability)) {
      sendJson(response, 401, { ok: false, error: { code: "capability_invalid" } });
      return;
    }

    try {
      const call = parseBridgeRequest(await readRequest(request));
      const result = await bridge.dispatch(call);
      sendJson(response, 200, { ok: true, value: result.value });
    } catch (error) {
      if (error instanceof BridgeHttpError) {
        sendJson(response, error.status, { ok: false, error: { code: error.code } });
        return;
      }
      const safe = safeToolError(error);
      sendJson(response, safe.status, { ok: false, error: { code: safe.code } });
    }
  });

  server.on("close", () => {
    active = false;
    capability.fill(0);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", () => reject(new Error("tool_bridge_listen_failed")));
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close(() => undefined);
    throw new Error("tool_bridge_address_invalid");
  }
  return new LoopbackToolBridgeServer(
    server,
    `http://127.0.0.1:${address.port}${REQUEST_PATH}`,
    capabilityValue,
  );
}
