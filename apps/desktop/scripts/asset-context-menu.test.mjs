import assert from "node:assert/strict";
import test from "node:test";
import { buildAssetContextMenu } from "../src/lib/assetContextMenu.ts";

const asset = (ext = "png", extra = {}) => ({ store_path: `media/file.${ext}`, ext, source: "import", ...extra });
const snapshot = (extra = {}) => {
  const current = extra.asset ?? asset();
  return {
    asset: current, targets: [current], mode: "single", selectedCount: 1,
    busy: false, manage: false, embedded: false, hasDetail: false, canSearchPinterest: false,
    hasProject: false, hasMembershipProject: false, canAddToProject: false, libraryProject: false,
    canvasLibraryStatus: "unavailable", generationCount: 0, hasGenerationGroup: false,
    describe: { queued: false, cloudUsable: true, cloudAvailable: true, loggedIn: true, codexUsable: true, canUseByo: true },
    ...extra,
  };
};
const model = extra => buildAssetContextMenu(snapshot(extra));
const rows = result => result.columns.flatMap(column => column.flatMap(section => section.items));
const find = (result, id) => {
  const search = items => items.find(item => item.id === id) ?? items.filter(item => item.kind === "submenu")
    .map(item => search(item.items)).find(Boolean);
  return search(rows(result));
};
const canvas = (extra = {}) => ({ nodeCount: 1, canRemove: true, itemTarget: true, canUngroup: false, ...extra });

test("incomplete selection offers only folder move", () => {
  const result = model({ mode: "incomplete", canvas: canvas(), generationCount: 4 });
  assert.equal(result.label, "所选素材的操作");
  assert.equal(result.columns[0][0].heading, "部分所选条目已不存在");
  assert.deepEqual(rows(result).map(item => item.id), ["move-incomplete"]);
});

test("single media matrix keeps labels and capabilities for every host", () => {
  const media = [
    ["png", "打开图片详情", true, true, true],
    ["svg", "打开图片详情", false, true, true],
    ["tiff", "打开图片详情", false, true, true],
    ["mp4", "打开视频详情", false, false, false],
    ["mp3", "打开音频详情", false, false, false],
    ["md", "打开文本编辑器", false, false, false],
  ];
  const hosts = [
    ["library", { libraryProject: true, hasMembershipProject: true }],
    ["canvas", { canvas: canvas() }],
    ["local", { file: { local: true } }],
    ["reference", { file: { local: false, entries: { available: true, canRemoveReferences: true } } }],
  ];
  for (const [ext, detail, editable, describable, artboard] of media) {
    for (const [source, settings] of hosts) {
      const current = asset(ext);
      const result = model({ asset: current, ...settings });
      const context = `${source}/${ext}`;
      assert.deepEqual(result.columns.map(col => col[0].heading), ["常用", "文件"], context);
      assert.equal(find(result, "open-detail")?.label, detail, context);
      for (const id of ["edit", "copy-image", "layers"]) assert.equal(!!find(result, id), editable, `${context} ${id}`);
      assert.equal(!!find(result, "describe"), describable, context);
      assert.equal(!!find(result, "dimensions"), describable, context);
      assert.equal(!!find(result, "artboard"), source === "canvas" && artboard, context);
      assert.equal(!!find(result, "transfers"), source !== "local", context);
    }
  }
});

test("library browsing, managing and embedded detail have distinct selection actions", () => {
  assert.equal(find(model(), "select")?.label, "选择");
  assert.equal(find(model({ manage: true, hasDetail: true }), "select")?.label, "选择/取消选择");
  assert.equal(find(model({ manage: true, hasDetail: true }), "add-to-chat"), undefined);
  assert.equal(find(model({ hasDetail: true }), "add-to-chat")?.label, "添加到对话框");
  assert.equal(find(model({ embedded: true }), "select"), undefined);
  assert.equal(find(model({ embedded: true, file: { local: true } }), "select")?.label, "选择");
});

test("asset membership, external paths and disconnected entries preserve independent actions", () => {
  const project = { libraryProject: true, hasMembershipProject: true };
  assert.equal(find(model(project), "hide-in-library")?.disabled, true);
  assert.equal(find(model({ ...project, canvasLibraryStatus: "available" }), "hide-in-library")?.disabled, false);
  assert.equal(find(model(project), "remove-from-project")?.label, "移出当前项目");
  assert.equal(find(model({ canvas: canvas(), asset: asset("png", { library_hidden: true }) }), "show-in-library")?.label, "加入素材库");
  const external = asset("png", { source: "external" });
  assert.equal(find(model({ asset: external }), "rename")?.title, "修改引用名称，原文件名保留");
  assert.equal(find(model({ asset: external }), "references")?.label, "管理外部引用 · 原文件保留");
  assert.equal(find(model({ asset: external, file: { local: true } }), "rename")?.title, "重命名本机文件");
  const reference = model({ asset: external, file: { local: false, entries: { available: false, canRemoveReferences: true } } });
  assert.equal(find(reference, "rename")?.disabled, true);
  assert.equal(find(reference, "remove-references")?.label, "删除此分身");
});

test("generated-image deletion, canvas item deletion and canvas group deletion use separate targets", () => {
  const generated = asset("png", { generation_session_id: "generation" });
  const result = model({ asset: generated, generationCount: 1 });
  assert.equal(find(result, "reuse")?.tour, "ctx-reuse-gen");
  assert.equal(find(result, "history")?.label, "回看所属创作");
  assert.equal(find(result, "delete-generation"), undefined);
  assert.equal(find(model({ asset: generated, generationCount: 3 }), "delete-generation")?.label, "删除整组原文件 · 3 张");
  const group = model({ asset: generated, canvas: canvas({ canUngroup: true, groupCount: 3 }), hasGenerationGroup: true });
  assert.equal(find(group, "ungroup")?.label, "解散素材组");
  assert.equal(find(group, "generation-group")?.kind, "slot");
  assert.deepEqual(find(group, "canvas-item").items.map(item => item.id), ["remove-canvas-item-from-project", "delete-canvas-item"]);
  assert.deepEqual(find(group, "canvas-group").items.map(item => item.id), ["remove-canvas-group", "remove-canvas-group-from-project", "delete-canvas-group"]);
});

test("asynchronous checks keep disabled rows in place until targets are verified", () => {
  const project = { libraryProject: true, canvasLibraryStatus: "checking" };
  const libraryAction = find(model(project), "hide-in-library");
  assert.equal(libraryAction.disabled, true);
  assert.equal(libraryAction.title, "正在检查画布状态…");
  assert.equal(find(model({ ...project, canvasLibraryStatus: "failed" }), "hide-in-library")?.title, "无法检查画布状态，请重新打开菜单");
  const pending = model({ generationCheck: "checking" });
  const ready = model({ generationCount: 3 });
  const unavailable = model({ generationCheck: "unavailable" });
  assert.deepEqual(find(pending, "delete").items.map(item => item.id), find(ready, "delete").items.map(item => item.id));
  assert.equal(find(pending, "delete-generation").disabled, true);
  assert.equal(find(ready, "delete-generation").disabled, false);
  assert.equal(find(unavailable, "delete-generation").disabled, true);

  const multi = { canvas: canvas({ nodeCount: 2 }), mode: "multi", selectedCount: 2 };
  const missingAsset = model({ ...multi, targets: [asset(), undefined], canvasImagesPending: "正在检查所选素材…" });
  const resolved = model({ ...multi, targets: [asset(), asset()] });
  assert.deepEqual(rows(missingAsset).map(item => item.id), rows(resolved).map(item => item.id));
  assert.equal(find(missingAsset, "describe").disabled, true);
  assert.equal(find(resolved, "describe").disabled, false);
});

test("multi-selection keeps one column, media gates and the item's destructive scope", () => {
  const images = { mode: "multi", selectedCount: 2, targets: [asset(), asset("svg")] };
  let result = model({ ...images, canAddToProject: true, canSearchPinterest: true });
  assert.equal(result.columns.length, 1);
  assert.equal(result.label, "已选 2 项素材的操作");
  assert.equal(find(result, "describe")?.label, "批量反推");
  assert.equal(find(result, "merge-generation-group")?.kind, "slot");
  assert.equal(find(result, "project-picker")?.label, "加入项目");
  assert.equal(find(result, "edit"), undefined);
  result = model({ ...images, selectedCount: 3, targets: [asset(), asset("mp4"), undefined],
    canvas: canvas({ nodeCount: 3, canUngroup: true }), hasProject: true, hasMembershipProject: true, canAddToProject: true });
  assert.equal(find(result, "describe"), undefined);
  assert.equal(find(result, "merge-generation-group"), undefined);
  assert.equal(find(result, "project-picker"), undefined);
  assert.equal(find(result, "remove-from-canvas")?.label, "从画布移出所选 3 项");
  assert.equal(find(result, "canvas-item")?.label, "当前项的项目与原文件");
  assert.equal(find(result, "ungroup"), undefined);
});

test("describe readiness and queue state retain existing explanations", () => {
  const describe = snapshot().describe;
  const cases = [
    ["describe-cloud", { cloudUsable: false, cloudAvailable: false }, "当前版本未配置 Bowerbird Cloud"],
    ["describe-cloud", { cloudUsable: false, loggedIn: false }, "请先登录 Bowerbird 账号"],
    ["describe-cloud", { cloudUsable: false }, "可用积分不足，请补充积分后继续。"],
    ["describe-codex", { codexUsable: false, canUseByo: false }, "升级 Pro 解锁本机 codex"],
    ["describe-codex", { codexUsable: false }, "codex 不可用"],
    ["describe-codex", { codexUsable: false, codexReason: "本机未安装 codex" }, "本机未安装 codex"],
  ];
  for (const [id, state, reason] of cases) {
    const disabled = find(model({ describe: { ...describe, ...state } }), id);
    assert.equal(disabled.disabledReason, reason);
    assert.equal(disabled.icon, "status-unavailable");
  }
  assert.equal(find(model(), "describe-cloud")?.icon, "status-ready");
  const queued = { ...describe, queued: true };
  assert.equal(find(model({ describe: queued }), "describe")?.title, "这张图片正在反推或已排队");
  assert.equal(find(model({ describe: queued }), "describe")?.disabled, true);
  assert.equal(find(model({ mode: "multi", targets: [asset(), asset()], describe: queued }), "describe")?.disabled, false);
});
