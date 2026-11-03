import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptQuickTransferSnapshot, EMPTY_QUICK_TRANSFER } from "../src/lib/quickTransferState.ts";

test("late status and command replies cannot reopen a stopped receiver", () => {
  const stopped = { ...EMPTY_QUICK_TRANSFER, revision: 12 };
  const oldActive = { ...stopped, revision: 11, active: true, url: "http://192.168.1.23:53317/?pin=fixture" };
  assert.equal(acceptQuickTransferSnapshot(stopped, oldActive), stopped);
});

test("a late progress event cannot erase a durable successful result", () => {
  const complete = { ...EMPTY_QUICK_TRANSFER, revision: 9, transfers: [{ id: "photo", status: "complete" }] };
  const progress = { ...complete, revision: 8, transfers: [{ id: "photo", status: "receiving" }] };
  assert.equal(acceptQuickTransferSnapshot(complete, progress), complete);
  assert.equal(acceptQuickTransferSnapshot(EMPTY_QUICK_TRANSFER, complete), complete);
  assert.equal(acceptQuickTransferSnapshot(complete, complete), complete);
});
