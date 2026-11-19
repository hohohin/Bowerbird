import { readFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { verifyUpdate } from "../macOS/verify-update.mjs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export async function inspectSignedInstaller(installer) {
  const config = JSON.parse(await readFile(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const filename = `Bowerbird_${config.version}_x64-setup.exe`;
  const signature = (await readFile(`${installer}.sig`, "utf8")).trim();
  const bytes = await readFile(installer);
  if (!bytes.length) throw new Error("Installer is empty");
  verifyUpdate(bytes, signature, config.plugins.updater.pubkey);
  const decoded = Buffer.from(signature, "base64").toString("utf8");
  if (!decoded.split(/\r?\n/)[2].split("\t").includes(`file:${filename}`)) {
    throw new Error("Signed installer version or architecture does not match the release channel");
  }
  return { platform: "windows-x86_64", version: config.version, installer: filename,
    sha256: createHash("sha256").update(bytes).digest("hex"), signature };
}

export async function writeUpdateManifest(installer, downloadUrl, output, notesFile, evidenceFile = installer + ".verification.json") {
  const candidate = await inspectSignedInstaller(installer);
  const url = new URL(downloadUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || decodeURIComponent(url.pathname.split("/").at(-1)) !== candidate.installer) {
    throw new Error("Use an immutable HTTPS installer URL containing the exact configured version.");
  }
  const evidence = JSON.parse((await readFile(evidenceFile, "utf8")).replace(/^\uFEFF/, ""));
  if (evidence.platform !== candidate.platform || evidence.version !== candidate.version
    || evidence.installer !== candidate.installer || evidence.typecheckAndRustTests !== "passed"
    || evidence.sha256?.toLowerCase() !== candidate.sha256) {
    throw new Error("A passing TypeScript and Rust test record for this exact installer SHA-256 is required.");
  }
  const manifest = {
    version: candidate.version,
    notes: notesFile ? (await readFile(notesFile, "utf8")).trim() : "改进与问题修复。安装后需要重新登录，素材和项目会保留。",
    pub_date: new Date().toISOString(),
    platforms: { "windows-x86_64": { url: url.href, signature: candidate.signature } },
  };
  const staged = `${output}.${randomUUID()}.tmp`;
  await writeFile(staged, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(staged, output);
  return manifest;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === "--inspect") {
    console.log(JSON.stringify(await inspectSignedInstaller(process.argv[3])));
    process.exit(0);
  }
  const [installer, url, output, notes, evidence] = process.argv.slice(2);
  if (!installer || !url || !output) throw new Error("Usage: node update-manifest.mjs <installer> <https-url> <manifest-output> [notes-file] [test-record]");
  await writeUpdateManifest(installer, url, output, notes, evidence);
  console.log(`Signed update manifest: ${output}`);
}
