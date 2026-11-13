import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "../kernel/tool-ledger.ts";

const PREFIX = "bowerbird:cloud-text-skill:v1\n";
const LEGACY_EDITOR = "你是文本编辑器中的写作助手。引用文字是 JSON，segment 为当前段落，conversation 为本气泡的对话历史。按用户要求回答或写作，返回可直接插入文档的 Markdown 正文，不要附加完成说明，不要生成图片或调用生图工具。\n用户要求：";
type SkillId = "h3-video-prompt" | "text-editor";
export interface CloudTextSkillSnapshot {
  id: SkillId;
  version: 1;
  sha256: string;
  instructions: string;
  instruction: string;
  parameters: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("cloud_text_skill_request_invalid");
  return value as Record<string, unknown>;
}

function h3Parameters(value: unknown): Record<string, unknown> {
  const p = record(value);
  if (Object.keys(p).some(key => !["mode", "seconds", "ratio", "firstFrameCount", "lastFrameCount"].includes(key)) ||
      !["text", "reference", "frames"].includes(String(p.mode)) ||
      typeof p.seconds !== "number" || !Number.isFinite(p.seconds) || p.seconds <= 0 || p.seconds > 120 ||
      !["9:16", "16:9", "4:3", "3:4", "1:1", "auto"].includes(String(p.ratio)) ||
      ![0, 1].includes(p.firstFrameCount as number) || ![0, 1].includes(p.lastFrameCount as number) ||
      (p.mode === "text" && (p.firstFrameCount !== 0 || p.lastFrameCount !== 0)) ||
      (p.mode === "reference" && (p.firstFrameCount !== 1 || p.lastFrameCount !== 0)) ||
      (p.mode === "frames" && p.firstFrameCount !== 1)) throw new Error("cloud_text_skill_parameters_invalid");
  return p;
}

function parseRequest(goal: string): Record<string, unknown> | undefined {
  try {
    if (goal.startsWith(PREFIX)) return record(JSON.parse(goal.slice(PREFIX.length)));
    // Compatibility for released clients: discard their method body entirely.
    if (/^---\r?\nname: h3-video-prompt\r?\n/.test(goal)) {
      const marker = "\n\n本次生成参数：";
      const start = goal.lastIndexOf(marker);
      if (start < 0) throw new Error("missing_parameters");
      return { id: "h3-video-prompt", parameters: JSON.parse(goal.slice(start + marker.length)) };
    }
    if (goal.startsWith(LEGACY_EDITOR)) return { id: "text-editor", instruction: goal.slice(LEGACY_EDITOR.length) };
  } catch { throw new Error("cloud_text_skill_request_invalid"); }
}

/** Resolve only trusted IDs; never treat a client-supplied path or Skill body as executable policy. */
export function resolveCloudTextSkill(goal: string, directory?: string): CloudTextSkillSnapshot | undefined {
  const request = parseRequest(goal);
  return request && loadCloudTextSkill(request, directory);
}

export function loadCloudTextSkill(request: Record<string, unknown>, directory = process.env.BOWERBIRD_TEXT_SKILL_DIR ?? join(import.meta.dirname, "text")): CloudTextSkillSnapshot {
  if (Object.keys(request).some(key => !["id", "parameters", "instruction"].includes(key)) ||
      !["h3-video-prompt", "text-editor"].includes(String(request.id))) throw new Error("cloud_text_skill_request_invalid");
  const id = request.id as SkillId;
  const parameters = id === "h3-video-prompt" ? h3Parameters(request.parameters) : {};
  if ((id === "h3-video-prompt" && request.instruction !== undefined) ||
      (id === "text-editor" && (request.parameters !== undefined || typeof request.instruction !== "string" || !request.instruction.trim()))) {
    throw new Error("cloud_text_skill_request_invalid");
  }
  const instructions = readFileSync(join(directory, id, "SKILL.md"), "utf8");
  if (!instructions.trim() || instructions.length > 20000) throw new Error("cloud_text_skill_file_invalid");
  return { id, version: 1, sha256: sha256Hex(instructions), instructions,
    instruction: id === "text-editor" ? request.instruction as string : "", parameters };
}

/** Checkpoints keep the exact method used by this run, even after a VPS file update. */
export function validateCloudTextSkillSnapshot(value: unknown): CloudTextSkillSnapshot {
  const snapshot = record(value);
  if (!["h3-video-prompt", "text-editor"].includes(String(snapshot.id)) || snapshot.version !== 1 ||
      typeof snapshot.instructions !== "string" || !snapshot.instructions.trim() || snapshot.instructions.length > 20000 ||
      snapshot.sha256 !== sha256Hex(snapshot.instructions) || typeof snapshot.instruction !== "string") {
    throw new Error("cloud_text_skill_snapshot_invalid");
  }
  if (snapshot.id === "h3-video-prompt") h3Parameters(snapshot.parameters);
  else if (canonicalJson(record(snapshot.parameters)) !== "{}") throw new Error("cloud_text_skill_snapshot_invalid");
  return snapshot as unknown as CloudTextSkillSnapshot;
}
