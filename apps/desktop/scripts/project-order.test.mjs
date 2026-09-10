import assert from "node:assert/strict";
import test from "node:test";
import { loadProjectOrder, reconcileProjectOrder, saveProjectOrder } from "../src/lib/projectOrder.ts";

const project = (id, values = {}) => ({ id, name: id, created_at: 1, workspace_path: `blank:${id}`, asset_count: 0, ...values });
const ids = rows => rows.map(row => row.id);

test("initial order is adopted unchanged; timestamps and names never reorder known projects", () => {
  const initial = [project("z", { updated_at: 8 }), project("a", { last_opened_at: 9 }), project("m")];
  assert.deepEqual(reconcileProjectOrder(initial, []), initial);
  const latest = [project("a", { name: "renamed", last_opened_at: 100 }), initial[2], initial[0]];
  const result = reconcileProjectOrder(latest, ids(initial));
  assert.deepEqual(ids(result), ["z", "a", "m"]);
  assert.equal(result[1], latest[0]);
  assert.equal(result[1].last_opened_at, 100);
  assert.deepEqual(ids(latest), ["a", "m", "z"]);
});

test("new projects precede known ones in response order; deleted and duplicate stored IDs are removed", () => {
  const rows = [project("b"), project("new2"), project("a"), project("new1")];
  assert.deepEqual(ids(reconcileProjectOrder(rows, ["a", "deleted", "a", "b"])), ["new2", "new1", "a", "b"]);
});

test("provisional materialization retains its position and metadata", () => {
  const current = [project("p", { provisional: true }), project("a"), project("b")];
  const saved = project("p", { provisional: false, name: "saved" });
  assert.deepEqual(reconcileProjectOrder([current[2], saved, current[1]], ids(current)), [saved, current[1], current[2]]);
});

test("order survives reload, excluding provisional entries; invalid or unavailable storage is safe", () => {
  let value = null;
  globalThis.localStorage = { getItem: () => value, setItem: (_key, next) => { value = next; } };
  saveProjectOrder([project("p", { provisional: true }), project("b"), project("a")]);
  assert.deepEqual(loadProjectOrder(), ["b", "a"]);
  assert.deepEqual(ids(reconcileProjectOrder([project("a"), project("b")], loadProjectOrder())), ["b", "a"]);
  for (const invalid of ["{", "null", "{}", "1"]) { value = invalid; assert.deepEqual(loadProjectOrder(), []); }
  value = '["b",3,null,"a"]';
  assert.deepEqual(loadProjectOrder(), ["b", "a"]);
  globalThis.localStorage = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); } };
  assert.deepEqual(loadProjectOrder(), []);
  assert.doesNotThrow(() => saveProjectOrder([project("a")]));
  delete globalThis.localStorage;
});
