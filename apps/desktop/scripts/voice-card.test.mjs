import test from 'node:test';
import assert from 'node:assert/strict';
import { newWorkflowNode, workflowInputs, workflowOutputs } from '../src/lib/canvasWorkflow.ts';
import { planAutomaticConnection } from '../src/lib/workflowAutoConnect.ts';
import { VOICE_LANGUAGE_GROUPS, voiceCardPreviewKey, voiceLanguageLabel } from '../src/lib/voiceCard.ts';
import { canvasAssetShowsName } from '../src/components/canvas/canvasWorkspaceHelpers.ts';

test('a new voice card accepts a recording; a selected voice accepts script and delivers audio', () => {
  const node = newWorkflowNode('voice', 20, 30, 'local');
  const connect = media => planAutomaticConnection([node], [{ type:'image', media, binding:{assetId:'source'} }], node.id);
  assert.deepEqual(workflowInputs(node).map(p => p.label), ['参考录音']);
  assert.equal(connect('audio').bindings.length, 1);
  assert.equal(connect('image').bindings.length, 0);
  node.voice={id:'speaker'};
  assert.deepEqual(workflowInputs(node).map(p => p.label), ['台词']);
  assert.equal(connect('audio').bindings.length, 0);
  assert.deepEqual(workflowOutputs(node).map(p => p.label), ['配音']);
});

test('a voice audition depends on language and preserves old keys in automatic mode', () => {
  const asset = { id: 'clip', name: 'clip.wav', duration: 15 };
  const settings = { sampleText: '  试听台词。  ', seed: 0 };
  const oldFields = ['clip', 0, 12, '', '试听台词。'];
  assert.equal(voiceCardPreviewKey({ sampleText: settings.sampleText }, asset), JSON.stringify(oldFields));
  assert.equal(voiceCardPreviewKey(settings, asset), JSON.stringify([...oldFields, 0]));
  assert.equal(voiceCardPreviewKey({ ...settings, language: '' }, asset), voiceCardPreviewKey(settings, asset));
  assert.notEqual(voiceCardPreviewKey({ ...settings, language: 'yue' }, asset), voiceCardPreviewKey(settings, asset));
  assert.notEqual(voiceCardPreviewKey({ ...settings, language: 'yue' }, asset), voiceCardPreviewKey({ ...settings, language: 'en' }, asset));
});

test('the language menu exposes 39 distinct language and dialect codes', () => {
  assert.deepEqual(VOICE_LANGUAGE_GROUPS.map(group => group.label), ['中文与方言', '常用外语', '其他语种']);
  const codes = VOICE_LANGUAGE_GROUPS.flatMap(group => group.options.map(option => option.code));
  assert.equal(codes.length, 39);
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(voiceLanguageLabel('yue'), '粤语');
  assert.equal(voiceLanguageLabel('zh'), '普通话');
  assert.equal(voiceLanguageLabel('en'), '英语');
  assert.equal(voiceLanguageLabel(), '自动（随台词）');
});

test('audio asset names are always shown while other assets follow the setting', () => {
  for (const setting of [undefined, false, true]) {
    assert.equal(canvasAssetShowsName({ kind: 'asset', asset: { storePath: 'clip.WAV?version=1' } }, setting), true);
    for (const storePath of ['picture.png', 'video.mp4', null]) {
      assert.equal(canvasAssetShowsName({ kind: 'asset', asset: { storePath } }, setting), !!setting);
    }
    assert.equal(canvasAssetShowsName({ kind: 'folder' }, setting), false);
  }
});
