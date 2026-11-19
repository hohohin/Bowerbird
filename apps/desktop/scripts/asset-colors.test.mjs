import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseColors } from "../src/lib/assetColors.ts";

test("missing or invalid color JSON has no display colors", () => {
  for (const value of [null, undefined, "", " ", "{invalid", '["red",]']) {
    assert.deepEqual(parseColors(value), []);
  }
});

test("valid JSON must be an array", () => {
  for (const value of ["null", "{}", '"red"', "42", "true"]) {
    assert.deepEqual(parseColors(value), []);
  }
});

test("mixed arrays retain only their string entries in order", () => {
  assert.deepEqual(parseColors('["#ff0000",null,8,false,{},["blue"],"red"]'), ["#ff0000", "red"]);
  assert.deepEqual(parseColors("[]"), []);
});

test("stored strings are not validated, trimmed or deduplicated", () => {
  assert.deepEqual(parseColors('["", "not-a-color", " #abc ", "red", "red"]'), ["", "not-a-color", " #abc ", "red", "red"]);
});

test("asset detail and masonry share the color parser", () => {
  for (const component of ["AssetDetail", "MasonryGrid"]) {
    const source = readFileSync(new URL(`../src/components/${component}.tsx`, import.meta.url), "utf8");
    assert.match(source, /import\s*\{\s*parseColors\s*\}\s*from\s*["']\.\.\/lib\/assetColors["']/);
    assert.doesNotMatch(source, /function\s+parseColors\s*\(/);
    assert.match(source, /parseColors\((?:asset|shown)\.colors\)/);
  }
});
