import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
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
