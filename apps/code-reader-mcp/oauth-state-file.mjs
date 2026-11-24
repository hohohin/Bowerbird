import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 4 * 1024 * 1024;

// This runs in the launcher. The HTTP child can only ask it to read or replace
// this fixed file and never receives filesystem write permissions.
export function attachOAuthStateFile(child, local) {
  const directory = path.join(local, 'oauth');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new Error('Invalid OAuth directory');
  if (process.platform === 'win32') {
    const account = execFileSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true }).trim();
    execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', account + ':(OI)(CI)F'], {
      windowsHide: true, stdio: 'pipe',
    });
  }
  const file = path.join(directory, 'state.json');
  child.on('message', message => {
    if (!Number.isSafeInteger(message?.id) || !['oauth-load', 'oauth-save'].includes(message.type)) return;
    try {
      let data;
      if (message.type === 'oauth-load') {
        try {
          const info = lstatSync(file);
          if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Invalid OAuth file');
          data = readFileSync(file, 'utf8');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      } else {
        if (typeof message.data !== 'string' || Buffer.byteLength(message.data) > MAX_BYTES) throw new Error('Invalid OAuth write');
        const temporary = path.join(directory, randomUUID() + '.tmp');
        try {
          writeFileSync(temporary, message.data, { mode: 0o600, flag: 'wx', flush: true });
          renameSync(temporary, file);
        } finally { rmSync(temporary, { force: true }); }
      }
      child.send({ id: message.id, data }, () => {});
    } catch {
      child.send({ id: message.id, error: true }, () => {});
    }
  });
}
