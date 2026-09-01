import type { AgentRuntime } from "../contracts/agent-runtime.ts";

/**
 * Claims created before U4 do not carry agentRuntime. They are historical
 * legacy runs and must never be silently upgraded to DSH during recovery.
 */
export function agentRuntimeForClaim(run: { agentRuntime?: AgentRuntime }): AgentRuntime {
  return run.agentRuntime ?? "legacy_kernel";
}
