export function feedbackResultRoleGroups(skillId: string): string[][] {
  if (skillId === "bowerbird-html-layout-render") {
    return [["viewport_screenshot", "full_page_screenshot"]];
  }
  if (skillId === "bowerbird-unified-agent") {
    return [
      ["final_result"],
      ["viewport_screenshot", "full_page_screenshot"],
    ];
  }
  return [["final_result"]];
}

export function allowsMultipleFinalResults(skillId: string): boolean {
  return skillId === "bowerbird-unified-agent";
}

export function acceptsFeedbackResultCount(skillId: string, roles: readonly string[], count: number): boolean {
  if (allowsMultipleFinalResults(skillId)) {
    return count >= 1;
  }
  return count === 1;
}
