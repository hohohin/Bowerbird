// Deterministic, local relevance. No model calls and no changes to saved tag order.
const alphabetic = new Intl.Collator("zh-Hans-CN-u-co-pinyin", { numeric: true, sensitivity: "base" });
const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase();
export const catalogLetters = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "#"];
const indexName = (name: string) => name.normalize("NFKC").trim().replace(/^#+\s*/, "");
export function catalogInitial(name: string): string {
  const first = [...indexName(name)][0] ?? "";
  const latin = first.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase();
  if (/^[A-Z]$/.test(latin)) return latin;
  if (!/\p{Script=Han}/u.test(first)) return "#";
  // CLDR's pinyin index boundaries, shared by Intl/ICU in Chromium and WebKit.
  // https://www.unicode.org/reports/tr35/tr35-collation.html#CJK_Index_Markers
  for (const letter of [..."ABCDEFGHJKLMNOPQRSTWXYZ"].reverse()) {
    if (alphabetic.compare(first, `\uFDD0${letter}`) >= 0) return letter;
  }
  return "#";
}
function compareTagNames(a: string, b: string) {
  return catalogLetters.indexOf(catalogInitial(a)) - catalogLetters.indexOf(catalogInitial(b))
    || alphabetic.compare(indexName(a), indexName(b));
}
function terms(text: string): Set<string> {
  const result = new Set<string>();
  for (const part of normalize(text).match(/[a-z0-9]+|[\u3400-\u9fff]+/g) ?? []) {
    if (/^[a-z0-9]/.test(part)) { if (part.length > 2) result.add(part); }
    else for (let i = 0; i < part.length - 1; i++) result.add(part.slice(i, i + 2));
  }
  return result;
}
export function orderCatalogTags<T extends { id: string; name: string; description: string; projectCount: number }>(tags: T[], prompts: string[], project: boolean, pinned: string[] = []) {
  const text = normalize(prompts.join("\n"));
  const words = terms(text);
  return tags.map(tag => {
    const name = normalize(tag.name).replace(/^#/, "").trim();
    const tokens = terms(tag.description);
    const overlap = [...tokens].filter(word => words.has(word)).length;
    const nameMatch = !!name && (/[\u3400-\u9fff]/.test(name) ? text.includes(name) :
      (` ${text.replace(/[^a-z0-9]+/g, " ")} `).includes(` ${name.replace(/[^a-z0-9]+/g, " ")} `));
    const score = project ? (nameMatch ? 8 : 0) + Math.min(6, Math.log2(1 + tag.projectCount) * 2)
      + (overlap >= 2 ? 2 * overlap / Math.max(1, tokens.size) : 0) : 0;
    return { ...tag, score, nameMatch };
  }).sort((a, b) => {
    const aPin = pinned.indexOf(a.id), bPin = pinned.indexOf(b.id);
    return (aPin < 0 ? Infinity : aPin) - (bPin < 0 ? Infinity : bPin)
      || b.score - a.score || compareTagNames(a.name, b.name) || a.id.localeCompare(b.id);
  });
}

export const UNTAGGED_SECTION = "__catalog_untagged__";
export function collectionRows<T extends { id: string; name: string; parent_id?: string | null }>(collections: T[]) {
  const result: { item: T; depth: number; path: string }[] = [];
  const visited = new Set<string>();
  function walk(parent: string | null, depth: number, path: string) {
    for (const item of collections.filter(c => (c.parent_id ?? null) === parent).sort((a,b) => alphabetic.compare(a.name,b.name))) {
      if (visited.has(item.id)) continue;
      visited.add(item.id);
      const full = path ? `${path} / ${item.name}` : item.name;
      result.push({ item, depth, path: full }); walk(item.id, depth + 1, full);
    }
  }
  walk(null, 0, "");
  // Keep old orphaned records reachable instead of silently hiding them.
  for (const item of collections) if (!visited.has(item.id)) { visited.add(item.id); result.push({ item, depth: 0, path: item.name }); walk(item.id, 1, item.name); }
  return result;
}
