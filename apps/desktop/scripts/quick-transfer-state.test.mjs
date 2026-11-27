import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptQuickTransferSnapshot, EMPTY_QUICK_TRANSFER, initialQuickTransferDestination, quickTransferDestinationKey } from "../src/lib/quickTransferState.ts";

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

test("an active destination comes from the newest receive snapshot", () => {
  const destination = { kind: "project", projectId: "p", name: "海报", directory: "D:/BowerbirdLibrary/项目/海报-p" };
  const active = { ...EMPTY_QUICK_TRANSFER, revision: 14, active: true, destination };
  const old = { ...active, revision: 13, destination: { kind: "folder", folderId: "p", name: "旧文件夹", directory: "D:/旧文件夹" } };
  assert.deepEqual(acceptQuickTransferSnapshot(active, old).destination, destination);
  assert.notEqual(quickTransferDestinationKey(destination), quickTransferDestinationKey(old.destination));
});

test("opening in a valid canvas preselects its project; elsewhere use the resolved default", () => {
  const folder = { kind: "folder", folderId: "inbox" };
  const projects = [{ id: "p" }];
  assert.deepEqual(initialQuickTransferDestination("p", projects, folder), { kind: "project", projectId: "p" });
  assert.deepEqual(initialQuickTransferDestination("missing", projects, folder), folder);
  assert.deepEqual(initialQuickTransferDestination(null, projects, folder), folder);
  assert.deepEqual(initialQuickTransferDestination(null, projects, { kind: "default" }), { kind: "default" });
});
