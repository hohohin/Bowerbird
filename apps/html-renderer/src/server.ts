/**
 * 内部 HTTP 服务 —— HTML-RENDER-PLAN.md H1-T1/T5。
 *
 * 只面向 Docker 内部网络上的 Agent Worker：
 *   - POST /render：Bearer 内部共享 secret（timing-safe 比对）+ 请求体上限 + 并发 1 队列；
 *   - GET  /healthz：fingerprint 与队列状态，无任何用户内容；
 *   - 无端口映射由部署层保证；本服务自身不做任何出站连接。
 * 响应错误只携带稳定错误码 + 安全文案；详细 reason 只进日志。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { RENDER_LIMITS } from "./limits.ts";
import type { InternalRenderResult } from "./contracts.ts";
import { renderFailure, type RenderErrorCode } from "./errors.ts";
import type { RenderLogger } from "./render-service.ts";

const FAILURE_STATUS: Record<RenderErrorCode, number> = {
  render_input_invalid: 400,
  render_html_unsafe: 400,
  render_resource_invalid: 400,
  render_document_too_large: 400,
  render_layout_unstable: 422,
  render_timeout: 504,
  render_capacity_busy: 429,
  render_output_invalid: 500,
  render_service_unavailable: 503,
};

export type RenderServerStatus = {
  startedAt: number;
  busy: boolean;
  queued: number;
  renderedCount: number;
  failedCount: number;
};

export type RenderServerOptions = {
  port: number;
  token: string;
  handleRender: (body: unknown) => Promise<InternalRenderResult>;
  health: () => Record<string, unknown>;
  log: RenderLogger;
};

export type RunningServer = {
  server: Server;
  status: RenderServerStatus;
  close: () => Promise<void>;
};

function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function startRenderServer(options: RenderServerOptions): RunningServer {
  const status: RenderServerStatus = { startedAt: Date.now(), busy: false, queued: 0, renderedCount: 0, failedCount: 0 };
  // 并发 1 + 有界等待队列：超过即 render_capacity_busy。
  const waiting: Array<() => void> = [];

  function enqueue(job: () => Promise<void>): boolean {
    if (status.busy) {
      if (waiting.length >= RENDER_LIMITS.maxQueueDepth) return false;
      waiting.push(job);
      status.queued = waiting.length;
      return true;
    }
    status.busy = true;
    void job().finally(() => {
      const next = waiting.shift();
      status.queued = waiting.length;
      if (next) {
        void next();
      } else {
        status.busy = false;
      }
    });
    return true;
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    if (req.method === "GET" && url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...options.health(), busy: status.busy, queued: waiting.length, uptimeSec: Math.floor((Date.now() - status.startedAt) / 1000), renderedCount: status.renderedCount, failedCount: status.failedCount }));
      return;
    }
    if (req.method === "POST" && url === "/render") {
      handleRenderRequest(req, res, options, status, enqueue, waiting);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, code: "render_service_unavailable", message: "not found" }));
  });

  function handleRenderRequest(
    req: IncomingMessage,
    res: ServerResponse,
    opts: RenderServerOptions,
    st: RenderServerStatus,
    submit: (job: () => Promise<void>) => boolean,
    queue: Array<() => void>,
  ): void {
    if (!tokenMatches(req.headers.authorization?.replace(/^Bearer\s+/i, ""), opts.token)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, code: "render_input_invalid", message: "unauthorized", retryable: false }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > RENDER_LIMITS.maxRequestBytes) {
        aborted = true;
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, code: "render_input_invalid", message: "request too large", retryable: false }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => undefined);
    req.on("end", () => {
      if (aborted) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, code: "render_input_invalid", message: "invalid json", retryable: false }));
        return;
      }
      const startedAt = Date.now();
      const requestId = extractRequestId(body);
      const accepted = submit(async () => {
        let result: InternalRenderResult;
        try {
          result = await opts.handleRender(body);
        } catch {
          result = renderFailure("render_service_unavailable");
        }
        if (result.ok) st.renderedCount += 1;
        else st.failedCount += 1;
        st.queued = queue.length;
        const statusCode = result.ok ? 200 : FAILURE_STATUS[result.code];
        const resHeaders = { "content-type": "application/json" };
        if (!res.headersSent) {
          res.writeHead(statusCode, resHeaders);
          res.end(JSON.stringify(result));
        }
        opts.log({ event: "render_response", requestId, ok: result.ok, code: result.ok ? undefined : result.code, status: statusCode, ms: Date.now() - startedAt });
      });
      if (!accepted) {
        st.failedCount += 1;
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify(renderFailure("render_capacity_busy")));
        return;
      }
      if (queue.length > 0) st.queued = queue.length;
    });
  }

  return {
    server,
    status,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function extractRequestId(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "requestId" in body && typeof (body as { requestId: unknown }).requestId === "string") {
    return (body as { requestId: string }).requestId;
  }
  return undefined;
}
