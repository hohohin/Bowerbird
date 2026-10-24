import { test } from "node:test";
import { Buffer } from "node:buffer";
import { deepEqual, equal, throws, ok, rejects } from "node:assert/strict";
import { replicationMessages, validateReplicationResult, validateReplicationVideo, type ReplicationPayload } from "./replication.ts";
import { validateReplication, replicationPriceAvailable } from "../../../cloud/supabase/functions/_shared/replication.ts";

const video = { mime: "video/mp4" as const, duration: 5, base64: Buffer.from(new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0])).toString("base64") };
test("text analysis preserves prose and separates speech without requiring JSON or shot fields", () => {
  const input: ReplicationPayload = { operation: "video-analysis", video };
  const parse = (text: string) => JSON.parse(validateReplicationResult(input, text, "stop"));
  const analysis = "整体暖色。\nstart: 0, end: 5\n人物拿起杯子，镜头缓慢推进。";
  deepEqual(parse(`【视频分析】\n${analysis}\n\n【语音转写】\n你好，欢迎。\n【转写状态】\ntranscribed`), { analysisText: analysis, transcript: "你好，欢迎。", transcriptStatus: "transcribed" });
  equal(parse(`## 【视频分析】\r\n${analysis}\r\n**【语音转写】**\r\n\r\n【转写状态】\r\nno_speech`).transcriptStatus, "no_speech");
  equal(parse(`【视频分析】\n${analysis}\n【语音转写】\n\n【转写状态】\nunavailable`).transcriptStatus, "unavailable");
  deepEqual(parse(analysis), { analysisText: analysis, transcript: "", transcriptStatus: "unavailable" });
  equal(parse('"普通文字"').analysisText, '"普通文字"');
  throws(() => validateReplicationResult(input, analysis, "length"), /replication_result_truncated/);
  throws(() => parse("  "), /replication_result_incomplete/);
  throws(() => parse("a".repeat(50001)), /replication_result_incomplete/);
  throws(() => parse(`【视频分析】\n${analysis}\n【语音转写】\n${"a".repeat(20001)}`), /replication_transcript_invalid/);
});
test("analysis preserves actual speech separately and distinguishes missing audio from silence", () => {
  const input: ReplicationPayload = { operation: "video-analysis", video };
  const base = { shots: [{ start: 0, end: 5, subject: "产品", action: "展示", camera: "固定", composition: "居中", lighting: "柔光", transition: "切" }] };
  const parsed = (value: object) => JSON.parse(validateReplicationResult(input, JSON.stringify(value), "stop"));
  equal(parsed({ ...base, transcript: "今天介绍这款产品。", transcriptStatus: "transcribed" }).transcript, "今天介绍这款产品。");
  equal(parsed({ ...base, transcript: "", transcriptStatus: "no_speech" }).transcriptStatus, "no_speech");
  equal(parsed(base).transcriptStatus, "unavailable");
  equal(parsed({ shots: [{ ...base.shots[0], transcript: "分镜中的实际语音", transcriptStatus: "transcribed" }] }).transcript, "分镜中的实际语音");
  throws(() => parsed({ shots: [{ ...base.shots[0], transcript: [] }] }), /replication_transcript_invalid/);
  for (const transcript of [[], 12, "a".repeat(20001)]) throws(() => parsed({ ...base, transcript }), /replication_transcript_invalid/);
  throws(() => parsed({ ...base, transcript: "伪造", transcriptStatus: "no_speech" }), /replication_transcript_invalid/);
  ok(JSON.stringify(replicationMessages(input)).includes("不能把画面字幕或推测当成听到的语音"));
});
test("unpriced operations stay disabled until a positive separate price is explicitly ready", () => {
  for (const row of [undefined, {}, {active:true,unit_cost:3}, {active:false,unit_cost:3,parameters:{pricing_ready:true}}, {active:true,unit_cost:0,parameters:{pricing_ready:true}}, {active:true,unit_cost:3,parameters:{pricing_ready:"true"}}]) equal(replicationPriceAvailable(row),false);
  equal(replicationPriceAvailable({active:true,unit_cost:3,parameters:{pricing_ready:true}}),true);
});
test("worker checks real media duration and proxy bounds before a model call", async () => {
  const info={duration:5,width:640,height:360,fps:10};
  await validateReplicationVideo(video,async()=>info);
  for(const change of [{duration:121},{duration:7},{width:1920},{fps:60}]) await rejects(()=>validateReplicationVideo(video,async()=>({...info,...change})));
});
test("replication validates real MP4 signature, limits and mutually exclusive inputs", () => {
  validateReplication({ operation: "video-analysis", video });
  for (const invalid of [{ ...video, duration: 121 }, { ...video, duration: 0 }, { ...video, base64: "YWJjZA==" }, { ...video, mime: "image/png" }]) throws(() => validateReplication({ operation: "video-analysis", video: invalid }));
  throws(() => validateReplication({ operation: "video-analysis", video, instruction: "hidden instruction" }));
  throws(() => validateReplication({ operation: "video-analysis", video, rewrite: {} }));
});
test("rewrite preserves exact user input as data, independent of video and generation", () => {
  const rewrite = { inputText: " 保留\n换行 ", persona: "编导", rules: "不虚构", product: null };
  validateReplication({ operation: "text-rewrite", rewrite });
  const messages = replicationMessages({ operation: "text-rewrite", rewrite }) as { role: string; content: string }[];
  deepEqual(JSON.parse(messages[1].content), { targetProduct: null, referenceText: rewrite.inputText });
  equal(messages[0].role, "system"); ok(messages[0].content.includes("不生成视频"));
  throws(() => validateReplication({ operation: "text-rewrite", rewrite: { ...rewrite, persona: "" } }));
  throws(() => validateReplication({ operation: "text-rewrite", rewrite: { ...rewrite, inputText: "a".repeat(50001) } }));
  throws(() => validateReplication({ operation: "text-rewrite", rewrite: { ...rewrite, product: { id: "p", name: "p", description: "p", path: "secret" } } }));
});
test("truncated or invalid shot results are never accepted as complete", () => {
  const input: ReplicationPayload = { operation: "video-analysis", video };
  const shot = { start: 0, end: 5, subject: "瓶", action: "旋转", camera: "近景", composition: "居中", lighting: "柔光", transition: "切" };
  equal(JSON.parse(validateReplicationResult(input, JSON.stringify({ shots: [shot] }), "stop")).shots.length, 1);
  throws(() => validateReplicationResult(input, JSON.stringify({ shots: [shot] }), "length"));
  throws(() => validateReplicationResult(input, JSON.stringify({ shots: [{ ...shot, end: 10 }] }), "stop"));
  throws(() => validateReplicationResult(input, JSON.stringify({ shots: [shot, shot] }), "stop"));
  throws(() => validateReplicationResult(input, '{"shots":[]}', "stop"));
  const messages = replicationMessages(input) as { content: { type: string; video_url?: { fps: number } }[] }[];
  equal(messages[0].content[0].type, "video_url"); equal(messages[0].content[0].video_url?.fps, 1);
});

test("missing transition preserves complete analysis, while malformed required fields and times still fail", () => {
  const input: ReplicationPayload = { operation: "video-analysis", video };
  const shot = { start: 0, end: 5, subject: "人物", action: "展示", camera: "中景", composition: "居中", lighting: "自然光" };
  for (const transition of [undefined, null]) {
    const result = JSON.parse(validateReplicationResult(input, JSON.stringify({ shots: [{ ...shot, transition }] }), "stop"));
    deepEqual(result.shots[0], { ...shot, transition: "未提供" });
  }
  for (const transition of ["硬切", ""]) equal(JSON.parse(validateReplicationResult(input, JSON.stringify({ shots: [{ ...shot, transition }] }), "stop")).shots[0].transition, transition);
  throws(() => validateReplicationResult(input, JSON.stringify({ shots: [{ ...shot, action: null }] }), "stop"), /replication_shot_fields_invalid/);
  throws(() => validateReplicationResult(input, JSON.stringify({ shots: [{ ...shot, end: 7 }] }), "stop"), /replication_shot_time_invalid/);
  throws(() => validateReplicationResult(input, JSON.stringify({ shots: [shot] }), "length"), /replication_result_truncated/);
  equal(JSON.parse(validateReplicationResult(input, "普通分镜描述", "stop")).analysisText, "普通分镜描述");
});
