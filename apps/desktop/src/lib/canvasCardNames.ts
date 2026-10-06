/** Names belong to canvas identities, so copies get new names and reloads keep old ones. */
export function assignCanvasCardNames(previous: Record<string, string> = {}, cards: { id: string; title: string }[]): Record<string, string> {
  const names = { ...previous };
  const used = new Set(Object.values(names));
  for (const card of cards) {
    if (names[card.id]) continue;
    let index = 1;
    while (used.has(`${card.title} ${index}`)) index++;
    names[card.id] = `${card.title} ${index}`;
    used.add(names[card.id]);
  }
  return names;
}

export function canvasCardNameError(id: string, value: string, names: Record<string, string>, activeIds: Set<string>): string {
  const name = value.trim();
  if (!name) return "名称不能为空";
  if (name.length > 80) return "名称最多 80 个字符";
  return Object.entries(names).some(([otherId, otherName]) => otherId !== id && activeIds.has(otherId) && otherName.trim() === name)
    ? "该名字重复，请换一个名称" : "";
}
