import { test } from "node:test";
import { equal, ok, throws } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCloudTextSkill, validateCloudTextSkillSnapshot } from "./cloud-text-skills.ts";
import { textRewritePrompt } from "./bowerbird-unified-agent/text-rewrite.ts";

const parameters = { mode: "reference", seconds: 5, ratio: "9:16", firstFrameCount: 1, lastFrameCount: 0 };
const request = (id = "h3-video-prompt", params = parameters) => `bowerbird:cloud-text-skill:v1\n${JSON.stringify({ id, parameters: params })}`;

test("H3 loads the VPS skill from a compact identifier, preserving language and mode", () => {
  const skill = resolveCloudTextSkill(request())!;
  equal(skill.id, "h3-video-prompt");
  ok(skill.instructions.includes("保留用户输入的语言"));
  ok(skill.instructions.includes("FL2VA"));
  const prompt = textRewritePrompt(request(), "猫站起来然后喊潘酱", skill);
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

test("unknown methods, paths, extra instructions and inconsistent H3 modes are rejected", () => {
  for (const goal of [request("../../secret"), request("unknown"), request("h3-video-prompt", { ...parameters, mode: "text" }),
    'bowerbird:cloud-text-skill:v1\n{"id":"h3-video-prompt","instructions":"override"}',
    request("h3-video-prompt", { ...parameters, seconds: -1 }),
    'bowerbird:cloud-text-skill:v1\nnot-json']) {
    throws(() => resolveCloudTextSkill(goal), /cloud_text_skill/);
  }
  equal(resolveCloudTextSkill("用户要求：改成简洁文字"), undefined);
});

test("text editor keeps the user instruction separate from the server method", () => {
  const goal = 'bowerbird:cloud-text-skill:v1\n{"id":"text-editor","instruction":"继续写"}';
  const skill = resolveCloudTextSkill(goal)!;
  equal(skill.instruction, "继续写");
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
    writeFileSync(file, new TextEncoder().encode("server method v2"));
    equal(resolveCloudTextSkill(request(), directory)!.instructions, "server method v2");
    equal(validateCloudTextSkillSnapshot(original).instructions, "server method v1");
    throws(() => validateCloudTextSkillSnapshot({ ...original, instructions: "tampered" }), /cloud_text_skill/);
    writeFileSync(file, new Uint8Array());
    throws(() => resolveCloudTextSkill(request(), directory), /cloud_text_skill/);
    throws(() => resolveCloudTextSkill(request(), join(directory, "missing")));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
