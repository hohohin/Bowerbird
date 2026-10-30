import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, publicConfig } from '../lib/config.mjs';

test('configuration keeps credentials private and preserves saved secrets on blank input', async t => {
  const root = await mkdtemp(join(tmpdir(), 'replication-config-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  await writeFile(join(root,'.env.local'), 'DOUBAO_SPEECH_API_KEY=test-secret\n');
  const config = await loadConfig(root);
  assert.equal(config.speechApiKey, 'test-secret');
  assert.equal(JSON.stringify(publicConfig(config)).includes('test-secret'), false);
  const saved = await saveConfig(root, { speechApiKey:'', jimengBinary:'C:\\Program Files\\Dreamina\\dreamina.exe' });
  assert.equal(saved.speechConfigured, true);
  assert.equal(saved.speechApiKey, undefined);
  assert.equal((await loadConfig(root)).speechApiKey, 'test-secret');
  assert.equal((await loadConfig(root)).jimengBinary, 'C:\\Program Files\\Dreamina\\dreamina.exe');
  assert.match(await readFile(join(root,'.env.local'),'utf8'), /DOUBAO_SPEECH_API_KEY=/);
  await assert.rejects(saveConfig(root,{ arbitrary:'value' }), /配置内容/);
  await assert.rejects(saveConfig(root,{speechApiKey:'line\nbreak'}), /配置内容/);
});
