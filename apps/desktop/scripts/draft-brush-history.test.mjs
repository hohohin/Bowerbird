import assert from "node:assert/strict";
import test from "node:test";
import { DraftHistory } from "../src/lib/draftHistory.ts";

test("undo/redo retain their bytes and a new edit removes the redo branch", () => {
  const history = new DraftHistory(100, 10);
  let value = 0;
  const edit = (next, bytes = 20) => {
    const before = value;
    value = next;
    history.push({ undo: () => { value = before; }, redo: () => { value = next; }, bytes });
  };
  assert.equal(history.undo(), false);
  assert.equal(history.redo(), false);
  edit(1); edit(2);
  assert.equal(history.bytes, 40);
  assert.equal(history.undo(), true); assert.equal(value, 1);
  assert.equal(history.bytes, 40, "redo keeps its pixel buffers alive");
  assert.equal(history.canRedo, true);
  assert.equal(history.redo(), true); assert.equal(value, 2);
  history.undo(); edit(3, 30);
  assert.equal(history.canRedo, false); assert.equal(history.bytes, 50);
  history.undo(); assert.equal(value, 1);
  history.undo(); assert.equal(value, 0);
  assert.equal(history.canUndo, false);
  history.redo(); assert.equal(value, 1);
  history.redo(); assert.equal(value, 3);
  history.clear(); assert.equal(history.bytes, 0); assert.equal(history.canUndo, false);
});

test("byte and step budgets evict the oldest complete operations", () => {
  const history = new DraftHistory(50, 2);
  const undone = [];
  const push = (id, bytes) => history.push({ undo: () => undone.push(id), redo() {}, bytes });
  push(1, 20); push(2, 20); push(3, 20);
  assert.equal(history.bytes, 40);
  history.undo(); history.undo();
  assert.deepEqual(undone, [3, 2]); assert.equal(history.undo(), false);
  history.redo(); history.redo();
  push(4, 40);
  assert.equal(history.bytes, 40);
  history.undo(); assert.deepEqual(undone, [3, 2, 4]);
  assert.equal(history.canUndo, false);
});

test("an oversized edit becomes a new base instead of undoing across an unrecorded change", () => {
  const history = new DraftHistory(10, 5);
  let value = 1;
  history.push({ undo: () => { value = 0; }, redo: () => { value = 1; }, bytes: 5 });
  value = 2;
  history.push({ undo: () => { value = 1; }, redo: () => { value = 2; }, bytes: 11 });
  assert.equal(value, 2); assert.equal(history.bytes, 0);
  assert.equal(history.canUndo, false); assert.equal(history.canRedo, false);
  value = 3;
  history.push({ undo: () => { value = 2; }, redo: () => { value = 3; }, bytes: 4 });
  history.undo(); assert.equal(value, 2); assert.equal(history.undo(), false);
});

test("failed callbacks keep the history cursor, and invalid sizes leave history untouched", () => {
  const history = new DraftHistory();
  let fail = true;
  history.push({ undo() { if (fail) throw new Error("undo failure"); }, redo() { throw new Error("redo failure"); }, bytes: 12 });
  assert.throws(() => history.undo(), /undo failure/);
  assert.equal(history.canUndo, true); assert.equal(history.canRedo, false);
  fail = false; history.undo();
  assert.throws(() => history.redo(), /redo failure/);
  assert.equal(history.canUndo, false); assert.equal(history.canRedo, true);
  assert.throws(() => history.push({ undo() {}, redo() {}, bytes: NaN }), /大小无效/);
  assert.equal(history.canRedo, true); assert.equal(history.bytes, 12);
});
