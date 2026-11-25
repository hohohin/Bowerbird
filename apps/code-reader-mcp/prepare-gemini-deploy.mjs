import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GEMINI_MAC_ORIGIN, GEMINI_REMOTE_PORT, GEMINI_SSH_USER, validateConfig } from './http-app.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const local = path.join(here, '.local/gemini');
const config = validateConfig(JSON.parse(readFileSync(path.join(local, 'config.json'), 'utf8')));
const mac = config.origin === GEMINI_MAC_ORIGIN;
const remotePort = mac ? 48734 : GEMINI_REMOTE_PORT;
const sshUser = mac ? 'bowerbird-mcp-mac' : GEMINI_SSH_USER;
if ((config.remotePort ?? GEMINI_REMOTE_PORT) !== remotePort || (config.sshUser ?? GEMINI_SSH_USER) !== sshUser) {
  throw new Error('The SSH account and port must match the deployment profile for this issuer.');
}
const target = path.join(local, mac ? 'deployment-mac' : 'deployment');
mkdirSync(target, { recursive: true, mode: 0o700 });
const replacements = {
  'mcp.bowerbird.cn': 'mcp-mac.bowerbird.cn',
  'bowerbird-mcp': sshUser,
  'bowerbird_mcp': 'bowerbird_mcp_mac',
  '48732': String(remotePort),
};
const forMac = text => text.replace(/mcp\.bowerbird\.cn|bowerbird-mcp|bowerbird_mcp|48732/g, match => replacements[match]);
const manifest = [];
for (const name of readdirSync(path.join(here, 'deploy')).sort()) {
  const template = readFileSync(path.join(here, 'deploy', name), 'utf8').replaceAll('\r\n', '\n');
  const outputName = mac ? forMac(name) : name;
  let contents = mac ? forMac(template) : template;
  if (mac && name.endsWith('.conf') && name.startsWith('90-')) {
    contents = contents.replace('    AllowTcpForwarding remote\n', '    AllowTcpForwarding remote\n    AllowStreamLocalForwarding no\n    PermitTunnel no\n');
  }
  writeFileSync(path.join(target, outputName), contents, { mode: 0o600 });
  manifest.push(createHash('sha256').update(contents).digest('hex') + '  ' + outputName);
}
const publicKey = readFileSync(path.join(local, 'id_ed25519.pub'), 'utf8').trim() + '\n';
if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]+)?\n$/.test(publicKey)) throw new Error('Invalid dedicated tunnel public key');
writeFileSync(path.join(target, 'tunnel.pub'), publicKey, { mode: 0o600 });
manifest.push(createHash('sha256').update(publicKey).digest('hex') + '  tunnel.pub');
writeFileSync(path.join(target, 'SHA256SUMS'), manifest.join('\n') + '\n', { mode: 0o600 });
console.log('Prepared public-only deployment bundle at ' + target + '. No deployment performed.');
