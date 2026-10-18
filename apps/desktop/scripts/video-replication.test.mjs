import { test } from 'node:test';
import { equal } from 'node:assert/strict';
import { replicationDuration, validateReplicationInput } from '../src/lib/videoReplication.ts';

test('rewrite duration spans start/end, rounds up and does not clamp to model limits', () => {
  equal(replicationDuration('{"shots":[{"start":2,"end":5},{"end":12.1,"start":4}]}'),11);
  equal(replicationDuration('```json\n[{"start":"00:00","end":"00:10.731"}]\n```'),11);
  equal(replicationDuration('start: 0, end: 3\nstart: 3, end: 8.5'),9);
  equal(replicationDuration('1. 时长：0-2秒\n2. 时长：2–11秒'),11);
  equal(replicationDuration('[{"start":0,"end":40}]'),40);
  equal(replicationDuration('[{"start":0,"end":2}]'),2);
});
test('missing or invalid shot boundaries do not guess a duration', () => {
  for (const text of ['白色瓶身，缓慢推进。', '{"start":3,"end":2}', '{"start":-1,"end":5}', '{"start":0}', '[{"start":0,"end":5},{"start":5}]', '{"start":"00:70","end":"01:20"}', 'start: 0\nstart: 5\nend: 8']) equal(replicationDuration(text),null);
});
test('analysis is independent of products; pasted rewrite is independent of analysis', () => {
  equal(validateReplicationInput({ operation:'analyze', title:'视频', referenceId:'ref' }),null);
  equal(validateReplicationInput({ operation:'rewrite', title:'改写', inputText:'原文', persona:'编导', rules:'保持节奏' }),null);
});
test('generation cannot be submitted from the replication tool', () => {
  const value={ operation:'generate',title:'视频',product:{id:'p',name:'产品',description:'说明'},prompt:'镜头',duration:5,ratio:'9:16' };
  equal(validateReplicationInput(value),'请在画板对话框中生成视频');
});
