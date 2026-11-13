import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { createRequire } from "node:module";
import { viteLifecycle } from "./scripts/vite-lifecycle.mjs";
import { textEditorAssets } from "./scripts/text-editor-assets.mjs";

// Tauri 期望 Vite dev server 跑在固定端口 (1420) 上，
// 且 HMR 在 Tauri WebView 里要用具体 IP 而非 localhost。
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), viteLifecycle(), textEditorAssets()],
  clearScreen: false,
  root: resolve(__dirname, "."),
  resolve: {
    alias: {
      // Vite prebundles Markdown dependencies for the page and the Worker together.
      // The package's default export uses the entity table; its browser export needs a DOM.
      "decode-named-character-reference": createRequire(import.meta.url).resolve("decode-named-character-reference"),
      "@": resolve(__dirname, "./src"),
      events: "events/",
      path: "path-browserify",
      buffer: "buffer/",
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/.tmp/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    rollupOptions: {
      input: { main: resolve(__dirname, "index.html"), screenshot: resolve(__dirname, "screenshot.html") },
    },
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
  },
});
