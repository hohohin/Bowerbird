import { randomUUID } from "node:crypto";
import {
  AgentControlClient,
  AgentControlError,
  type ClaimedAgentRun,
} from "../control-plane/agent-control-client.ts";

export type AgentWorkerConfig = {
  controlUrl: string;
  workerToken: string;
  workerId: string;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  maintenanceIntervalMs: number;
  testClaimDelayMs: number;
};

export type AgentStopSignal = { requested: boolean };

export type AgentLeaseSignal = {
  readonly aborted: boolean;
  readonly cancelRequested: boolean;
  readonly leaseLost: boolean;
  readonly stopRequested: boolean;
};

export type AgentRunContext = {
  claimed: ClaimedAgentRun & { run: NonNullable<ClaimedAgentRun["run"]>; lease: NonNullable<ClaimedAgentRun["lease"]> };
  control: AgentControlClient;
  signal: AgentLeaseSignal;
};

export interface AgentRunProcessor {
  process(context: AgentRunContext): Promise<void>;
}

type Sleep = (ms: number) => Promise<void>;

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name}_missing`);
  return value;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name}_invalid`);
  return parsed;
}

function boundedNonNegativeInt(value: string | undefined, fallback: number, maximum: number, name: string): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new Error(`${name}_invalid`);
  return parsed;
}

export function agentConfigFromEnv(env: Record<string, string | undefined>): AgentWorkerConfig {
  const workerId = env.AGENT_WORKER_ID?.trim() || `agent-${env.HOSTNAME?.trim() || randomUUID()}`;
  if (workerId.length > 120) throw new Error("AGENT_WORKER_ID_invalid");
  return {
    controlUrl: required(env, "AGENT_CONTROL_URL"),
    workerToken: required(env, "AGENT_WORKER_TOKEN"),
    workerId,
    pollIntervalMs: positiveInt(env.AGENT_POLL_INTERVAL_MS, 2_000, "AGENT_POLL_INTERVAL_MS"),
    heartbeatIntervalMs: positiveInt(env.AGENT_HEARTBEAT_INTERVAL_MS, 20_000, "AGENT_HEARTBEAT_INTERVAL_MS"),
    maintenanceIntervalMs: positiveInt(env.AGENT_MAINTENANCE_INTERVAL_MS, 600_000, "AGENT_MAINTENANCE_INTERVAL_MS"),
    testClaimDelayMs: boundedNonNegativeInt(
      env.BOWERBIRD_TEST_AGENT_CLAIM_DELAY_MS,
      0,
      30_000,
      "BOWERBIRD_TEST_AGENT_CLAIM_DELAY_MS",
    ),
  };
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z0-9._:-]{1,80}$/.test(error.message)) return error.message;
  return "agent_run_failed";
}

async function heartbeatLoop(
  context: AgentRunContext,
  mutable: { cancelRequested: boolean; leaseLost: boolean; stopped: boolean },
  intervalMs: number,
  sleep: Sleep,
): Promise<void> {
  while (!mutable.stopped) {
    await sleep(intervalMs);
    if (mutable.stopped) return;
    try {
      const heartbeat = await context.control.heartbeat(context.claimed.run.id, context.claimed.lease.leaseId);
      mutable.cancelRequested ||= heartbeat.cancelRequested;
    } catch (error) {
      if (error instanceof AgentControlError && error.status === 409) {
        mutable.leaseLost = true;
        return;
      }
      console.error(JSON.stringify({ event: "agent_heartbeat_failed", run_id: context.claimed.run.id, error: safeErrorCode(error) }));
    }
  }
}

export async function executeClaimedAgentRun(
  claimed: ClaimedAgentRun,
  control: AgentControlClient,
  processor: AgentRunProcessor,
  stop: AgentStopSignal,
  heartbeatIntervalMs: number,
  sleep: Sleep = defaultSleep,
): Promise<void> {
  if (!claimed.run || !claimed.lease?.leaseId) throw new Error("agent_claim_response_invalid");
  const mutable = { cancelRequested: false, leaseLost: false, stopped: false };
  const context: AgentRunContext = {
    claimed: claimed as AgentRunContext["claimed"],
    control,
    signal: {
      get aborted() { return mutable.cancelRequested || mutable.leaseLost || stop.requested; },
      get cancelRequested() { return mutable.cancelRequested; },
      get leaseLost() { return mutable.leaseLost; },
      get stopRequested() { return stop.requested; },
    },
  };
  void heartbeatLoop(context, mutable, heartbeatIntervalMs, sleep);
  try {
    await processor.process(context);
    if (mutable.cancelRequested && !mutable.leaseLost) {
      await control.cancel(claimed.run.id, claimed.lease.leaseId);
    }
  } catch (error) {
    if (mutable.leaseLost) return;
    try {
      if (mutable.cancelRequested) {
        await control.cancel(claimed.run.id, claimed.lease.leaseId);
      } else {
        await control.fail(claimed.run.id, claimed.lease.leaseId, safeErrorCode(error), "Agent Run 执行失败");
      }
    } catch (settlementError) {
      console.error(JSON.stringify({ event: "agent_settlement_failed", run_id: claimed.run.id, error: safeErrorCode(settlementError) }));
    }
  } finally {
    mutable.stopped = true;
  }
}

export async function runAgentWorker(
  config: AgentWorkerConfig,
  processor: AgentRunProcessor,
  options: {
    control?: AgentControlClient;
    stop?: AgentStopSignal;
    sleep?: Sleep;
    now?: () => number;
    maintenance?: (control: AgentControlClient) => Promise<void> | void;
  } = {},
): Promise<void> {
  const control = options.control ?? new AgentControlClient(config);
  const stop = options.stop ?? { requested: false };
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  let lastMaintenanceAt = Number.NEGATIVE_INFINITY;
  console.log(JSON.stringify({ event: "agent_worker_started", worker_id: config.workerId }));
  while (!stop.requested) {
    if (options.maintenance && now() - lastMaintenanceAt >= config.maintenanceIntervalMs) {
      lastMaintenanceAt = now();
      try {
        await options.maintenance(control);
      } catch (error) {
        console.error(JSON.stringify({ event: "agent_maintenance_failed", error: safeErrorCode(error) }));
      }
    }
    try {
      const claimed = await control.claim();
      if (claimed.run) {
        if (config.testClaimDelayMs > 0) {
          console.log(JSON.stringify({
            event: "agent_test_claim_delay",
            run_id: claimed.run.id,
            delay_ms: config.testClaimDelayMs,
          }));
          await sleep(config.testClaimDelayMs);
          if (stop.requested) continue;
        }
        await executeClaimedAgentRun(claimed, control, processor, stop, config.heartbeatIntervalMs, sleep);
      } else {
        await sleep(config.pollIntervalMs);
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "agent_claim_failed", error: safeErrorCode(error) }));
      if (!stop.requested) await sleep(Math.max(config.pollIntervalMs, 5_000));
    }
  }
}
