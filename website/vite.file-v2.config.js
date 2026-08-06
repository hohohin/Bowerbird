import { resolve } from "node:path";
import { defineConfig } from "vite";

// v2 单独 lib 构建：app-v2.js -> app-v2.bundle.js（IIFE 仅支持单入口）。
export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "app-v2.js"),
      name: "BowerbirdWebsiteV2",
      formats: ["iife"],
      fileName: () => "app-v2.bundle.js",
    },
    outDir: ".",
    emptyOutDir: false,
    minify: true,
  },
});
