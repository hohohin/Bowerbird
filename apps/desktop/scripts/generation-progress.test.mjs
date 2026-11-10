import assert from 'node:assert/strict';
import test from 'node:test';
import { applyGenerationProgress, generationProgressLabel } from '../src/lib/generationProgress.ts';
import { libraryGenerationTasks } from '../src/lib/libraryGenerationActivity.ts';

const job = () => ({ id: 'job', projectId: 'p', threadId: 't', createdAt: 1, running: true,
  turns: [{ turnKey: 'old', images: [] }, { turnKey: 'current', images: [] }] });

test('progress belongs to the exact running turn; late events cannot revive finished work', () => {
  const current = job();
  for (const turnKey of [undefined, 'old', 'other']) {
    assert.equal(applyGenerationProgress(current, { stage: 'saving', turnKey }), current);
  }
  const finished = { ...current, running: false };
  assert.equal(applyGenerationProgress(finished, { stage: 'saving', turnKey: 'current' }), finished);
  const updated = applyGenerationProgress(current, { stage: 'saving', turnKey: 'current' });
  assert.equal(generationProgressLabel(updated), '正在保存结果');
  assert.equal(generationProgressLabel({ ...updated, turns: [{ turnKey: 'next' }] }), '准备生成');
});

test('only valid queue numbers are displayed; unknown processing never becomes a percentage', () => {
  const label = progress => generationProgressLabel({ ...job(), progress: { stage: 'queued', turnKey: 'current', ...progress } });
  assert.equal(label({ queue_position: 3, queue_length: 9 }), '排队中 · 队列位置 3 / 9');
  for (const [queue_position, queue_length] of [[0, 0], [-1, 9], [10, 9], [1.5, 9], [NaN, 9], [3, undefined]]) {
    assert.equal(label({ queue_position, queue_length }), '上游处理中');
  }
  assert.equal(generationProgressLabel(), '上游处理中');
  assert.equal(generationProgressLabel({ ...job(), remoteStatus: 'querying' }), '上游处理中');
});

test('library uses the same phase and does not keep running text after completion or failure', () => {
  const rows = runningJob => libraryGenerationTasks({ projects: [{ id: 'p', name: '测试' }], jobs: [runningJob] });
  const running = applyGenerationProgress(job(), { stage: 'tool_running', turnKey: 'current' });
  assert.equal(rows(running)[0].statusLabel, '正在执行工具');
  assert.equal(rows({ ...running, running: false, turns: [{ turnKey: 'current', images: ['done.png'] }] })[0].statusLabel, '已完成');
  assert.notEqual(rows({ ...running, running: false, turns: [{ turnKey: 'current', images: [], error: 'failed' }] })[0].status, 'running');
});
