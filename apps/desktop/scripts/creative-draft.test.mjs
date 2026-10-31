import assert from 'node:assert/strict';
import test from 'node:test';
import { clearSentCreativeChatDraft, isCreativeComposerDraftMeaningful, parseCreativeComposerDraft, parseCreativeComposerState, serializeCreativeComposerState } from '../src/lib/creativeDraft.ts';

const draft = (text = '', media = 'image', refs = []) => ({ doc: { type: 'doc', content: [{ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) }] }, refs, generation: { media, ratio: media === 'video' ? '16:9' : '1:1' } });

test('chat provider survives switching modes and clearing accepted text independently of generation', () => {
  const chat = draft('已经发送');
  const state = { mode: 'video', chatProvider: 'deepseek-cloud', drafts: { chat, video: draft('视频草稿', 'video') } };
  const saved = serializeCreativeComposerState(state);
  assert.deepEqual(parseCreativeComposerState(saved), state);
  const cleared = clearSentCreativeChatDraft(saved, JSON.stringify(chat));
  assert.equal(parseCreativeComposerState(cleared).chatProvider, 'deepseek-cloud');
  assert.deepEqual(parseCreativeComposerState(cleared).drafts.video, state.drafts.video);
});

test('old schema 1 image and video drafts keep their mode, parameters, text and reference identity', () => {
  for (const media of ['image', 'video']) {
    const composer = draft('旧版未发送内容', media, [{ id: 'reference', store_path: 'preserved-local-path.png' }]);
    const saved = JSON.stringify({ schema_version: 1, composer });
    assert.deepEqual(parseCreativeComposerState(saved), { mode: media, drafts: { [media]: composer } });
    assert.deepEqual(parseCreativeComposerDraft(saved), composer);
  }
});

test('all three independent drafts survive serialization while the compatibility composer follows the active mode', () => {
  const drafts = { image: draft('图片草稿'), video: draft('视频草稿', 'video'), chat: draft('对话草稿', 'image', [{ id: 'chat-ref' }]) };
  for (const mode of ['image', 'video', 'chat']) {
    const saved = serializeCreativeComposerState({ mode, drafts });
    assert.deepEqual(parseCreativeComposerState(saved), { mode, drafts });
    assert.deepEqual(parseCreativeComposerDraft(saved), drafts[mode]);
  }
});

test('a fresh empty mode cannot discard meaningful drafts saved in inactive modes', () => {
  for (const [inactive, active] of [['image', 'chat'], ['video', 'image'], ['chat', 'video']]) {
    const saved = serializeCreativeComposerState({ mode: active, drafts: { [inactive]: draft('保留这份草稿', inactive === 'video' ? 'video' : 'image') } });
    assert.equal(isCreativeComposerDraftMeaningful(saved), true);
    assert.equal(parseCreativeComposerState(saved).drafts[inactive].doc.content[0].content[0].text, '保留这份草稿');
  }
});

test('clearing the matching accepted chat preserves the current mode plus image and video drafts', () => {
  const drafts = { image: draft('保持图片'), video: draft('保持视频', 'video'), chat: draft('已经发送', 'image', [{ id: 'sent-ref' }]) };
  const sent = JSON.stringify(drafts.chat);
  for (const mode of ['image', 'video', 'chat']) {
    const cleared = clearSentCreativeChatDraft(serializeCreativeComposerState({ mode, drafts }), sent);
    assert.equal(typeof cleared, 'string');
    assert.equal(JSON.parse(cleared).modeDrafts.chat, undefined);
    const restored = parseCreativeComposerState(cleared);
    assert.equal(restored.mode, mode);
    assert.deepEqual(restored.drafts.image, drafts.image);
    assert.deepEqual(restored.drafts.video, drafts.video);
    if (mode === 'chat') {
      assert.equal(restored.drafts.chat.doc.content[0].content, undefined);
      assert.equal(restored.drafts.chat.refs.length, 0);
    }
  }
});

test('a late acceptance cannot clear chat text or references edited after the send snapshot', () => {
  const sentDraft = draft('发送时的内容', 'image', [{ id: 'original-ref' }]);
  const sent = JSON.stringify(sentDraft);
  for (const updated of [draft('发送后新输入的内容', 'image', sentDraft.refs), draft('发送时的内容', 'image', [{ id: 'new-ref' }])]) {
    const saved = serializeCreativeComposerState({ mode: 'chat', drafts: { chat: updated, image: draft('图片仍保留') } });
    assert.equal(clearSentCreativeChatDraft(saved, sent), null);
    assert.deepEqual(parseCreativeComposerState(saved).drafts.chat, updated);
  }
});

test('replaying the same accepted draft cleanup is a no-op after chat has already been cleared', () => {
  const sentDraft = draft('已经接受的首条消息');
  const sent = JSON.stringify(sentDraft);
  assert.notEqual(sent, undefined);
  for (const mode of ['image', 'chat']) {
    const saved = serializeCreativeComposerState({ mode, drafts: { chat: sentDraft, image: draft('另一模式草稿') } });
    const cleared = clearSentCreativeChatDraft(saved, sent);
    assert.equal(typeof cleared, 'string');
    assert.equal(clearSentCreativeChatDraft(cleared, sent), null);
  }
});

test('reference-only and semantic-chip drafts remain meaningful in inactive modes', () => {
  const reference = draft('', 'image', [{ id: 'reference' }]);
  const chip = { ...draft(), doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'image_ref', attrs: { assetId: 'reference' } }] }] } };
  for (const composer of [reference, chip]) assert.equal(isCreativeComposerDraftMeaningful(serializeCreativeComposerState({ mode: 'chat', drafts: { image: composer } })), true);
  for (const text of ['', '  ', '请参考']) assert.equal(isCreativeComposerDraftMeaningful(serializeCreativeComposerState({ mode: 'chat', drafts: { image: draft(text) } })), false);
});

test('an explicit mode draft wins over the compatibility composer; malformed mode entries are ignored', () => {
  const current = draft('应保留的内容');
  const saved = JSON.stringify({ schema_version: 1, mode: 'chat', composer: draft('兼容旧字段'), modeDrafts: { chat: current, image: { doc: {}, refs: 'bad' }, video: { refs: [] } } });
  assert.deepEqual(parseCreativeComposerState(saved), { mode: 'chat', drafts: { chat: current } });
});

test('unknown modes fall back to old media and malformed storage loads safely', () => {
  const composer = draft('视频兼容', 'video');
  assert.deepEqual(parseCreativeComposerState(JSON.stringify({ schema_version: 1, mode: 'future', composer })), { mode: 'video', drafts: { video: composer } });
  for (const saved of ['{', 'null', '[]', '{}', '42']) {
    assert.deepEqual(parseCreativeComposerState(saved), { mode: 'image', drafts: {} });
    assert.equal(isCreativeComposerDraftMeaningful(saved), false);
  }
});
