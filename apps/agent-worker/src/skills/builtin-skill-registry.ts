import type { SkillManifest } from "../contracts/skill.ts";
import { loadControlledImageEditSkill } from "./bowerbird-controlled-image-edit/loader.ts";
import { CONTROLLED_IMAGE_EDIT_MANIFEST } from "./bowerbird-controlled-image-edit/manifest.ts";
import { loadHtmlLayoutRenderSkill } from "./bowerbird-html-layout-render/loader.ts";
import { HTML_LAYOUT_RENDER_MANIFEST } from "./bowerbird-html-layout-render/manifest.ts";
import { loadUnifiedAgentSkill } from "./bowerbird-unified-agent/loader.ts";
import { UNIFIED_AGENT_MANIFEST } from "./bowerbird-unified-agent/manifest.ts";

export type LoadedSkillBundle = {
  id: string;
  version: string;
  instructionHash: string;
  instructions: string;
};

/** 首版 runner 只用显式判别，不允许由 Skill id 或目录路径动态构造模块。 */
export type BuiltinSkillRunner = "controlled-image-edit" | "html-layout-render" | "unified-agent";

export type BuiltinSkillRegistration = {
  id: string;
  version: string;
  loadBundle(): LoadedSkillBundle;
  manifest: SkillManifest;
  runner: BuiltinSkillRunner;
};

export type ResolvedBuiltinSkill = BuiltinSkillRegistration & {
  bundle: LoadedSkillBundle;
};

function validateRegistration(registration: BuiltinSkillRegistration): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(registration.id) || registration.manifest.id !== registration.id) {
    throw new Error("builtin_skill_registration_id_invalid");
  }
  if (!registration.version || registration.manifest.version !== registration.version) {
    throw new Error("builtin_skill_registration_version_invalid");
  }
  if (!Number.isInteger(registration.manifest.snapshotSchemaVersion) || registration.manifest.snapshotSchemaVersion <= 0) {
    throw new Error("builtin_skill_snapshot_schema_invalid");
  }
}

/**
 * 随 Worker 镜像发布的官方 Skill 白名单。
 *
 * 不扫描目录、不接受路径、不下载或热加载；解析只做 Map 精确匹配。loadBundle
 * 仍由各 Skill 自己复核 SKILL.md + references 的钉死 hash。
 */
export class BuiltinSkillRegistry {
  readonly #registrations: ReadonlyMap<string, BuiltinSkillRegistration>;

  constructor(registrations: readonly BuiltinSkillRegistration[]) {
    const entries = new Map<string, BuiltinSkillRegistration>();
    for (const registration of registrations) {
      validateRegistration(registration);
      if (entries.has(registration.id)) throw new Error("builtin_skill_registration_duplicate");
      entries.set(registration.id, Object.freeze(registration));
    }
    this.#registrations = entries;
  }

  resolve(skillId: string, skillVersion: string): ResolvedBuiltinSkill {
    const registration = this.#registrations.get(skillId);
    if (!registration) throw new Error("agent_skill_not_supported");
    if (skillVersion !== registration.version) throw new Error("agent_skill_version_unavailable");
    const bundle = registration.loadBundle();
    if (bundle.id !== registration.id || bundle.version !== registration.version) {
      throw new Error("builtin_skill_bundle_identity_mismatch");
    }
    if (!/^[0-9a-f]{64}$/.test(bundle.instructionHash)) {
      throw new Error("builtin_skill_bundle_hash_invalid");
    }
    return { ...registration, bundle };
  }

  assertSnapshotCompatible(skill: ResolvedBuiltinSkill, snapshotSchemaVersion: number): void {
    if (snapshotSchemaVersion !== skill.manifest.snapshotSchemaVersion) {
      throw new Error("agent_skill_snapshot_incompatible");
    }
  }

  list(): ReadonlyArray<{ id: string; version: string; runner: BuiltinSkillRunner }> {
    return [...this.#registrations.values()].map(({ id, version, runner }) => ({ id, version, runner }));
  }
}

const controlledImageEditRegistration: BuiltinSkillRegistration = {
  id: CONTROLLED_IMAGE_EDIT_MANIFEST.id,
  version: CONTROLLED_IMAGE_EDIT_MANIFEST.version,
  loadBundle: loadControlledImageEditSkill,
  manifest: CONTROLLED_IMAGE_EDIT_MANIFEST,
  runner: "controlled-image-edit",
};

const htmlLayoutRenderRegistration: BuiltinSkillRegistration = {
  id: HTML_LAYOUT_RENDER_MANIFEST.id,
  version: HTML_LAYOUT_RENDER_MANIFEST.version,
  loadBundle: loadHtmlLayoutRenderSkill,
  manifest: HTML_LAYOUT_RENDER_MANIFEST,
  runner: "html-layout-render",
};

const unifiedAgentRegistration: BuiltinSkillRegistration = {
  id: UNIFIED_AGENT_MANIFEST.id,
  version: UNIFIED_AGENT_MANIFEST.version,
  loadBundle: loadUnifiedAgentSkill,
  manifest: UNIFIED_AGENT_MANIFEST,
  runner: "unified-agent",
};

export const BUILTIN_SKILL_REGISTRY = new BuiltinSkillRegistry([
  controlledImageEditRegistration,
  htmlLayoutRenderRegistration,
  unifiedAgentRegistration,
]);
