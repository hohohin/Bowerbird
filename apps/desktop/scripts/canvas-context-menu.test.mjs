import assert from "node:assert/strict";
import test from "node:test";
import { buildCanvasContextMenu } from "../src/lib/canvasContextMenu.ts";

const base = {
  blank: false, nodeCount: 1, cardKind: null, hasFolder: false, section: undefined,
  assetCount: 0, imageCount: 0, hasDissolvableGroup: false, interactive: true,
  canSaveTemplate: false, canExportWorkflow: false, selectionLocked: false, sessionRunning: false,
};
const menu = facts => buildCanvasContextMenu({ ...base, ...facts });
const ids = items => items.map(item => item.id);
const submenu = (items, id) => items.find(item => item.id === id).items;

test("pure blank canvas offers only actions for the point", () => {
  assert.deepEqual(ids(menu({ blank: true, nodeCount: 0 }).items), ["draft", "artboard", "import-package", "paste"]);
});

test("blank section, artboard and workflow container retain their removal submenu", () => {
  for (const [kind, label] of [["section", "移除分区"], ["artboard", "移除画板"], ["container", "解封容器"]]) {
    const { items } = menu({ blank: true, nodeCount: 0, section: { kind, name: "测试" } });
    const [remove] = submenu(items, "remove-section-menu");
    assert.equal(remove.label, `${label}「测试」`);
    assert.equal(remove.danger, true);
  }
});

test("selection remains available in its submenu from blank space, with stable targets", () => {
  const { items } = menu({ blank: true, nodeCount: 3, assetCount: 2, imageCount: 2 });
  assert.deepEqual(ids(items), ["draft", "artboard", "import-package", "paste", "selection"]);
  const selected = submenu(items, "selection");
  assert.ok(ids(selected).includes("merge-group"));
  assert.equal(submenu(selected, "delete-menu")[0].label, "从画布移出所选 3 项");
  const noImages = submenu(menu({ blank: true, nodeCount: 3 }).items, "selection");
  assert.ok(ids(noImages).includes("selection-actions"));
  assert.ok(!ids(noImages).includes("asset-transfers"));
  assert.ok(!ids(noImages).includes("merge-group"));
});

test("ordinary card, folder, workflow, prompt and Agent actions remain distinct", () => {
  assert.ok(ids(menu({}).items).includes("copy"));
  assert.ok(!ids(menu({}).items).includes("export-package"));
  assert.equal(submenu(menu({ hasFolder: true }).items, "delete-menu")[0].id, "ungroup-folder");
  assert.ok(ids(menu({ canExportWorkflow: true }).items).includes("export-package"));
  const prompt = menu({ cardKind: "prompt" });
  assert.equal(prompt.label, "生成指令菜单");
  assert.ok(ids(prompt.items).includes("reuse"));
  assert.ok(ids(submenu(prompt.items, "delete-menu")).includes("delete-session"));
  assert.equal(menu({ cardKind: "agent_group" }).label, "Agent 执行组菜单");
  assert.ok(ids(menu({ hasDissolvableGroup: true }).items).includes("dissolve-group"));
  const section = menu({ section: { kind: "section", name: "分镜" } });
  assert.ok(ids(section.items).includes("section-colors"));
});

test("locked cards and running generation independently disable their actions", () => {
  const running = submenu(menu({ cardKind: "prompt", sessionRunning: true }).items, "delete-menu");
  assert.equal(running.find(item => item.id === "remove-nodes").disabled, false);
  assert.equal(running.find(item => item.id === "delete-session").disabled, true);
  const locked = submenu(menu({ cardKind: "prompt", selectionLocked: true }).items, "delete-menu");
  assert.equal(locked.find(item => item.id === "remove-nodes").disabled, true);
  assert.equal(locked.find(item => item.id === "delete-session").disabled, false);
  assert.equal(menu({ interactive: false }).items.find(item => item.id === "paste").disabled, true);
});
