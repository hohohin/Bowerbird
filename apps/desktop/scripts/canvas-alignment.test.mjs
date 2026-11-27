import assert from "node:assert/strict";
import { test } from "node:test";
import { computeCanvasAlignment } from "../src/lib/canvasAlignment.ts";

const items = Object.freeze([
  Object.freeze({ id: "a", x: -11, y: -9, width: 4, height: 8 }),
  Object.freeze({ id: "b", x: 4, y: 9, width: 11, height: 5 }),
  Object.freeze({ id: "c", x: 31, y: 28, width: 6, height: 13 }),
]);

const cases = [
  ["left", { b: { x: -11, y: 9 }, c: { x: -11, y: 28 } }],
  ["center-x", { a: { x: 11, y: -9 }, b: { x: 8, y: 9 }, c: { x: 10, y: 28 } }],
  ["right", { a: { x: 33, y: -9 }, b: { x: 26, y: 9 } }],
  ["top", { b: { x: 4, y: -9 }, c: { x: 31, y: -9 } }],
  ["center-y", { a: { x: -11, y: 12 }, b: { x: 4, y: 14 }, c: { x: 31, y: 10 } }],
  ["bottom", { a: { x: -11, y: 33 }, b: { x: 4, y: 36 } }],
  ["distribute-x", { b: { x: 7, y: 9 } }],
  ["distribute-y", { b: { x: 4, y: 11 } }],
];

for (const [mode, expected] of cases) {
  test(`${mode} uses the active axis and handles mixed sizes and negative coordinates`, () => {
    assert.deepEqual(Object.fromEntries(computeCanvasAlignment([...items].reverse(), mode)), expected);
  });
}

test("requires two cards to align and three cards to distribute", () => {
  for (const [mode] of cases) {
    assert.deepEqual(computeCanvasAlignment([], mode), new Map());
    assert.deepEqual(computeCanvasAlignment(items.slice(0, 1), mode), new Map());
    if (mode.startsWith("distribute")) assert.deepEqual(computeCanvasAlignment(items.slice(0, 2), mode), new Map());
  }
  assert.equal(computeCanvasAlignment(items.slice(0, 2), "left").size, 1);
});

test("distribution breaks coordinate ties by ID and preserves fractional endpoints", () => {
  const tied = [
    { id: "b", x: -0.5, y: 17.5, width: 10, height: 10 },
    { id: "c", x: 49.5, y: 23, width: 10, height: 10 },
    { id: "a", x: -0.5, y: 13, width: 10, height: 10 },
  ];
  assert.deepEqual(computeCanvasAlignment(tied, "distribute-x"), new Map([["b", { x: 25, y: 17.5 }]]));
});

test("already aligned or equally spaced cards produce no updates", () => {
  assert.deepEqual(computeCanvasAlignment(items.map(item => ({ ...item, x: -20 })), "left"), new Map());
  assert.deepEqual(computeCanvasAlignment(items.map(item => ({ ...item, x: item.id === "b" ? 7 : item.x })), "distribute-x"), new Map());
});
