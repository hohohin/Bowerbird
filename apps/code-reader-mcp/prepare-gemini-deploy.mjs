import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, '.local/gemini/deployment');
mkdirSync(target, { recursive: true, mode: 0o700 });
const manifest = [];
for (const name of readdirSync(path.join(here, 'deploy')).sort()) {
  const contents = readFileSync(path.join(here, 'deploy', name), 'utf8').replaceAll('\r\n', '\n');
  writeFileSync(path.join(target, name), contents, { mode: 0o600 });
  manifest.push(createHash('sha256').update(contents).digest('hex') + '  ' + name);
}
const publicKey = readFileSync(path.join(here, '.local/gemini/id_ed25519.pub'), 'utf8').trim() + '\n';
if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]+)?\n$/.test(publicKey)) throw new Error('Invalid dedicated tunnel public key');
writeFileSync(path.join(target, 'tunnel.pub'), publicKey, { mode: 0o600 });
manifest.push(createHash('sha256').update(publicKey).digest('hex') + '  tunnel.pub');
writeFileSync(path.join(target, 'SHA256SUMS'), manifest.join('\n') + '\n', { mode: 0o600 });
console.log('Prepared public-only deployment bundle at ' + target + '. No deployment performed.');
