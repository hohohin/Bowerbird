// Offline issuance: save plaintext privately, then apply the hash-only SQL using an admin connection.
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [countArg, expiresArg, outputDir] = process.argv.slice(2);
const count = Number(countArg);
const expires = new Date(expiresArg);
if (!Number.isInteger(count) || count < 1 || count > 1000 || !Number.isFinite(expires.getTime()) || expires <= new Date() || !outputDir) {
  throw new Error("Usage: node apps/cloud/scripts/create-pro-codes.mjs <count 1..1000> <redeem-before ISO timestamp> <private output directory>");
}
const batchId = randomUUID();
const codes = Array.from({ length: count }, () => {
  const raw = randomBytes(16).toString("hex").toUpperCase();
  return {
    id: randomUUID(), code: raw.match(/.{8}/g).join("-"),
    hash: createHash("sha256").update(raw).digest("hex"),
  };
});
const directory = path.resolve(outputDir);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const privatePath = path.join(directory, `pro-codes-${batchId}.json`);
const sqlPath = path.join(directory, `pro-codes-${batchId}.sql`);
writeFileSync(privatePath, JSON.stringify({ batchId, proMonths: 1, credits: 1100, expiresAt: expires.toISOString(), codes }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
writeFileSync(sqlPath, `-- Pro monthly + 1100 credits; batch ${batchId}. No plaintext codes.\nbegin;\ninsert into public.pro_redemption_codes(id, code_hash, expires_at) values\n${codes.map(({ id, hash }) => `('${id}', '${hash}', '${expires.toISOString()}')`).join(",\n")}\non conflict (code_hash) do nothing;\ncommit;\n`, { flag: "wx", mode: 0o600 });
console.log(`Created ${count} codes locally. Apply the SQL to activate them.\nPrivate codes: ${privatePath}\nHash-only SQL: ${sqlPath}`);
