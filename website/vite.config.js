import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// The homepages and pricing page share Vite's asset pipeline. Keep classic scripts and standalone
// pages at their public URLs, including the account SDK loaded at runtime.
const EXTRA_FILES = [
  "account-sdk.js", "app.bundle.js", "app-v2.bundle.js", "user-error.js",
  "billing.js", "assets/logo.png",
  "wechat-callback.html", "wechat-callback.css",
  "admin/index.html", "admin/admin.js", "admin/admin.css",
];

export default defineConfig({
  base: "./",
  plugins: [
    {
      name: "copy-file-bundle",
      generateBundle() {
        for (const file of EXTRA_FILES) {
          this.emitFile({
            type: "asset",
            fileName: file,
            source: readFileSync(resolve(__dirname, file)),
          });
        }
      },
    },
  ],
  build: {
    rollupOptions: {
      input: ["index.html", "index-v2.html", "pricing/index.html"],
      output: {
        manualChunks(id) {
          // Pricing retains its approved base + upgrade CSS. The public
          // homepages import styles.css?homepage for their original layout.
          if (id.endsWith("/website/styles.css") || id.endsWith("/website/homepage-upgrade.css")) {
            return "homepage-upgrade";
          }
        },
      },
    },
    outDir: "dist",
    emptyOutDir: true,
  },
});
