import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshOnboarding, parseOnboarding, nextLessonStep } from '../src/lib/onboarding.ts';

test('progress distinguishes pause, skip, completion and preparation across restarts', () => {
  for (const status of ['paused', 'skipped', 'completed']) {
    const p = { ...freshOnboarding(), status, step: 5, projectId: 'p', outcome: 'prepared', dismissed: ['explore'] };
    assert.deepEqual(parseOnboarding(JSON.stringify(p)), p);
  }
  assert.equal(parseOnboarding(JSON.stringify({ ...freshOnboarding(), status: 'active' })).status, 'paused');
});
test('malformed or old progress never skips onboarding or grants completion', () => {
  for (const raw of ['{', '1', '{}', '{"version":1}', '{"version":2,"status":"completed","step":99}'])
    assert.deepEqual(parseOnboarding(raw), freshOnboarding());
  const p = parseOnboarding(JSON.stringify({ ...freshOnboarding(), projectId: {}, jobId: 12, outcome: 'generated-later', dismissed: [null, 3, 'explore'] }));
  assert.equal(p.projectId, null); assert.equal(p.jobId, null); assert.equal(p.outcome, null);
  assert.deepEqual(p.dismissed, ['explore']);
});
test('real outcomes are required, and another project cannot advance any step', () => {
  const yes = { onProject: true, hasCard: true, movedCard: true, hasText: true, hasReference: true, hasDimension: true, generated: true };
  for (let step = 1; step <= 5; step++) {
    assert.equal(nextLessonStep(step, yes), step + 1);
    assert.equal(nextLessonStep(step, { ...yes, onProject: false }), step);
  }
  assert.equal(nextLessonStep(3, { ...yes, hasText: false }), 3);
  assert.equal(nextLessonStep(3, { ...yes, hasReference: false }), 3);
  assert.equal(nextLessonStep(4, { ...yes, hasDimension: false }), 4);
  assert.equal(nextLessonStep(5, { ...yes, generated: false }), 5);
});

test('the removed sixth step resumes at generation without erasing the project or completion', () => {
  for (const status of ['active', 'paused', 'completed']) {
    const restored = parseOnboarding(JSON.stringify({ ...freshOnboarding(), status, step: 6, projectId: 'p', jobId: 'job' }));
    assert.equal(restored.step, 5);
    assert.equal(restored.projectId, 'p');
    assert.equal(restored.jobId, 'job');
    assert.equal(restored.status, status === 'active' ? 'paused' : status);
  }
});
