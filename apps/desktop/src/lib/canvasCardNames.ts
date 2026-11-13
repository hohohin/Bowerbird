/** Names belong to canvas identities, so copies get new names and reloads keep old ones. */
export function assignCanvasCardNames(previous: Record<string, string> = {}, cards: { id: string; title: string }[]): Record<string, string> {
  const names = { ...previous };
  // Older clients assigned every asset an image name. Only replace that default pattern.
  for (const card of cards) {
    if ((card.title === "视频卡片" || card.title === "音频卡片") && /^图片卡片 [1-9]\d*$/.test(names[card.id] ?? "")) delete names[card.id];
  }
  const used = new Set(Object.values(names));
  const nextByTitle = new Map<string, number>();
  for (const card of cards) {
    if (names[card.id]) continue;
    let index = nextByTitle.get(card.title) ?? 1;
    while (used.has(`${card.title} ${index}`)) index++;
    names[card.id] = `${card.title} ${index}`;
    used.add(names[card.id]);
    nextByTitle.set(card.title, index + 1);
  }
  return names;
}

export function activeCanvasNameCounts(names: Record<string, string>, activeIds: Set<string>) {
  const counts = new Map<string, number>();
  for (const id of activeIds) {
    const name = names[id]?.trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

export function canvasCardNameError(id: string, value: string, names: Record<string, string>, activeIds: Set<string>, counts = activeCanvasNameCounts(names, activeIds)): string {
  const name = value.trim();
  if (!name) return "名称不能为空";
  if (name.length > 80) return "名称最多 80 个字符";
  return (counts.get(name) ?? 0) > (activeIds.has(id) && names[id]?.trim() === name ? 1 : 0)
    ? "该名字重复，请换一个名称" : "";
}
