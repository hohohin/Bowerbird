/** Bowerbird Agent Kernel —— 纯函数门控层（M0 子集，无 I/O）。 */

export {
  M0_FIXED_TARIFF,
  canAfford,
  estimateToolCost,
  spend,
} from "./budget.ts";

export {
  findPhase,
  isTerminal,
  nextPhase,
  validateAction,
} from "./phase-machine.ts";
export type {
  PhaseActionDecision,
  PhaseRejectReason,
} from "./phase-machine.ts";

export type { PolicyContext, PolicyVerdict, ToolSpec } from "./policy-engine.ts";
export {
  GLOBAL_TOOL_REGISTRY,
  evaluatePolicy,
  lookupTool,
} from "./policy-engine.ts";

export {
  ToolLedger,
  canonicalJson,
  computeArgsHash,
  deriveCallId,
  isIdempotentReuse,
  sha256Hex,
} from "./tool-ledger.ts";
