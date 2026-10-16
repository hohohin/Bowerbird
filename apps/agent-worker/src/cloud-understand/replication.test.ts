import { test } from "node:test";
import { Buffer } from "node:buffer";
import { deepEqual, equal, throws, ok, rejects } from "node:assert/strict";
import { replicationMessages, validateReplicationResult, validateReplicationVideo, type ReplicationPayload } from "./replication.ts";
import { validateReplication, replicationPriceAvailable } from "../../../cloud/supabase/functions/_shared/replication.ts";

const video = { mime: "video/mp4" as const, duration: 5, base64: Buffer.from(new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0])).toString("base64") };
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
  throws(() => validateReplicationResult(input, "{}", "stop"));
  const messages = replicationMessages(input) as { content: { type: string; video_url?: { fps: number } }[] }[];
  equal(messages[0].content[0].type, "video_url"); equal(messages[0].content[0].video_url?.fps, 1);
});
