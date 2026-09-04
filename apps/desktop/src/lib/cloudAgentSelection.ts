import type { CloudAgentRuntime } from "./types";

export const CONTROLLED_AGENT_SKILL = "bowerbird-controlled-image-edit" as const;
export const HTML_LAYOUT_AGENT_SKILL = "bowerbird-html-layout-render" as const;
export const UNIFIED_AGENT_SKILL = "bowerbird-unified-agent" as const;
export const LEGACY_AGENT_RUNTIME: CloudAgentRuntime = "legacy_kernel";
export const DSH_AGENT_RUNTIME: CloudAgentRuntime = "dsh";

export type CloudAgentSkill = typeof CONTROLLED_AGENT_SKILL | typeof HTML_LAYOUT_AGENT_SKILL;
export type CloudAgentRunSkill = CloudAgentSkill | typeof UNIFIED_AGENT_SKILL;
export type CloudAgentSelection = CloudAgentSkill | null;

export function activateCloudAgentSkill(value: string): CloudAgentSkill {
  if (value === CONTROLLED_AGENT_SKILL || value === HTML_LAYOUT_AGENT_SKILL) return value;
  throw new TypeError(`Unsupported cloud Agent skill: ${value}`);
}

export function cloudAgentSkill(selection: CloudAgentSelection): CloudAgentSkill {
  return selection ?? CONTROLLED_AGENT_SKILL;
}

export function cloudAgentModeForSelection(
  selection: CloudAgentSelection,
  runtime: CloudAgentRuntime,
  isTestAccount: boolean,
): boolean {
  return selection !== null || (runtime === DSH_AGENT_RUNTIME && isTestAccount);
}

export function toggleCloudAgent(selection: CloudAgentSelection): CloudAgentSelection {
  return selection === null ? CONTROLLED_AGENT_SKILL : null;
}

export function activateCloudAgentRuntime(value: string, isTestAccount: boolean): CloudAgentRuntime {
  if (value === LEGACY_AGENT_RUNTIME) return value;
  if (value === DSH_AGENT_RUNTIME && isTestAccount) return value;
  throw new TypeError(`Unsupported cloud Agent runtime: ${value}`);
}

export function activateCloudAgentRuntimeSelection(
  value: string,
  isTestAccount: boolean,
  currentSelection: CloudAgentSelection,
): { runtime: CloudAgentRuntime; selection: CloudAgentSelection } {
  const runtime = activateCloudAgentRuntime(value, isTestAccount);
  return {
    runtime,
    selection: runtime === DSH_AGENT_RUNTIME
      ? currentSelection ?? CONTROLLED_AGENT_SKILL
      : currentSelection,
  };
}

export function runtimeForAgentSkill(
  runtime: CloudAgentRuntime,
  _skill: CloudAgentSkill,
  isTestAccount: boolean,
): CloudAgentRuntime {
  return isTestAccount ? runtime : LEGACY_AGENT_RUNTIME;
}

export function runSkillForAgentRuntime(
  runtime: CloudAgentRuntime,
  legacySkill: CloudAgentSkill,
  isTestAccount: boolean,
): CloudAgentRunSkill {
  return runtime === DSH_AGENT_RUNTIME && isTestAccount ? UNIFIED_AGENT_SKILL : legacySkill;
}
