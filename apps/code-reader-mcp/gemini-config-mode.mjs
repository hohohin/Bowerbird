import { lstatSync, readFileSync } from 'node:fs';

export function usesLocalConfig() {
  const file = new URL('./.local/gemini/config.json', import.meta.url);
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info) return false;
  if (!info.isFile() || info.nlink !== 1 || info.size > 65536) throw new Error('Invalid Gemini configuration file');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  return Object.hasOwn(config, 'clients');
}
