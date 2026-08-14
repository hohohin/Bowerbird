/**
 * Bowerbird Agent Runtime 契约层 barrel。
 * v1 冻结点：M0（A0 + V0）。变更需升 schema/response 版本并经 eval 回归。
 */

export type {
  AbortSignalLike,
  ActionDefinition,
  ContextBlock,
  ModelBackend,
  ModelTurnRequest,
  ModelTurnResult,
  ProviderUsage,
  TrustLevel,
} from "./model.ts";
export { MODEL_RESPONSE_SCHEMA_VERSION } from "./model.ts";

export type {
  BudgetSnapshot,
  RunStatus,
} from "./run.ts";
export { TERMINAL_STATUSES, remainingBudget } from "./run.ts";

export type {
  BudgetTier,
  PhaseDef,
  PhaseTransition,
  SkillManifest,
} from "./skill.ts";

export type {
  CallIdComponents,
  ToolCall,
  ToolCallStatus,
  ToolErrorClass,
} from "./tools.ts";
export { TOOL_CALL_LIFECYCLE } from "./tools.ts";

export type {
  AgentEvent,
  AgentEventType,
  DisplayPayload,
} from "./events.ts";

export type {
  ClarificationProposal,
  IntentPatch,
  IntentPatchOp,
} from "./clarification.ts";

export type {
  PreferenceCandidate,
  PreferenceCapsule,
  PreferenceFact,
  PreferenceFactCategory,
} from "./preference.ts";

export type { RunSnapshot, SnapshotToolCallRef } from "./snapshot.ts";
export { SNAPSHOT_SCHEMA_VERSION } from "./snapshot.ts";

export type {
  CandidateDirection,
  EvidenceConflict,
  EvidenceFact,
  RulePolarity,
  VisualEvidenceCard,
  VisualLanguageCategory,
  VisualProfileCapsule,
  VisualProfileDraft,
  VisualRule,
  VisualRuleValue,
} from "./visual-profile.ts";
export { VISUAL_LANGUAGE_CATEGORIES } from "./visual-profile.ts";
