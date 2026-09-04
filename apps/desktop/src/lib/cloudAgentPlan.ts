type JsonRecord = Record<string, unknown>;

export interface CloudAgentPlanDisplayDetail {
  label: string;
  values: string[];
}

export interface CloudAgentPlanDisplayItem {
  key: string;
  label: string;
  detail?: string;
}

export interface CloudAgentPlanDisplayStep {
  id: string;
  goal: string;
  kindLabel?: string;
  rationale?: string;
  details: CloudAgentPlanDisplayDetail[];
}

export interface CloudAgentPlanDisplay {
  title: string;
  summary: string;
  strategyLabel: string;
  references: CloudAgentPlanDisplayItem[];
  sections: CloudAgentPlanDisplayItem[];
  missingAssets: CloudAgentPlanDisplayItem[];
  steps: CloudAgentPlanDisplayStep[];
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : [])
    : [];
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const parsed = record(item);
    return parsed ? [parsed] : [];
  }) : [];
}

function legacyStrategyLabel(strategy: unknown): string {
  if (strategy === "direct") return "直接单步";
  if (strategy === "controlled") return "一致性控制";
  if (strategy === "staged_controlled") return "分阶段控制";
  return "动态计划";
}

const TOOL_LABELS: Record<string, string> = {
  understand_asset: "理解素材",
  generate_image: "生成图片",
  compose_html: "编排 HTML",
  render_html: "渲染页面",
  inspect_artifact: "检查产物",
  compose_xiaohongshu: "编排小红书草稿",
  finalize_output: "确认最终产物",
  direct_generate: "直接生成",
  generate_control_reference: "生成控制参考",
  edit_from_previous: "基于上一步编辑",
};

const ASSET_ROLE_LABELS: Record<string, string> = {
  product: "产品",
  logo: "品牌标识",
  copy_source: "文案来源",
  style_reference: "风格参考",
  supporting: "辅助素材",
};

const COPY_SOURCE_LABELS: Record<string, string> = {
  user_goal: "用户原文",
  asset_observation: "素材观察",
  none: "无文案来源",
};

const MISSING_ASSET_LABELS: Record<string, string> = {
  generate: "计划生成",
  reuse_existing: "复用现有素材",
  not_needed: "无需补充",
};

function normalizeLegacyPlan(plan: JsonRecord): CloudAgentPlanDisplay | null {
  const summary = text(plan.intentSummary);
  if (!summary || !Array.isArray(plan.steps)) return null;
  const steps = records(plan.steps).flatMap((step, index): CloudAgentPlanDisplayStep[] => {
    const goal = text(step.goal);
    if (!goal) return [];
    const id = text(step.id) ?? `step-${index + 1}`;
    return [{
      id,
      goal,
      kindLabel: TOOL_LABELS[text(step.kind) ?? ""],
      rationale: text(step.rationale),
      details: [
        { label: "修改", values: strings(step.modifies) },
        { label: "保持", values: strings(step.preserves) },
        { label: "排除", values: strings(step.excludes) },
      ].filter((item) => item.values.length > 0),
    }];
  });
  if (!steps.length) return null;
  const references = records(plan.referenceRoles).flatMap((reference, index): CloudAgentPlanDisplayItem[] => {
    const referenceId = text(reference.referenceId);
    const role = text(reference.role);
    if (!referenceId || !role) return [];
    return [{ key: `${referenceId}-${index}`, label: `${referenceId} · ${role}` }];
  });
  return {
    title: "Agent 对真实意图的理解",
    summary,
    strategyLabel: legacyStrategyLabel(plan.strategy),
    references,
    sections: [],
    missingAssets: [],
    steps,
  };
}

function normalizeUnifiedPlan(plan: JsonRecord): CloudAgentPlanDisplay | null {
  const title = text(plan.title);
  const summary = text(plan.summary);
  if (!title || !summary || !Array.isArray(plan.steps)) return null;
  const steps = records(plan.steps).flatMap((step, index): CloudAgentPlanDisplayStep[] => {
    const goal = text(step.goal);
    if (!goal) return [];
    const id = text(step.id) ?? `step-${index + 1}`;
    const inputAssetIds = strings(step.inputAssetIds);
    const dependsOn = strings(step.dependsOn);
    return [{
      id,
      goal,
      kindLabel: TOOL_LABELS[text(step.kind) ?? ""] ?? text(step.kind),
      details: [
        { label: "输入素材", values: inputAssetIds },
        { label: "依赖步骤", values: dependsOn },
      ].filter((item) => item.values.length > 0),
    }];
  });
  if (!steps.length) return null;

  const contentPlan = record(plan.contentPlan);
  const references = records(contentPlan?.assetAssignments).flatMap((assignment, index): CloudAgentPlanDisplayItem[] => {
    const assetId = text(assignment.assetId);
    if (!assetId) return [];
    const roles = strings(assignment.roles).map((role) => ASSET_ROLE_LABELS[role] ?? role);
    return [{
      key: `${assetId}-${index}`,
      label: roles.length ? `${assetId} · ${roles.join("、")}` : assetId,
      detail: text(assignment.rationale),
    }];
  });
  const sections = records(contentPlan?.informationArchitecture).flatMap((section, index): CloudAgentPlanDisplayItem[] => {
    const id = text(section.id);
    const purpose = text(section.purpose);
    if (!id || !purpose) return [];
    const source = COPY_SOURCE_LABELS[text(section.copySource) ?? ""];
    const sourceAssets = strings(section.sourceAssetIds);
    const suffix = [source, sourceAssets.length ? `素材：${sourceAssets.join("、")}` : undefined].filter(Boolean).join(" · ");
    return [{ key: `${id}-${index}`, label: `${id} · ${purpose}`, detail: suffix || undefined }];
  });
  const missingAssets = records(contentPlan?.missingAssets).flatMap((item, index): CloudAgentPlanDisplayItem[] => {
    const id = text(item.id);
    const purpose = text(item.purpose);
    if (!id || !purpose) return [];
    const decision = MISSING_ASSET_LABELS[text(item.decision) ?? ""] ?? text(item.decision);
    return [{ key: `${id}-${index}`, label: `${id} · ${purpose}`, detail: decision }];
  });
  return {
    title,
    summary,
    strategyLabel: "自动选工具",
    references,
    sections,
    missingAssets,
    steps,
  };
}

/** Convert either trusted plan schema into a render-safe view; malformed remote JSON never crashes React. */
export function cloudAgentPlanDisplay(value: unknown): CloudAgentPlanDisplay | null {
  const plan = record(value);
  if (!plan) return null;
  return "intentSummary" in plan ? normalizeLegacyPlan(plan) : normalizeUnifiedPlan(plan);
}
