import assert from "node:assert/strict";
import test from "node:test";
import { groupLibraryAssets } from "../src/lib/libraryView.ts";

const projects = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "empty", name: "Empty" }];
const assets = [{ id: "shared" }, { id: "a-only" }, { id: "global" }];
const memberships = [
  { assetId: "shared", projectId: "a" }, { assetId: "shared", projectId: "b" },
  { assetId: "a-only", projectId: "a" }, { assetId: "shared", projectId: "a" },
];

test("shared assets appear once per project, never as loose global cards", () => {
  const view = groupLibraryAssets(assets, projects, memberships);
  assert.deepEqual(view.globalAssets.map(a => a.id), ["global"]);
  assert.deepEqual(view.projectGroups.map(g => [g.project.id, g.assets.map(a => a.id)]), [
    ["a", ["shared", "a-only"]], ["b", ["shared"]],
  ]);
});

test("filtered-out and empty projects have no folder; previews and counts use matching assets", () => {
  const view = groupLibraryAssets([{ id: "a-only" }], projects, memberships);
  assert.equal(view.projectGroups.length, 1);
  assert.equal(view.projectGroups[0].assets.length, 1);
  assert.equal(view.projectGroups[0].project.id, "a");
  assert.deepEqual(groupLibraryAssets([], projects, memberships), { globalAssets: [], projectGroups: [] });
});

test("archived, provisional or stale owners cannot swallow canonical assets", () => {
  const view = groupLibraryAssets(assets, [{ ...projects[0], archived_at: 1 }, { ...projects[1], provisional: true }], memberships);
  assert.deepEqual(view.globalAssets, assets);
  assert.deepEqual(view.projectGroups, []);
});
