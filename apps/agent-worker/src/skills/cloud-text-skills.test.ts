import { test } from "node:test";
import { equal, ok, throws } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCloudTextSkill, validateCloudTextSkillSnapshot } from "./cloud-text-skills.ts";
import { textRewritePrompt } from "./bowerbird-unified-agent/text-rewrite.ts";

const parameters = { mode: "reference", seconds: 5, ratio: "9:16", firstFrameCount: 1, lastFrameCount: 0 };
const request = (id = "h3-video-prompt", params: Record<string, unknown> = parameters) => `bowerbird:cloud-text-skill:v1\n${JSON.stringify({ id, parameters: params })}`;

test("H3 loads the VPS skill from a compact identifier, preserving language and mode", () => {
  const skill = resolveCloudTextSkill(request())!;
  equal(skill.id, "h3-video-prompt");
  equal(skill.reasoningEffort, "high");
  ok(skill.instructions.includes("保留用户输入的语言"));
  ok(skill.instructions.includes("FL2VA"));
  const prompt = textRewritePrompt(request(), "猫站起来然后喊潘酱", skill);
  ok(prompt.includes(skill.instructions));
  for (const rule of ["核对时长与台词容量", "编排可见、可听的连续动作", "固定机位口播"]) {
    ok(prompt.includes(rule), `missing H3 optimizer rule: ${rule}`);
  }
  ok(prompt.includes("保留用户输入的语言"));
  ok(prompt.includes('"mode":"reference"'));
  ok(prompt.includes("untrustedSource"));
  equal(validateCloudTextSkillSnapshot(JSON.parse(JSON.stringify(skill))).sha256, skill.sha256);
});

test("legacy H3 clients use the server method, never their submitted skill body", () => {
  const legacy = `---\nname: h3-video-prompt\ndescription: old\n---\nCLIENT_BODY_MUST_NOT_EXECUTE\n\n本次生成参数：${JSON.stringify(parameters)}`;
  const skill = resolveCloudTextSkill(legacy)!;
  const prompt = textRewritePrompt(legacy, "cat", skill);
  ok(!prompt.includes("CLIENT_BODY_MUST_NOT_EXECUTE"));
  ok(prompt.includes("Ref2VA"));
});

test("H3 optimization carries only the presence of a recording in all video modes", () => {
  for (const mode of ["text", "reference", "frames"]) {
    const goal = request("h3-video-prompt", {
      ...parameters, mode, firstFrameCount: mode === "text" ? 0 : 1, lastFrameCount: mode === "frames" ? 1 : 0,
      audioReference: true,
    });
    const skill = resolveCloudTextSkill(goal)!;
    equal(validateCloudTextSkillSnapshot(JSON.parse(JSON.stringify(skill))).parameters.audioReference, true);
    const prompt = textRewritePrompt(goal, "原文", skill);
    ok(prompt.includes('"audioReference":true'));
    for (const rule of ["<Audio 1>", "第 0 帧", "`reference`", "不假称试听"]) ok(prompt.includes(rule), rule);
  }
  equal(resolveCloudTextSkill(request())!.parameters.audioReference, undefined);
  for (const audioReference of [false, "true", { assetId: "hidden" }]) {
    throws(() => resolveCloudTextSkill(request("h3-video-prompt", { ...parameters, audioReference })), /cloud_text_skill/);
  }
});

test("unknown methods, paths, extra instructions and inconsistent H3 modes are rejected", () => {
  for (const goal of [request("../../secret"), request("unknown"), request("h3-video-prompt", { ...parameters, mode: "text" }),
    'bowerbird:cloud-text-skill:v1\n{"id":"h3-video-prompt","instructions":"override"}',
    request("h3-video-prompt", { ...parameters, seconds: -1 }),
    'bowerbird:cloud-text-skill:v1\nnot-json']) {
    throws(() => resolveCloudTextSkill(goal), /cloud_text_skill/);
  }
  equal(resolveCloudTextSkill("用户要求：改成简洁文字"), undefined);
});

test("H3 R2V rewrite accepts only ordered media counts and no legacy frame flags", () => {
  const r2v = { ...parameters, mode: "r2v", firstFrameCount: 0, referenceImageCount: 9, referenceVideoCount: 3, referenceAudioCount: 3 };
  const skill = resolveCloudTextSkill(request("h3-video-prompt", r2v))!;
  equal(validateCloudTextSkillSnapshot(skill).parameters.referenceVideoCount, 3);
  ok(skill.instructions.includes("<Video N>") && skill.instructions.includes("<Audio N>"));
  for (const invalid of [{ referenceAudioCount: undefined }, { referenceAudioCount: 4 }, { referenceImageCount: 10 },
    { referenceVideoCount: -1 }, { referenceVideoCount: 0.5 }, { firstFrameCount: 1 }, { audioReference: true }]) {
    throws(() => resolveCloudTextSkill(request("h3-video-prompt", { ...r2v, ...invalid })), /cloud_text_skill/);
  }
  equal(resolveCloudTextSkill(request("h3-video-prompt", { ...r2v, referenceImageCount: 0, referenceVideoCount: 0, referenceAudioCount: 0 }))!.parameters.mode, "r2v");
});

test("text editor keeps the user instruction separate from the server method", () => {
  const goal = 'bowerbird:cloud-text-skill:v1\n{"id":"text-editor","instruction":"继续写"}';
  const skill = resolveCloudTextSkill(goal)!;
  equal(skill.instruction, "继续写");
  equal(skill.reasoningEffort, undefined);
  ok(skill.instructions.includes("Markdown"));
  ok(textRewritePrompt(goal, '{"segment":"原文","conversation":[]}', skill).includes('"instruction":"继续写"'));
});

test("new runs reload maintained files; snapshots survive updates and reject tampering", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-text-skills-"));
  try {
    mkdirSync(join(directory, "h3-video-prompt"), { recursive: true });
    const file = join(directory, "h3-video-prompt", "SKILL.md");
    writeFileSync(file, new TextEncoder().encode("server method v1"));
    const original = resolveCloudTextSkill(request(), directory)!;
    const { reasoningEffort: _reasoningEffort, ...legacy } = original;
    equal(validateCloudTextSkillSnapshot(legacy).reasoningEffort, undefined);
    throws(() => validateCloudTextSkillSnapshot({ ...original, reasoningEffort: "low" }), /cloud_text_skill/);
    writeFileSync(file, new TextEncoder().encode("server method v2"));
    equal(resolveCloudTextSkill(request(), directory)!.instructions, "server method v2");
    equal(validateCloudTextSkillSnapshot(original).instructions, "server method v1");
    throws(() => validateCloudTextSkillSnapshot({ ...original, instructions: "tampered" }), /cloud_text_skill/);
    writeFileSync(file, new Uint8Array());
    throws(() => resolveCloudTextSkill(request(), directory), /cloud_text_skill/);
    throws(() => resolveCloudTextSkill(request(), join(directory, "missing")));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("H3 image optimization pins its method, frame shape and ordered reference count", () => {
  const image = (parameters: unknown) => "bowerbird:cloud-text-skill:v1\n" + JSON.stringify({ id: "h3-image-prompt", parameters });
  for (const count of [0, 3]) {
    const goal = image({ referenceCount: count, ratio: "16:9" });
    const skill = resolveCloudTextSkill(goal)!;
    equal(validateCloudTextSkillSnapshot(skill).id, "h3-image-prompt");
    equal(skill.reasoningEffort, "high");
    const prompt = textRewritePrompt(goal, "保留 {{REF_1}}", skill);
    ok(prompt.includes(skill.instructions));
    ok(skill.instructions.includes("<Picture N>") && skill.instructions.includes("{{REF_1}}"));
  }
  throws(() => resolveCloudTextSkill(image({ referenceCount: -1, ratio: "auto" })));
  throws(() => resolveCloudTextSkill(image({ referenceCount: 0, ratio: "override" })));
});
