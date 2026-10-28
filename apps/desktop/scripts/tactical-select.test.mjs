import test from "node:test";
import assert from "node:assert/strict";
import { createElement as h, Fragment } from "react";
import { findTacticalOption, moveTacticalOption, parseTacticalOptions, tacticalSelectPosition } from "../src/components/tacticalSelectLogic.ts";

test("option trees preserve groups, numeric values, explicit labels and unavailable choices", () => {
  const result = parseTacticalOptions(h(Fragment, null,
    h("option", { value: "" }, "默认"),
    [h("option", { key: "numeric", value: .6, label: "0.6 MP", title: "分辨率" }, "0.6")],
    h("optgroup", { label: "已归档", disabled: true, title: "只读" }, h("option", { value: "past" }, "旧线程")),
    h("option", { hidden: true }, "隐藏选项"),
    h("option", null, " 无显式值 ")));
  assert.deepEqual(result.map(option => [option.value, option.label, option.disabled, option.hidden]), [
    ["", "默认", false, false], ["0.6", "0.6 MP", false, false], ["past", "旧线程", true, false],
    ["隐藏选项", "隐藏选项", false, true], ["无显式值", "无显式值", false, false],
  ]);
  assert.equal(result[1].title, "分辨率");
  assert.equal(result[2].group.label, "已归档");
  assert.equal(result[2].group.title, "只读");
});

test("arrow navigation wraps while skipping disabled and hidden entries", () => {
  const options = parseTacticalOptions([
    h("option", { key: 0, value: "a" }, "Alpha"),
    h("option", { key: 1, value: "b", disabled: true }, "Beta"),
    h("option", { key: 2, value: "c", hidden: true }, "Charlie"),
    h("option", { key: 3, value: "d" }, "Delta"),
  ]);
  assert.equal(moveTacticalOption(options, 0, 1), 3);
  assert.equal(moveTacticalOption(options, 3, 1), 0);
  assert.equal(moveTacticalOption(options, 0, -1), 3);
  assert.equal(moveTacticalOption(options, -1, -1), 3);
  assert.equal(moveTacticalOption(options, -1, 1), 0);
  assert.equal(moveTacticalOption(options.map(option => ({ ...option, disabled: true })), 0, 1), -1);
  assert.equal(moveTacticalOption([], -1, 1), -1);
});

test("type search cycles matching choices and does not activate disabled options", () => {
  const options = parseTacticalOptions([
    h("option", { key: 0, value: "a" }, "Archive"),
    h("option", { key: 1, value: "x", disabled: true }, "Art unavailable"),
    h("option", { key: 2, value: "b" }, "Artwork"),
    h("option", { key: 3, value: "c" }, "视频"),
  ]);
  assert.equal(findTacticalOption(options, "A", 1), 2);
  assert.equal(findTacticalOption(options, "artw", 0), 2);
  assert.equal(findTacticalOption(options, "a", 3), 0);
  assert.equal(findTacticalOption(options, "视", 0), 3);
  assert.equal(findTacticalOption(options, "missing", 0), -1);
});

test("a menu near the bottom-right opens upward within viewport bounds", () => {
  const rect = { left: 900, top: 660, bottom: 690, width: 80 };
  const position = tacticalSelectPosition(rect, { width: 300, height: 220 }, { width: 1024, height: 720 });
  assert.equal(position.top + 220, rect.top - 6);
  assert.equal(position.left + position.width, 1012);
  assert.equal(position.width, 300);
  assert.equal(position.maxHeight, 320);
});

test("wide transformed triggers and long menus stay inside small viewports", () => {
  const position = tacticalSelectPosition({ left: 20, top: 30, bottom: 60, width: 480 }, { width: 600, height: 900 }, { width: 280, height: 220 });
  assert.equal(position.width, 256);
  assert.equal(position.left, 12);
  assert.equal(position.top, 66);
  assert.equal(position.maxHeight, 142);
  assert.ok(position.top + position.maxHeight <= 208);
});

test("height measured after width clamping can flip a wrapped menu above the trigger", () => {
  const rect = { left: 50, top: 360, bottom: 390, width: 120 };
  const viewport = { width: 800, height: 620 };
  const natural = tacticalSelectPosition(rect, { width: 640, height: 80 }, viewport);
  assert.equal(natural.width, 360);
  assert.equal(natural.top, 396);
  const wrapped = tacticalSelectPosition(rect, { width: natural.width, height: 280 }, viewport);
  assert.equal(wrapped.top, 74);
  assert.equal(wrapped.top + 280, rect.top - 6);
  assert.ok(wrapped.top + Math.min(280, wrapped.maxHeight) <= viewport.height - 12);
});
