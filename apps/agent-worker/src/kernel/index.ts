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

export type {
  ApprovedStepExecutor,
  ControlledRunnerCheckpoint,
  GenerateApprovedStepRequest,
  GeneratedApprovedStep,
} from "./controlled-image-edit-runner.ts";
export {
  completeControlledExport,
  controlledRunnerAllowsVision,
  createControlledRunnerCheckpoint,
  decideControlledPlan,
  executeNextControlledStep,
  proposeControlledPlan,
  recordControlledIntentAnalysis,
  submitControlledResultFeedback,
} from "./controlled-image-edit-runner.ts";

export type { EncodedControlledCheckpoint } from "./controlled-checkpoint.ts";
export {
  CONTROLLED_CHECKPOINT_SCHEMA_VERSION,
  MAX_CONTROLLED_CHECKPOINT_BYTES,
  decodeControlledCheckpoint,
  encodeControlledCheckpoint,
} from "./controlled-checkpoint.ts";

export type {
  DurableToolAdapter,
  DurableToolControl,
  DurableToolIdentity,
  PersistedToolResult,
} from "./durable-tool-dispatcher.ts";
export {
  DurableProviderError,
  DurableToolDispatcher,
  SimulatedProcessCrash,
} from "./durable-tool-dispatcher.ts";

export type {
  AdvanceControlledRunRequest,
  ControlledRunClaimState,
  ControlledRunControl,
  ControlledRunEngineOutcome,
} from "./controlled-run-engine.ts";
export { advanceControlledRun } from "./controlled-run-engine.ts";
