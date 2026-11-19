import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [{
    name: "bundle-account-sdk",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "account-sdk.js",
        source: readFileSync(resolve(__dirname, "node_modules/@supabase/supabase-js/dist/umd/supabase.js")) });
    },
  }],
  build: {
    lib: {
      entry: resolve(__dirname, "app.js"),
      name: "BowerbirdWebsite",
      formats: ["iife"],
      fileName: () => "app.bundle.js",
    },
    outDir: ".",
    emptyOutDir: false,
    minify: true,
  },
});
