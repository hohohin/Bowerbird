import { catalogInitial, compareTagNames } from "../lib/materialCatalogOrder.ts";

export type TagChoice = { id: string; name: string };
export const normalizeTagName = (name: string) => name.trim().replace(/^#+\s*/, "").normalize("NFKC").toLocaleLowerCase();

/** Keep whole alphabet groups together, in reading/keyboard order down each column. */
export function tagPickerColumns(labels: TagChoice[], query: string, count: number) {
  const groups: { letter: string; tags: TagChoice[] }[] = [];
  const search = normalizeTagName(query);
  for (const tag of [...labels].sort((a, b) => compareTagNames(a.name, b.name))) {
    const letter = catalogInitial(tag.name);
    if (search && !normalizeTagName(tag.name).includes(search) && letter.toLowerCase() !== search) continue;
    const previous = groups[groups.length - 1];
    if (previous?.letter === letter) previous.tags.push(tag);
    else groups.push({ letter, tags: [tag] });
  }
  const columns: typeof groups[] = Array.from({ length: count }, () => []);
  let index = 0;
  for (let column = 0; column < count; column++) {
    const target = groups.slice(index).reduce((sum, group) => sum + 38 + group.tags.length * 32, 0) / (count - column);
    let height = 0;
    while (index < groups.length) {
      const group = groups[index], size = 38 + group.tags.length * 32;
      if (column < count - 1 && columns[column].length && Math.abs(height + size - target) > Math.abs(height - target)) break;
      columns[column].push(group); height += size; index++;
    }
  }
  return columns;
}
