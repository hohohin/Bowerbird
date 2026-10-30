import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKFLOW, createClipPlan, makeGenerationPrompt, transcriptToSrt, captionsFromTranscript, dialogueWarning } from '../lib/plan.mjs';

function analysisFor(durations = [8000]) {
  let startMs = 0;
  return { summary: '分镜证据', style: '自然光产品摄影', shots: durations.map((duration, index) => {
    const shot = { id: `shot-${index + 1}`, startMs, endMs: startMs + duration, visual: `画面${index + 1}：人物展示产品`, camera: '固定机位中景', action: '举起产品', transition: 'cut' };
    startMs += duration; return shot;
  }) };
}
const words = [{ text: '你好', startMs: 800, endMs: 1800 }, { text: '，', startMs: null, endMs: null },
  { text: '世界', startMs: 3800, endMs: 4200 }, { text: '。', startMs: null, endMs: null }];
const crossing = { text: '你好，世界。', utterances: [{ text: '你好，世界。', startMs: 500, endMs: 7000, words }] };

test('structured visual analysis is required instead of original-video reference fallback', () => {
  assert.equal(WORKFLOW, 'storyboard-v2');
  for (const analysis of [undefined, null, {}, { shots: [] }]) assert.throws(() => createClipPlan(8000, {}, {}, analysis), /画面拆解|分镜/);
  for (const duration of [NaN, 3000, 120001]) assert.throws(() => createClipPlan(duration, {}, {}, analysisFor()), /4–120/);
});

test('storyboard continuously covers the source with unique 4–15 second shots', () => {
  assert.deepEqual(createClipPlan(19000, {}, {}, analysisFor([4000, 15000])).map(shot => shot.duration), [4, 15]);
  for (const durations of [[3000, 5000], [16000]]) assert.throws(() => createClipPlan(durations.reduce((a, b) => a + b), {}, {}, analysisFor(durations)), /4–15/);
  for (const offset of [-100, 100]) {
    const invalid = analysisFor([4000, 4000]); invalid.shots[1].startMs += offset;
    assert.throws(() => createClipPlan(8000, {}, {}, invalid), /连续|4–15/);
  }
  const duplicate = analysisFor([4000, 4000]); duplicate.shots[1].id = duplicate.shots[0].id;
  assert.throws(() => createClipPlan(8000, {}, {}, duplicate), /编号/);
  const empty = analysisFor(); empty.shots[0].visual = ' ';
  assert.throws(() => createClipPlan(8000, {}, {}, empty), /画面描述/);
  assert.throws(() => createClipPlan(9000, {}, {}, analysisFor()), /完整覆盖/);
  assert.throws(() => createClipPlan(100000, {}, {}, analysisFor(Array(25).fill(4000))), /数量|编号/);
});

test('each original utterance and replacement belong to the corresponding shot exactly once', () => {
  const utterances = [{ startMs: 500, endMs: 3200, text: '第一句' }, { startMs: 4500, endMs: 7200, text: '介绍产品' }];
  const chunks = createClipPlan(8000, { utterances }, { replacements: { 1: '介绍新产品' } }, analysisFor([4000, 4000]));
  assert.deepEqual(chunks.flatMap(chunk => chunk.lines.map(line => line.index)), [0, 1]);
  assert.deepEqual(chunks.map(chunk => chunk.dialogue), ['第一句', '介绍新产品']);
  assert.deepEqual(chunks[1].lines[0], { index: 1, startMs: 500, endMs: 3200, original: '介绍产品', text: '介绍新产品' });
  assert.ok(chunks.every(chunk => !chunk.dialogueIssue));
});

test('shot text, numbered image roles and direction form independent prompts with no video references', () => {
  const edits = { fullText: '这是新台词', direction: '保持柔和光线', shots: { 'shot-1': { visual: '白色桌面上的蓝色包装', camera: '俯拍', action: '缓慢开盒' } } };
  const shot = createClipPlan(8000, {}, edits, analysisFor())[0];
  const prompt = makeGenerationPrompt(shot, edits, [{ role: 'person' }, { role: 'product' }]);
  assert.equal(shot.shotId, 'shot-1'); assert.equal(shot.duration, 8);
  for (const phrase of ['白色桌面上的蓝色包装', '俯拍', '缓慢开盒', '自然光产品摄影', '这是新台词', '保持柔和光线']) assert.ok(prompt.includes(phrase));
  assert.match(prompt, /图片1是替换人物/); assert.match(prompt, /图片2是替换产品/);
  assert.match(prompt, /字幕由后期独立合成/); assert.doesNotMatch(prompt, /参考视频|原视频|视频1|--video/);
  assert.match(makeGenerationPrompt(createClipPlan(8000, {}, {}, analysisFor())[0], {}, []), /没有台词|不生成人声/);
});

test('complete replacement text is accepted only for one shot', () => {
  assert.equal(createClipPlan(8000, {}, { fullText: '完整台词' }, analysisFor())[0].dialogue, '完整台词');
  assert.throws(() => createClipPlan(8000, {}, { fullText: '完整台词' }, analysisFor([4000, 4000])), /多个分镜|逐句/);
});

test('cross-shot word timings allocate words and punctuation once, including a boundary-spanning word', () => {
  const shots = createClipPlan(8000, crossing, {}, analysisFor([4000, 4000]));
  assert.deepEqual(shots.map(shot => shot.dialogue), ['你好，', '世界。']);
  assert.equal(shots.map(shot => shot.dialogue).join(''), crossing.text);
  assert.ok(shots.every(shot => !shot.dialogueIssue));
  assert.equal(shots[1].lines[0].startMs, 0); assert.equal(shots[1].lines[0].endMs, 200);
});

test('cross-shot replacements or missing word times require explicit per-shot dialogue', () => {
  for (const [transcript, edits] of [[crossing, { replacements: { 0: '替换整句后不能复用原词时间' } }],
    [{ utterances: [{ text: '跨镜头的原句', startMs: 0, endMs: 8000 }] }, {}]]) {
    const shots = createClipPlan(8000, transcript, edits, analysisFor([4000, 4000]));
    assert.ok(shots.every(shot => shot.dialogueIssue));
    assert.deepEqual(shots.map(shot => shot.lines), [[], []]);
  }
});

test('partial cross-shot word lists cannot silently delete original dialogue', () => {
  const partial = { text: '你好世界', utterances: [{ text: '你好世界', startMs: 0, endMs: 8000, words: [{ text: '你好', startMs: 1000, endMs: 3000 }] }] };
  assert.ok(createClipPlan(8000, partial, {}, analysisFor([4000, 4000])).every(shot => shot.dialogueIssue));
});

test('word evidence outside the observed sentence cannot silently lose words or extend captions', () => {
  for (const words of [
    [{ text: '你好', startMs: 1000, endMs: 3000 }, { text: '世界', startMs: 9000, endMs: 10000 }],
    [{ text: '你好', startMs: -100, endMs: 1000 }, { text: '世界', startMs: 4000, endMs: 7000 }],
  ]) {
    const sentence = { text: '你好世界', startMs: 0, endMs: 8000, words };
    assert.ok(createClipPlan(8000, { utterances: [sentence] }, {}, analysisFor([4000, 4000])).every(shot => shot.dialogueIssue));
    const captioned = captionsFromTranscript({ utterances: [sentence] });
    assert.deepEqual(captioned.utterances.map(item => [item.text, item.startMs, item.endMs]), [['你好世界', 0, 8000]]);
  }
});

test('word timings exactly on observed sentence boundaries remain usable', () => {
  const sentence = { text: '你好世界', startMs: 1000, endMs: 7000,
    words: [{ text: '你好', startMs: 1000, endMs: 3000 }, { text: '世界', startMs: 4000, endMs: 7000 }] };
  const shots = createClipPlan(8000, { utterances: [sentence] }, {}, analysisFor([4000, 4000]));
  assert.ok(shots.every(shot => !shot.dialogueIssue));
  assert.deepEqual(shots.map(shot => shot.dialogue), ['你好', '世界']);
});

test('explicit per-shot dialogue, including empty text, resolves missing source timing', () => {
  const transcript = { text: '没有时间定位的原句', utterances: [{ text: '没有时间定位的原句', startMs: null, endMs: null }] };
  const analysis = analysisFor([4000, 4000]);
  assert.ok(createClipPlan(8000, transcript, {}, analysis).every(shot => shot.dialogueIssue));
  const resolved = createClipPlan(8000, transcript, { shots: { 'shot-1': { dialogue: '' }, 'shot-2': { dialogue: '用户指定的第二镜头台词' } } }, analysis);
  assert.deepEqual(resolved.map(shot => shot.dialogue), ['', '用户指定的第二镜头台词']);
  assert.ok(resolved.every(shot => !shot.dialogueIssue));
  assert.ok(createClipPlan(8000, { text: '只有整段转写' }, {}, analysis).every(shot => shot.dialogueIssue));
});

test('new-performance caption groups retain complete words and use actual word timestamps', () => {
  const words = [{ text: '这是一段新的实际声音内容', startMs: 1200, endMs: 2200 },
    { text: '这也是新的实际声音内容', startMs: 2400, endMs: 3400 }, { text: '。', startMs: null, endMs: null }];
  const result = captionsFromTranscript({ utterances: [{ text: words.map(word => word.text).join(''), startMs: 1000, endMs: 3500, words }] });
  assert.equal(result.utterances.length, 2);
  assert.deepEqual(result.utterances.map(item => [item.startMs, item.endMs]), [[1200, 2200], [2400, 3400]]);
  assert.equal(result.utterances.map(item => item.text).join(''), words.map(word => word.text).join(''));
  assert.match(transcriptToSrt(result), /00:00:01,200 --> 00:00:02,200/);
  assert.doesNotMatch(transcriptToSrt(result), /00:00:00,500/);
});

test('caption groups split by duration and fall back to actual sentence times without words', () => {
  const words = [{ text: '第一部分', startMs: 1200, endMs: 2000 }, { text: '第二部分', startMs: 4900, endMs: 5500 }];
  assert.equal(captionsFromTranscript({ utterances: [{ text: '第一部分第二部分', startMs: 1200, endMs: 5500, words }] }).utterances.length, 2);
  const sentence = { text: '只有句级时戳', startMs: 1700, endMs: 4300, words: [] };
  assert.deepEqual(captionsFromTranscript({ utterances: [sentence] }).utterances, [sentence]);
});

test('partial caption words fall back to the full observed sentence rather than deleting spoken text', () => {
  const sentence = { text: '完整的新语音台词', startMs: 1200, endMs: 4300, words: [{ text: '完整的', startMs: 1200, endMs: 2000 }] };
  const result = captionsFromTranscript({ utterances: [sentence] });
  assert.equal(result.utterances.map(item => item.text).join(''), sentence.text);
  assert.deepEqual(result.utterances.map(item => [item.startMs, item.endMs]), [[1200, 4300]]);
});

test('SRT retains observed valid times and removes control markup and content line breaks', () => {
  const text = transcriptToSrt({ utterances: [{ text: '你好 <b>产品</b> {\\pos(1,2)}\r\n下一行', startMs: 160, endMs: 4760 },
    { text: '缺失', startMs: null, endMs: null }, { text: '逆序', startMs: 6000, endMs: 5000 }] });
  assert.match(text, /^1\n00:00:00,160 --> 00:00:04,760\n/);
  assert.doesNotMatch(text.split('\n').slice(2).join('\n'), /[{}<>\\\r]|缺失|逆序/);
  assert.equal(text.split('\n').length, 4);
});

test('dialogue warnings compare the actual speech without claiming successful alignment', () => {
  assert.equal(dialogueWarning('你好，世界！', '你好世界'), null);
  assert.equal(dialogueWarning('Hello, WORLD!', 'hello world'), null);
  assert.equal(dialogueWarning('', '意外出现的声音'), null);
  assert.match(dialogueWarning('必须说出的台词', ''), /没有识别到/);
  assert.match(dialogueWarning('只要九十九元', '这是另一个完全不同的故事'), /差异|试听/);
});
