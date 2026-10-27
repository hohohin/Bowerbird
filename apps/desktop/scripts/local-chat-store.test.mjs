import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const storePath = fileURLToPath(new URL('../src/lib/localChatStore.ts', import.meta.url));
const plain = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const chat = (revision = 1, projectId = 'p', id = 'chat-p', status = 'idle') => ({ id, projectId, threadId: `thread-${id}`, nodeId: `node-${id}`, title: `对话 ${id}`, provider: 'codex-local', status, turnCount: 1, preview: `回复 ${revision}`, revision, createdAt: 1, updatedAt: revision, error: null,
  messages: [{ id: 'user', turnId: 'turn', role: 'user', text: '问题', referenceAssetIds: [], status: 'done', createdAt: 1, updatedAt: 1 }, { id: 'assistant', turnId: 'turn', role: 'assistant', text: `回复 ${revision}`, referenceAssetIds: [], status: status === 'running' ? 'running' : 'done', createdAt: 1, updatedAt: revision }] });

function fixture(storage = new Map()) {
  const calls = [];
  const handlers = new Map();
  const listeners = new Map();
  const modules = new Map();
  const context = vm.createContext({ console, crypto: webcrypto, TextEncoder, setTimeout, clearTimeout,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } });
  function load(path) {
    if (modules.has(path)) return modules.get(path).exports;
    const module = { exports: {} }; modules.set(path, module);
    const compiled = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const localRequire = specifier => {
      if (specifier === '@tauri-apps/api/core') return { invoke: async (command, args) => { calls.push({ command, args: plain(args) }); const handler = handlers.get(command); if (!handler) throw new Error(`No synthetic handler for ${command}`); return handler(args); } };
      if (specifier === '@tauri-apps/api/event') return { listen: async (event, callback) => { listeners.set(event, callback); return () => listeners.delete(event); } };
      if (specifier.startsWith('.')) return load(resolve(dirname(path), `${specifier}.ts`));
      return require(specifier);
    };
    const execute = vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, { filename: path });
    execute(localRequire, module, module.exports); return module.exports;
  }
  const module = load(storePath);
  return { store: module.useLocalChatStore, events: module.ensureLocalChatEvents, calls, handlers, storage,
    emit: value => listeners.get('local-chat://updated')?.({ payload: value }), draft: module.localChatDraft };
}

test('a newer streamed event wins over an older delayed send acknowledgement', async () => {
  const f = fixture(); let resolveSend;
  f.handlers.set('local_chat_send', () => new Promise(resolve => { resolveSend = resolve; }));
  const pending = f.store.getState().send({ projectId: 'p', text: '问题', referenceAssetIds: [] });
  await settle(); assert.equal(typeof resolveSend, 'function');
  f.emit(chat(5)); resolveSend(chat(1, 'p', 'chat-p', 'running'));
  const result = await pending;
  assert.equal(result.revision, 5);
  assert.equal(f.store.getState().summaries['chat-p'].status, 'idle');
  assert.equal(f.store.getState().conversations['chat-p'].messages.at(-1).text, '回复 5');
});

test('late list/read snapshots cannot rewind stream state or move history across projects', async () => {
  const f = fixture(); let resolveList, resolveRead;
  f.handlers.set('local_chat_list', () => new Promise(resolve => { resolveList = resolve; }));
  f.handlers.set('local_chat_get', () => new Promise(resolve => { resolveRead = resolve; }));
  const listed = f.store.getState().loadProject('p');
  const read = f.store.getState().loadConversation('chat-p');
  await settle(); f.emit(chat(6)); f.emit(chat(3, 'q', 'chat-q'));
  resolveList([chat(2)]); resolveRead(chat(4)); await Promise.all([listed, read]);
  assert.equal(f.store.getState().summaries['chat-p'].revision, 6);
  assert.equal(f.store.getState().conversations['chat-p'].revision, 6);
  assert.deepEqual(plain(f.store.getState().projectIds), { p: ['chat-p'], q: ['chat-q'] });
});

test('uncertain sends reuse their request ID; an accepted identical later message receives a new ID', async () => {
  const f = fixture(); let attempt = 0;
  f.handlers.set('local_chat_send', () => { if (++attempt === 1) throw new Error('lost acknowledgement'); return chat(attempt); });
  const input = { projectId: 'p', text: '同一条内容', referenceAssetIds: ['ref'] };
  await assert.rejects(f.store.getState().send(input), /lost acknowledgement/);
  await f.store.getState().send(input); await f.store.getState().send(input);
  const ids = f.calls.filter(call => call.command === 'local_chat_send').map(call => call.args.input.requestId);
  assert.equal(ids[0], ids[1]); assert.notEqual(ids[1], ids[2]);
});

test('changed input after an uncertain send has a different request identity', async () => {
  const f = fixture();
  f.handlers.set('local_chat_send', () => { throw new Error('connection lost'); });
  for (const [text, references] of [['原稿', []], ['修改内容', []], ['修改内容', ['ref']]]) await assert.rejects(f.store.getState().send({ projectId: 'p', text, referenceAssetIds: references }), /connection lost/);
  assert.equal(new Set(f.calls.map(call => call.args.input.requestId)).size, 3);
});

test('concurrent send to the same conversation is rejected before a second IPC', async () => {
  const f = fixture(); let resolveSend;
  f.handlers.set('local_chat_send', () => new Promise(resolve => { resolveSend = resolve; }));
  const input = { projectId: 'p', conversationId: 'chat-p', text: '续聊', referenceAssetIds: [] };
  const first = f.store.getState().send(input); await settle();
  await assert.rejects(f.store.getState().send(input), /仍在回复/);
  assert.equal(f.calls.length, 1);
  resolveSend(chat(2, 'p', 'chat-p', 'running')); await first;
  await assert.rejects(f.store.getState().send(input), /仍在回复/);
  assert.equal(f.calls.length, 1);
});

test('card options are frozen per submission and changing them after an uncertain send gets a new identity', async () => {
  const f = fixture();
  f.handlers.set('local_chat_send', () => { throw new Error('connection lost'); });
  const input = { projectId: 'p', text: '创建生成卡', referenceAssetIds: [], cardDefaults: { provider: 'codex', videoChannel: 'jimeng', videoOptions: { kind: 'text2video', model_version: 'seedance2.5', duration: 5, video_resolution: '720p' } } };
  await assert.rejects(f.store.getState().send(input), /connection lost/);
  await assert.rejects(f.store.getState().send(input), /connection lost/);
  const changed = { ...input, cardDefaults: { ...input.cardDefaults, provider: 'jimeng' } };
  await assert.rejects(f.store.getState().send(changed), /connection lost/);
  assert.equal(f.calls[0].args.input.cardDefaults.provider, 'codex');
  assert.equal(f.calls[0].args.input.requestId, f.calls[1].args.input.requestId);
  assert.notEqual(f.calls[0].args.input.requestId, f.calls[2].args.input.requestId);
});

test('failed stop preserves running state, partial response and unsent draft', async () => {
  const f = fixture(); await f.events(); f.emit(chat(3, 'p', 'chat-p', 'running'));
  f.store.getState().setDraft('chat-p', { text: '下一条草稿', referenceAssetIds: ['ref'] });
  f.handlers.set('local_chat_stop', () => { throw new Error('stop not acknowledged'); });
  await assert.rejects(f.store.getState().stop('chat-p'), /stop not acknowledged/);
  assert.equal(f.store.getState().summaries['chat-p'].status, 'running');
  assert.equal(f.store.getState().conversations['chat-p'].messages.at(-1).text, '回复 3');
  assert.deepEqual(plain(f.draft('chat-p')), { text: '下一条草稿', referenceAssetIds: ['ref'] });
});

test('conversation drafts survive reload separately and clearing one never clears another', () => {
  const first = fixture();
  first.store.getState().setDraft('chat-p', { text: '项目 A', referenceAssetIds: ['a'] });
  first.store.getState().setDraft('chat-q', { text: '项目 B', referenceAssetIds: [] });
  const reloaded = fixture(first.storage);
  assert.deepEqual(plain(reloaded.draft('chat-p')), { text: '项目 A', referenceAssetIds: ['a'] });
  reloaded.store.getState().setDraft('chat-p', { text: '', referenceAssetIds: [] });
  const third = fixture(first.storage);
  assert.deepEqual(plain(third.draft('chat-p')), { text: '', referenceAssetIds: [] });
  assert.equal(third.draft('chat-q').text, '项目 B');
});

test('invalid input never reaches native IPC and byte limit counts non-ASCII text', async () => {
  const f = fixture();
  for (const [text, references] of [['  ', []], ['汉'.repeat(33334), []], ['内容', Array.from({ length: 9 }, (_, i) => `${i}`)]]) await assert.rejects(f.store.getState().send({ projectId: 'p', text, referenceAssetIds: references }));
  assert.equal(f.calls.length, 0);
});
