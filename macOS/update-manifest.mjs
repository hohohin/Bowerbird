import { readFile, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Mirrors Windows/update-manifest.mjs for the darwin updater channels. The
// artifact is the tar.gz the Tauri bundler signs, published under a versioned
// immutable name; the running app extracts it and replaces its own .app.
export async function writeUpdateManifest(bundle, arch, downloadUrl, output, notesFile) {
  if (arch !== "aarch64" && arch !== "x86_64") {
    throw new Error("Architecture must be aarch64 or x86_64.");
  }
  const config = JSON.parse(await readFile(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const url = new URL(downloadUrl);
  const filename = `Bowerbird_${config.version}_${arch}.app.tar.gz`;
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || decodeURIComponent(url.pathname.split("/").at(-1)) !== filename) {
    throw new Error("Use an immutable HTTPS bundle URL containing the exact configured version and architecture.");
  }
  if (!(await stat(bundle)).size) throw new Error("Bundle is empty");
  const signature = (await readFile(`${bundle}.sig`, "utf8")).trim();
  const decoded = Buffer.from(signature, "base64").toString("utf8");
  if (!decoded.startsWith("untrusted comment:") || !decoded.includes("trusted comment:")) {
    throw new Error("Missing or malformed Tauri updater signature");
  }
  const manifest = {
    version: config.version,
    notes: notesFile ? (await readFile(notesFile, "utf8")).trim() : "改进与问题修复。更新在本机完成，素材、项目和登录状态保留。",
    pub_date: new Date().toISOString(),
    platforms: { [`darwin-${arch}`]: { url: url.href, signature } },
  };
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [bundle, arch, url, output, notes] = process.argv.slice(2);
  if (!bundle || !arch || !url || !output) throw new Error("Usage: node macOS/update-manifest.mjs <app.tar.gz> <aarch64|x86_64> <https-url> <manifest-output> [notes-file]");
  await writeUpdateManifest(bundle, arch, url, output, notes);
  console.log(`Signed darwin-${arch} update manifest: ${output}`);
}
