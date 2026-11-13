/** External pages often stamp their default typography on every text run. Keep local variation and semantic HTML. */
export function documentPasteData(data: DataTransfer): DataTransfer | undefined {
  if (data.files.length || data.types.some(type => type.includes("slate") || type.includes("plate"))) return;
  const html = data.getData("text/html");
  if (!html || !/style\s*=/i.test(html) || /data-slate-fragment\s*=/i.test(html)) return;
  const template = document.createElement("template");
  template.innerHTML = html;
  const root = template.content;
  const properties = ["font-family", "font-size", "color"] as const;
  const values = new Map(properties.map(key => [key, new Set<string>()]));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (!walker.currentNode.textContent?.trim()) continue;
    for (const property of properties) {
      let value = "";
      for (let element = walker.currentNode.parentElement; element && !value; element = element.parentElement) {
        if (element instanceof HTMLElement) value = element.style.getPropertyValue(property);
      }
      values.get(property)!.add(value.toLowerCase());
    }
  }
  const defaults = properties.filter(property => {
    const distinct = values.get(property)!;
    if (distinct.size !== 1) return false;
    const [v] = distinct;
    if (property === "font-family") return /(?:^|,)\s*["']?(?:-apple-system(?:-body)?|system-ui|ui-sans-serif)["']?(?:,|$)/.test(v);
    if (property === "font-size") return /^(?:1[46]px|1[12]pt|medium|100%|1r?em)$/.test(v);
    return /^(?:black|#000(?:000)?|rgb\(0,\s*0,\s*0\))$/.test(v);
  });
  if (!defaults.length) return;
  for (const element of root.querySelectorAll<HTMLElement>("[style]")) {
    if (!(element instanceof HTMLElement)) continue;
    for (const property of defaults) element.style.removeProperty(property);
    if (!element.style.length) element.removeAttribute("style");
  }
  const cleaned = new DataTransfer();
  for (const type of data.types) cleaned.setData(type, type === "text/html" ? template.innerHTML : data.getData(type));
  return cleaned;
}
