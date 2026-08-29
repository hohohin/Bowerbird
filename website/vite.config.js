import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// vite build 使用本配置：以 index.html 为入口产出 dist/，并把下列已构建文件原样复制进 dist。
// app.bundle.js / app-v2.bundle.js 由 bundle:file（vite.file.config.js）先行生成；
// index-v2.html 引用 ./app-v2.bundle.js，相对路径在 dist 下同样有效。
const EXTRA_FILES = ["app.bundle.js", "app-v2.bundle.js", "index-v2.html", "wechat-callback.html"];

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
    outDir: "dist",
    emptyOutDir: true,
  },
});
