/** 首版 bowerbird-controlled-image-edit 的版本化业务契约。 */

import type { PreferenceCapsule } from "./preference.ts";
import type { VisualProfileCapsule } from "./visual-profile.ts";

export const CONTROLLED_IMAGE_EDIT_SCHEMA_VERSION = 1 as const;

export type HighConsistencySignal =
  | "identity"
  | "product"
  | "pose"
  | "garment"
  | "accessory"
  | "composition"
  | "text_layout";

export type ReferenceRole =
  | "base"
  | "pose"
  | "identity"
  | "product"
  | "garment"
  | "accessory"
  | "composition"
  | "style"
  | "other";

export type ControlledReferenceInput = {
  referenceId: string;
  token: string;
  ordinal: number;
  mime: string;
  bytes: number;
  sha256: string;
  /** Safe local metadata used by Kernel after text-only subject binding. */
  aspectRatio?: string;
};

export type ControlledImageEditInput = {
  schemaVersion: 1;
  intentPrompt: string;
  references: ControlledReferenceInput[];
  ratio?: string;
  usageContext?: string;
  budgetTier?: string;
  explicitPreserve?: string[];
  explicitExclude?: string[];
  /** 桌面本地生成的只读显式偏好；随 Run 临时数据过期，Kernel 不可修改。 */
  preferenceCapsule?: PreferenceCapsule;
  /** 项目内已确认并在 Run 启动时冻结的只读视觉设定。 */
  visualProfileCapsule?: VisualProfileCapsule;
};

export type IntentAnalysis = {
  schemaVersion: 1;
  intentSummary: string;
  finalSubjectReferenceId?: string;
  mustPreserve: string[];
  mustTransfer: Array<{ fromReferenceId: string; attributes: string[] }>;
  mustExclude: string[];
  mayChange: string[];
  highConsistencySignals: HighConsistencySignal[];
  assumptions: string[];
};

export type PlanInputBinding =
  | { type: "reference"; referenceId: string }
  | { type: "step"; stepId: string };

export type ControlledPlanStep = {
  id: string;
  kind: "direct_generate" | "generate_control_reference" | "edit_from_previous";
  goal: string;
  inputs: PlanInputBinding[];
  modifies: string[];
  preserves: string[];
  excludes: string[];
  outputRole: "control_reference" | "stage_result" | "final_result";
  rationale: string;
  estimatedUsage: { generateCalls: number; understandCalls: number };
};

export type ControlledImageEditPlan = {
  schemaVersion: 1;
  intentAnalysisHash: string;
  intentSummary: string;
  strategy: "direct" | "controlled" | "staged_controlled";
  referenceRoles: Array<{
    referenceId: string;
    role: ReferenceRole;
    mustPreserve: string[];
    mustTransfer: string[];
    mustExclude: string[];
  }>;
  assumptions: string[];
  steps: ControlledPlanStep[];
};

export type ControlledFeedbackDiagnosis = {
  schemaVersion: 1;
  summary: string;
  earliestFailedStepId: string;
  failedConstraints: string[];
  preservedConstraints: string[];
  revisionDirective: string;
  inspectedArtifactIds: string[];
};

export type ControlledArtifactRole =
  | "input"
  | "control_reference"
  | "stage_result"
  | "final_result"
  | "plan"
  | "diagnostic";

export type ControlledRunArtifact = {
  artifactId: string;
  conversationId: string;
  runId: string;
  role: ControlledArtifactRole;
  stepId?: string;
  parentArtifactId?: string;
  mime: string;
  bytes: number;
  sha256: string;
  userVisible: boolean;
};
