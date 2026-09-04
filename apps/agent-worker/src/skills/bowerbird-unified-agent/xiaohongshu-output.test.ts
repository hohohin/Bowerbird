import { deepEqual, equal, throws } from "node:assert/strict";
import { test } from "node:test";

import {
  compileXiaohongshuPackageV1,
  validateXiaohongshuDraftV1,
  XIAOHONGSHU_RECIPE_VERSION,
} from "./xiaohongshu-output.ts";

test("xiaohongshu v1 validates a bounded draft and deterministically binds parent-owned images", () => {
  const draft = validateXiaohongshuDraftV1({
    schemaVersion: 1,
    title: "一张长图讲清产品",
    body: "先看重点，再按顺序浏览细节。",
    tags: ["产品设计", "视觉灵感"],
    imageNotes: ["封面与核心信息", "细节与使用场景"],
  }, 2);
  const first = compileXiaohongshuPackageV1({
    draft,
    imageArtifactIds: ["slice-0001", "slice-0002"],
    approvedPlanHash: "a".repeat(64),
    visualProfile: { profileId: "profile-1", version: 3, hash: "b".repeat(64) },
  });
  const second = compileXiaohongshuPackageV1({
    draft,
    imageArtifactIds: ["slice-0001", "slice-0002"],
    approvedPlanHash: "a".repeat(64),
    visualProfile: { profileId: "profile-1", version: 3, hash: "b".repeat(64) },
  });
  equal(first.json, second.json);
  equal(first.value.recipeVersion, XIAOHONGSHU_RECIPE_VERSION);
  deepEqual(first.value.images, [
    { position: 1, artifactId: "slice-0001", note: "封面与核心信息" },
    { position: 2, artifactId: "slice-0002", note: "细节与使用场景" },
  ]);
});

test("xiaohongshu v1 rejects unknown fields, hashtag-shaped tags and image-count drift", () => {
  throws(() => validateXiaohongshuDraftV1({
    schemaVersion: 1, title: "标题", body: "正文", tags: ["#标签"], imageNotes: ["封面"], extra: true,
  }, 1), /xiaohongshu_draft_invalid/);
  throws(() => validateXiaohongshuDraftV1({
    schemaVersion: 1, title: "标题", body: "正文", tags: ["标签"], imageNotes: [],
  }, 1), /xiaohongshu_draft_invalid/);
});
