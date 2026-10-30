import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createState, descendants, folderPath, entriesIn, addReference, renameEntry, removeEntry,
  newFolder, renameFolder, moveFolder, deleteFolder, disconnectRoot, moveEntries, reconnect, connectDemo,
} from "./fixtures/library-connections/model.ts";

test("current-folder and recursive scopes follow actual entries, including independent references", () => {
  const state = createState();
  assert.equal(entriesIn(state, "brand", false).length, 5);
  assert.equal(entriesIn(state, "brand", true).length, 18);
  assert.equal(entriesIn(state, "products", false).length, 5);
  assert.equal(entriesIn(state, "products", true).length, 7);
  assert.deepEqual(folderPath(state, "details"), ["品牌素材", "产品", "细节"]);
  assert.deepEqual(descendants(state, "brand"), ["products", "details", "videos", "inspiration"]);
  assert.equal(entriesIn(state, "projects", false).length, 0);
  assert.equal(entriesIn(state, "projects", true).filter(entry => entry.reference).length, 3);
});

test("adding an original or a reference creates one direct reference without cloning the asset", () => {
  const state = createState(), before = structuredClone(state);
  const next = addReference(state, ["entry-brand-01", "reference-brand-01"], "inspiration");
  const references = entriesIn(next, "inspiration", false).filter(entry => entry.assetId === "brand-01");
  assert.equal(references.length, 1);
  assert.equal(references[0].reference, true);
  assert.equal(references[0].name, "自然之间.jpg.bowerbird");
  assert.equal(next.assets.length, state.assets.length);
  assert.deepEqual(state, before, "mutations never modify the input snapshot");
  assert.deepEqual(addReference(next, ["entry-brand-01"], "inspiration"), next);
});

test("renaming and deleting a reference never rename or remove its original", () => {
  const state = createState();
  const renamed = renameEntry(state, "reference-brand-01", "提案主视觉");
  assert.equal(renamed.entries.find(entry => entry.id === "reference-brand-01").name, "提案主视觉.bowerbird");
  assert.deepEqual(renamed.assets, state.assets);
  assert.deepEqual(renamed.entries.find(entry => entry.id === "entry-brand-01"), state.entries.find(entry => entry.id === "entry-brand-01"));
  const removed = removeEntry(renamed, "reference-brand-01");
  assert.ok(removed.entries.some(entry => entry.id === "entry-brand-01"));
  assert.deepEqual(removed.assets, state.assets);
});

test("removing an original keeps its creative identity and missing references", () => {
  const state = createState(), next = removeEntry(state, "entry-brand-01");
  assert.ok(!next.entries.some(entry => entry.id === "entry-brand-01"));
  assert.ok(next.entries.some(entry => entry.id === "reference-brand-01"));
  const asset = next.assets.find(asset => asset.id === "brand-01");
  assert.equal(asset.available, false);
  assert.deepEqual(asset.tags, state.assets.find(asset => asset.id === "brand-01").tags);
  assert.equal(next.assets.length, state.assets.length);
});

test("original rename preserves reference labels and stable asset identity", () => {
  const state = createState(), next = renameEntry(state, "entry-brand-01", "新版主视觉.jpg");
  assert.equal(next.assets.find(asset => asset.id === "brand-01").name, "新版主视觉.jpg");
  assert.equal(next.entries.find(entry => entry.id === "entry-brand-01").name, "新版主视觉.jpg");
  assert.equal(next.entries.find(entry => entry.id === "reference-brand-01").name, "自然之间.jpg.bowerbird");
});

test("entry moves retain asset identity and move only the chosen entry", () => {
  const state = createState();
  const next = moveEntries(state, ["entry-brand-01"], "projects");
  assert.equal(next.entries.find(entry => entry.id === "entry-brand-01").folderId, "projects");
  assert.equal(next.entries.find(entry => entry.id === "reference-brand-01").folderId, "proposal");
  assert.deepEqual(next.assets, state.assets);
  const movedReference = moveEntries(state, ["reference-brand-01"], "inspiration");
  assert.equal(movedReference.entries.find(entry => entry.id === "entry-brand-01").folderId, "brand");
  assert.equal(movedReference.entries.find(entry => entry.id === "reference-brand-01").folderId, "inspiration");
  assert.throws(() => moveEntries(state, ["entry-brand-01"], "proposal"), /已包含/);
});

test("disconnect removes a directory connection while retaining asset data and references elsewhere", () => {
  const state = createState(), next = disconnectRoot(state, "brand");
  assert.ok(!next.roots.brand);
  assert.ok(!next.folders.some(folder => folder.rootId === "brand"));
  assert.deepEqual(next.assets, state.assets);
  assert.equal(entriesIn(next, "proposal", false).length, 3);
  assert.ok(next.assets.find(asset => asset.id === "brand-01").available);
});

test("offline directory writes fail without deleting cached data; reconnect restores availability", () => {
  const state = createState(), before = structuredClone(state);
  assert.throws(() => newFolder(state, "drive", "新建"), /不可用/);
  assert.throws(() => addReference(state, ["entry-brand-01"], "archive"), /不可用/);
  assert.throws(() => removeEntry(state, "entry-archive-01"), /不可用/);
  assert.deepEqual(state, before);
  const next = reconnect(state, "drive");
  assert.equal(next.roots.drive.available, true);
  assert.ok(next.assets.find(asset => asset.id === "archive-01").available);
  assert.deepEqual(next.entries, state.entries);
});

test("new folders share the proper root and names reject duplicates and path syntax", () => {
  const state = createState();
  const root = newFolder(state, null, "独立目录");
  const folder = root.folders.at(-1);
  assert.equal(folder.parentId, null);
  assert.equal(root.roots[folder.id].path, "D:/设计资料/独立目录");
  const child = newFolder(root, folder.id, "子目录").folders.at(-1);
  assert.equal(child.rootId, folder.id);
  assert.throws(() => newFolder(state, "brand", "产品"), /同名/);
  assert.throws(() => newFolder(state, "brand", "../其他目录"), /有效名称/);
  const renamed = renameFolder(state, "brand", "新品牌素材");
  assert.equal(renamed.roots.brand.path, "D:/设计资料/新品牌素材");
  assert.deepEqual(folderPath(renamed, "details"), ["新品牌素材", "产品", "细节"]);
});

test("connecting the demo directory is idempotent and reconnecting reuses original assets", () => {
  const state = createState(), next = connectDemo(state);
  assert.equal(entriesIn(next, "travel", false).length, 2);
  assert.equal(entriesIn(next, "travel", true).length, 4);
  assert.equal(next.assets.length, state.assets.length + 4);
  assert.deepEqual(connectDemo(next), next);
  const disconnected = disconnectRoot(next, "travel");
  const restored = connectDemo(disconnected);
  assert.equal(restored.assets.length, next.assets.length);
  assert.equal(entriesIn(restored, "travel", true).length, 4);
});

test("renaming a Windows root preserves the drive, parent path and separator style", () => {
  const state = createState();
  state.roots.brand.path = "D:\\设计资料\\品牌素材";
  const next = renameFolder(state, "brand", "新版品牌");
  assert.equal(next.roots.brand.path, "D:\\设计资料\\新版品牌");
  assert.equal(state.roots.brand.path, "D:\\设计资料\\品牌素材");
  const network = createState();
  network.roots.brand.path = "\\\\studio-nas\\素材\\品牌素材";
  assert.equal(renameFolder(network, "brand", "新版品牌").roots.brand.path, "\\\\studio-nas\\素材\\新版品牌");
});

test("moving a folder relocates its entire subtree without changing entry or asset identities", () => {
  const state = createState(), before = structuredClone(state);
  const next = moveFolder(state, "products", "projects");
  assert.deepEqual(folderPath(next, "details"), ["项目参考", "产品", "细节"]);
  assert.equal(next.folders.find(folder => folder.id === "products").rootId, "projects");
  assert.equal(next.folders.find(folder => folder.id === "details").rootId, "projects");
  assert.equal(entriesIn(next, "products", true).length, 7);
  assert.deepEqual(next.assets, state.assets);
  assert.deepEqual(next.entries, state.entries);
  assert.deepEqual(state, before);
});

test("moving a connected root beneath another root removes only its former root connection", () => {
  const state = createState(), next = moveFolder(state, "brand", "projects");
  assert.ok(!next.roots.brand);
  assert.ok(next.roots.projects);
  assert.deepEqual(folderPath(next, "details"), ["项目参考", "品牌素材", "产品", "细节"]);
  assert.ok(["brand", ...descendants(next, "brand")].every(id => next.folders.find(folder => folder.id === id).rootId === "projects"));
  assert.deepEqual(next.assets, state.assets);
  assert.deepEqual(next.entries, state.entries);
});

test("folder moves reject cycles, name conflicts and offline locations atomically", () => {
  const state = createState();
  assert.throws(() => moveFolder(state, "brand", "details"), /自身或其子/);
  assert.throws(() => moveFolder(state, "products", "products"), /自身或其子/);
  assert.throws(() => moveFolder(state, "products", "archive"), /不可用/);
  assert.throws(() => moveFolder(state, "archive", "brand"), /不可用/);
  const duplicate = newFolder(state, "projects", "产品"), before = structuredClone(duplicate);
  assert.throws(() => moveFolder(duplicate, "products", "projects"), /同名/);
  assert.deepEqual(duplicate, before);
});

test("deleting a folder removes its subtree and marks only the contained originals unavailable", () => {
  const state = createState(), next = deleteFolder(state, "products");
  assert.ok(!next.folders.some(folder => ["products", "details"].includes(folder.id)));
  assert.ok(!next.entries.some(entry => ["products", "details"].includes(entry.folderId)));
  assert.equal(next.assets.find(asset => asset.id === "product-01").available, false);
  assert.equal(next.assets.find(asset => asset.id === "detail-01").available, false);
  assert.equal(next.assets.find(asset => asset.id === "brand-01").available, true);
  assert.ok(next.entries.some(entry => entry.id === "reference-product-01"));
  assert.equal(next.assets.length, state.assets.length);
  assert.ok(next.roots.brand);
});

test("deleting a reference-only folder leaves originals intact; deleting a root removes its connection", () => {
  const state = createState(), references = deleteFolder(state, "proposal");
  assert.deepEqual(references.assets, state.assets);
  assert.ok(references.entries.some(entry => entry.id === "entry-brand-01"));
  const root = deleteFolder(state, "brand");
  assert.ok(!root.roots.brand);
  assert.ok(!root.folders.some(folder => folder.rootId === "brand"));
  assert.ok(root.entries.some(entry => entry.id === "reference-brand-01"));
  assert.equal(root.assets.find(asset => asset.id === "brand-01").available, false);
  assert.throws(() => deleteFolder(state, "drive"), /不可用/);
});
