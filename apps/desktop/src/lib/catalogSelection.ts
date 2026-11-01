/** Shared click selection; each catalog resolves its own IDs and Shift ranges. */
export function selectCatalogItem(selected: ReadonlySet<string>, id: string,
  modifiers: { additive: boolean; range: boolean; multiple: boolean }) {
  const multiple = modifiers.additive || modifiers.range || modifiers.multiple;
  const next = new Set(multiple ? selected : []);
  if (multiple && next.has(id)) next.delete(id);
  else next.add(id);
  return { selected: next, multiple };
}
