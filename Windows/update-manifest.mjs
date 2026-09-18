import { readFile, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export async function writeUpdateManifest(installer, downloadUrl, output, notesFile) {
  const config = JSON.parse(await readFile(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const url = new URL(downloadUrl);
  const filename = `Bowerbird_${config.version}_x64-setup.exe`;
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || decodeURIComponent(url.pathname.split("/").at(-1)) !== filename) {
    throw new Error("Use an immutable HTTPS installer URL containing the exact configured version.");
  }
  if (!(await stat(installer)).size) throw new Error("Installer is empty");
  const signature = (await readFile(`${installer}.sig`, "utf8")).trim();
  const decoded = Buffer.from(signature, "base64").toString("utf8");
  if (!decoded.startsWith("untrusted comment:") || !decoded.includes("trusted comment:")) {
    throw new Error("Missing or malformed Tauri updater signature");
  }
  const manifest = {
    version: config.version,
    notes: notesFile ? (await readFile(notesFile, "utf8")).trim() : "改进与问题修复。安装后需要重新登录，素材和项目会保留。",
    pub_date: new Date().toISOString(),
    platforms: { "windows-x86_64": { url: url.href, signature } },
  };
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [installer, url, output, notes] = process.argv.slice(2);
  if (!installer || !url || !output) throw new Error("Usage: node update-manifest.mjs <installer> <https-url> <manifest-output> [notes-file]");
  await writeUpdateManifest(installer, url, output, notes);
  console.log(`Signed update manifest: ${output}`);
}
