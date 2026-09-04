/** “新建创作”只带明确选择；“新建空白画板”始终忽略当前选择。 */
export function creativeLaunchAssetIds(blank: boolean, selectedIds: Iterable<string>) {
  if (blank) return [];
  return Array.from(new Set(selectedIds));
}

export function creativeLaunchTargetsProject(
  request: { projectId: string } | null,
  projectId: string | null,
) {
  return request != null && projectId != null && request.projectId === projectId;
}
