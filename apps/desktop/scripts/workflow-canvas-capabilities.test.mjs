import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import ts from 'typescript';

registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context); throw error; }
  },
  load(url, context, next) {
    const result = next(url, context);
    return url.endsWith('.ts') ? { ...result, format: 'module', source: ts.transpileModule(String(result.source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText } : result;
  },
});
const { canvasAutomaticOutputs } = await import('../src/lib/workflowCanvasCapabilities.ts');
const { newWorkflowNode } = await import('../src/lib/canvasWorkflow.ts');
const { planAutomaticConnection } = await import('../src/lib/workflowAutoConnect.ts');

const assets = [
  { id: 'photo', store_path: '/photo.png' },
  { id: 'movie', store_path: '/movie.MP4?version=1', thumb_path: '/poster.png' },
  { id: 'sound', store_path: '/sound.mp3', thumb_path: '/cover.png' },
];
const node = (id, kind, rest = {}) => ({ ...newWorkflowNode(kind, 0, 0, 'codex'), id, ...rest });
const cell = (id, assetId) => ({ id, content_type: 'image', text: '@图片1', image_refs: [{ asset_id: assetId, token: '@图片1' }] });
const card = (id, cells, rest = {}) => ({ id, kind: 'note', projectId: 'p', hiddenAt: null,
  payloadJson: JSON.stringify({ schema_version: 1, note_type: 'images', text: '', cells, member_ids: [], ...rest }) });
const outputs = (source, nodes = [], metadata = assets, latest = false) => canvasAutomaticOutputs(source.id, nodes, [source], [], metadata, latest);
const imageOnly = node('receiver', 'instruction');
const plan = sourceOutputs => planAutomaticConnection([imageOnly], sourceOutputs, imageOnly.id);

test('known video and audio content cards reject image-only receivers before execution', () => {
  for (const [id, media] of [['movie', 'video'], ['sound', 'audio']]) {
    const sourceOutputs = outputs(card('content', [[cell('one', id)]]));
    assert.deepEqual(sourceOutputs.find(output => output.type === 'image').media, [media]);
    assert.match(plan(sourceOutputs).error, /不能接收/);
  }
});

test('mixed content advertises all actual media and keeps receiver filtering', () => {
  const sourceOutputs = outputs(card('content', [[cell('one', 'movie')], [cell('two', 'photo')], [cell('three', 'sound')]]));
  assert.deepEqual(sourceOutputs.find(output => output.type === 'image').media, ['video', 'image', 'audio']);
  const result = plan(sourceOutputs);
  assert.equal(result.error, null);
  assert.deepEqual(result.bindings.map(item => item.inputId), ['image']);
  assert.deepEqual(result.bindings[0].binding.mediaFilter, ['image']);
});

test('document projection checks actual media identity even behind an image reference', () => {
  const source = card('document', [], { note_type: 'document', text: '场景说明\n\n<img data-bowerbird-asset="movie" data-caption="" />\n' });
  const sourceOutputs = outputs(source);
  assert.deepEqual(sourceOutputs.find(output => output.type === 'image').media, ['video']);
  assert.deepEqual(sourceOutputs.find(output => output.type === 'text').media, ['video']);
  assert.match(plan(sourceOutputs).error, /不能接收/);
});

test('document video tags preserve their legacy text attachment projection', () => {
  const source = card('document', [], { note_type: 'document', text: '说明\n\n<video data-bowerbird-asset="movie" data-caption="" />\n' });
  const sourceOutputs = outputs(source);
  assert.deepEqual(sourceOutputs.map(output => [output.type, output.media]), [['text', ['video']]]);
  assert.match(plan(sourceOutputs).error, /不能接收/);
});

test('partial metadata is unknown rather than a false incompatible verdict', () => {
  const source = card('content', [[cell('one', 'movie')], [cell('two', 'unloaded')]]);
  const sourceOutputs = outputs(source);
  assert.equal(sourceOutputs.find(output => output.type === 'image').media, undefined);
  assert.equal(plan(sourceOutputs).error, null);
  assert.equal(outputs(card('unknown', [[cell('one', 'unknown')]]), [], [{ id: 'unknown' }]).find(output => output.type === 'image').media, undefined);
});

test('pending writers and generation references preserve future media uncertainty', () => {
  const source = card('content', [[cell('one', 'movie')]]);
  const writer = node('writer', 'text', { textTarget: { nodeId: 'content', cellId: 'future', image: true } });
  assert.equal(outputs(source, [writer]).find(output => output.type === 'image').media, undefined);
  const generation = card('content', [[{ id: 'one', content_type: 'image', text: '', generation_ref: { session_node_id: 'future-session' } }]]);
  const future = outputs(generation).find(output => output.type === 'image');
  assert.ok(future);
  assert.equal(future.media, undefined);
  assert.equal(plan([future]).error, null);
});

test('latest-row media capability follows that row instead of earlier compatible images', () => {
  const source = card('content', [[cell('one', 'photo')], [cell('two', 'movie')]]);
  assert.equal(plan(outputs(source)).error, null);
  const latest = outputs(source, [], assets, true);
  assert.deepEqual(latest.find(output => output.type === 'image').media, ['video']);
  assert.match(plan(latest).error, /不能接收/);
});

test('group automatic media uses full membership while retaining the legacy image list', () => {
  const material = { id: 'group', groupId: 'group', assetIds: [], mediaAssetIds: ['movie', 'sound'] };
  const sourceOutputs = canvasAutomaticOutputs('group', [], [], [material], assets);
  assert.deepEqual(sourceOutputs[0].binding.assetIds, ['movie', 'sound']);
  assert.deepEqual(sourceOutputs[0].media, ['video', 'audio']);
  assert.match(plan(sourceOutputs).error, /不能接收/);
  assert.deepEqual(material.assetIds, []);
  const mixed = canvasAutomaticOutputs('group', [], [], [{ ...material, mediaAssetIds: ['photo', 'movie'] }], assets);
  assert.equal(plan(mixed).error, null);
  assert.deepEqual(canvasAutomaticOutputs('group', [], [], [{ id: 'group', groupId: 'group', assetIds: ['photo'] }], assets)[0].media, ['image']);
});

test('session outputs classify complete actual media and keep partial sessions unknown', () => {
  const session = { id: 'session', kind: 'prompt', projectId: 'p', hiddenAt: null, payloadJson: JSON.stringify({ job_id: 'job', turn_key: 'turn' }) };
  const result = id => ({ id: `result-${id}`, kind: 'asset', role: 'output', assetId: id, projectId: 'p', hiddenAt: null, payloadJson: JSON.stringify({ execution: { job_id: 'job', turn_key: 'turn' } }) });
  assert.deepEqual(canvasAutomaticOutputs('session', [], [session, result('sound')], [], assets)[0].media, ['audio']);
  assert.equal(canvasAutomaticOutputs('session', [], [session, result('movie'), result('unknown')], [], assets)[0].media, undefined);
});

test('single assets use registered extensions without mistaking video thumbnails for images', () => {
  assert.deepEqual(canvasAutomaticOutputs('card', [], [], [{ id: 'card', assetId: 'movie' }], assets)[0].media, ['video']);
  assert.deepEqual(canvasAutomaticOutputs('card', [], [], [{ id: 'card', assetId: 'sound' }], [{ id: 'sound', ext: 'm4a' }])[0].media, ['audio']);
  assert.equal(canvasAutomaticOutputs('card', [], [], [{ id: 'card', assetId: 'unloaded' }], assets)[0].media, undefined);
});
