import type {
  ControlledImageEditInput,
  ControlledImageEditPlan,
  ControlledPlanStep,
  IntentAnalysis,
} from "../../contracts/controlled-image-edit.ts";
import { canonicalJson, sha256Hex } from "../../kernel/tool-ledger.ts";

export type TextOnlyPlanningContext = {
  intentPrompt: string;
  references: Array<{
    referenceId: string;
    token: string;
    ordinal: number;
    mime: string;
    bytes: number;
    sha256: string;
  }>;
  ratio?: string;
  usageContext?: string;
  explicitPreserve: string[];
  explicitExclude: string[];
};

/** 规划前唯一允许发送给文本模型的用户上下文；不接受图片内容字段。 */
export function buildTextOnlyPlanningContext(input: ControlledImageEditInput): TextOnlyPlanningContext {
  return {
    intentPrompt: input.intentPrompt,
    references: input.references.map(({ referenceId, token, ordinal, mime, bytes, sha256 }) => ({
      referenceId,
      token,
      ordinal,
      mime,
      bytes,
      sha256,
    })),
    ratio: input.ratio,
    usageContext: input.usageContext,
    explicitPreserve: [...(input.explicitPreserve ?? [])],
    explicitExclude: [...(input.explicitExclude ?? [])],
  };
}

export function hashIntentAnalysis(analysis: IntentAnalysis): string {
  return sha256Hex(canonicalJson(analysis));
}

export function hashControlledPlan(plan: ControlledImageEditPlan): string {
  return sha256Hex(canonicalJson(plan));
}

function joinOrNone(values: string[]): string {
  return values.length > 0 ? values.join("；") : "无额外项";
}

/** 将已批准的结构化步骤编译成 provider prompt，不让执行期模型改写计划。 */
export function compileApprovedStepPrompt(
  plan: ControlledImageEditPlan,
  step: ControlledPlanStep,
): string {
  const inputRoles = step.inputs.map((input, index) =>
    input.type === "reference"
      ? `输入${index + 1}=用户参考 ${input.referenceId}`
      : `输入${index + 1}=已批准步骤 ${input.stepId} 的产物`,
  );
  const controlWarning = step.outputRole === "control_reference"
    ? "这是身份无关、背景无关的控制参考；只编码当前目标属性，不补造来源中不可见的事实。"
    : "参考只控制当前步骤声明的属性；不得带入其他身份、文字、背景或无关物体。";
  return [
    `最终意图：${plan.intentSummary}`,
    `当前步骤：${step.goal}`,
    ...inputRoles,
    `只修改：${joinOrNone(step.modifies)}`,
    `严格保持：${joinOrNone(step.preserves)}`,
    `必须排除：${joinOrNone(step.excludes)}`,
    controlWarning,
    "最终画面不得出现控制线、箭头、标注框、骨架或示意图风格。",
  ].join("\n");
}

export function plannedGenerateCalls(plan: ControlledImageEditPlan): number {
  return plan.steps.reduce((sum, step) => sum + step.estimatedUsage.generateCalls, 0);
}

export function plannedUnderstandCalls(plan: ControlledImageEditPlan): number {
  return plan.steps.reduce((sum, step) => sum + step.estimatedUsage.understandCalls, 0);
}
