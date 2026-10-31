import test from "node:test";
import assert from "node:assert/strict";
import { EXPLORER_MIME, parseExplorerImage, queueBrowserOperation } from "../src/lib/explorer.ts";
const data = value => ({ getData: type => type === EXPLORER_MIME ? JSON.stringify(value) : "" });
test("only image drag metadata crosses the untrusted page boundary", () => {
  const valid = { version: 1, imageUrl: "https://i.pinimg.com/image.jpg?x=1", pageUrl: "https://www.pinterest.com/pin/1" };
  assert.deepEqual(parseExplorerImage(data(valid)), valid);
  const identified = { ...valid, dragId: "a".repeat(32) };
  assert.deepEqual(parseExplorerImage(data(identified)), identified);
  assert.equal(parseExplorerImage(data({ ...valid, dragId: "wrong" })), null);
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

test("video drags keep media separate from their poster and reject untrusted URL schemes", () => {
  const video = { version: 1, mediaKind: "video", imageUrl: "https://cdn.example/clip.mp4", pageUrl: "https://site.example/watch", posterUrl: "https://cdn.example/poster.png" };
  assert.deepEqual(parseExplorerImage(data(video)), video);
  const blob = { ...video, imageUrl: "blob:https://site.example/media" };
  assert.deepEqual(parseExplorerImage(data(blob)), blob, "unsupported page blobs remain video so capture can explain their limit");
  for (const invalid of [{ ...blob, pageUrl: blob.imageUrl }, { ...video, mediaKind: "audio" }, { ...video, posterUrl: "file:///private.png" },
    { ...video, imageUrl: "blob:file:///private" }, { ...video, imageUrl: "blob:https://name:password@site.example/media" }, { ...video, mediaKind: "image" }]) {
    assert.equal(parseExplorerImage(data(invalid)), null);
  }
});
