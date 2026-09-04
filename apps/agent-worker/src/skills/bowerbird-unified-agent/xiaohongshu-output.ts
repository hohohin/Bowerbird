import { canonicalJson } from "../../kernel/tool-ledger.ts";

const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TITLE_CODE_POINTS = 20;
const MAX_BODY_CODE_POINTS = 1_000;
const MAX_TAGS = 10;
const MAX_TAG_CODE_POINTS = 20;
const MAX_IMAGES = 9;
const MAX_IMAGE_NOTE_CODE_POINTS = 200;

export const XIAOHONGSHU_RECIPE_VERSION = "bowerbird-xiaohongshu-draft-v1" as const;

/**
 * Bowerbird 的保守内部输出配方，不冒充小红书实时发布规则。
 * U5 只交付可审阅草稿包，不登录、不发布、不读取渠道账号。
 */
export const XIAOHONGSHU_OUTPUT_RECIPE_V1 = [
  "Create one reviewable Xiaohongshu draft from the approved goal, content plan, rendered result and frozen visual profile.",
  "Do not invent product claims, ingredients, prices, endorsements or visible facts that are absent from the approved sources.",
  "Use a concrete title, readable short paragraphs, and tags without the # prefix. Do not include URLs, account handles or publishing instructions.",
  "The parent process owns image identity and order. Return exactly one imageNotes entry for each parent-selected image, in the same order.",
  "This is a draft artifact only. Never claim that it was published.",
].join(" ");

export type XiaohongshuDraftV1 = {
  schemaVersion: 1;
  title: string;
  body: string;
  tags: string[];
  imageNotes: string[];
};

export type XiaohongshuPackageV1 = {
  schemaVersion: 1;
  channel: "xiaohongshu";
  recipeVersion: typeof XIAOHONGSHU_RECIPE_VERSION;
  title: string;
  body: string;
  tags: string[];
  images: Array<{ position: number; artifactId: string; note: string }>;
  provenance: {
    approvedPlanHash: string;
    visualProfile: null | { profileId: string; version: number; hash: string };
  };
};

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("xiaohongshu_draft_invalid");
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("xiaohongshu_draft_invalid");
  }
  return record;
}

function boundedText(value: unknown, maxCodePoints: number): string {
  if (typeof value !== "string") throw new Error("xiaohongshu_draft_invalid");
  const text = value.trim();
  if (!text || Array.from(text).length > maxCodePoints) throw new Error("xiaohongshu_draft_invalid");
  return text;
}

export function validateXiaohongshuDraftV1(value: unknown, imageCount: number): XiaohongshuDraftV1 {
  if (!Number.isSafeInteger(imageCount) || imageCount < 1 || imageCount > MAX_IMAGES) {
    throw new Error("xiaohongshu_image_count_invalid");
  }
  const draft = exactRecord(value, ["schemaVersion", "title", "body", "tags", "imageNotes"]);
  if (draft.schemaVersion !== 1 || !Array.isArray(draft.tags) || draft.tags.length < 1 || draft.tags.length > MAX_TAGS ||
      !Array.isArray(draft.imageNotes) || draft.imageNotes.length !== imageCount) {
    throw new Error("xiaohongshu_draft_invalid");
  }
  const tags = draft.tags.map((tag) => {
    const text = boundedText(tag, MAX_TAG_CODE_POINTS);
    if (text.startsWith("#") || /\s/u.test(text)) throw new Error("xiaohongshu_draft_invalid");
    return text;
  });
  if (new Set(tags).size !== tags.length) throw new Error("xiaohongshu_draft_invalid");
  return {
    schemaVersion: 1,
    title: boundedText(draft.title, MAX_TITLE_CODE_POINTS),
    body: boundedText(draft.body, MAX_BODY_CODE_POINTS),
    tags,
    imageNotes: draft.imageNotes.map((note) => boundedText(note, MAX_IMAGE_NOTE_CODE_POINTS)),
  };
}

export function compileXiaohongshuPackageV1(args: {
  draft: XiaohongshuDraftV1;
  imageArtifactIds: readonly string[];
  approvedPlanHash: string;
  visualProfile?: { profileId: string; version: number; hash: string };
}): { value: XiaohongshuPackageV1; json: string } {
  const imageArtifactIds = [...args.imageArtifactIds];
  if (imageArtifactIds.length !== args.draft.imageNotes.length || imageArtifactIds.length < 1 ||
      imageArtifactIds.length > MAX_IMAGES || new Set(imageArtifactIds).size !== imageArtifactIds.length ||
      imageArtifactIds.some((id) => !ARTIFACT_ID.test(id)) || !/^[0-9a-f]{64}$/.test(args.approvedPlanHash) ||
      (args.visualProfile !== undefined && (!args.visualProfile.profileId || !Number.isSafeInteger(args.visualProfile.version) ||
        args.visualProfile.version < 1 || !/^[0-9a-f]{64}$/.test(args.visualProfile.hash)))) {
    throw new Error("xiaohongshu_package_binding_invalid");
  }
  const value: XiaohongshuPackageV1 = {
    schemaVersion: 1,
    channel: "xiaohongshu",
    recipeVersion: XIAOHONGSHU_RECIPE_VERSION,
    title: args.draft.title,
    body: args.draft.body,
    tags: [...args.draft.tags],
    images: imageArtifactIds.map((artifactId, index) => ({
      position: index + 1,
      artifactId,
      note: args.draft.imageNotes[index]!,
    })),
    provenance: {
      approvedPlanHash: args.approvedPlanHash,
      visualProfile: args.visualProfile ? { ...args.visualProfile } : null,
    },
  };
  return { value, json: canonicalJson(value) };
}
