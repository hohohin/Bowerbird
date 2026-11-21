import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

test("manifest verifies installer, release key and signed filename before replacing the output", async t => {
  const root = await mkdtemp(join(tmpdir(), "bowerbird-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ["Windows", "macOS", "apps/desktop/src-tauri"]) await mkdir(join(root, path), { recursive: true });
  for (const path of ["Windows/update-manifest.mjs", "macOS/verify-update.mjs"]) {
    await copyFile(new URL("../" + path, import.meta.url), join(root, path));
  }
  const { writeUpdateManifest } = await import(pathToFileURL(join(root, "Windows/update-manifest.mjs")));
  const filename = "Bowerbird_1.2.3_x64-setup.exe";
  const installer = join(root, filename), output = join(root, "manifest.json");
  const url = "https://example.test/" + filename;
  const key = generateKeyPairSync("ed25519");
  const id = Buffer.from("12345678");
  const wrapped = (...lines) => Buffer.from(lines.join("\n")).toString("base64");
  const pubkey = wrapped("untrusted comment: test", Buffer.concat([Buffer.from("Ed"), id,
    key.publicKey.export({ type: "spki", format: "der" }).subarray(-32)]).toString("base64"));
  await writeFile(join(root, "apps/desktop/src-tauri/tauri.conf.json"), JSON.stringify({
    version: "1.2.3", plugins: { updater: { pubkey } },
  }));
  const bytes = Buffer.from("isolated release fixture");
  function signed(bytes, file, privateKey) {
    const sig = sign(null, createHash("blake2b512").update(bytes).digest(), privateKey);
    const comment = "timestamp:1\tfile:" + file;
    return wrapped("untrusted comment: fixture", Buffer.concat([Buffer.from("ED"), id, sig]).toString("base64"),
      "trusted comment: " + comment, sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey).toString("base64"));
  }
  await writeFile(installer, bytes);
  await writeFile(installer + ".sig", signed(bytes, filename, key.privateKey));
  const evidence = { version: "1.2.3", platform: "windows-x86_64", installer: filename,
    sha256: createHash("sha256").update(bytes).digest("hex"), typecheckAndRustTests: "passed" };
  const record = installer + ".verification.json";
  await assert.rejects(writeUpdateManifest(installer, url, output), /ENOENT/);
  await writeFile(record, "\uFEFF" + JSON.stringify(evidence));
  await writeUpdateManifest(installer, url, output);
  const original = await readFile(output, "utf8");
  for (const mismatch of [{ sha256: "0".repeat(64) }, { typecheckAndRustTests: "skipped" },
    { installer: "other.exe" }, { version: "1.2.2" }, { platform: "darwin-x86_64" }]) {
    await writeFile(record, JSON.stringify({ ...evidence, ...mismatch }));
    await assert.rejects(writeUpdateManifest(installer, url, output), /exact installer SHA-256/);
    assert.equal(await readFile(output, "utf8"), original);
  }
  await writeFile(record, JSON.stringify(evidence));
  for (const signature of [signed(Buffer.from("other"), filename, key.privateKey),
    signed(bytes, filename, generateKeyPairSync("ed25519").privateKey), signed(bytes, "other.exe", key.privateKey),
    wrapped("untrusted comment:", "trusted comment:")]) {
    await writeFile(installer + ".sig", signature);
    await assert.rejects(writeUpdateManifest(installer, url, output));
    assert.equal(await readFile(output, "utf8"), original);
  }
  await writeFile(installer, Buffer.alloc(0));
  await writeFile(installer + ".sig", signed(Buffer.alloc(0), filename, key.privateKey));
  await assert.rejects(writeUpdateManifest(installer, url, output), /empty/);
  assert.equal(await readFile(output, "utf8"), original);

  if (process.platform === "win32") {
    // Exercise actual build.ps1 branching with a disposable signed bundler output.
    const work = join(root, "fixture-work");
    const workConfig = join(work, "apps/desktop/src-tauri");
    const bundled = join(workConfig, "target/release/bundle/nsis", filename);
    await mkdir(join(workConfig, "target/release/bundle/nsis"), { recursive: true });
    await copyFile(join(root, "apps/desktop/src-tauri/tauri.conf.json"), join(workConfig, "tauri.conf.json"));
    await writeFile(bundled, bytes);
    await writeFile(bundled + ".sig", signed(bytes, filename, key.privateKey));
    const win = join(root, "Windows");
    await copyFile(new URL("build.ps1", import.meta.url), join(win, "build.ps1"));
    await writeFile(join(win, "prepare.ps1"), 'param([switch]$Clean)\nWrite-Output $env:TEST_WORK\n');
    await writeFile(join(win, "verify-installer.ps1"), "param($Installer,$Version)\n");
    for (const command of ["pnpm", "cargo"]) await writeFile(join(win, command + ".cmd"), "@exit /b 0\r\n");
    const run = (...args) => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      join(win, "build.ps1"), ...args], { encoding: "utf8", env: { ...process.env,
        TEST_WORK: work, PATH: win + ";" + process.env.PATH, TAURI_SIGNING_PRIVATE_KEY: "fixture-only" } });
    const skipped = run("-SkipTests");
    assert.equal(skipped.status, 0, skipped.stderr);
    const untested = join(win, "dist", "untested", evidence.sha256);
    assert.deepEqual(await readFile(join(untested, filename)), bytes);
    await assert.rejects(readFile(join(win, "dist/windows-x86_64.json")), /ENOENT/);
    await assert.rejects(writeUpdateManifest(join(untested, filename), url, output), /exact installer/);
    const tested = run();
    assert.equal(tested.status, 0, tested.stderr);
    assert.equal(JSON.parse(await readFile(join(win, "dist/windows-x86_64.json"), "utf8")).version, "1.2.3");
  }
});
