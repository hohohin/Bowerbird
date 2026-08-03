import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [
    {
      name: "copy-file-bundle",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "app.bundle.js",
          source: readFileSync(resolve(__dirname, "app.bundle.js")),
        });
      },
    },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
