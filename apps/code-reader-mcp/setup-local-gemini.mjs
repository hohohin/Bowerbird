import { mkdir, lstat, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { token, validGoogleRedirect } from './gemini-oauth.mjs';
import { publicOrigin } from './local-http-app.mjs';

const directory = new URL('./.local/gemini/', import.meta.url);
const file = new URL('config.json', directory);
const [mode, value, ...extra] = process.argv.slice(2);
if (extra.length || !value || !['--origin', '--redirect-uri'].includes(mode)) {
  throw new Error('Usage: node setup-gemini.mjs --origin https://your-host OR --redirect-uri <exact Google redirect>');
}

if (mode === '--origin') {
  publicOrigin(value);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ origin: value, port: 48731, adminPassword: token(), clients: [] }, null, 2),
    { mode: 0o600, flag: 'wx' });
} else {
  if (!validGoogleRedirect(value)) throw new Error('Use the exact Google redirect URI shown by Gemini.');
  const info = await lstat(file);
  if (!info.isFile() || info.nlink !== 1 || info.size > 65536) throw new Error('Invalid configuration file');
  const config = JSON.parse(await readFile(file, 'utf8'));
  const clients = config.clients ?? [];
  if (clients.length >= 16 || clients.some(client => client.redirect_uri === value)) throw new Error('Client already registered or limit reached');
  const temporary = new URL(`config.${token()}.tmp`, directory);
  config.clients = [...clients, { client_id: token(), client_secret: token(), redirect_uri: value }];
  await writeFile(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}
console.log(`Saved configuration to ${fileURLToPath(file)}`);
