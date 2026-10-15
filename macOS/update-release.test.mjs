import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { verifyUpdate } from "./verify-update.mjs";

const root = await mkdtemp(join(tmpdir(), "bowerbird-mac-release-test-"));
const version = "26.9.2001";
const bytes = Buffer.from("isolated release fixture; not an application");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const id = Buffer.from("12345678");
const pub = Buffer.from(`untrusted comment: test\n${Buffer.concat([
  Buffer.from("Ed"), id, publicKey.export({ format: "der", type: "spki" }).subarray(-32),
]).toString("base64")}\n`).toString("base64");
const main = sign(null, createHash("blake2b512").update(bytes).digest(), privateKey);
const comment = "timestamp:1\tfile:fixture\tprehashed";
const signature = Buffer.from(`untrusted comment: test\n${Buffer.concat([Buffer.from("ED"), id, main]).toString("base64")}\ntrusted comment: ${comment}\n${sign(null, Buffer.concat([main, Buffer.from(comment)]), privateKey).toString("base64")}\n`).toString("base64");
try {
  // Independent vector from minisign-verify 0.2.5's documented example.
  verifyUpdate(Buffer.from("test"), Buffer.from("untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==\n").toString("base64"),
    Buffer.from("untrusted comment: reference\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n").toString("base64"));
  verifyUpdate(bytes, signature, pub);
  assert.throws(() => verifyUpdate(Buffer.from("tampered"), signature, pub), /verification failed/);
  const badComment = Buffer.from(signature, "base64").toString().replace("timestamp:1", "timestamp:2");
  assert.throws(() => verifyUpdate(bytes, Buffer.from(badComment).toString("base64"), pub), /verification failed/);
  assert.throws(() => verifyUpdate(bytes, "invalid", pub), /Malformed/);

  for (const directory of ["bin", "macOS", "apps/desktop/src-tauri/target/release/bundle/macos/Bowerbird.app/Contents/MacOS", "apps/desktop/src-tauri/target/release/bundle/dmg"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  for (const name of ["release.sh", "update-manifest.mjs", "verify-update.mjs"]) {
    await copyFile(new URL(name, import.meta.url), join(root, "macOS", name));
  }
  await writeFile(join(root, "apps/desktop/src-tauri/tauri.conf.json"), JSON.stringify({ version }));
  await writeFile(join(root, "apps/desktop/src-tauri/tauri.macos.conf.json"), JSON.stringify({ plugins: { updater: { pubkey: pub } } }));
  const mocks = {
    rustc: 'echo "host: $TEST_HOST"',
    curl: 'echo \'{"version":"26.9.18"}\'',
    plutil: `echo ${version}`,
    file: 'echo "Mach-O 64-bit executable $TEST_MACHO"',
    hdiutil: 'exit 0',
  };
  for (const [name, body] of Object.entries(mocks)) await writeFile(join(root, "bin", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const bundle = join(root, "apps/desktop/src-tauri/target/release/bundle");
  await writeFile(join(bundle, "macos/Bowerbird.app.tar.gz"), bytes);
  await writeFile(join(bundle, "macos/Bowerbird.app.tar.gz.sig"), signature);
  function run(host, macho) {
    return spawnSync("bash", ["macOS/release.sh"], { cwd: root, encoding: "utf8", env: {
      ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, COS_SKIP_BUILD: "1", COS_SKIP_UPLOAD: "1",
      TEST_HOST: host, TEST_MACHO: macho, COS_PUBLIC_BASE: "https://example.com",
    } });
  }
  for (const [arch, host, dmg, macho] of [
    ["x86_64", "x86_64-apple-darwin", "x64", "x86_64"],
    ["aarch64", "aarch64-apple-darwin", "aarch64", "arm64"],
  ]) {
    await writeFile(join(bundle, `dmg/Bowerbird_${version}_${dmg}.dmg`), bytes);
    const result = run(host, macho);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const manifest = JSON.parse(await readFile(join(root, `macOS/dist/darwin-${arch}.json`), "utf8"));
    assert.deepEqual(Object.keys(manifest.platforms), [`darwin-${arch}`]);
    assert.equal(manifest.platforms[`darwin-${arch}`].url, `https://example.com/mac_package/Bowerbird_${version}_${arch}.app.tar.gz`);
    assert.equal(manifest.platforms[`darwin-${arch}`].signature, signature);
    await rm(join(bundle, `dmg/Bowerbird_${version}_${dmg}.dmg`));
  }
  assert.notEqual(run("x86_64-unknown-linux-gnu", "x86_64").status, 0);
  await rm(join(bundle, "macos/Bowerbird.app.tar.gz.sig"));
  assert.notEqual(run("x86_64-apple-darwin", "x86_64").status, 0);
  console.log("PASS Mac release: Intel x64 DMG / x86_64 channel, ARM64, signature/tamper/comment, unsupported host, missing signature");
} finally {
  await rm(root, { recursive: true, force: true });
}
