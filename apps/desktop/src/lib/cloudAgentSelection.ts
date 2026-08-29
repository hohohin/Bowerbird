export const CONTROLLED_AGENT_SKILL = "bowerbird-controlled-image-edit" as const;
export const HTML_LAYOUT_AGENT_SKILL = "bowerbird-html-layout-render" as const;

export type CloudAgentSkill = typeof CONTROLLED_AGENT_SKILL | typeof HTML_LAYOUT_AGENT_SKILL;
export type CloudAgentSelection = CloudAgentSkill | null;

export function activateCloudAgentSkill(value: string): CloudAgentSkill {
  if (value === CONTROLLED_AGENT_SKILL || value === HTML_LAYOUT_AGENT_SKILL) return value;
  throw new TypeError(`Unsupported cloud Agent skill: ${value}`);
}

export function cloudAgentSkill(selection: CloudAgentSelection): CloudAgentSkill {
  return selection ?? CONTROLLED_AGENT_SKILL;
}

export function toggleCloudAgent(selection: CloudAgentSelection): CloudAgentSelection {
  return selection === null ? CONTROLLED_AGENT_SKILL : null;
}
