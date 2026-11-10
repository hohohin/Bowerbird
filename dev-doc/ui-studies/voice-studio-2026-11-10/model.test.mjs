import test from 'node:test';
import assert from 'node:assert/strict';
import { initial, update } from './model.mjs';
const event = (state, type, value) => update(state, { type, value });
test('first-use setup resumes from saved progress and reaches readiness without repeated install', () => {
  let s = event(initial(), 'install');
  assert.equal(s.environment.phase, 'installing');
  s = event(s, 'tick'); const progress = s.environment.progress;
  s = event(JSON.parse(JSON.stringify(s)), 'install');
  assert.equal(s.environment.progress, progress);
  for (let i = 0; i < 10; i++) s = event(s, 'tick');
  assert.equal(s.environment.phase, 'ready');
});
test('a voice is saved only after audition and naming, reference edits invalidate audition', () => {
  let s = event(initial(), 'source', { name: '参考.wav', duration: 4 });
  s = event(s, 'name', '小林');
  assert.equal(event(s, 'saveVoice').voices.length, 0);
  s = event(s, 'ready'); s = event(s, 'preview'); s = event(s, 'tick');
  assert.equal(s.creation.preview, 'ready');
  assert.equal(event(s, 'range', { start: 1, end: 3 }).creation.preview, 'idle');
  s = event(s, 'saveVoice'); assert.equal(s.voices.length, 1);
  assert.equal(s.selected, s.voices[0].id);
  assert.equal(event(s, 'saveVoice').voices.length, 1);
});
test('one generation, cancel preserves draft and historical results survive voice deletion', () => {
  let s = event(initial(), 'demo'); s = event(s, 'draft', '这句台词不能丢。');
  s = event(s, 'generate'); s = event(s, 'generate'); assert.equal(s.jobs.length, 1);
  s = event(s, 'cancel'); assert.equal(s.jobs[0].phase, 'cancelled'); assert.equal(s.draft, '这句台词不能丢。');
  s = event(s, 'generate'); for (let i = 0; i < 4; i++) s = event(s, 'tick');
  const id = s.selected; s = event(s, 'deleteVoice', id);
  assert.equal(s.jobs[0].phase, 'done'); assert.equal(s.jobs[0].voiceName, '林岸');
});
test('saving failure retries storage only, and environment failure preserves setup progress', () => {
  let s = event(initial(), 'demo'); s = event(s, 'draft', '测试'); s = event(s, 'generate');
  s = event(s, 'saveFailure'); const id = s.jobs[0].id;
  s = event(s, 'retrySave', id); assert.equal(s.jobs.length, 1); assert.equal(s.jobs[0].phase, 'done');
  s = event(initial(), 'install'); s = event(s, 'tick'); s = event(s, 'installFailure');
  const progress = s.environment.progress; s = event(s, 'install'); assert.equal(s.environment.progress, progress);
});
