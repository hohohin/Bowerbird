import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const fields = {
  speechApiKey: 'DOUBAO_SPEECH_API_KEY', speechAppId: 'DOUBAO_SPEECH_APP_ID',
  speechAccessToken: 'DOUBAO_SPEECH_ACCESS_TOKEN', speechResourceId: 'DOUBAO_SPEECH_RESOURCE_ID',
  jimengBinary: 'JIMENG_BINARY', ffmpegBinary: 'FFMPEG_BINARY', ffprobeBinary: 'FFPROBE_BINARY',
  browserExecutable: 'BROWSER_EXECUTABLE', codexBinary: 'CODEX_BINARY',
};
const secretFields = new Set(['speechApiKey', 'speechAccessToken']);

export function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { throw new Error('配置文件中的双引号未正确闭合。'); } }
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

export async function loadConfig(root) {
  let source = '';
  try { source = await readFile(join(root, '.env.local'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const env = parseEnv(source);
  const config = Object.fromEntries(Object.entries(fields).map(([key, name]) => [key, env[name] || '']));
  config.speechResourceId ||= 'volc.bigasr.auc_turbo';
  return config;
}

export function publicConfig(config) {
  const result = { ...config };
  for (const key of secretFields) { result[`${key}Configured`] = Boolean(config[key]); delete result[key]; }
  result.speechConfigured = Boolean(config.speechApiKey || (config.speechAppId && config.speechAccessToken));
  return result;
}

export async function saveConfig(root, changes) {
  const config = await loadConfig(root);
  for (const [key, value] of Object.entries(changes)) {
    if (!(key in fields) || typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) {
      throw new Error('配置内容不正确，请检查填写的字段。');
    }
    // Empty password inputs mean keep the existing key. A dedicated clear action is not needed for this demo.
    if (secretFields.has(key) && !value.trim()) continue;
    config[key] = value.trim();
  }
  const file = join(root, '.env.local');
  await mkdir(dirname(file), { recursive: true });
  const lines = ['# Local credentials. Ignored by Git; never served by the Demo.'];
  for (const [key, name] of Object.entries(fields)) lines.push(`${name}=${JSON.stringify(config[key])}`);
  await writeFile(`${file}.tmp`, lines.join('\n') + '\n', { mode: 0o600 });
  await rename(`${file}.tmp`, file);
  return publicConfig(config);
}
