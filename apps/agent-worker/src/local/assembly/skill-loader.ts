/**
 * Skill loader（A/B 阶段：本地仓库文件源）。
 *
 * 正式分发按定案走「登录拉取」（JWT + FeaturePolicy + 短时签名 + 本地缓存最后版本）；
 * A/B 评测不依赖分发机制，skill 内容从仓库工作区文件读取，但**哈希钉死机制与正式形态同构**：
 * manifest（src/skills/prompt-review/skill.json）记录 contentHash，内容不匹配即拒绝加载——
 * 防止 skill 文件被无声改动后进入评测。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 本文件位于 apps/agent-worker/src/local/assembly → 仓库根需向上 5 级。 */
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");
const MANIFEST_PATH = join(REPO_ROOT, "apps", "agent-worker", "src", "skills", "prompt-review", "skill.json");

export type LoadedSkill = {
  id: string;
  version: string;
  instructions: string;
  contentHash: string;
};

export function loadPromptReviewSkill(): LoadedSkill {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    id: string;
    version: string;
    source: { path: string; contentHash: string };
  };
  const skillPath = join(REPO_ROOT, manifest.source.path.replaceAll("\\", "/").replace(/^\.\//, ""));
  const instructions = readFileSync(skillPath, "utf8");
  const contentHash = createHash("sha256").update(instructions).digest("hex");
  if (contentHash !== manifest.source.contentHash) {
    throw new Error(`skill_hash_mismatch:${manifest.id}`);
  }
  return { id: manifest.id, version: manifest.version, instructions, contentHash };
}
