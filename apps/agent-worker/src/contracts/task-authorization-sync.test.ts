import { equal, notEqual, throws } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const workerPath = resolve(import.meta.dirname, "task-authorization.ts");
const cloudPath = resolve(import.meta.dirname, "../../../cloud/supabase/functions/_shared/task-authorization.ts");

// Keep runtime copies independent; only this repository test reads both sources.
function assertContractsMatch(worker: string, cloud: string): void {
  equal(worker.replace(/\r\n/g, "\n"), cloud.replace(/\r\n/g, "\n"),
    "Task authorization contract drift: update both apps/agent-worker/src/contracts/task-authorization.ts and apps/cloud/supabase/functions/_shared/task-authorization.ts");
}

test("Cloud and Worker task authorization contracts stay identical", () => {
  assertContractsMatch(readFileSync(workerPath, "utf8"), readFileSync(cloudPath, "utf8"));
});

test("task authorization source comparison tolerates checkout line endings", () => {
  const source = readFileSync(workerPath, "utf8").replace(/\r\n/g, "\n");
  assertContractsMatch(source, source.replace(/\n/g, "\r\n"));
});

test("task authorization source comparison rejects type, capability and limit drift", () => {
  const source = readFileSync(workerPath, "utf8");
  for (const [before, after] of [
    ["schemaVersion: 3;", "schemaVersion: 4;"],
    ['"render_html",', '"publish_html",'],
    ["integer(item.maxCalls, 31)", "integer(item.maxCalls, 32)"],
  ]) {
    const changed = source.replace(before, after);
    notEqual(changed, source, `Drift fixture must change ${before}`);
    throws(() => assertContractsMatch(source, changed), /Task authorization contract drift/);
  }
});
