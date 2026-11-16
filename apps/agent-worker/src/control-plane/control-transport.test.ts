import { equal, ok, rejects } from "node:assert/strict";
import { test } from "node:test";
import type { WorkerFetch } from "../cloud-generation/runtime.ts";
import { AgentControlError, ControlDeadlineError, ControlTransport } from "./control-transport.ts";

function response(value: unknown) {
  return { ok: true, status: 200, headers: { get: () => null },
    text: async () => JSON.stringify(value), arrayBuffer: async () => new ArrayBuffer(0) };
}

const config = { controlUrl: "https://control.test", workerId: "test", workerToken: "test" };

for (const stall of ["headers", "body"]) {
  test(`control deadline aborts stalled ${stall} before lease expiry without replay`, async () => {
    let requests = 0;
    const fetch: WorkerFetch = async (_url, request) => {
      requests++;
      if (requests === 1) return response({ lease: { leaseId: "lease", leaseSeconds: 0.24 } });
      const untilAbort = new Promise<never>((_, reject) => {
        request!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return stall === "headers" ? untilAbort : { ...response(null), text: () => untilAbort };
    };
    const control = new ControlTransport(config, fetch);
    await control.post({ action: "claim" });
    // Node's native AbortSignal.timeout is unref'ed. Keep the simulated socket active.
    const socket = setTimeout(() => {}, 1000);
    try {
      await rejects(() => control.post({ action: "submitted", leaseId: "lease" }), ControlDeadlineError);
      equal(requests, 2);
      ok(control.remainingMs("lease") > 0);
    } finally { clearTimeout(socket); }
  });
}

test("temporary heartbeat failure keeps original expiry and an expired lease blocks the next control call", async () => {
  let calls = 0;
  const control = new ControlTransport(config, async () => {
    if (++calls === 1) return response({ lease: { leaseId: "lease", leaseSeconds: 30 } });
    if (calls === 2) return { ...response({}), ok: false, status: 503 };
    return response({ leaseExpiresAt: new Date(0).toISOString() });
  });
  await control.post({ action: "claim" });
  await rejects(() => control.post({ action: "heartbeat", leaseId: "lease" }), AgentControlError);
  ok(control.remainingMs("lease") > 0);
  await rejects(() => control.post({ action: "heartbeat", leaseId: "lease" }), AgentControlError);
  await rejects(() => control.post({ action: "submitted", leaseId: "lease" }), AgentControlError);
  equal(calls, 3);
});
