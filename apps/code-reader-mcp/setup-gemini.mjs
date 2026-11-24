import { chmodSync, mkdirSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { usesLocalConfig } from './gemini-config-mode.mjs';

const args = process.argv.slice(2);
const newLoopback = args.length === 2 && args[0] === '--origin' && /^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(args[1]);
if (newLoopback || usesLocalConfig()) {
  await import('./setup-local-gemini.mjs');
} else {
  const { validateConfig, googleRedirect, GEMINI_ORIGIN } = await import('./http-app.mjs');
  const { values, tokens } = parseArgs({ args, tokens: true, options: {
    origin: { type: 'string' },
    'remote-port': { type: 'string' },
    'ssh-user': { type: 'string' },
    'redirect-uri': { type: 'string' },
  } });
  if (new Set(tokens.map(token => token.name)).size !== tokens.length) throw new Error('Duplicate Gemini setup option');
  const redirect = values['redirect-uri'];
  const remotePort = values['remote-port'];
  if (redirect !== undefined && !googleRedirect(redirect)) throw new Error('Use the exact Google callback URL.');
  if (remotePort !== undefined && (!/^[0-9]{1,5}$/.test(remotePort) || /[^0-9]/.test(remotePort))) {
    throw new Error('Use a numeric Gemini SSH remote port.');
  }

  const dir = fileURLToPath(new URL('./.local/gemini/', import.meta.url));
  const configFile = path.join(dir, 'config.json');
  const existing = existsSync(configFile);
  const config = existing ? validateConfig(JSON.parse(readFileSync(configFile, 'utf8'))) : {
    origin: values.origin ?? GEMINI_ORIGIN, port: 48731, adminPassword: randomBytes(32).toString('base64url'),
  };
  if (values.origin !== undefined && values.origin !== config.origin) {
    throw new Error('Existing Gemini issuer is in use. Set up the other origin in a separate checkout.');
  }
  if (remotePort !== undefined) config.remotePort = Number(remotePort);
  if (values['ssh-user'] !== undefined) config.sshUser = values['ssh-user'];
  if (redirect !== undefined) {
    config.oauthClient = { clientId: config.oauthClient?.clientId ?? randomBytes(32).toString('base64url'),
      clientSecret: config.oauthClient?.clientSecret ?? randomBytes(32).toString('base64url'), redirectUri: redirect };
  }
  validateConfig(config);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
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
  if (!existing) {
    writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
  } else if (remotePort !== undefined || values['ssh-user'] !== undefined || redirect !== undefined) {
    if (process.platform === 'win32') {
      writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    } else {
      const temporary = path.join(dir, 'config.' + randomBytes(16).toString('hex') + '.tmp');
      try {
        writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
        renameSync(temporary, configFile);
      } finally { rmSync(temporary, { force: true }); }
    }
  }
  if (process.platform === 'win32') {
    const account = execFileSync('whoami', [], { encoding: 'utf8', windowsHide: true }).trim();
    for (const file of [configFile, identity, identity + '.pub', knownHosts]) {
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', account + ':(F)'], { windowsHide: true, stdio: 'pipe' });
    }
  } else {
    for (const file of [configFile, identity, knownHosts]) chmodSync(file, 0o600);
  }
  console.log('Prepared local Gemini configuration, dedicated tunnel key and pinned VPS host key.');
  console.log('Authorization password remains in ' + configFile);
  if (config.oauthClient) console.log('Manual OAuth Client ID and secret remain in oauthClient in the same local file. Restart Gemini MCP to load them.');
  console.log('Deploy only the public key at ' + identity + '.pub');
}
