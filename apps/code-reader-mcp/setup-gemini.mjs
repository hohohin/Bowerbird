import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateConfig, googleRedirect } from './http-app.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--redirect-uri' || !googleRedirect(args[1]))) {
  throw new Error('Usage: node setup-gemini.mjs [--redirect-uri <exact Google callback URL>]');
}

const dir = fileURLToPath(new URL('./.local/gemini/', import.meta.url));
mkdirSync(dir, { recursive: true, mode: 0o700 });
const configFile = path.join(dir, 'config.json');
if (!existsSync(configFile)) {
  writeFileSync(configFile, JSON.stringify({ origin: 'https://mcp.bowerbird.cn', port: 48731,
    adminPassword: randomBytes(32).toString('base64url') }, null, 2), { mode: 0o600, flag: 'wx' });
}
const config = validateConfig(JSON.parse(readFileSync(configFile, 'utf8')));
if (args.length) {
  config.oauthClient = { clientId: config.oauthClient?.clientId ?? randomBytes(32).toString('base64url'),
    clientSecret: config.oauthClient?.clientSecret ?? randomBytes(32).toString('base64url'), redirectUri: args[1] };
  validateConfig(config);
  writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
}
const identity = path.join(dir, 'id_ed25519');
if (!existsSync(identity)) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'bowerbird-mcp-tunnel', '-f', identity], { windowsHide: true });
if (!existsSync(identity + '.pub')) throw new Error('Tunnel public key missing');
const knownHosts = path.join(dir, 'known_hosts');
if (!existsSync(knownHosts)) {
  const trusted = execFileSync('ssh-keygen', ['-F', '106.55.44.143', '-f', path.join(os.homedir(), '.ssh', 'known_hosts')], { encoding: 'utf8', windowsHide: true });
  const entries = trusted.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
  if (!entries.length) throw new Error('No previously trusted VPS host key');
  writeFileSync(knownHosts, entries.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
}
if (process.platform === 'win32') {
  const account = execFileSync('whoami', [], { encoding: 'utf8', windowsHide: true }).trim();
  for (const file of [configFile, identity, identity + '.pub', knownHosts]) {
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', account + ':(F)'], { windowsHide: true, stdio: 'pipe' });
  }
}
console.log('Prepared local Gemini configuration, dedicated tunnel key and pinned VPS host key.');
console.log('Authorization password remains in ' + configFile);
if (config.oauthClient) console.log('Manual OAuth Client ID and secret remain in oauthClient in the same local file. Restart Gemini MCP to load them.');
console.log('Deploy only the public key at ' + identity + '.pub');
