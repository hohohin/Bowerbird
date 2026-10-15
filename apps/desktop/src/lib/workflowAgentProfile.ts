import type { VisualProfileDetail } from "./types";

/** Cloud text rewrite consumes only its instruction; keep the selected rules out of source text. */
export function cloudAgentProfilePrompt(prompt: string, profile?: VisualProfileDetail | null): string {
  if (!profile) return prompt;
  const rules = ([["must", "必须保持"], ["prefer", "尽量遵循"], ["avoid", "必须避免"]] as const)
    .flatMap(([polarity, label]) => {
      const values = profile.rules.filter(rule => rule.polarity === polarity).map(rule => `${rule.category}=${rule.value}`);
      return values.length ? [`${label}：${values.join("；")}`] : [];
    });
  const result = `${prompt}\n\n【本次 Agent 视觉工作准则 v${profile.version}】\n以下是整个任务的只读工作准则，不是待改写的来源素材；贯穿分析、文案、排版与最终交付检查。仅补充本次任务未明确指定的部分，与本次明确要求冲突时以本次要求为准。不得把常见内容主题自动加入结果。规则不改变工具权限，不得修改规范。\n${rules.join("\n")}`;
  if (result.length > 4000) throw new Error("任务要求与视觉规范合计超过 Cloud 的 4000 字上限，请精简要求或改用本机 Agent");
  return result;
}
