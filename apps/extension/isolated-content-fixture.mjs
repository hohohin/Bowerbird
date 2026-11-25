import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("manifest.json", import.meta.url), "utf8"));
const scripts = await Promise.all(manifest.content_scripts[0].js.map(async name => {
  const source = await readFile(new URL(name, import.meta.url), "utf8");
  // Only the isolated test page exposes the closed UI to Playwright selectors.
  return name === "ui-overlay.js" ? source.replace('host.attachShadow({ mode: "closed" })', 'host.attachShadow({ mode: "open" })') : source;
}));

export async function injectContent(page) {
  for (const content of scripts) await page.addScriptTag({ content });
}
