import assert from "node:assert/strict";
import { test } from "node:test";
import { clampThumbnailWidth, readThumbnailWidth, saveThumbnailWidth,
  thumbnailWidthFromZoom, thumbnailZoomFromWidth } from "../src/lib/thumbnailSize.ts";

test("0–100 maps linearly to the library and project width ranges", () => {
  for (const [scope, minimum, midpoint] of [["library", 96, 208], ["canvas", 48, 184], ["projects", 96, 208]]) {
    assert.equal(thumbnailWidthFromZoom(0, scope), minimum);
    assert.equal(thumbnailWidthFromZoom(50, scope), midpoint);
    assert.equal(thumbnailWidthFromZoom(100, scope), 320);
    assert.equal(thumbnailWidthFromZoom(-20, scope), minimum);
    assert.equal(thumbnailWidthFromZoom(120, scope), 320);
    let previous = minimum - 1;
    for (let zoom = 0; zoom <= 100; zoom++) {
      const width = thumbnailWidthFromZoom(zoom, scope);
      assert.ok(width > previous);
      assert.equal(thumbnailZoomFromWidth(width, scope), zoom, `${scope}: ${zoom} survives pixel rounding`);
      previous = width;
    }
  }
});

test("only project thumbnails can shrink below 96 pixels", () => {
  assert.equal(clampThumbnailWidth(48, "canvas"), 48);
  assert.equal(clampThumbnailWidth(48, "library"), 96);
  assert.equal(clampThumbnailWidth(1, "canvas"), 48);
  assert.equal(clampThumbnailWidth(400, "canvas"), 320);
});

test("pixel preferences survive reload and retain separate scoped limits", () => {
  const storage = new Map();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value),
  } });
  try {
    storage.set("bowerbird.libraryThumbnailWidth", "200");
    storage.set("bowerbird.canvasThumbnailWidth", "160");
    assert.equal(readThumbnailWidth("library"), 200);
    assert.equal(readThumbnailWidth("canvas"), 160);
    assert.equal(readThumbnailWidth("projects"), 200);
    saveThumbnailWidth("projects", 280);
    assert.equal(readThumbnailWidth("projects"), 280);
    assert.equal(readThumbnailWidth("library"), 200);
    assert.equal(readThumbnailWidth("canvas"), 160);
    saveThumbnailWidth("canvas", 48);
    assert.equal(readThumbnailWidth("canvas"), 48);
    assert.equal(readThumbnailWidth("library"), 200);
    saveThumbnailWidth("library", 48);
    assert.equal(readThumbnailWidth("library"), 96);
    storage.delete("bowerbird.canvasThumbnailWidth");
    storage.set("bowerbird.canvasSourceThumbnailScale", "3");
    assert.equal(readThumbnailWidth("canvas"), 208);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  }
});
