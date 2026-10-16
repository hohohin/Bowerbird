import { test } from 'node:test';
import { equal } from 'node:assert/strict';
import { validateReplicationInput } from '../src/lib/videoReplication.ts';
test('analysis is independent of products; pasted rewrite is independent of analysis', () => {
  equal(validateReplicationInput({ operation:'analyze', title:'视频', referenceId:'ref' }),null);
  equal(validateReplicationInput({ operation:'rewrite', title:'改写', inputText:'原文', persona:'编导', rules:'保持节奏' }),null);
});
test('generation requires explicit product, prompt, duration and ratio', () => {
  const value={ operation:'generate',title:'视频',product:{id:'p',name:'产品',description:'说明'},prompt:'镜头',duration:5,ratio:'9:16' };
  equal(validateReplicationInput(value),null);
  for (const change of [{product:null},{prompt:'x'.repeat(12001)},{duration:3},{duration:4.5},{ratio:'bad'}]) equal(typeof validateReplicationInput({...value,...change}),'string');
});
