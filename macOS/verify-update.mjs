import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Tauri wraps the minisign public key and signature text in base64.
// Match minisign-verify: ED = BLAKE2b-512, then Ed25519; verify the comment too.
export function verifyUpdate(bytes, signature, publicKey) {
  const keyLines = Buffer.from(publicKey.trim(), "base64").toString("utf8").trim().split(/\r?\n/);
  const lines = Buffer.from(signature.trim(), "base64").toString("utf8").trim().split(/\r?\n/);
  const key = Buffer.from(keyLines[1] ?? "", "base64");
  const sig = Buffer.from(lines[1] ?? "", "base64");
  const global = Buffer.from(lines[3] ?? "", "base64");
  if (key.length !== 42 || sig.length !== 74 || global.length !== 64
    || key.subarray(0, 2).toString() !== "Ed" || sig.subarray(0, 2).toString() !== "ED"
    || !lines[2]?.startsWith("trusted comment: ")) throw new Error("Malformed updater key/signature");
  if (!key.subarray(2, 10).equals(sig.subarray(2, 10))) throw new Error("Updater key ID mismatch");
  const ed25519 = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]),
    format: "der", type: "spki",
  });
  const digest = createHash("blake2b512").update(bytes).digest();
  const comment = Buffer.from(lines[2].slice("trusted comment: ".length));
  if (!verify(null, digest, ed25519, sig.subarray(10))
    || !verify(null, Buffer.concat([sig.subarray(10), comment]), ed25519, global)) {
    throw new Error("Updater signature verification failed");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [bundle, signature, key] = process.argv.slice(2);
  if (!bundle || !signature || !key) throw new Error("Usage: node verify-update.mjs <bundle> <bundle.sig> <mac.pubkey.b64>");
  verifyUpdate(await readFile(bundle), await readFile(signature, "utf8"), await readFile(key, "utf8"));
  console.log("PASS Mac updater package signature and trusted comment");
}
