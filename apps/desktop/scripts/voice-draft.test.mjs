import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyVoiceDraft, readVoiceDraft, writeVoiceDraft, voicePreviewKey, voiceClipRange } from '../src/lib/voiceStudioDraft.ts';
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) };
test('draft restores recording selection, trim and script only in its project', () => {
  const draft = { ...emptyVoiceDraft(), text: '明天见。', sourceId: 'recording', name: '角色', start: 2, end: 8, previewId: 'audition' };
  writeVoiceDraft('p', draft); assert.deepEqual(readVoiceDraft('p'), draft); assert.deepEqual(readVoiceDraft('other'), emptyVoiceDraft());
  storage.set('bowerbird.voice.draft.v1:broken', '{'); assert.deepEqual(readVoiceDraft('broken'), emptyVoiceDraft());
});
test('changing reference clip invalidates audition but naming does not', () => {
  const draft = emptyVoiceDraft(), key = voicePreviewKey(draft);
  assert.equal(voicePreviewKey({ ...draft, name: '旁白' }), key);
  for (const patch of [{ sourceId: 'another' }, { end: 5 }, { transcript: '不同原文' }]) assert.notEqual(voicePreviewKey({ ...draft, ...patch }), key);
});
test('legacy text design drafts cannot restore a design or reuse its audition', () => {
  storage.set('bowerbird.voice.draft.v1:legacy', JSON.stringify({ ...emptyVoiceDraft(), text: '保留台词', voiceId: 'saved', mode: 'design', description: '温暖女声', sourceId: 'old-recording', name: '旧设计', previewId: 'old-design', start: 1, end: 4 }));
  const restored=readVoiceDraft('legacy');
  assert.equal(restored.text,'保留台词'); assert.equal(restored.voiceId,'saved');
  assert.equal(restored.sourceId,''); assert.equal(restored.previewId,''); assert.equal(restored.name,'');
  assert.equal('mode' in restored,false); assert.equal('description' in restored,false);
});
test('trim stays inside the file and between one and thirty seconds', () => {
  assert.deepEqual(voiceClipRange(60, 0, 12, 'in', 13), { start: 11, end: 12 });
  assert.deepEqual(voiceClipRange(60, 0, 12, 'out', 55), { start: 0, end: 30 });
  assert.deepEqual(voiceClipRange(60, 25, 45, 'in', 0), { start: 15, end: 45 });
  assert.deepEqual(voiceClipRange(4, 1, 3, 'out', 20), { start: 1, end: 4 });
  assert.deepEqual(voiceClipRange(4, 1, 3, 'in', NaN), { start: 1, end: 3 });
});
