import type { WorkerFetch } from "../cloud-generation/runtime.ts";

type JsonRecord = Record<string, unknown>;
type ControlConfig = { controlUrl: string; workerToken: string; workerId: string };

export class AgentControlError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`agent_control_http_${status}`);
    this.name = "AgentControlError";
    this.status = status;
  }
}

export class ControlDeadlineError extends Error {
  constructor() { super("control_deadline_exceeded"); }
}

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Each sequential consumer owns one transport. An RPC is sent at most once. */
export class ControlTransport {
  private readonly config: ControlConfig;
  private readonly fetch: WorkerFetch;
  private lease?: { id: string; durationMs: number; expiresAt: number };

  constructor(config: ControlConfig, fetchImpl: WorkerFetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  remainingMs(leaseId: string): number {
    if (!this.lease) return Infinity;
    return leaseId === this.lease.id ? Math.max(0, this.lease.expiresAt - performance.now()) : 0;
  }

  nextHeartbeatMs(leaseId: string, intervalMs: number): number {
    return Math.min(intervalMs, Math.max(1, Math.floor(this.remainingMs(leaseId) / 3)));
  }

  async post(body: JsonRecord): Promise<JsonRecord> {
    const leaseId = typeof body.leaseId === "string" ? body.leaseId : null;
    const remaining = leaseId ? this.remainingMs(leaseId) : Infinity;
    if (remaining <= 1) throw new AgentControlError(409);
    // Leave time for another heartbeat after a transient failure.
    const timeoutMs = Math.min(10_000, Math.floor(remaining / 2));
    const signal = AbortSignal.timeout(timeoutMs);
    const started = performance.now();
    try {
      const response = await this.fetch(this.config.controlUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.workerToken}`,
          "content-type": "application/json",
          "x-worker-id": this.config.workerId,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        if (body.action === "heartbeat" && response.status === 409 && this.lease && this.lease.id === leaseId) {
          this.lease.expiresAt = 0;
        }
        void response.body?.getReader().cancel().catch(() => {});
        throw new AgentControlError(response.status);
      }
      const text = await response.text();
      let result: unknown;
      try { result = JSON.parse(text); } catch { throw new Error("agent_control_invalid_json"); }
      if (!record(result)) throw new Error("agent_control_invalid_json");
      if (body.action === "claim" && record(result.lease)) {
        const { leaseId: id, leaseSeconds } = result.lease;
        if (typeof id !== "string" || typeof leaseSeconds !== "number" || !Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
          throw new Error("control_invalid_lease");
        }
        const durationMs = leaseSeconds * 1000;
        this.lease = { id, durationMs, expiresAt: started + durationMs };
      }
      if (leaseId && this.lease) {
        if (body.action === "heartbeat" && this.remainingMs(leaseId) > 0) {
          const serverExpiry = Date.parse(String(result.leaseExpiresAt));
          const serverRemaining = serverExpiry - Date.now();
          const latest = Number.isFinite(serverRemaining) ? performance.now() + serverRemaining : Infinity;
          this.lease.expiresAt = Math.min(started + this.lease.durationMs, latest);
        }
        if (this.remainingMs(leaseId) <= 0) throw new AgentControlError(409);
      }
      return result;
    } catch (error) {
      if (signal.aborted) throw new ControlDeadlineError();
      throw error;
    }
  }
}
