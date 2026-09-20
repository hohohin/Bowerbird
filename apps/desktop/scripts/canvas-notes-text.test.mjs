import test from "node:test";
import assert from "node:assert/strict";
import { canvasGridWeights, canvasTextCsv } from "../src/lib/canvasNotes.ts";

const cell = text => ({ text, bold: false, italic: false, align: "left" });

test("canvasTextCsv quotes commas, quotes and line breaks per RFC 4180", () => {
  assert.equal(canvasTextCsv([[cell("a"), cell("b")], [cell("c"), cell("d")]]), "a,b\nc,d");
  assert.equal(canvasTextCsv([[cell("带,逗号")]]), '"带,逗号"');
  assert.equal(canvasTextCsv([[cell("含\"引号\"")]]), '"含""引号"""');
  assert.equal(canvasTextCsv([[cell("第一行\n第二行")]]), '"第一行\n第二行"');
  assert.equal(canvasTextCsv([[cell(" 空白保留 ")]]), " 空白保留 ");
});

test("canvasGridWeights falls back to equal weights on malformed vectors", () => {
  assert.deepEqual(canvasGridWeights(undefined, 3), [1, 1, 1]);
  assert.deepEqual(canvasGridWeights([2, 1], 2), [2, 1]);
  assert.deepEqual(canvasGridWeights([2], 2), [1, 1]);
  assert.deepEqual(canvasGridWeights([2, 0], 2), [1, 1]);
  assert.deepEqual(canvasGridWeights([2, Number.NaN], 2), [1, 1]);
});
