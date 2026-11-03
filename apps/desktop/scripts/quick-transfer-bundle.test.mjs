import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { build } from "vite";

// Use the real browser component through the isolated fixture, never the test decoder.
let modules = [];
await build({
  configFile: false,
  build: { outDir: ".tmp/quick-transfer-desktop-bundle", emptyOutDir: true,
    rollupOptions: { input: "scripts/fixtures/quick-transfer-desktop/preview.html" } },
  plugins: [{ name: "record-browser-modules", generateBundle() { modules = [...this.getModuleIds()].map(id => id.replaceAll("\\", "/")); } }],
});
const includes = name => modules.some(id => id.includes(`/node_modules/${name}/`));
assert.ok(includes("qrcode") && includes("dijkstrajs"));
for (const absent of ["jsqr", "pngjs", "yargs"]) assert.equal(includes(absent), false, `${absent} must not ship in the browser runtime`);
await writeFile(".tmp/quick-transfer-desktop-bundle/modules.json", JSON.stringify({ qrcode: "1.5.4", runtimeDependencies: ["dijkstrajs@1.0.3"], excluded: ["jsqr", "pngjs", "yargs"] }, null, 2));
console.log("PASS quick transfer browser bundle: qrcode + dijkstrajs; no test decoder or Node-only dependencies");
