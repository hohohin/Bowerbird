import test from "node:test";
import assert from "node:assert/strict";
import { EXPLORER_MIME, parseExplorerImage, queueBrowserOperation } from "../src/lib/explorer.ts";
const data = value => ({ getData: type => type === EXPLORER_MIME ? JSON.stringify(value) : "" });
test("only image drag metadata crosses the untrusted page boundary", () => {
  const valid = { version: 1, imageUrl: "https://i.pinimg.com/image.jpg?x=1", pageUrl: "https://www.pinterest.com/pin/1" };
  assert.deepEqual(parseExplorerImage(data(valid)), valid);
  for (const imageUrl of ["file:///secret", "javascript:alert(1)", "https://user:pass@example.com/img"]) {
    assert.equal(parseExplorerImage(data({ ...valid, imageUrl })), null);
  }
  assert.equal(parseExplorerImage(data({ ...valid, version: 2 })), null);
  assert.deepEqual(parseExplorerImage({ getData: type => type === "text/plain" ? "bowerbird-explorer:" + JSON.stringify(valid) : "" }), valid);
  assert.equal(parseExplorerImage({ getData: () => "not an image" }), null);
});
test("closing during a slow native open cannot leave an orphaned view", async () => {
  const calls = []; let release;
  const open = queueBrowserOperation(async () => { calls.push("open"); await new Promise(resolve => { release = resolve; }); });
  const hide = queueBrowserOperation(async () => { calls.push("hide"); });
  await Promise.resolve(); assert.deepEqual(calls, ["open"]);
  release(); await Promise.all([open, hide]); assert.deepEqual(calls, ["open", "hide"]);
  await assert.rejects(queueBrowserOperation(async () => { throw new Error("failed"); }));
  await queueBrowserOperation(async () => { calls.push("reopen"); });
  assert.equal(calls.at(-1), "reopen");
});
