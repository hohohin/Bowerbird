import { test } from 'node:test';
import { equal } from 'node:assert/strict';
import { replicationAnalysisParts, replicationDuration, replicationRewriteParts, replicationRewriteInput, validateReplicationInput } from '../src/lib/videoReplication.ts';

test('analysis separates speech from shot text and keeps old results readable', () => {
  const result=replicationAnalysisParts({analysis:JSON.stringify({overview:'画面',shots:[],transcript:'你好',transcriptStatus:'transcribed'})});
  equal(result.transcript,'你好');equal(result.transcriptStatus,'transcribed');equal(result.analysisText.includes('transcript'),false);
  const legacy=replicationAnalysisParts({analysis:'旧分析'});equal(legacy.analysisText,'旧分析');equal(legacy.transcriptStatus,'unavailable');
  const plain=replicationAnalysisParts({analysis:JSON.stringify({analysisText:'start: 0, end: 5\n产品特写。',transcript:'你好',transcriptStatus:'transcribed'})});
  equal(plain.analysisText,'start: 0, end: 5\n产品特写。');equal(plain.transcript,'你好');equal(plain.transcriptStatus,'transcribed');
});

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
test('legacy direct-operation validation remains compatible; task UI supplies its video and analysis', () => {
  equal(validateReplicationInput({ operation:'analyze', title:'视频', referenceId:'ref' }),null);
  equal(validateReplicationInput({ operation:'rewrite', title:'改写', inputText:'原文', persona:'编导', rules:'保持节奏' }),null);
});
test('generation cannot be submitted from the replication tool', () => {
  const value={ operation:'generate',title:'视频',product:{id:'p',name:'产品',description:'说明'},prompt:'镜头',duration:5,ratio:'9:16' };
  equal(validateReplicationInput(value),'请在画板对话框中生成视频');
});

test('explicit first-frame fields are separated without guessing or consuming later sections', () => {
  let result=replicationRewriteParts('start: 0, end: 5\n产品特写\n\n## 首帧画面提示词\n白色瓶身、柔光。\n\n## 配音\n欢迎。');
  equal(result.firstFramePrompt,'白色瓶身、柔光。');equal(result.text,'start: 0, end: 5\n产品特写\n\n## 配音\n欢迎。');
  result=replicationRewriteParts('```json\n{"shots":[{"start":0,"end":6}],"first_frame_prompt":"柔光"}\n```');
  equal(result.firstFramePrompt,'柔光');equal(replicationDuration(result.text),6);
  equal(replicationRewriteParts('**首帧画面提示词：** 清晨浴室').firstFramePrompt,'清晨浴室');
  equal(replicationRewriteParts('镜头的首帧画面提示词不要放在视频中').firstFramePrompt,'');
  equal(replicationRewriteParts('start: 0, end: 3\n一瓶香水').firstFramePrompt,'');
});

test('first-frame scene headings copy the first scene while preserving the video script', () => {
  const scene='两位身着古装的女性，一位是娘娘装束，一位是侍女长今，处于现代办公室场景中，娘娘手上捧着印有godox神牛标识的牛皮纸大礼盒，另一位女性与其对话。景别为中景，构图为两人同框，光照为办公室明亮的室内灯光，色彩融合古装的传统色调与现代办公环境的冷色调。';
  const text=`# 整体风格\n古装与现代办公室结合的创意广告，以古装对话形式引出神牛产品促销信息。\n\n# 镜头1\n## 首帧画面\n${scene}\n## 拍摄手法\n机位固定，剪辑节奏平缓，以对话推进。\n## 时长\n约10秒`;
  equal(replicationRewriteParts(text).firstFramePrompt,scene);
  equal(replicationRewriteParts(text).text,text);
  equal(replicationRewriteParts(text+'\n# 镜头2\n## 首帧画面\n另一个场景').firstFramePrompt,scene);
  for(const title of ['【首帧画面】','**首帧画面**','首帧画面：']) equal(replicationRewriteParts(`${title}\n${scene}\n## 拍摄手法\n固定`).firstFramePrompt,scene);
  equal(replicationRewriteParts('首帧画面需要明亮，不要阴暗。').firstFramePrompt,'');
  equal(replicationRewriteParts('## 首帧画面\n## 拍摄手法\n固定').firstFramePrompt,'');
  equal(replicationRewriteParts(JSON.stringify({'首帧画面':scene,拍摄手法:'固定'})).firstFramePrompt,scene);
});
test('rewrite direction is submitted alongside the reference, with a combined length limit', () => {
  equal(replicationRewriteInput({inputText:'原文',rewriteDirection:' 改成夜景 '}),'【参考文本】\n原文\n\n【改写方向】\n改成夜景');
  equal(replicationRewriteInput({inputText:'原文'}),'原文');
  equal(validateReplicationInput({operation:'rewrite',title:'改写',inputText:'a'.repeat(49990),rewriteDirection:'夜景',persona:'编导',rules:'保留节奏'}),'参考文本与改写方向合计不能超过 50000 字');
});
