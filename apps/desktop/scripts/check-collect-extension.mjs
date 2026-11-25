import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const source = new URL("../../extension/", import.meta.url);
const readSource = path => readFileSync(new URL(path, source), "utf8");
const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const manifest = JSON.parse(readSource("manifest.json"));
const files = readdirSync(source).filter(file => /\.(?:js|html|json)$/.test(file) && !file.endsWith(".test.js"));
const resources = Object.fromEntries(
  Object.entries(config.bundle.resources).filter(([input, target]) => input.startsWith("../../extension/") || target.startsWith("extension/"))
);
assert.deepEqual(resources, Object.fromEntries(
  [...files, "icons/"].map(path => [`../../extension/${path}`, `extension/${path}`])
), "Bundle resources must match the canonical extension runtime files");

const runtimeEntries = [
  manifest.background.service_worker,
  manifest.options_page,
  ...manifest.content_scripts.flatMap(script => script.js),
];
for (const file of runtimeEntries) assert.ok(files.includes(file), `Missing extension runtime entry: ${file}`);
const icons = [...Object.values(manifest.icons), ...Object.values(manifest.action?.default_icon ?? {})];
for (const file of new Set(icons)) {
  assert.ok(file.startsWith("icons/") && existsSync(new URL(file, source)), `Missing extension icon: ${file}`);
}
for (const file of files.filter(path => path.endsWith(".js"))) {
  for (const call of readSource(file).matchAll(/\bimportScripts\(([^)]*)\)/g)) {
    for (const imported of call[1].matchAll(/["']([^"']+)["']/g)) {
      assert.ok(files.includes(imported[1]), `${file} loads missing extension dependency: ${imported[1]}`);
    }
  }
}
for (const optionScript of readSource(manifest.options_page).matchAll(/<script\s+src=["']([^"']+)["']/g)) {
  assert.ok(files.includes(optionScript[1]), `Missing options page script: ${optionScript[1]}`);
}
console.log(`[collect] Extension ${manifest.version}: ${files.length} runtime files and icons from apps/extension`);
